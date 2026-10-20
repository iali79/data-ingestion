/**
 * Insider transactions from PSX "Disclosure of Interest" notices.
 *
 * Under PSX Regulation 5.6.4 a company tells the exchange within a day when a director, the CEO, an
 * executive, their spouse or a substantial shareholder deals in its shares. The notice is a letter
 * with one table, written by each company in its own layout (all seen in 2025-2026):
 *
 *   Name of Relevant Person(s) | Form of Share Certificate | Market | Date | Nature | No. of Shares | Rate | Cumulative ...
 *
 * with the name wrapping over several lines and the "(Director)" description under it, the date split
 * across lines ("03-09-" / "2025", "2026-" / "02-26"), the nature written Buy, BUY, Purchase, Sale or
 * Sell, and the quantity sometimes a line above the nature. A third of the notices are text PDFs; the
 * rest are scans that come through OCR as the same shapes of text, so this reads text, not pixels.
 *
 * Rows are found by their anchor, the nature word, and each takes the lines nearest to it. The
 * numbers are read to the right of the nature column, the date and the person to its left. A row is
 * kept only when it has a person, a plausible date, a nature and a positive quantity; anything else
 * is dropped, never guessed. The ingest side checks every row again against the notice's publish date.
 */

export interface InsiderTransactionCandidate {
  /** Day of the trade, ISO. */
  date: string;
  person: string;
  /** "Director", "CEO", "Executive", "Substantial Shareholder", as written in the parentheses. */
  designation: string | null;
  nature: 'buy' | 'sell' | 'other';
  quantity: number;
  rate: number | null;
  /** Ready, Future, NDM ... as written. */
  market: string | null;
  /** Shares the person holds after the trade, and the percentage of the company. */
  cumulativeShares: number | null;
  cumulativePercent: number | null;
  confidence: number;
  sourceText: string;
}

