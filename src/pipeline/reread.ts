import { rm } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../extraction.js';
import type { DocumentAnalysis } from './analyse.js';
import { cellKey, type CellRef, type Reading } from './constraint-types.js';
import { parseFigure, type StatementRow, type StatementTable } from './normalize.js';

/**
 * Stage 6b fallback: an independent second reading of suspect cells.
 *
 * When a constraint fails, the repair stage needs a reading of the cells involved that did not come
 * from the table model. Two sources, chosen by the page the row sits on:
 *
 * - Native page: the page's `pdftotext -layout` text, already in memory from stage 1. The row's
 *   line is found by its caption and its place in the table, and the figures on that line are
 *   mapped to the value columns by their horizontal position. No process is started.
 * - Scanned page: the page rendered again at 300 dpi and read by tesseract twice, once for layout
 *   (`--psm 6`) and once restricted to digits and figure punctuation. The row's line is found by
 *   caption in the layout pass; figures come from both. Each page is rendered and read once, however
 *   many of its cells are asked for, and at most `maxOcrPages` pages are read per filing.
 *
 * A reading is only produced when the line and the column are unambiguous and the text parses as a
 * figure: a wrong second reading is worse than none, since the repair engine would take it as
 * evidence. Nothing here throws on a missing tool or a failed command; the cell simply gets no
 * reading.
 */
export interface RereadOptions {
  /** Scanned pages read by OCR per call (per filing); further pages get no reading. Default 6. */
  maxOcrPages?: number;
}

/** Default bound on scanned pages re-read per filing: two passes of tesseract at 300 dpi cost seconds each. */
export const MAX_OCR_PAGES = 6;
const OCR_DPI = 300;
const OCR_TIMEOUT_MS = 90_000;

export async function rereadCells(
  pdf: string,
  analysis: DocumentAnalysis,
  tables: StatementTable[],
  cells: CellRef[],
  workDir: string,
  options: RereadOptions = {},
): Promise<Map<string, Reading[]>> {
  const readings = new Map<string, Reading[]>();
  const add = (cell: CellRef, reading: Reading) => {
    const key = cellKey(cell);
    const list = readings.get(key) ?? [];
    if (!list.some((item) => item.source === reading.source)) list.push(reading);
    readings.set(key, list);
  };

  // Which (table, page) pairs are needed, and for each whether it is read from the text layer or by OCR.
  const wanted: Array<{ cell: CellRef; row: StatementRow; source: 'native' | 'ocr' }> = [];
  for (const cell of cells) {
    const row = tables[cell.table]?.rows.find((item) => item.id === cell.row);
    if (!row || cell.column < 0 || cell.column >= row.cells.length) continue;
    const page = analysis.pages[row.page - 1];
    if (!page || page.kind === 'blank') continue;
    // The page kind decides, not the table model's method: a native page's text layer is exact even
    // when the table model OCRed it.
    const native = page.kind === 'native' && page.textSource === 'pdftotext';
    wanted.push({ cell, row, source: native ? 'native' : 'ocr' });
  }

  // Native: one pass over the page text per (table, page).
  const nativeCache = new Map<string, Map<string, Array<string | null>>>();
  for (const { cell, row } of wanted.filter((item) => item.source === 'native')) {
    const key = `${cell.table}:${row.page}`;
    let lines = nativeCache.get(key);
    if (!lines) {
      const table = tables[cell.table]!;
      lines = readRowsFromText(analysis.pages[row.page - 1]!.text, rowsOn(table, row.page), 'layout');
      nativeCache.set(key, lines);
    }
    const text = lines.get(row.id)?.[cell.column];
    const value = text === null || text === undefined ? null : parseFigure(text);
    if (text && value !== null) add(cell, { value, source: 'pdftotext', text });
  }

  // Scanned: the pages with the most suspect cells first, up to the bound.
  const ocrWanted = wanted.filter((item) => item.source === 'ocr');
  const perPage = new Map<number, number>();
  for (const { row } of ocrWanted) perPage.set(row.page, (perPage.get(row.page) ?? 0) + 1);
  const limit = Math.max(0, options.maxOcrPages ?? MAX_OCR_PAGES);
  const pages = [...perPage.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([page]) => page);
  const ocrTexts = new Map<number, OcrText | null>();
  let toolsMissing = false;
  for (const page of pages.sort((a, b) => a - b)) {
    if (toolsMissing) break;
    const result = await ocrPage(pdf, page, workDir);
    if (result === 'missing') toolsMissing = true;
    else ocrTexts.set(page, result);
  }
  const ocrCache = new Map<string, Map<string, OcrRowReading>>();
  for (const { cell, row } of ocrWanted) {
    const text = ocrTexts.get(row.page);
    if (!text) continue;
    const key = `${cell.table}:${row.page}`;
    let lines = ocrCache.get(key);
    if (!lines) {
      lines = readRowsFromOcr(text.layout, text.digits, rowsOn(tables[cell.table]!, row.page));
      ocrCache.set(key, lines);
    }
    const found = lines.get(row.id);
    for (const [source, texts] of [['ocr-300', found?.layout], ['ocr-digits', found?.digits]] as const) {
      const raw = texts?.[cell.column];
      const value = raw ? parseFigure(raw) : null;
      if (raw && value !== null) add(cell, { value, source, text: raw });
    }
  }
  return readings;
}

