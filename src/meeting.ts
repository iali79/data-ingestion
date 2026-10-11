/**
 * Board meetings from PSX notices: when the meeting is, and whether it is for results.
 *
 * A notice says it in one sentence, written many ways (all seen in September-October 2026):
 *   "a meeting of the Board of Directors of the Company will be held on Wednesday, September 30,
 *    2026 at 03:30 p.m. ... to consider the Annual accounts for period ended on June 30, 2026"
 *   "... is scheduled on 30th September 2026 at 03:00 pm. Inter-alia to consider financial accounts"
 *   "... will be held at 12:30 PM on September 30, 2026(Wednesday) ..."
 *   "... will be held on 28-09-2026 at 12:30 Hrs ... to consider the business other than financial results"
 * So the parser finds that sentence (the Board, then "held"/"scheduled"/"convened"), reads the
 * first date in it, a time beside it, and what the meeting is "to consider".
 *
 * Numeric dates are read day-first (`28-09-2026`): Pakistani notices write them that way. The
 * ingest side checks every date against the notice's own publish date, so a misread lands
 * nowhere rather than on the wrong day.
 */

export interface MeetingCandidate {
  kind: 'board_meeting';
  date: string;
  time: string | null;
  purpose: 'financial_results' | 'other';
  resultsPeriod: 'quarter' | 'half_year' | 'annual' | null;
  periodEnded: string | null;
  confidence: number;
  sourceText: string;
}

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ORD = '(?:st|nd|rd|th)?';

/** A notice titled as a board meeting. Only these are read for a meeting. */
export function isBoardMeetingTitle(title: string): boolean {
  return /\bboard\s+meeting\b|\bmeeting\s+of\s+(?:the\s+)?board\b/iu.test(title) && !/\brevoked\b/iu.test(title);
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 0 || month > 11) return null;
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase());
}

interface FoundDate {
  at: number;
  end: number;
  date: string;
}