/** A notice titled as a disclosure of interest. Only these are read for transactions. */
export function isInsiderDisclosureTitle(title: string): boolean {
  return /disclosure\s+of\s+interest|relevant\s+persons?\s+holding|insider\s+(?:trad|trans)|5\.6\.[14]\b/iu.test(title);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(year: number, month: number, day: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (y < 2000 || y > 2100 || month < 0 || month > 11 || day < 1) return null;
  const d = new Date(Date.UTC(y, month, day));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

/** Dates as the notices write them: 2026-02-26, 29-01-2026, 06-Feb-26, 04-JUNE-26, 4/9/2025, and the typo 0409-2025. */
export function readDate(text: string): string | null {
  let m = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/u.exec(text);
  if (m) return iso(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /\b(\d{1,2})[-/.\s]([A-Za-z]{3,9})[-/.\s,]*(\d{2,4})\b/u.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (month >= 0) return iso(Number(m[3]), month, Number(m[1]));
  }
  // "Feb 28, 2025", "February 28 2025".
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/u.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (month >= 0) return iso(Number(m[3]), month, Number(m[2]));
  }
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/u.exec(text);
  if (m) return iso(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  // "0409-2025": the separator between day and month lost.
  m = /\b(\d{2})(\d{2})[-/.](20\d{2})\b/u.exec(text);
  if (m) return iso(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

const NATURE = /\b(buy|bought|purchase[ds]?|acquired|acquisition|sell|sold|sale|disposal|disposed|gift|transfer(?:red)?)\b/iu;

function natureOf(word: string): 'buy' | 'sell' | 'other' {
  const w = word.toLowerCase();
  if (/^(buy|bought|purchase|purchased|purchases|acquired|acquisition)$/u.test(w)) return 'buy';
  if (/^(sell|sold|sale|disposal|disposed)$/u.test(w)) return 'sell';
  return 'other';
}

/** Words that sit in the form and market columns, so they are not part of a name. */
const COLUMN_WORDS = /^(?:cdc|cds|ccd|physical|scrip|scrips|ready|future|futures|ndm|deal|odd|lot|negotiated|through|cc|market|block|off-market|\*)$/iu;

interface Row {
  line: number;
  nature: string;
  natureAt: number;
}

const END = /^\s*(?:we\s+confirm|you\s+may|yours|thanks|thank\s+you|sincerely|notes?\s*:?|cc\s*:|company\s+secretary|regards|please|very\s+truly|\*\s)/iu;

const HEADER_WORD = /\b(?:certificates?|description|market|nature|rate|price|percentage|cumulative|shareholding|name\s+of|relevant|persons?|form\s+of|date|details?\s+of)\b/iu;

/** A line of column titles: two or more different title words and no date. A name that happens to be "Person" is one word. */
function isHeaderLine(line: string): boolean {
  if (readDate(line) !== null) return false;
  const hits = new Set([...line.matchAll(new RegExp(HEADER_WORD.source, 'giu'))].map((m) => m[0].toLowerCase().replace(/\s+/gu, ' ')));
  return hits.size >= 2 || (hits.size === 1 && /^\s*\S+(?:\s+\S+)?\s*$/u.test(line) && /\b(?:certificate|nature|rate|market|date)s?\b/iu.test(line));
}

const NUM = /-?\d[\d,]*(?:\.\d+)?%?/gu;

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/[,%]/gu, ''));
  return Number.isFinite(n) ? n : null;
}

/** Numeric tokens of `line` that start at or after `from`, with their column. */
const DATE_ANYWHERE = /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}[-/.\s][A-Za-z]{3,9}[-/.\s,]*\d{2,4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b/gu;

/** `line` with every date blanked out (same width), so its digits are not read as figures. */
function maskDates(line: string): string {
  return line.replace(DATE_ANYWHERE, (m) => ' '.repeat(m.length));
}

function numbersFrom(line: string, from: number): Array<{ at: number; raw: string; value: number }> {
  const out: Array<{ at: number; raw: string; value: number }> = [];
  for (const m of maskDates(line).matchAll(NUM)) {
    if (m.index === undefined || m.index < from) continue;
    const value = toNumber(m[0]);
    if (value !== null) out.push({ at: m.index, raw: m[0], value });
  }
  return out;
}

export function parseInsiderDisclosure(text: string, options: { publishedAt?: Date } = {}): InsiderTransactionCandidate[] {
  const lines = text.split(/\r?\n|\f/u);
  // The table starts at the header row naming the Nature column, and ends at the sign-off.
  let start = lines.findIndex((line) => /\bnature\b/iu.test(line));
  if (start < 0) start = 0;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (END.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // The header can wrap over several lines: rows begin after the last line that is all header words.
  const region = lines.slice(start, end);

  const rows: Row[] = [];
  region.forEach((line, i) => {
    const m = NATURE.exec(line);
    if (!m || m.index === undefined) return;
    // Header or prose lines name a nature without any number beside it.
    const near = [region[i - 1], line, region[i + 1]].filter((l): l is string => l !== undefined);
    if (!near.some((l) => numbersFrom(l, 0).some((n) => n.raw.replace(/\D/gu, '').length >= 1 && n.value > 0))) return;
    if (/\bNature\b/u.test(line) && !/\d{2,}/u.test(line)) return;
    rows.push({ line: i, nature: m[1]!, natureAt: m.index });
  });
  if (rows.length === 0) return [];

  // Header lines (column titles, wrapped over several lines) end before the first row's own lines.
  let headerEnd = -1;
  for (let i = 0; i < rows[0]!.line; i += 1) {
    if (isHeaderLine(region[i]!)) headerEnd = i;
  }

  // Where a row's own lines sit around its figures. Letters wrap a long name either below the figures
  // (the figures are on the row's first line), above them (on its last) or both (centred). The first
  // row's lines above its figures and the last row's lines below tell which, and lines between two
  // rows then go to the row they belong to.
  const above = rows[0]!.line - (headerEnd + 1);
  const below = region.length - 1 - rows[rows.length - 1]!.line;
  const mode: 'first' | 'last' | 'centred' = above === 0 ? 'first' : below === 0 ? 'last' : 'centred';

  const out: InsiderTransactionCandidate[] = [];
  rows.forEach((row, index) => {
    const prev = rows[index - 1]?.line ?? -1;
    const next = rows[index + 1]?.line ?? region.length;
    let top: number;
    let bottom: number;
    if (mode === 'first') {
      top = row.line;
      bottom = next - 1;
    } else if (mode === 'last') {
      top = index === 0 ? headerEnd + 1 : prev + 1;
      bottom = row.line;
    } else {
      top = index === 0 ? headerEnd + 1 : Math.floor((prev + row.line) / 2) + 1;
      bottom = index === rows.length - 1 ? region.length - 1 : Math.floor((row.line + next - 1) / 2);
    }
    const block = region.slice(top, bottom + 1);
    const core = region[row.line]!;
    const parsed = readRow(core, block, row);
    if (parsed) out.push(parsed);
  });
  let last: { person: string; designation: string | null } | null = null;
  const named: InsiderTransactionCandidate[] = [];
  for (const t of out) {
    if (t.person) {
      last = { person: t.person, designation: t.designation };
      named.push(t);
    } else if (last) {
      // A carried name is less certain than one printed beside the row.
      named.push({ ...t, person: last.person, designation: t.designation ?? last.designation, confidence: Math.min(t.confidence, 0.7) });
    }
  }
  return named.filter((t) => plausible(t, options.publishedAt));
}

function readRow(core: string, block: string[], row: Row): InsiderTransactionCandidate | null {
  const nx = row.natureAt;
  // Numbers to the right of the nature column, in reading order across the whole block.
  const right: Array<{ at: number; raw: string; value: number }> = [];
  for (const line of block) right.push(...numbersFrom(line, Math.max(0, nx - 1)).filter((n) => n.at >= nx - 1));
  // Drop a "Page 1 of 1" style tail and a footnote marker; keep the first four figures.
  let figures = right.filter((n) => !/%$/u.test(n.raw) || right.indexOf(n) >= 3);
  if (figures.length === 0) {
    // Some letters put the date, quantity and rate before the nature ("11-03-2022  14000  8.00  Purchased ...").
    const beforeDate = core.slice(0, nx).replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b20\d{2}-\d{2}-\d{2}\b/gu, ' ');
    figures = numbersFrom(beforeDate, 0).filter((n) => n.value > 0);
  }
  const quantity = figures[0];
  if (!quantity || !Number.isInteger(quantity.value) || quantity.value <= 0) return null;
  // The rate has a decimal point; an integer rate is accepted when a fourth figure follows (cumulative shares).
  const rateToken = figures[1] && (figures[1].raw.includes('.') || figures.length >= 4) ? figures[1] : null;
  const cumulative = figures.slice(rateToken ? 2 : 1);
  const cumShares = cumulative.find((n) => Number.isInteger(n.value) && n.value >= 0 && !n.raw.includes('.'));
  const cumPercent = [...cumulative].reverse().find((n) => n !== cumShares && n.value >= 0 && n.value <= 100);

  // Left of the nature column: person, designation, form, market, date.
  const leftOf = (line: string) => line.slice(0, Math.max(nx, 0));
  const lefts = block.map(leftOf);
  const coreLeft = leftOf(core);
  // The first data column in the core line (form, market or date) is where the name column ends.
  const cut = firstDataColumn(coreLeft);

  let date = readDate(coreLeft) ?? readDate(lefts.join(' ')) ?? readDate(core.slice(nx));
  let confidence = 0.9;
  if (!date) {
    // A date split over lines: join the numeric fragments in order ("2026-" + "02-26", "03-09-" + "2025").
    const fragments = lefts
      .flatMap((l) => l.split(/\s+/u))
      .filter((w) => (/^\d+(?:[-/.]\d*){1,2}$|^[-/.]\d+$|^\d{1,2}-[A-Za-z]{3,9}-?$/u.test(w) && !/^\d{1,3}\.$/u.test(w)) || /^\d{4}$/u.test(w));
    date = readDate(fragments.join(''));
    confidence = 0.75;
  }
  if (!date) return null;

  const nameText = lefts
    .map((line) => line.slice(0, cut > 0 ? cut : line.length))
    .map((s) => maskDates(s).replace(/^\s*\d{1,3}[.)]?\s*$/u, ' ').replace(/^\s*\d{1,3}[.)]?\s+(?=\S)/u, ' '))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const split = splitPerson(nameText);
  // A row whose name is blank or garbled keeps its figures: the name is carried down from the row above (several trades by one person print the name once).
  const named = cleanName(split.person);
  const person = named ? split.person : '';
  const designation = split.designation;

  const marketMatch = /\b(Ready|Futures?|NDM|Deal|Negotiated|Odd\s*lot|Block)\b/iu.exec(lefts.join(' '));
  return {
    date,
    person,
    designation,
    nature: natureOf(row.nature),
    quantity: quantity.value,
    rate: rateToken ? rateToken.value : null,
    market: marketMatch ? marketMatch[1]!.replace(/\s+/gu, ' ') : null,
    cumulativeShares: cumShares?.value ?? null,
    cumulativePercent: cumPercent?.value ?? null,
    confidence,
    sourceText: block.map((l) => l.trim()).filter(Boolean).join(' | ').slice(0, 300),
  };
}