function rowsOn(table: StatementTable, page: number): StatementRow[] {
  return table.rows.filter((row) => row.page === page);
}

interface OcrText {
  layout: string;
  digits: string;
}

/**
 * One scanned page at 300 dpi, read twice. 'missing' when pdftoppm or tesseract is not installed
 * (no later page can be read either); null when this page failed (timeout, bad render).
 */
async function ocrPage(pdf: string, page: number, workDir: string): Promise<OcrText | null | 'missing'> {
  const prefix = path.join(workDir, `reread-p${page}`);
  const image = `${prefix}.png`;
  const env = { OMP_THREAD_LIMIT: '1' };
  try {
    await runCommand('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(OCR_DPI), '-gray', '-singlefile', '-png', pdf, prefix]);
    // Sequential, not parallel: one thread per tesseract process, as in stage 1, and the filing's
    // other work may be running beside this.
    const layout = await runCommand('tesseract', [image, 'stdout', '-l', 'eng', '--psm', '6'], OCR_TIMEOUT_MS, env);
    const digits = await runCommand('tesseract', [image, 'stdout', '-l', 'eng', '-c', 'tessedit_char_whitelist=0123456789,.()-', '--psm', '6'], OCR_TIMEOUT_MS, env);
    return { layout: layout.stdout, digits: digits.stdout };
  } catch (error) {
    // runCommand reports a missing executable (ENOENT) as "<command> is not installed".
    return /is not installed/u.test(error instanceof Error ? error.message : String(error)) ? 'missing' : null;
  } finally {
    await rm(image, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Finding a row's line

/** A whitespace-delimited piece of a line, with its character span (end exclusive). */
export interface Token {
  text: string;
  start: number;
  end: number;
}

/**
 * A place on a page where a row's figures could be printed: a run of figures on one line, with the
 * caption printed just before it on that line (empty for a figure-only line) and the character span
 * the pair occupies, which bounds where continuation lines of the caption are looked for.
 */
interface Segment {
  line: number;
  /**
   * The caption before the figures, in parts cut at wide gaps: on a side-by-side page the other
   * half's text (an equity statement's column headings) can sit in the same run of text, so the
   * caption is taken as the last part, or the last two, whichever matches the row best.
   */
  captions: string[][];
  figures: Token[];
  from: number;
  to: number;
  /**
   * Figures printed at the start of the line, before this segment's caption: a layout with value
   * columns on both sides of the caption (a bank's US dollar columns left of the rupee ones).
   */
  leading: boolean;
}

type Mode = 'layout' | 'ocr';

/**
 * Figures of the given rows found in page text, as printed, per value column (null where the
 * column's figure could not be placed). Rows whose line is not found, or found ambiguously, or
 * whose figures do not map cleanly onto the columns, are absent.
 *
 * `layout` is `pdftotext -layout` text, where columns keep their character positions; `ocr` is
 * tesseract text, where a line is words separated by single spaces and only the count of figures
 * can place them.
 *
 * Line matching:
 * 1. Every line is cut into segments, a caption followed by a run of figures. In layout mode a line
 *    is first cut at gaps of two spaces or more, so a dash inside a caption ("Reserves - capital")
 *    stays in the caption, and a balance sheet printed in two halves side by side yields a segment
 *    per half.
 * 2. Each row is scored against each segment by caption words (lower case, letters only, small
 *    connecting words dropped; words match exactly, by a prefix of four letters or more, or within
 *    one edit). Coverage counts the row's words found in the segment's caption plus up to two
 *    caption lines just above it with no figures (a wrapped caption; for a figure-only line, across
 *    one blank line); the caption line just below counts only when the caption is incomplete
 *    without it, at a discount, since it is usually the next row's. Precision counts the segment's
 *    own caption words found in the row's label, so "Total equity" does not take "Total equity and
 *    liabilities". A captioned line needs coverage and precision of 60%, a figure-only line 80%
 *    coverage from the lines around it.
 * 3. Rows are assigned to lines in order (the Nth row below the (N-1)th) by dynamic programming
 *    over the scores, separately for each piece of the table on the page (see `pieces`). A row is
 *    dropped when another line between its neighbours' lines scores nearly as well: two "Others"
 *    lines with nothing to tell them apart are not guessed between. An uncaptioned row (a
 *    subtotal) is kept only when the rows on both sides of it were found.
 *
 * Figures are then placed in columns by `placeFigures`. Rows whose id is not unique get nothing
 * (see `duplicateIds`).
 */
export function readRowsFromText(text: string, rows: StatementRow[], mode: Mode = 'layout'): Map<string, Array<string | null>> {
  const out = new Map<string, Array<string | null>>();
  const columnCount = rows[0]?.cells.length ?? 0;
  if (columnCount === 0) return out;
  for (const piece of pieces(rows)) {
    const found = matchRows(text, piece, mode);
    // Figures on both sides of the captions, line after line: the run after a caption may run on
    // into the next table's columns with nothing to show where one ends, so the piece is not read
    // at all. (A few such lines are the other half of a side-by-side page ending in figures.)
    const leading = [...found.values()].filter((segment) => segment.leading).length;
    if (leading >= 2 && leading * 2 >= found.size) continue;
    // Column positions per piece: the two halves of a side-by-side page have their own.
    const anchors = mode === 'layout' ? columnAnchors([...found.values()].map((segment) => segment.figures), columnCount) : null;
    for (const [index, segment] of found) {
      const placed = placeFigures(segment.figures, columnCount, anchors);
      if (placed) out.set(piece[index]!.id, placed);
    }
  }
  for (const id of duplicateIds(rows)) out.delete(id);
  return out;
}

/**
 * A statement's rows on one page, cut where the table model's row number starts again ("p160.r19"
 * then "p160.r3"): two tables on the page, such as the halves of a balance sheet printed side by
 * side, each read top to bottom on the same lines. Each piece is matched to the lines on its own.
 */
export function pieces(rows: StatementRow[]): StatementRow[][] {
  const out: StatementRow[][] = [];
  let previous = -Infinity;
  for (const row of rows) {
    // "p45.r12b" is the second half of a fused row (rule R4b), "p45.r12a".."p45.r12c" the lines a
    // fused row was rebuilt into (rule R4c): all still row 12.
    const number = Number(/\.r(\d+)/u.exec(row.id)?.[1] ?? NaN);
    if (out.length === 0 || number < previous) out.push([]);
    out.at(-1)!.push(row);
    if (!Number.isNaN(number)) previous = number;
  }
  return out;
}

/**
 * Row ids printed twice in one statement. Two tables on one page number their rows from the same
 * start, so a side-by-side balance sheet can carry two "p160.r12"; a cell reference cannot say which
 * is meant, so neither gets a reading.
 */
export function duplicateIds(rows: StatementRow[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const row of rows) (seen.has(row.id) ? twice : seen).add(row.id);
  return twice;
}

function matchRows(text: string, rows: StatementRow[], mode: Mode): Map<number, Segment> {
  const lines = text.split(/\r?\n/u);
  const segments = lines.map((line, index) => segmentsOf(line, index, mode));
  const candidates = lines.map((_, index) => index).filter((index) => segments[index]!.length > 0);
  const labels = rows.map((row) => words(row.label));
  const score = (r: number, line: number): { score: number; segment: Segment | null; tie: boolean } => {
    let best = { score: 0, segment: null as Segment | null, tie: false };
    for (const segment of segments[line]!) {
      const value = scoreSegment(labels[r]!, segment, lines, mode);
      if (value > best.score + 0.05) best = { score: value, segment, tie: false };
      else if (value > 0 && value >= best.score - 0.05) best = { score: Math.max(value, best.score), segment: best.segment, tie: true };
    }
    return best;
  };
  const S = rows.map((_, r) => candidates.map((line) => score(r, line)));

  // dp[r][c]: best total score placing rows[0..r) on candidate lines[0..c).
  const R = rows.length;
  const C = candidates.length;
  const dp = Array.from({ length: R + 1 }, () => new Float64Array(C + 1));
  for (let r = 1; r <= R; r++) {
    for (let c = 1; c <= C; c++) {
      const take = S[r - 1]![c - 1]!.score >= MIN_SCORE ? dp[r - 1]![c - 1]! + S[r - 1]![c - 1]!.score : -Infinity;
      dp[r]![c] = Math.max(dp[r - 1]![c]!, dp[r]![c - 1]!, take);
    }
  }
  const assigned = new Array<number>(R).fill(-1);
  for (let r = R, c = C; r > 0 && c > 0; ) {
    if (dp[r]![c] === dp[r - 1]![c]) r--;
    else if (dp[r]![c] === dp[r]![c - 1]) c--;
    else {
      assigned[r - 1] = c - 1;
      r--;
      c--;
    }
  }

  const out = new Map<number, Segment>();
  for (let r = 0; r < R; r++) {
    const c = assigned[r]!;
    if (c < 0) continue;
    const { score: best, segment, tie } = S[r]![c]!;
    if (!segment || tie) continue;
    // An uncaptioned row (a subtotal) is placed only by its neighbours: both must be found.
    if (labels[r]!.length === 0 && ((r > 0 && assigned[r - 1]! < 0) || (r + 1 < R && assigned[r + 1]! < 0))) continue;
    // The window the row could sit in: between its matched neighbours.
    const before = assigned.slice(0, r).filter((value) => value >= 0).at(-1) ?? -1;
    const after = assigned.slice(r + 1).find((value) => value >= 0) ?? C;
    let rival = false;
    for (let other = before + 1; other < after && !rival; other++) {
      if (other !== c && S[r]![other]!.score >= best - AMBIGUITY) rival = true;
    }
    if (!rival) out.set(r, segment);
  }
  return out;
}

/** A row and a line must score at least this to be paired. */
const MIN_SCORE = 0.5;
/** Another line within this score of the best one makes the pairing ambiguous. */
const AMBIGUITY = 0.1;
const STOPWORDS = new Set(['and', 'of', 'the', 'in', 'for', 'to', 'from', 'on', 'at', 'by', 'a', 'an', 'as', 'or']);

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z]+/gu, ' ')
    .split(' ')
    .filter((word) => word && !STOPWORDS.has(word));
}

function scoreSegment(label: string[], segment: Segment, lines: string[], mode: Mode): number {
  const parts = segment.captions;
  if (parts.length === 0) return scoreCaption(label, [], segment, lines, mode);
  let best = 0;
  for (let k = 1; k <= parts.length; k++) best = Math.max(best, scoreCaption(label, parts.slice(-k).flat(), segment, lines, mode));
  return best;
}

function scoreCaption(label: string[], own: string[], segment: Segment, lines: string[], mode: Mode): number {
  if (label.length === 0) return own.length === 0 ? 0.6 : 0;
  const above = captionAbove(segment, lines, mode);
  const below = captionBelow(segment, lines, mode);
  // Captions are printed above or beside their figures far more often than below them, and a
  // caption line below a figure-only line is usually the next row's; so the line below counts only
  // when the caption is not complete without it, and at a discount.
  const plain = scoreContext([...above, ...own]);
  if (plain > 0 || below.length === 0) return plain;
  return 0.9 * scoreContext([...above, ...own, ...below]);

  function scoreContext(context: string[]): number {
    const coverage = matched(label, context, mode) / label.length;
    if (own.length === 0) return coverage >= 0.8 ? 0.5 + 0.3 * coverage : 0;
    const precision = matched(own, label, mode) / own.length;
    if (coverage < 0.6 || precision < 0.6) return 0;
    const ownCoverage = matched(label, own, mode) / label.length;
    return coverage * precision * (0.8 + 0.2 * ownCoverage);
  }
}

/** How many of `needles` find a distinct match in `haystack`. */
function matched(needles: string[], haystack: string[], mode: Mode): number {
  const used = new Array<boolean>(haystack.length).fill(false);
  let count = 0;
  for (const word of needles) {
    const index = haystack.findIndex((other, i) => !used[i] && sameWord(word, other, mode));
    if (index >= 0) {
      used[index] = true;
      count++;
    }
  }
  return count;
}

export function sameWord(a: string, b: string, mode: Mode): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (shorter >= 5 && editDistance(a, b) <= (mode === 'ocr' && shorter >= 8 ? 2 : 1)) return true;
  return false;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Caption words on up to two lines directly above the segment, within its span and without
 * figures. One blank line between the caption and a figure-only line is allowed ("NET FOREIGN
 * EXCHANGE DIFFERENCES", an empty line, then the figures): some filings print totals that way.
 */
function captionAbove(segment: Segment, lines: string[], mode: Mode): string[] {
  const out: string[] = [];
  let skipped = false;
  for (let line = segment.line - 1, taken = 0; line >= 0 && taken < 2; line--) {
    const raw = lines[line]!;
    if (!raw.trim() && out.length === 0 && !skipped && segment.captions.length === 0) {
      skipped = true;
      continue;
    }
    const text = captionLine(raw, segment, mode);
    if (text === null) break;
    out.unshift(...text);
    taken++;
  }
  return out;
}

function captionBelow(segment: Segment, lines: string[], mode: Mode): string[] {
  const next = lines[segment.line + 1];
  return next === undefined ? [] : captionLine(next, segment, mode) ?? [];
}

/** The caption words of a neighbouring line within the segment's span; null for a blank line or one with figures there. */
function captionLine(line: string, segment: Segment, mode: Mode): string[] | null {
  const pieces = mode === 'layout' ? chunks(line) : [tokens(line)];
  const inside = pieces.filter((piece) => piece.length > 0 && piece[0]!.start >= segment.from - 8 && piece[0]!.start < segment.to);
  if (inside.length === 0) return null;
  if (inside.some((piece) => isFigureChunk(piece))) return null;
  const found = inside.flatMap((piece) => words(piece.map((token) => token.text).join(' ')));
  return found.length > 0 ? found : null;
}

export function tokens(line: string): Token[] {
  return [...line.matchAll(/\S+/gu)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

/** A line cut at gaps of two or more spaces: pdftotext keeps a caption's words one space apart and puts columns further apart. */
function chunks(line: string): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const token of joinBrackets(tokens(line))) {
    const last = current.at(-1);
    if (last && token.start - last.end >= 2) {
      out.push(current);
      current = [];
    }
    current.push(token);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** "( 1,234 )" printed with spaces inside the brackets is one figure. */
export function joinBrackets(list: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of list) {
    const last = out.at(-1);
    if (last && (last.text === '(' || (token.text === ')' && /\d$/u.test(last.text))) && token.start - last.end <= 2) {
      out[out.length - 1] = { text: `${last.text}${token.text}`, start: last.start, end: token.end };
    } else out.push(token);
  }
  return out;
}

function isFigure(text: string): boolean {
  return parseFigure(text) !== null;
}

function isFigureChunk(chunk: Token[]): boolean {
  return chunk.every((token) => isFigure(token.text));
}

/**
 * A line's segments. Layout mode: the line's chunks grouped into runs of caption and runs of
 * figures; each run of figures, with the caption run before it, is a segment. A run of figures at
 * the start of a line followed by a caption is a numbering or a dash, not a row's figures. OCR mode:
 * one segment, the figures at the end of the line and everything before them as caption.
 */
function segmentsOf(line: string, index: number, mode: Mode): Segment[] {
  if (mode === 'ocr') {
    const list = joinBrackets(tokens(line)).filter((token) => !/^[|!\[\]{}]+$/u.test(token.text));
    let first = list.length;
    while (first > 0 && isFigure(list[first - 1]!.text)) first--;
    if (first === list.length) return [];
    const figures = list.slice(first);
    const caption = words(list.slice(0, first).map((token) => token.text).join(' '));
    return [{ line: index, captions: caption.length > 0 ? [caption] : [], figures, from: 0, to: Infinity, leading: false }];
  }
  const pieces = chunks(line);
  const runs: Array<{ figure: boolean; tokens: Token[]; chunks: Token[][] }> = [];
  for (const piece of pieces) {
    const figure = isFigureChunk(piece);
    const last = runs.at(-1);
    if (last && last.figure === figure) {
      last.tokens.push(...piece);
      last.chunks.push(piece);
    } else runs.push({ figure, tokens: [...piece], chunks: [piece] });
  }
  const out: Segment[] = [];
  let boundary = 0;
  for (const [i, run] of runs.entries()) {
    if (!run.figure) continue;
    const caption = i > 0 ? runs[i - 1]! : null;
    if (!caption && i + 1 < runs.length) continue;
    const parts: Token[][] = [];
    for (const chunk of caption?.chunks ?? []) {
      const last = parts.at(-1);
      if (last && chunk[0]!.start - last.at(-1)!.end < WIDE_GAP) last.push(...chunk);
      else parts.push([...chunk]);
    }
    const captions = parts.map((part) => words(part.map((token) => token.text).join(' '))).filter((list) => list.length > 0);
    const from = parts.length > 0 ? parts.at(-1)![0]!.start : boundary;
    const to = run.tokens.at(-1)!.end;
    const leading = i === 2 && runs[0]!.figure && runs[0]!.tokens.some((token) => /\d,\d{3}/u.test(token.text));
    out.push({ line: index, captions, figures: run.tokens, from, to, leading });
    boundary = to;
  }
  return out;
}

/** A gap in a caption this wide (characters) separates two captions, not two words of one. */
const WIDE_GAP = 5;

// ---------------------------------------------------------------------------------------------
// Placing a line's figures in the value columns

/** A note reference printed in the note column: "5", "12.1", "3.1.4". Never a value with a thousands separator. */
const NOTE_LIKE = /^\d{1,2}(?:\.\d{1,2}){0,2}$/u;

/**
 * Character position (right edge) of each value column, from the matched lines that print exactly
 * one figure per column (after a note reference, if any). pdftotext right-aligns figures as they
 * are printed, so a column's right edges agree to a character or two. Null when fewer than two
 * lines say so, or the columns would not be in order.
 */
function columnAnchors(runs: Token[][], columnCount: number): number[] | null {
  const edges: number[][] = Array.from({ length: columnCount }, () => []);
  let lines = 0;
  for (const run of runs) {
    const values = withoutNote(run, columnCount);
    if (!values || values.length !== columnCount || values.some((token) => isDash(token.text))) continue;
    values.forEach((token, index) => edges[index]!.push(token.end));
    lines++;
  }
  if (lines < 2) return null;
  const anchors = edges.map((list) => median(list));
  for (let i = 1; i < anchors.length; i++) if (anchors[i]! - anchors[i - 1]! < 3) return null;
  return anchors;
}

/** The value figures of a run: all of it, or all but a leading note reference when that leaves one per column. */
function withoutNote(run: Token[], columnCount: number): Token[] | null {
  if (run.length === columnCount) return run;
  if (run.length === columnCount + 1 && NOTE_LIKE.test(run[0]!.text)) return run.slice(1);
  // "7 & 8": a note reference citing two notes.
  const lead = run.slice(0, run.length - columnCount);
  if (lead.length === 3 && lead[1]!.text === '&' && NOTE_LIKE.test(lead[0]!.text) && NOTE_LIKE.test(lead[2]!.text)) return run.slice(-columnCount);
  return null;
}

function isDash(text: string): boolean {
  return /^[-–—]+$/u.test(text);
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * A line's figures per value column. With column positions: each figure goes to the column whose
 * right edge is nearest its own (a dash, printed centred, by its centre), within under half the
 * narrowest gap between columns; a figure left of every column must be a note reference. When a
 * figure fits no column (a subtotal printed in an outer column, offset from the rest) the line is
 * read by count if it prints exactly one figure per column after its note, else not at all.
 * Without positions (OCR, or too few full lines): by count only.
 */
function placeFigures(run: Token[], columnCount: number, anchors: number[] | null): Array<string | null> | null {
  if (!anchors) return byCount(run, columnCount);
  const gaps = anchors.slice(1).map((anchor, i) => anchor - anchors[i]!);
  const narrowest = Math.min(...(gaps.length > 0 ? gaps : [12]));
  const tolerance = Math.max(2, narrowest * 0.45);
  const placed = new Array<string | null>(columnCount).fill(null);
  for (const token of run) {
    const at = isDash(token.text) ? (token.start + token.end) / 2 : token.end;
    let best = -1;
    let distance = Infinity;
    anchors.forEach((anchor, index) => {
      const d = Math.abs(anchor - at);
      if (d < distance) [best, distance] = [index, d];
    });
    const slack = isDash(token.text) ? tolerance + 3 : tolerance;
    if (distance <= slack && placed[best] === null) {
      placed[best] = token.text;
      continue;
    }
    if (at < anchors[0]! - tolerance && (NOTE_LIKE.test(token.text) || token.text === '&') && placed.every((value) => value === null)) continue;
    // Figures well right of the last column (further than an outer subtotal column would sit)
    // belong to the next table on a side-by-side page, its figure-only line running on after this
    // one: no reading by count either.
    return run.some((item) => item.end > anchors.at(-1)! + 3 * narrowest) ? null : byCount(run, columnCount);
  }
  return placed.some((value) => value !== null) ? placed : null;
}

/**
 * One figure per column after a note reference, in order. When the count matches only because the
 * first figure may be a note with a value missing ("Contingencies  10", "Trade debts  12  1,234"),
 * the two cannot be told apart without positions, so nothing is read.
 */
function byCount(run: Token[], columnCount: number): Array<string | null> | null {
  const values = withoutNote(run, columnCount);
  if (!values) return null;
  const first = values[0]!.text;
  if (values === run && NOTE_LIKE.test(first) && (columnCount === 1 || run.some((token) => /\d,\d{3}/u.test(token.text)))) return null;
  return values.map((token) => token.text);
}

// ---------------------------------------------------------------------------------------------
// Scanned pages

export interface OcrRowReading {
  /** Figures per value column from the layout pass. */
  layout: Array<string | null> | null;
  /** Figures per value column from the digits-only pass. */
  digits: Array<string | null> | null;
}

/**
 * Rows read from the two tesseract passes of one scanned page.
 *
 * Layout pass: the row's line is found by caption and order (as `readRowsFromText` in OCR mode) and
 * its figures placed by count, one per column after the note.
 *
 * Digits pass: it has no captions (letters come out as stray digits and punctuation), so the row's
 * line is found through the layout pass. The layout line's numeric tail (its last tokens that hold
 * a digit or are a dash, including figures the layout pass misread, such as "118,882,5I1") says how
 * many figures to expect; the digits line is the one at the same place among the page's non-blank
 * lines, give or take three, whose last as many tokens are figures resembling the tail token by
 * token (each at least half alike in digits) and most alike overall, by a clear margin over the
 * next such line. Its tokens are then placed like the layout pass's. The digits pass matters most where the layout pass read a
 * digit as a letter; it never borrows a token from the layout pass.
 */
export function readRowsFromOcr(layout: string, digits: string, rows: StatementRow[]): Map<string, OcrRowReading> {
  const out = new Map<string, OcrRowReading>();
  const columnCount = rows[0]?.cells.length ?? 0;
  if (columnCount === 0) return out;
  const layoutLines = layout.split(/\r?\n/u);
  const found = new Map<StatementRow, Segment>();
  for (const piece of pieces(rows)) for (const [index, segment] of matchRows(layout, piece, 'ocr')) found.set(piece[index]!, segment);
  const nonBlank = layoutLines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim());
  const position = new Map(nonBlank.map(({ index }, rank) => [index, rank]));
  const digitLines = digits.split(/\r?\n/u).filter((line) => line.trim());
  const scale = nonBlank.length > 0 ? digitLines.length / nonBlank.length : 1;
  for (const [row, segment] of found) {
    const reading: OcrRowReading = { layout: byCount(segment.figures, columnCount), digits: null };
    const rank = position.get(segment.line);
    const tail = numericTail(layoutLines[segment.line]!);
    if (rank !== undefined && tail.length >= columnCount) {
      const centre = Math.round(rank * scale);
      const candidates: Array<{ tokens: Token[]; similarity: number }> = [];
      for (let j = Math.max(0, centre - 3); j <= Math.min(digitLines.length - 1, centre + 3); j++) {
        const list = joinBrackets(tokens(digitLines[j]!));
        if (list.length < tail.length) continue;
        const last = list.slice(list.length - tail.length);
        const alike = last.map((token, i) => (isFigure(token.text) ? likeness(digitSkeleton(token.text), digitSkeleton(tail[i]!.text)) : 0));
        if (alike.every((value) => value >= 0.5)) candidates.push({ tokens: last, similarity: alike.reduce((a, b) => a + b, 0) / alike.length });
      }
      candidates.sort((a, b) => b.similarity - a.similarity);
      const [best, second] = candidates;
      if (best && (!second || second.similarity <= best.similarity - 0.1)) reading.digits = byCount(best.tokens, columnCount);
    }
    if (reading.layout || reading.digits) out.set(row.id, reading);
  }
  for (const id of duplicateIds(rows)) out.delete(id);
  return out;
}

/** The last tokens of an OCR line that hold a digit or are a dash: its figures, read well or not. */
function numericTail(line: string): Token[] {
  const list = joinBrackets(tokens(line)).filter((token) => !/^[|!\[\]{}]+$/u.test(token.text));
  let first = list.length;
  while (first > 0 && (/\d/u.test(list[first - 1]!.text) || isDash(list[first - 1]!.text))) first--;
  return list.slice(first);
}

/** A figure's digits, brackets and minus; any dash counts as one "-". */
function digitSkeleton(text: string): string {
  return text.replace(/[–—]/gu, '-').replace(/[^\d()-]/gu, '');
}

/** Longest common subsequence over the longer length: 1 for equal strings. */
function likeness(a: string, b: string): number {
  if (!a && !b) return 1;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]!;
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j]!, previous[j - 1]!);
      diagonal = above;
    }
  }
  return previous[b.length]! / Math.max(a.length, b.length);
}
