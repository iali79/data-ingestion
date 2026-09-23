import type { ExtractedDocument, ExtractedPage } from '../extraction.js';
import type { ConsolidationBasis, StatementType } from '../parser.js';

/**
 * Finds the face-of-statement pages in a filing: the statement of profit or loss, of financial
 * position and of cash flows, per consolidation basis. Only these pages go to the model -- a
 * 114-page annual report becomes three or four pages of input.
 *
 * Matching is on the page's heading block (its first lines), where PSX filings print the
 * statement title, e.g. "Condensed Interim Statement of Profit or Loss". Pages whose heading is a
 * multi-year summary, the notes, or the statement of changes in equity are never candidates:
 * they reuse statement wording against a different table shape.
 */
export interface StatementPage {
  statementType: StatementType;
  basis: ConsolidationBasis;
  /** One page, or two when a balance sheet continues onto the next page. */
  pages: ExtractedPage[];
  /**
   * When two statements are printed side by side, the character columns of this one in the
   * layout text ([start, end)); `cropped` applies it. Absent for a full-width statement.
   */
  columns?: [number, number];
}

/** The statement's own text: its page(s), cut to its column when printed side by side. */
export function cropped(statement: StatementPage): Array<{ pageNumber: number; text: string }> {
  return statement.pages.map((page) => ({
    pageNumber: page.pageNumber,
    text: statement.columns
      ? page.text.split('\n').map((line) => line.slice(statement.columns![0], statement.columns![1])).join('\n')
      : page.text,
  }));
}

const HEADING_LINES = 14;

const TITLES: Array<[StatementType, RegExp]> = [
  [
    'income_statement',
    /^(statement\s+of\s+profit\s+(?:or|and)\s+loss|profit\s+and\s+loss\s+account|income\s+statement|statement\s+of\s+income)\b/iu,
  ],
  ['balance_sheet', /^(statement\s+of\s+financial\s+position|balance\s+sheet)\b/iu],
  ['cash_flow', /^(statement\s+of\s+cash\s+flows?|cash\s+flow\s+statement)\b/iu],
];

/** Words that may precede a title: "Unconsolidated Condensed Interim Statement of ...". */
const TITLE_PREFIX = /^(?:(?:un-?consolidated|consolidated|separate|standalone|condensed|interim)\s+)*/iu;

/**
 * Pages that reuse statement wording against a different table: multi-year summaries and
 * analyses. Checked across the whole heading block -- such a page may carry a statement title as
 * a sub-heading ("Horizontal Analysis / Statement of Financial Position").
 */
const SUMMARY_PAGE =
  /\bfinancial\s+highlights\b|\byears?\s+at\s+a\s+glance\b|\b(?:six|6|ten|10)[\s-]years?'?\b|\bhorizontal\s+analysis\b|\bvertical\s+analysis\b|\bkey\s+(?:financial\s+)?(?:data|indicators)\b|\bdupont\b|\bvalue\s+added\b/iu;

/** Titles that are not read but still mark a column edge when printed beside one that is. */
const OTHER_TITLE = /^(statement\s+of\s+(?:other\s+)?comprehensive\s+income|statement\s+of\s+changes\s+in\s+equity|notes\s+to\s+the)\b/iu;

/** Annual reports print two statements side by side; their headings share a line, split by a wide gap. */
const COLUMN_GAP = /\s{3,}/u;

/** A statement page is a table: many lines ending in figures. */
const FIGURE_LINE = /(?:\(?\d{1,3}(?:,\d{3})+\)?|\(?\d+\.\d+\)?|\s-\s*$)\s*$/u;
const MIN_FIGURE_LINES = 6;

export function findStatementPages(document: ExtractedDocument): StatementPage[] {
  const found: StatementPage[] = [];
  let bannerBasis: ConsolidationBasis = 'unknown';

  for (const [index, page] of document.pages.entries()) {
    const segments = headingSegments(page.text);
    const banner = segments
      .map((segment) => /^(un-?consolidated|separate|consolidated)\s+(?:condensed\s+interim\s+)?financial\s+statements\b/iu.exec(segment))
      .find(Boolean);
    if (banner) bannerBasis = basisFrom(banner[1]);
    if (SUMMARY_PAGE.test(segments.join('\n'))) continue;
    if (figureLines(page.text) < MIN_FIGURE_LINES) continue;

    const titles = titlesOn(segments);
    const offsets = titleOffsets(page.text);
    for (const [position, { type, basis: titleBasis }] of titles.entries()) {
      const basis = titleBasis ?? bannerBasis;
      const columns = sideBySideColumns(offsets, type);
      const pages = [page];
      // A balance sheet split over two pages: assets on one, equity and liabilities on the next.
      const next = document.pages[index + 1];
      if (
        type === 'balance_sheet' &&
        titles.length === 1 &&
        next &&
        !/\bequity\s+and\s+liabilities\b|\btotal\s+liabilities\b/iu.test(page.text) &&
        figureLines(next.text) >= MIN_FIGURE_LINES &&
        titlesOn(headingSegments(next.text)).length === 0
      ) {
        pages.push(next);
      }
      // The same statement found twice for one basis: the first is the statement itself (they
      // precede the notes), so later repeats are ignored.
      if (found.some((item) => item.statementType === type && item.basis === basis)) continue;
      void position;
      found.push({ statementType: type, basis, pages, ...(columns ? { columns } : {}) });
    }
  }
  return found;
}