/** Column where the form, market or date begins in a row's left half, or -1. */
function firstDataColumn(left: string): number {
  const marks: number[] = [];
  for (const m of left.matchAll(/\b(?:CDC|CDS|CCD|Physical|Ready|Futures?|NDM|Through|\d{1,2}[-/.]\S+|20\d{2}-\d{2}-\d{2})/giu)) {
    if (m.index !== undefined && m.index > 3) marks.push(m.index);
  }
  return marks.length > 0 ? Math.min(...marks) : -1;
}

const HEADER_WORDS = /^(?:buyer|seller|certificates?|certificate\(s\)|description|relevant|person\(s\)|date|nature|rate|price|market|transactions?|cumulative|shareholding|percentage|average|name:?)$/iu;
const DESIGNATION = /\b(?:director|ceo|chief|executive|chairman|chairperson|substantial|shareholder|sponsor|spouse|elected|independent|nominee|secretary|cfo|officer|employee|head|manager|president|trustee|minor|associate)\b/iu;

/** A person or company name, not column titles or leftovers: 2 to 8 words, letters, no digits. */
export function cleanName(name: string): boolean {
  const words = name.split(/\s+/u).filter(Boolean);
  if (words.length < 2 && !/^[A-Z][a-z]{3,}$/u.test(name)) return false;
  if (words.length > 9 || /\d/u.test(name)) return false;
  if (words.some((w) => HEADER_WORDS.test(w))) return false;
  return /[A-Za-z]{3,}/u.test(name);
}