/** Every date in `text`, in order: named-month either way round, or numeric day-first. */
export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  const push = (m: RegExpExecArray, date: string | null) => {
    if (date) out.push({ at: m.index, end: m.index + m[0].length, date });
  };
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
    // 30th September 2026, 02nd October, 2026, 29 of September 2026
    [new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:of\\s+)?${MONTH}\\.?,?\\s*(\\d{4})`, 'giu'), (m) => iso(Number(m[3]), monthIndex(m[2] ?? ''), Number(m[1]))],
    // September 30, 2026 / September 29,2026 / June 30th, 2026
    [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})${ORD},?\\s*(\\d{4})`, 'giu'), (m) => iso(Number(m[3]), monthIndex(m[1] ?? ''), Number(m[2]))],
    // 28-09-2026, 28/09/2026, 28.09.2026 (day first)
    [/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/gu, (m) => iso(Number(m[3]), Number(m[2]) - 1, Number(m[1]))],
  ];
  for (const [re, toDate] of patterns) {
    for (let m = re.exec(text); m; m = re.exec(text)) push(m, toDate(m));
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A clock time as `HH:MM`, 24-hour: `03:30 p.m.`, `9:30 a.m.`, `05:45 PM`, `1700 hours`,
 * `12:30 Hrs`, `11 am`. Without a meridiem an hour from 1 to 7 is read as afternoon: boards do
 * not meet at 3 a.m.
 */
export function parseTime(fragment: string): string | null {
  const m =
    /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?|hrs\.?|hours)?/iu.exec(fragment) ??
    /\b(\d{1,2})\s*:?\s*()(a\.?\s?m\.?|p\.?\s?m\.?)/iu.exec(fragment) ??
    /\b([01]\d|2[0-3])([0-5]\d)\s*(hrs\.?|hours)\b/iu.exec(fragment);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = (m[3] ?? '').toLowerCase().replace(/[^apm]/gu, '');
  if (hour > 23 || minute > 59) return null;
  if (meridiem.startsWith('p') && hour < 12) hour += 12;
  else if (meridiem.startsWith('a') && hour === 12) hour = 0;
  else if (!meridiem && hour >= 1 && hour <= 7) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** OCR reads `2026` as `2O26` and `05` as `O5`; letters inside digit runs are put back. */
function repairDigits(text: string): string {
  return text.replace(/(?<=\d)[Oo](?=\d)|(?<=\d)[Oo]\b|\b[Oo](?=\d)/gu, '0');
}

const RESULTS = /\b(accounts|financial\s+(?:statements?|results?|information|reports?)|results|quarterly|half[- ]yearly|annual\s+report)\b/iu;
const NOT_RESULTS = /\b(?:other\s+than\s+(?:the\s+)?financ|non[- ]financial|matters\s+other\s+than)/iu;

function resultsPeriodOf(text: string): { resultsPeriod: MeetingCandidate['resultsPeriod']; periodEnded: string | null } {
  const ended = /\b(year|yearly|annual|period|quarter|(?:three|six|nine|3|6|9)\s+months|half[- ]year(?:ly)?)\s+ended(?:\s+on)?\s+/iu.exec(text);
  if (!ended) return { resultsPeriod: /\b(annual|yearly)\b/iu.test(text) ? 'annual' : /\bhalf[- ]year/iu.test(text) ? 'half_year' : /\bquarter/iu.test(text) ? 'quarter' : null, periodEnded: null };
  const after = text.slice(ended.index + ended[0].length, ended.index + ended[0].length + 40);
  const date = findDates(after).find((d) => d.at < 5)?.date ?? null;
  const word = (ended[1] ?? '').toLowerCase();
  const resultsPeriod: MeetingCandidate['resultsPeriod'] =
    /year|annual/u.test(word) && !/half/u.test(word)
      ? 'annual'
      : /half|six|6/u.test(word)
        ? 'half_year'
        : /quarter|three|nine|3|9/u.test(word)
          ? 'quarter'
          : // "period ended": by the words around it, else unknown
            /\b(annual|yearly|audited)\b/iu.test(text)
            ? 'annual'
            : null;
  return { resultsPeriod, periodEnded: date };
}

/**
 * The board meeting a notice announces, or null when the text does not state one clearly. Read
 * only for notices whose title says board meeting (`isBoardMeetingTitle`).
 */
export function parseBoardMeeting(rawText: string): MeetingCandidate | null {
  const text = repairDigits(rawText.replace(/\s+/gu, ' '));
  // The announcing sentence: the Board, then held/scheduled/convened within a short reach.
  const anchor = /\b(?:meeting\s+of\s+(?:the\s+)?board|board\s+(?:of\s+directors\s+)?meeting|board\s+of\s+directors)\b.{0,220}?\b(?:will\s+be\s+held|shall\s+be\s+held|is\s+(?:being\s+)?(?:scheduled|convened|going\s+to\s+be\s+held)|has\s+been\s+(?:scheduled|convened)|scheduled\s+(?:to\s+be\s+held\s+)?(?:on|at)|to\s+be\s+held|will\s+meet|will\s+take\s+place)\b/iu.exec(text);
  if (!anchor) return null;
  const sentence = text.slice(anchor.index, anchor.index + anchor[0].length + 260);
  const verbEnd = anchor[0].length;
  const dates = findDates(sentence).filter((d) => d.at >= verbEnd - 5);
  const first = dates[0];
  if (!first) return null;

  // The time sits beside the date: "on <date> at <time>" or "at <time> on <date>". Only that
  // close: further along are addresses ("Suite 602") and rule numbers ("clause 5.6.4").
  const before = sentence.slice(verbEnd, first.at);
  const time = (/\bat\b/iu.test(before) ? parseTime(before) : null) ?? parseTime(sentence.slice(first.end, first.end + 45));

  const consider = text.slice(anchor.index, anchor.index + anchor[0].length + 600);
  const isResults = RESULTS.test(consider) && !NOT_RESULTS.test(consider);
  const { resultsPeriod, periodEnded } = isResults ? resultsPeriodOf(consider) : { resultsPeriod: null, periodEnded: null };

  return {
    kind: 'board_meeting',
    date: first.date,
    time,
    purpose: isResults ? 'financial_results' : 'other',
    resultsPeriod,
    periodEnded,
    confidence: 0.8,
    sourceText: sentence.slice(0, 300),
  };
}
