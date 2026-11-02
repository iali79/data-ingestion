/**
 * Payouts from PSX results notices: what the Board declared and when the share register closes.
 *
 * Under PSX Regulation 5.6.1 a listed company sends its results with a covering letter that lists
 * the entitlements in a fixed order, then the book closure. Seen in LUCK's notice of 27 Jul 2019:
 *
 *   (i)   Cash Dividend                              65%
 *   (ii)  Bonus Shares                               Nil
 *   (iii) Right Shares                               Nil
 *   (iv)  Any other Entitlement / Corporate Action   Nil
 *   ...
 *   The Share Transfer Books of the Company will remain closed from Friday, September 13, 2019 to
 *   Friday, September 27, 2019 (both days inclusive).
 *
 * Others write it as a sentence ("recommended a final cash dividend of Rs. 6.50 per share i.e.
 * 65%"). Most notices before 2025 are scans, so the text is OCR output; the parser reads only the
 * covering letter (`PAYOUT_OCR`) and never guesses: a figure it cannot tie to an entitlement is
 * left out, and a notice that declares nothing yields null.
 *
 * Percentages are of face value, as PSX states them. The ex-date is not in the notice; the
 * receiving side derives it from the book closure in trading days.
 */
import type { OcrPolicy } from './extraction.js';
import { findDates, repairDigits, resultsPeriodOf } from './meeting.js';

/** The covering letter is the first one or two pages; three leaves room for a cover sheet. */
export const PAYOUT_OCR = { mode: 'leading', pages: 3 } as const satisfies OcrPolicy;

export interface PayoutCandidate {
  /** `YYYY-MM-DD` the results cover, or null. */
  periodEnded: string | null;
  resultsPeriod: 'quarter' | 'half_year' | 'annual' | null;
  instalment: 'final' | 'interim' | null;
  /** Cash dividend as a percent of face value. */
  cashPercent: number | null;
  /** Cash dividend in rupees per share, when the notice states it. */
  cashPerShare: number | null;
  bonusPercent: number | null;
  rightPercent: number | null;
  bookClosureFrom: string | null;
  bookClosureTo: string | null;
  confidence: number;
  sourceText: string;
}

/**
 * Notices that can carry a declaration: results, dividend and book-closure notices. Left out are
 * the meeting announcements before the results, and the notices that follow a payout (credit,
 * dispatch, unclaimed), which restate it without the book closure.
 */
export function isPayoutNoticeTitle(title: string): boolean {
  if (/\b(?:unclaimed|credit(?:ing)?\s+of|payment\s+of|dispatch|despatch|disbursement|e-?dividend\s+mandate|board\s+meeting|meeting\s+of\s+the\s+board|transmission\s+of)\b/iu.test(title)) return false;
  return /\b(?:financial\s+results?|dividend|book\s+closure|closure\s+of\s+(?:share\s+transfer\s+)?books?|bonus|right\s+(?:shares?|issue)|entitlements?)\b/iu.test(title);
}

const NUMBER = String.raw`(\d{1,4}(?:[.,]\d{1,4})?)`;
const NIL = /^\W{0,6}(?:nil|none|no\b|n\/a|-{1,3}\s*nil|-{1,2}(?:\s|$))/iu;

function toNumber(raw: string): number | null {
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : null;
}

/**
 * Where a clause turns to earlier payouts: "This is in addition to the interim dividend already
 * paid at Rs. 6.5 per share", "(Interim dividends at Rs. 5 per share ... have already been paid)",
 * "aready paid" as typed. Figures after it are not this declaration's.
 */