/** "Mahmood Ahmad (Director)" -> person and designation; wrapped designations are rejoined. */
export function splitPerson(raw: string): { person: string; designation: string | null } {
  const cleaned = raw
    .split(/\s+/u)
    .filter((word) => !COLUMN_WORDS.test(word))
    .join(' ')
    .replace(/\s*\(\s*/gu, ' (')
    .replace(/\s*\)/gu, ')')
    .trim();
  // Only a parenthesis that reads as a role is a designation; "(Pvt.)" and "(Retd)" belong to the name.
  const groups = [...cleaned.matchAll(/\(([^()]{2,60})\)/gu)].filter((g) => DESIGNATION.test(g[1]!));
  const designation = groups.length > 0 ? groups.at(-1)![1]!.trim() : null;
  let person = cleaned;
  for (const g of groups) person = person.replace(g[0], ' ');
  person = person.replace(/[|_*]/gu, ' ').replace(/\s+\)/gu, ')').replace(/\s+/gu, ' ').trim();
  return { person, designation: designation && designation.length >= 3 ? designation : null };
}

const MAX_QUANTITY = 5e10;

function plausible(t: InsiderTransactionCandidate, publishedAt?: Date): boolean {
  if (t.quantity > MAX_QUANTITY) return false;
  if (t.rate !== null && (t.rate <= 0 || t.rate > 1e6)) return false;
  if (t.cumulativePercent !== null && t.cumulativePercent > 100) return false;
  if (publishedAt && !Number.isNaN(publishedAt.getTime())) {
    const day = Date.parse(`${t.date}T00:00:00Z`);
    // A trade is reported within days; allow six months for a late filing, never a future date.
    if (day > publishedAt.getTime() + 2 * 86_400_000) return false;
    if (day < publishedAt.getTime() - 180 * 86_400_000) return false;
  }
  return true;
}
