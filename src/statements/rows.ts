/**
 * Splits statement or note pages into numbered rows of "caption + printed numbers", so the model
 * only has to say which row is which item -- the figures themselves are always taken from the
 * page by this code, never typed by the model. A value that is not printed cannot be produced.
 *
 * pdftotext's layout mode keeps columns apart with runs of spaces. A printed line can hold:
 *   - a caption, a note reference and values:     "Cost of sales   25   (15,842,506)   (13,688,965)"
 *   - values only (an unlabelled total):           "                     7,816,272   10,244,793"
 *   - two statements side by side (annual reports): "REVENUE 24 30,928,564 26,747,828   PROFIT FOR THE YEAR 2,909,544 1,857,147"
 *   - numbers before the caption (share tables):   "2,757,783  2,757,783  Issued for cash  27,578  27,578"
 * Each caption-with-numbers group becomes its own row; lines with text only are kept as headings
 * for context (the model needs "CURRENT ASSETS" to place an unlabelled total).
 */
export interface Row {
  id: string;
  page: number;
  caption: string;
  /** Numbers (and "-" for nil) printed before the caption, in order. */
  leading: string[];
  /** Numbers (and "-" for nil) printed after the caption, in order. */
  numbers: string[];
  /** The printed line, verbatim, for provenance. */
  line: string;
  /** Text-only lines (section headings) printed since the previous row. */
  headingsBefore: string[];
}

export interface RowView {
  rows: Row[];
  /** What the model sees: headings and rows, in page order. */
  text: string;
}

const NUMBER = /^\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?$|^\(?-?\d+(?:\.\d+)?\)?%?$/u;
const NIL = /^[-–—]+$/u;

export function isFigure(token: string): boolean {
  return NUMBER.test(token) || NIL.test(token);
}

export function buildRows(pages: Array<{ pageNumber: number; text: string }>, prefix = 'R'): RowView {
  const rows: Row[] = [];
  const out: string[] = [];
  let headings: string[] = [];
  let previousWasText = false;
  for (const page of pages) {
    out.push(`--- page ${page.pageNumber} ---`);
    for (const rawLine of page.text.split('\n')) {
      const line = rawLine.replace(/\s+$/u, '');
      if (!line.trim()) continue;
      const segments = segmentsOf(line);
      if (segments.length === 0) {
        const heading = line.trim().replace(/\s{2,}/gu, ' | ');
        headings.push(heading);
        out.push(`   ${heading}`);
        previousWasText = true;
        continue;
      }
      // Rule R4: a caption printed on the line above its figures (a wrapped caption) belongs to
      // the figures-only line under it.
      if (segments.length === 1 && !segments[0]!.caption && headings.length > 0 && previousWasText) {
        segments[0]!.caption = headings[headings.length - 1]!.replace(/\s*\|\s*/gu, ' ');
      }
      for (const segment of segments) {
        const id = `${prefix}${rows.length + 1}`;
        rows.push({ id, page: page.pageNumber, ...segment, line: line.trim(), headingsBefore: headings });
        headings = [];
        const leading = segment.leading.length > 0 ? `[${segment.leading.join(' | ')}] ` : '';
        out.push(`${id}: ${leading}${segment.caption || '(no caption)'} || ${segment.numbers.join(' | ')}`);
      }
    }
  }
  return { rows, text: out.join('\n') };
}

/** A line's caption-with-numbers groups; none when the line has no numbers at all. */
function segmentsOf(line: string): Array<{ caption: string; leading: string[]; numbers: string[] }> {
  const tokens = tokenize(line);
  if (!tokens.some((token) => token.figure)) return [];
  const segments: Array<{ caption: string; leading: string[]; numbers: string[] }> = [];
  let current: { caption: string[]; leading: string[]; numbers: string[] } = { caption: [], leading: [], numbers: [] };
  for (const token of tokens) {
    if (token.figure) {
      if (current.caption.length === 0) current.leading.push(token.text);
      else current.numbers.push(token.text);
      continue;
    }
    // Text after this segment's numbers starts the next segment (side-by-side statements).
    if (current.numbers.length > 0) {
      segments.push(finish(current));
      current = { caption: [], leading: [], numbers: [] };
    }
    current.caption.push(token.text);
  }
  segments.push(finish(current));
  // A caption with no numbers of its own (e.g. a wrapped heading beside a number column) is not a row.
  return segments.filter((segment) => segment.numbers.length > 0 || segment.leading.length > 0);
}

function finish(segment: { caption: string[]; leading: string[]; numbers: string[] }) {
  return { caption: segment.caption.join(' ').replace(/\s+/gu, ' ').trim(), leading: segment.leading, numbers: segment.numbers };
}

/**
 * Tokens in reading order. Layout gaps (2+ spaces) separate cells; inside a cell, single-space
 * separated parts that are all figures ("3 1,777,765" -- a note number glued to a value) are split.
 */
function tokenize(line: string): Array<{ text: string; figure: boolean }> {
  const tokens: Array<{ text: string; figure: boolean }> = [];
  for (const cell of line.trim().split(/\s{2,}|\t+/u)) {
    const trimmed = cell.trim();
    if (!trimmed || trimmed === '|') continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.every((part) => isFigure(part))) {
      for (const part of parts) tokens.push({ text: part, figure: true });
      continue;
    }
    // Text cell possibly ending in figures: "Stock-in-trade 9 4,094,840" -> text + figures.
    let end = parts.length;
    while (end > 0 && isFigure(parts[end - 1]!)) end -= 1;
    const text = parts.slice(0, end).join(' ');
    if (text) tokens.push({ text, figure: false });
    for (const part of parts.slice(end)) tokens.push({ text: part, figure: true });
  }
  return tokens;
}

/** A printed figure as a number: "(1,234)" -> -1234, "-" -> 0. */
export function figureValue(token: string): number {
  if (NIL.test(token)) return 0;
  const negative = token.startsWith('(') || token.startsWith('-');
  const digits = Number(token.replace(/[(),%\s-]/gu, ''));
  return negative ? -digits : digits;
}