function titlesOn(segments: string[]): Array<{ type: StatementType; basis: ConsolidationBasis | null }> {
  const titles: Array<{ type: StatementType; basis: ConsolidationBasis | null }> = [];
  for (const segment of segments) {
    const prefix = TITLE_PREFIX.exec(segment)?.[0] ?? '';
    const rest = segment.slice(prefix.length);
    const type = TITLES.find(([, title]) => title.test(rest))?.[0];
    if (!type || titles.some((title) => title.type === type)) continue;
    // "Statement of Comprehensive Income" alone restates profit for the year; skip it.
    if (type === 'income_statement' && /^statement\s+of\s+income/iu.test(rest) === false && /comprehensive/iu.test(rest) && !/profit/iu.test(rest)) continue;
    const word = /\b(un-?consolidated|separate|standalone|consolidated)\b/iu.exec(prefix)?.[1];
    titles.push({ type, basis: word ? basisFrom(word) : null });
  }
  return titles;
}

/** Where each statement title starts on the heading lines that carry two titles side by side. */
function titleOffsets(text: string): Array<{ type: StatementType; start: number; lineTitles: number }> {
  const offsets: Array<{ type: StatementType; start: number; lineTitles: number }> = [];
  const lines = text.split('\n').filter((line) => line.trim().length > 0).slice(0, HEADING_LINES);
  for (const line of lines) {
    const found: Array<{ type: StatementType; start: number }> = [];
    const cell = /\S+(?:\s\S+)*/gu;
    for (let match = cell.exec(line); match; match = cell.exec(line)) {
      const text = match[0].replace(/\s+/gu, ' ');
      for (const part of text.split(COLUMN_GAP)) {
        const prefix = TITLE_PREFIX.exec(part)?.[0] ?? '';
        const rest = part.slice(prefix.length);
        const type = TITLES.find(([, title]) => title.test(rest))?.[0];
        if (type) found.push({ type, start: match.index });
        else if (OTHER_TITLE.test(rest)) found.push({ type: 'other' as StatementType, start: match.index });
      }
    }
    if (found.length >= 2) offsets.push(...found.map((item) => ({ ...item, lineTitles: found.length })));
  }
  return offsets;
}

/** For a statement printed beside another: [its title's start (or 0), the next title's start (or end)). */
function sideBySideColumns(offsets: Array<{ type: StatementType; start: number }>, type: StatementType): [number, number] | undefined {
  const mine = offsets.find((item) => item.type === type);
  if (!mine) return undefined;
  const starts = [...new Set(offsets.map((item) => item.start))].sort((a, b) => a - b);
  const index = starts.indexOf(mine.start);
  const start = index === 0 ? 0 : Math.max(0, mine.start - 2);
  const end = index + 1 < starts.length ? starts[index + 1]! - 2 : 10_000;
  return [start, end];
}

/** The heading block's lines, each split into side-by-side column headings. */
function headingSegments(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, HEADING_LINES)
    .flatMap((line) => line.trim().split(COLUMN_GAP))
    .map((segment) => segment.replace(/\s+/gu, ' ').trim())
    .filter((segment) => segment.length > 0);
}

/** True when a statement type is missing -- the signal to OCR near-empty (scanned) pages. */
export function statementsIncomplete(document: ExtractedDocument): boolean {
  const types = new Set(findStatementPages(document).map((item) => item.statementType));
  return !(types.has('income_statement') && types.has('balance_sheet'));
}

/**
 * Page text as the model sees it: runs of layout spaces become " | " so columns stay distinct
 * (a note number and a value would otherwise read as one run of digits), blank lines dropped.
 */
export function compactPageText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/gu, ' | ').replace(/^\s*\|\s*/u, '').trim())
    .filter((line) => line.length > 0 && line !== '|')
    .join('\n');
}

function figureLines(text: string): number {
  return text.split('\n').filter((line) => FIGURE_LINE.test(line.trimEnd())).length;
}

function basisFrom(word: string | undefined): ConsolidationBasis {
  if (!word) return 'unknown';
  return /^(un-?consolidated|separate|standalone)$/iu.test(word) ? 'unconsolidated' : 'consolidated';
}