const EARLIER = /\(?\s*\b(?:this\s+is\s+)?in\s+addition\s+to\b|\(\s*interim\b|\b(?:al?ready|aready)\s+(?:been\s+)?(?:paid|declared|announced|distributed)\b|\bpreviously\s+(?:paid|declared|announced)\b|\bearlier\s+(?:paid|declared)\b/iu;
/** "No dividend has been announced for the Second Quarter" (MCB, 2020). */
const NO_DIVIDEND = /^\W{0,10}(?:no|nil)\b/iu;

/** A percentage at the start of an item's text (bonus, right), or null; `Nil` is zero. */
function leadingPercent(fragment: string): number | null {
  if (NIL.test(fragment)) return 0;
  const m = new RegExp(String.raw`^[^\d%]{0,80}?${NUMBER}\s*(?:%|percent\b)`, 'iu').exec(fragment);
  return m ? toNumber(m[1]!) : null;
}

/**
 * The cash amount in a declaration: the first "Rs. 1.00 per share" and the first "10%" / "17.5
 * percent" before the text turns to earlier payouts. "Rs." is sometimes left out ("@ 2.5 per
 * share") and "/-" added ("Rs. 2.25/- per share").
 */
export function cashAmount(fragment: string): { percent: number | null; perShare: number | null; nil: boolean } {
  if (NO_DIVIDEND.test(fragment)) return { percent: 0, perShare: null, nil: true };
  const cut = fragment.search(EARLIER);
  const own = cut >= 0 ? fragment.slice(0, cut) : fragment;
  // OCR turns "27.5 percent" into "27-5 percent" and "(30%)" into "(30o)".
  const repaired = own.replace(/\b(\d{1,3})[-\u2013]\s?(\d{1,2})\s*(?=%|percent\b)/giu, '$1.$2').replace(/\((\d{1,4}(?:\.\d{1,2})?)\s*[o0]\)/giu, '($1%)');
  const percent = new RegExp(String.raw`${NUMBER}\s*(?:%|percent\b)`, 'iu').exec(repaired);
  const perShare = new RegExp(String.raw`(?:\b(?:rs|pkr|rupees)\s*[.:,]?\s*|[@]\s*)?${NUMBER}\s*(?:\/-?|\/=)?\s*per\s+(?:ordinary\s+)?share`, 'iu').exec(own);
  return { percent: percent ? toNumber(percent[1]!) : null, perShare: perShare ? toNumber(perShare[1]!) : null, nil: false };
}

interface Entitlements {
  cashPercent: number | null;
  cashPerShare: number | null;
  bonusPercent: number | null;
  rightPercent: number | null;
  instalment: PayoutCandidate['instalment'];
  sourceText: string;
}

/**
 * The 5.6.1 list: each item's figure is the text between its heading and the next heading.
 * Only read when at least two headings appear, so a stray "cash dividend" in prose is not a list.
 */
function fromList(text: string): Entitlements | null {
  const heads = [
    { key: 'cash', re: /\b(?:(final|interim|special)\s+)?(?:cash\s+)?dividends?\b(?!\s+(?:already|has\s+already))/iu },
    { key: 'bonus', re: /\bbonus(?:\s*\/\s*right)?\s+(?:shares?|issue)\b/iu },
    { key: 'right', re: /\bright\s+(?:shares?|issue)\b/iu },
    { key: 'other', re: /\b(?:any\s+)?other\s+(?:entitlements?|corporate\s+action|price)/iu },
  ] as const;
  // The list follows "recommended/approved the following"; search from there when present.
  const lead = /\b(?:recommended|recommend|declared|approved|announced)\b[^.]{0,120}?\bfollowing\b/iu.exec(text);
  if (!lead) return null;
  const start = lead.index + lead[0].length;
  const body = text.slice(start, start + 1500);
  const found = heads
    .map((head) => ({ key: head.key, m: head.re.exec(body) }))
    .filter((hit): hit is { key: (typeof heads)[number]['key']; m: RegExpExecArray } => hit.m !== null)
    .sort((a, b) => a.m.index - b.m.index);
  const cashHit = found.find((hit) => hit.key === 'cash');
  if (!cashHit) return null;
  const windowOf = (key: string): string | null => {
    const at = found.findIndex((hit) => hit.key === key);
    if (at < 0) return null;
    const from = found[at]!.m.index + found[at]!.m[0].length;
    const next = found.slice(at + 1).find((hit) => hit.m.index >= from);
    const to = next?.m.index ?? Math.min(body.length, from + 400);
    return body.slice(from, Math.min(to, from + 400));
  };
  const cash = cashAmount(windowOf('cash') ?? '');
  const bonus = windowOf('bonus');
  const right = windowOf('right');
  const cashWindow = windowOf('cash') ?? '';
  const instalmentWord = (cashHit.m[1] ?? /\b(final|interim)\b/iu.exec(cashWindow.slice(0, 120))?.[1] ?? '').toLowerCase();
  const lastHead = found.at(-1)!;
  return {
    cashPercent: cash.percent,
    cashPerShare: cash.perShare,
    bonusPercent: bonus !== null ? leadingPercent(bonus) : null,
    rightPercent: right !== null ? leadingPercent(right) : null,
    instalment: instalmentWord === 'final' ? 'final' : instalmentWord === 'interim' ? 'interim' : null,
    sourceText: body.slice(cashHit.m.index, Math.max(cashHit.m.index + 160, lastHead.m.index + lastHead.m[0].length + 20)),
  };
}

/**
 * The prose form: "The Board of Directors has recommended a final cash dividend of Rs. 6.00 per
 * share (60%)". The first declaration that is not a mention of an earlier payout.
 */
function fromProse(text: string): Entitlements | null {
  const verb = /\b(?:recommended|declared|approved|announced|proposed|intimated)\b/giu;
  for (let m = verb.exec(text); m; m = verb.exec(text)) {
    const clause = text.slice(m.index, m.index + 300);
    const dividend = /\b(?:(final|interim|special)\s+)?(?:cash\s+)?dividends?\b/iu.exec(clause);
    if (!dividend || dividend.index > 120) continue;
    const after = clause.slice(dividend.index + dividend[0].length);
    const cash = cashAmount(after);
    if (cash.nil || (cash.percent === null && cash.perShare === null)) continue;
    const word = (dividend[1] ?? '').toLowerCase();
    const bonus = /\bbonus\s+(?:shares?|issue)\b[^%]{0,60}?(\d{1,4}(?:\.\d{1,4})?)\s*%/iu.exec(clause);
    return {
      cashPercent: cash.percent,
      cashPerShare: cash.perShare,
      bonusPercent: bonus ? toNumber(bonus[1]!) : null,
      rightPercent: null,
      instalment: word === 'final' ? 'final' : word === 'interim' ? 'interim' : null,
      sourceText: clause.slice(dividend.index, dividend.index + 200),
    };
  }
  return null;
}

/** "Share Transfer Books ... closed from <date> to <date>", "book closure from <date> to <date>". */
export function bookClosure(text: string): { from: string; to: string; at: number } | null {
  const anchor = /\b(?:share\s+transfer\s+books?|transfer\s+books?|register\s+of\s+(?:members|shareholders)|book\s+closure)\b/giu;
  for (let m = anchor.exec(text); m; m = anchor.exec(text)) {
    const window = text.slice(m.index, m.index + 360);
    const from = /\b(?:from|w\.?e\.?f\.?|commencing)\b/iu.exec(window);
    if (!from) continue;
    const dates = findDates(window.slice(from.index));
    const [first, second] = dates;
    if (!first || (second && second.at - first.end >= 40)) {
      const loose = looseRange(window.slice(from.index, from.index + 160));
      if (loose) return { ...loose, at: m.index };
    }
    if (!first) continue;
    // A one-day closure is written "on <date>" or "from X to X".
    const to = second && second.at - first.end < 40 ? second.date : first.date;
    if (to < first.date) continue;
    return { from: first.date, to, at: m.index };
  }
  return null;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LOOSE_DAY = String.raw`(\d{1,2})(?:st|nd|rd|th|["”'’])?\s*(?:of\s+)?([a-z]{3,9})\.?(?:,?\s*(\d{4}))?`;

/**
 * "from Monday, 17" October to Saturday 29" October 2016": an OCR'd "th" and the year only on the
 * second date, which `findDates` cannot read as a pair. The missing year is the other date's.
 */
function looseRange(fragment: string): { from: string; to: string } | null {
  const m = new RegExp(String.raw`from\s+(?:[a-z]+day,?\s+)?${LOOSE_DAY}\s+(?:to|till|until|-)\s+(?:[a-z]+day,?\s+)?${LOOSE_DAY}`, 'iu').exec(fragment);
  if (!m) return null;
  const month = (name: string) => MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase());
  const year = Number(m[3] ?? m[6]);
  const fromYear = m[3] ? Number(m[3]) : year;
  const toYear = m[6] ? Number(m[6]) : year;
  const day = (y: number, mo: number, d: number) => {
    if (!(y >= 2000 && y <= 2100) || mo < 0) return null;
    const date = new Date(Date.UTC(y, mo, d));
    return date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
  };
  const from = day(fromYear, month(m[2]!), Number(m[1]));
  const to = day(toYear, month(m[5]!), Number(m[4]));
  return from && to && to >= from ? { from, to } : null;
}

/** The Board's declaration and book closure in a results or dividend notice; null when it declares no entitlement. */
export function parsePayoutNotice(rawText: string, context: { title: string }): PayoutCandidate | null {
  const text = repairDigits(`${context.title}\n${rawText}`.replace(/\s+/gu, ' '));
  const declared = fromList(text) ?? fromProse(text);
  if (!declared) return null;
  const any = [declared.cashPercent, declared.cashPerShare, declared.bonusPercent, declared.rightPercent].some((value) => value !== null && value > 0);
  if (!any) return null;

  const { resultsPeriod, periodEnded } = resultsPeriodOf(text.slice(0, 1500));
  const closure = bookClosure(text);
  const instalment = declared.instalment ?? (resultsPeriod === 'annual' ? 'final' : resultsPeriod ? 'interim' : null);
  const consistent =
    declared.cashPercent === null || declared.cashPerShare === null ||
    // 10 rupee shares are the norm; other face values exist, so a mismatch only lowers confidence.
    Math.abs(declared.cashPerShare * 10 - declared.cashPercent) < 0.01;
  const confidence = (closure ? 0.85 : 0.7) - (consistent ? 0 : 0.1);
  return {
    periodEnded,
    resultsPeriod,
    instalment,
    cashPercent: declared.cashPercent,
    cashPerShare: declared.cashPerShare,
    bonusPercent: declared.bonusPercent,
    rightPercent: declared.rightPercent,
    bookClosureFrom: closure?.from ?? null,
    bookClosureTo: closure?.to ?? null,
    confidence,
    sourceText: declared.sourceText.slice(0, 300),
  };
}
