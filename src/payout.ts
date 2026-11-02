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
  if (/\b(?:unclaimed|credit(?:ing)?\s+of|dispatch|despatch|disbursement|e-?dividend\s+mandate|board\s+meeting|meeting\s+of\s+the\s+board|transmission\s+of)\b/iu.test(title)) return false;
  return /\b(?:financial\s+results?|dividend|book\s+closure|closure\s+of\s+(?:share\s+transfer\s+)?books?|bonus|right\s+(?:shares?|issue)|entitlements?)\b/iu.test(title);
}

const NUMBER = String.raw`(\d{1,4}(?:[.,]\d{1,4})?)`;
const NIL = /^\W{0,6}(?:nil|none|no\b|n\/a|-{1,2}(?:\s|$))/iu;

/** A percentage at the start of an item's text, or null; `Nil` is zero. */
function leadingPercent(fragment: string): number | null {
  if (NIL.test(fragment)) return 0;
  const m = new RegExp(String.raw`^[^\d%]{0,80}?${NUMBER}\s*%`, 'iu').exec(fragment);
  return m ? toNumber(m[1]!) : null;
}

function toNumber(raw: string): number | null {
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : null;
}

/** Rupees per share stated near a cash dividend: "Rs. 6.50 per share", "PKR 4/- per share". */
function perShare(fragment: string): number | null {
  const m = new RegExp(String.raw`\b(?:rs|pkr|rupees)\s*[.:,]?\s*${NUMBER}\s*(?:\/-?|\/=)?\s*(?:\(\s*[a-z ]+\)\s*)?per\s+(?:ordinary\s+)?share`, 'iu').exec(fragment);
  return m ? toNumber(m[1]!) : null;
}

/** Text already paid or declared earlier ("in addition to the interim dividend already paid"). */
const EARLIER = /\b(?:already\s+(?:paid|declared|announced|distributed)|previously\s+(?:paid|declared|announced)|in\s+addition\s+to|earlier\s+(?:paid|declared))\b/iu;

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
    { key: 'cash', re: /\b(?:(final|interim|special)\s+)?cash\s+dividends?\b/iu },
    { key: 'bonus', re: /\bbonus\s+(?:shares?|issue)\b/iu },
    { key: 'right', re: /\bright\s+(?:shares?|issue)\b/iu },
    { key: 'other', re: /\bany\s+other\s+(?:entitlements?|corporate\s+action|price)/iu },
  ] as const;
  // The list follows "recommended/declared the following"; search from there when present.
  const start = /\b(?:recommended|declared|approved|announced)\b[^.]{0,80}?\bfollowing\b/iu.exec(text)?.index ?? 0;
  const body = text.slice(start, start + 1500);
  const found = heads
    .map((head) => ({ key: head.key, m: head.re.exec(body) }))
    .filter((hit): hit is { key: (typeof heads)[number]['key']; m: RegExpExecArray } => hit.m !== null)
    .sort((a, b) => a.m.index - b.m.index);
  if (found.length < 2) return null;
  const windowOf = (key: string): string | null => {
    const at = found.findIndex((hit) => hit.key === key);
    if (at < 0) return null;
    const from = found[at]!.m.index + found[at]!.m[0].length;
    const to = found[at + 1]?.m.index ?? Math.min(body.length, from + 160);
    return body.slice(from, to);
  };
  const cash = windowOf('cash');
  const bonus = windowOf('bonus');
  const right = windowOf('right');
  const cashHead = found.find((hit) => hit.key === 'cash');
  const instalmentWord = cashHead?.m[1]?.toLowerCase() ?? (cash ? /\b(final|interim)\b/iu.exec(cash)?.[1]?.toLowerCase() : undefined);
  const lastHead = found.at(-1)!;
  return {
    cashPercent: cash !== null ? leadingPercent(cash) : null,
    cashPerShare: cash !== null ? perShare(cash) : null,
    bonusPercent: bonus !== null ? leadingPercent(bonus) : null,
    rightPercent: right !== null ? leadingPercent(right) : null,
    instalment: instalmentWord === 'final' ? 'final' : instalmentWord === 'interim' ? 'interim' : null,
    sourceText: body.slice(found[0]!.m.index, lastHead.m.index + lastHead.m[0].length + 40),
  };
}

/**
 * The prose form: "recommended a final cash dividend of Rs. 6.50 per share i.e. 65%". The first
 * declaration that is not a mention of an earlier payout.
 */
function fromProse(text: string): Entitlements | null {
  const verb = /\b(?:recommended|declared|approved|announced|proposed)\b/giu;
  for (let m = verb.exec(text); m; m = verb.exec(text)) {
    const clause = text.slice(m.index, m.index + 260);
    const dividend = /\b(?:(final|interim|special)\s+)?(?:cash\s+)?dividends?\b/iu.exec(clause);
    if (!dividend || dividend.index > 120) continue;
    const after = clause.slice(dividend.index);
    const upTo = after.search(EARLIER);
    const own = upTo >= 0 ? after.slice(0, upTo) : after;
    const pct = new RegExp(String.raw`${NUMBER}\s*%`, 'u').exec(own);
    const rupees = perShare(own);
    if (!pct && rupees === null) continue;
    const word = (dividend[1] ?? /\b(final|interim)\b/iu.exec(own)?.[1] ?? '').toLowerCase();
    const bonus = /\bbonus\s+(?:shares?|issue)\b[^%]{0,60}?(\d{1,4}(?:\.\d{1,4})?)\s*%/iu.exec(clause);
    return {
      cashPercent: pct ? toNumber(pct[1]!) : null,
      cashPerShare: rupees,
      bonusPercent: bonus ? toNumber(bonus[1]!) : null,
      rightPercent: null,
      instalment: word === 'final' ? 'final' : word === 'interim' ? 'interim' : null,
      sourceText: own.slice(0, 200),
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
    if (!first) continue;
    // A one-day closure is written "on <date>" or "from X to X".
    const to = second && second.at - first.end < 40 ? second.date : first.date;
    if (to < first.date) continue;
    return { from: first.date, to, at: m.index };
  }
  return null;
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
