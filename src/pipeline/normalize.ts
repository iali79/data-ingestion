import type { ConsolidationBasis, StatementType } from '../parser.js';
import type { Statement } from '../financials/definitions.js';
import { monthsSince, unitFromText } from '../financials/conventions.js';
import type { SelectedStatement } from './classify.js';
import type { PageTable, PageTables } from './tables.js';

/**
 * Stage 5a -- a statement's table(s) as rows and dated value columns.
 *
 * From Docling's cell grid: the label column, the note column (dropped, rule V4), and the value
 * columns, each described by its printed header ("Nine months ended September 30, 2023") and, where
 * the header leaves something open, by the statement title ("For the year ended December 31,
 * 2023") -- rules C1-C7. Each body row keeps its label, its figures per column, the heading it sits
 * under, and whether its figures were read from a text layer or by OCR.
 */
export interface StatementColumn {
  /** Index into each row's `values`. */
  index: number;
  header: string;
  periodEnd: string | null;
  months: number | null;
  kept: boolean;
  reason?: string;
}

export interface StatementRow {
  /** Stable id within the statement, e.g. "p45.r12". */
  id: string;
  page: number;
  label: string;
  /** Raw printed text per value column ('' when the cell is empty). */
  cells: string[];
  /** Parsed figure per value column; null when the cell is empty or not a readable figure. */
  values: Array<number | null>;
  /** The printed note reference, if any. */
  note: string | null;
  /** Headings printed between the previous row and this one, in order ("ASSETS", "CURRENT ASSETS"). */
  headings: string[];
  ocr: boolean;
}

export interface StatementTable {
  statementType: StatementType;
  basis: ConsolidationBasis;
  pages: number[];
  method: 'docling-pdf' | 'docling-ocr' | 'mixed';
  title: string;
  unitScale: number;
  columns: StatementColumn[];
  rows: StatementRow[];
  problems: string[];
}

const KIND: Record<StatementType, Statement> = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(\d{1,2})\b|\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu;
const PERIOD_PHRASE = /\b(three|3)[-\s]months?\b|\bquarter\b|\b(six|6)[-\s]months?\b|\bhalf[-\s]?year|\b(nine|9)[-\s]months?\b|\b(twelve|12)[-\s]months?\b|\byear\s+ended\b/iu;
const NOTE_REF = /^\d{1,2}(?:\.\d{1,2}){0,2}(?:\s*[&,]\s*\d{1,2}(?:\.\d{1,2}){0,2})*$/u;
const FIGURE = /^\(?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?$|^\(?-?\d+(?:\.\d+)?\)?$/u;
const DASH = /^[-–—]+$/u;
const PERIOD_WINDOW_DAYS = 540;

/**
 * Builds one statement from the tables on its pages. On a page shared with another statement
 * (side by side), only the tables under this statement's title are used.
 */
export function buildStatementTable(
  statement: SelectedStatement,
  pages: PageTables[],
  filing: { periodEnded: string; yearEndMonthDay?: string | null },
): StatementTable {
  const kind = KIND[statement.statementType];
  const problems: string[] = [];
  const pieces: Array<{ page: PageTables; table: PageTable }> = [];
  for (const pageNumber of statement.pages) {
    const page = pages.find((item) => item.pageNumber === pageNumber);
    if (!page) continue;
    pieces.push(...tablesFor(statement, page).map((table) => ({ page, table })));
  }
  const pageTexts = statement.pages.flatMap((pageNumber) => pages.find((item) => item.pageNumber === pageNumber)?.texts ?? []);
  const title = pageTexts
    .filter((text) => text.label === 'section_header' || text.label === 'title' || text.label === 'text' || text.label === 'page_header')
    .slice(0, 6)
    .map((text) => text.text)
    .join(' ');
  const methods = new Set(pieces.map((piece) => piece.page.method));
  const base: StatementTable = {
    statementType: statement.statementType,
    basis: statement.basis,
    pages: statement.pages,
    method: methods.size > 1 ? 'mixed' : ([...methods][0] ?? 'docling-pdf'),
    title,
    unitScale: 1,
    columns: [],
    rows: [],
    problems,
  };
  if (pieces.length === 0) {
    problems.push('no table found on the statement pages');
    return base;
  }

  // Each piece: a grid; its value columns; its rows. Pieces must agree on the number of value
  // columns to be one statement (a balance sheet split over two pages, or into two tables).
  const grids = pieces.map(({ page, table }) => ({ page, grid: toGrid(table) }));
  const layouts = grids.map(({ grid }) => columnLayout(grid));
  const valueCount = layouts[0]!.values.length;
  if (valueCount === 0) {
    problems.push('the table has no value columns');
    return base;
  }
  const headerTexts = Array.from({ length: valueCount }, () => '');
  const rows: StatementRow[] = [];
  let pending: string[] = [];
  for (const [index, { page, grid }] of grids.entries()) {
    const layout = layouts[index]!;
    if (layout.values.length !== valueCount) {
      problems.push(`table on p.${page.pageNumber} has ${layout.values.length} value columns, expected ${valueCount}; skipped`);
      continue;
    }
    for (const [position, col] of layout.values.entries()) {
      const text = grid.header(col);
      if (text && !headerTexts[position]!.includes(text)) headerTexts[position] = `${headerTexts[position]} ${text}`.trim();
    }
    // The label column's header cell is often the first heading ("ASSETS", "CASH FLOWS FROM
    // OPERATING ACTIVITIES").
    const labelHeader = grid.header(layout.label);
    if (labelHeader && !/^note$/iu.test(labelHeader)) pending.push(labelHeader);
    for (let r = grid.bodyStart; r < grid.rows; r++) {
      const label = clean(grid.cell(r, layout.label));
      const cells = layout.values.map((col) => clean(grid.cell(r, col)));
      const note = layout.note === null ? null : clean(grid.cell(r, layout.note)) || null;
      const values = cells.map(parseFigure);
      if (values.every((value) => value === null) && cells.every((cell) => cell === '')) {
        if (label) pending.push(label);
        continue;
      }
      rows.push({
        id: `p${page.pageNumber}.r${r}`,
        page: page.pageNumber,
        label,
        cells,
        values,
        note: note && NOTE_REF.test(note.replace(/\s+/gu, ' ')) ? note : null,
        headings: pending,
        ocr: page.method === 'docling-ocr',
      });
      pending = [];
    }
  }

  mergeSplitRows(rows);
  // The unit ("Rupees in '000") is printed in the header, the title block, or a body cell of the
  // first row, depending on how the table was drawn.
  const cellTexts = grids.flatMap(({ grid }) => Array.from({ length: Math.min(grid.rows, 4) }, (_, r) => Array.from({ length: grid.cols }, (_, c) => grid.cell(r, c))).flat());
  const unitScale = unitFromText([...headerTexts, title, ...pageTexts.map((text) => text.text), ...cellTexts].join('\n')) ?? 1;
  const columns = describeColumns(headerTexts, title, kind, filing);
  return { ...base, unitScale, columns, rows };
}

/**
 * Rule R4 for table grids: one printed line that the table model split into two rows, each with
 * part of the label and part of the figures ("NET" + "FOREIGN EXCHANGE DIFFERENCES"). Merged only
 * when the two rows' figure cells do not overlap and together fill every column, and the first
 * label is a fragment (at most two words, or ending in a connecting word). The merged row still
 * has to pass the arithmetic checks.
 */
function mergeSplitRows(rows: StatementRow[]): void {
  for (let i = 0; i + 1 < rows.length; i++) {
    const [first, second] = [rows[i]!, rows[i + 1]!];
    if (first.page !== second.page || second.headings.length > 0 || !first.label || !second.label) continue;
    const words = first.label.split(/\s+/u);
    const fragment = words.length <= 2 || /\b(?:of|the|and|in|at|for|from|to|on|by)$/iu.test(first.label);
    const complementary = first.cells.every((cell, index) => (cell === '') !== (second.cells[index] === ''));
    if (!fragment || !complementary) continue;
    first.label = `${first.label} ${second.label}`;
    first.cells = first.cells.map((cell, index) => cell || second.cells[index]!);
    first.values = first.cells.map(parseFigure);
    first.note = first.note ?? second.note;
    rows.splice(i + 1, 1);
  }
}

/** The tables of a page that belong to this statement: all of them, or on a shared page those under its title. */
function tablesFor(statement: SelectedStatement, page: PageTables): PageTable[] {
  const usable = page.tables.filter((table) => table.rows >= 3 && table.cols >= 2);
  if (!statement.columns || usable.length <= 1) return usable;
  // Side by side: the statement's share of the page width, from the layout-text columns.
  const [start, end] = statement.columns;
  const left = start === 0 ? 0 : page.width / 2;
  const right = end >= 10_000 ? page.width : page.width / 2;
  return usable.filter((table) => {
    const centre = (table.bbox[0] + table.bbox[2]) / 2;
    return centre >= left && centre <= right;
  });
}

export interface Grid {
  rows: number;
  cols: number;
  bodyStart: number;
  cell(row: number, col: number): string;
  header(col: number): string;
}

/** A dense view of Docling's cells; header rows are the leading rows made only of column headers. */
export function toGrid(table: PageTable): Grid {
  const matrix: string[][] = Array.from({ length: table.rows }, () => Array.from({ length: table.cols }, () => ''));
  const headerCells: Array<{ col: number; colSpan: number; row: number; text: string }> = [];
  const headerRow = new Array<boolean>(table.rows).fill(true);
  const filled = new Array<boolean>(table.rows).fill(false);
  for (const cell of table.cells) {
    if (cell.row >= table.rows || cell.col >= table.cols) continue;
    matrix[cell.row]![cell.col] = cell.text;
    if (cell.text.trim()) filled[cell.row] = true;
    if (cell.columnHeader) headerCells.push({ col: cell.col, colSpan: cell.colSpan, row: cell.row, text: cell.text });
    else if (cell.text.trim()) headerRow[cell.row] = false;
  }
  let bodyStart = 0;
  while (bodyStart < table.rows && (headerRow[bodyStart] || !filled[bodyStart])) bodyStart++;
  const header = (col: number): string =>
    headerCells
      .filter((cell) => cell.row < bodyStart && cell.col <= col && col < cell.col + Math.max(1, cell.colSpan))
      .sort((a, b) => a.row - b.row)
      .map((cell) => cell.text.trim())
      .filter(Boolean)
      .join(' ');
  return { rows: table.rows, cols: table.cols, bodyStart, cell: (row, col) => matrix[row]?.[col] ?? '', header };
}

/** Which grid column holds labels, which the note references, which values. */
export function columnLayout(grid: Grid): { label: number; note: number | null; values: number[] } {
  const stats = Array.from({ length: grid.cols }, (_, col) => {
    let figures = 0;
    let notes = 0;
    let text = 0;
    for (let r = grid.bodyStart; r < grid.rows; r++) {
      const cell = clean(grid.cell(r, col));
      if (!cell) continue;
      if (NOTE_REF.test(cell) && !cell.includes(',')) notes++;
      else if (parseFigure(cell) !== null) figures++;
      else text++;
    }
    return { col, figures, notes, text, header: grid.header(col) };
  });
  const label = stats.reduce((best, item) => (item.text > best.text ? item : best), stats[0]!).col;
  const note =
    stats.find((item) => item.col !== label && (/^note\b/iu.test(item.header) || (item.notes > 0 && item.figures <= item.notes / 3)))?.col ?? null;
  const values = stats.filter((item) => item.col !== label && item.col !== note && item.figures > 0 && item.figures >= item.text).map((item) => item.col);
  return { label, note, values };
}

/**
 * Period of each value column (rules C1-C7): the year printed in its header; the month and day from
 * its header, else the title; the length from its header's phrase ("Nine months ended",
 * "Quarter ended"), else the title's ("For the year ended"), else the months since the financial
 * year-end (C7). Columns that cannot be dated, or that duplicate another, are not kept.
 */
export function describeColumns(
  headers: string[],
  title: string,
  kind: Statement,
  filing: { periodEnded: string; yearEndMonthDay?: string | null },
): StatementColumn[] {
  const titleDate = monthDay(title);
  const titlePhrase = PERIOD_PHRASE.exec(title);
  const titleMonths = titlePhrase && /year\s+ended/iu.test(titlePhrase[0]) && !/quarter|months|half/iu.test(title) ? 12 : null;
  const columns: StatementColumn[] = headers.map((header, index) => {
    const years = [...header.matchAll(/(?<![\d,.])((?:19|20)\d{2})(?![\d,.])/gu)].map((match) => match[1]!);
    const year = years.at(-1) ?? null;
    const date = monthDay(header) ?? titleDate;
    const phrase = PERIOD_PHRASE.exec(header);
    const months =
      kind === 'balance' ? 0 : phrase ? phraseMonths(phrase[0]) : titleMonths ?? (date && filing.yearEndMonthDay ? monthsSince(filing.yearEndMonthDay, date) : null);
    if (!year || !date) return { index, header, periodEnd: null, months, kept: false, reason: 'column period not printed' };
    const periodEnd = `${year}${date}`;
    const reason = columnProblem(periodEnd, months, kind, filing.periodEnded);
    return { index, header, periodEnd, months, kept: !reason, ...(reason ? { reason } : {}) };
  });
  const seen = new Map<string, number>();
  for (const column of columns) if (column.kept) seen.set(`${column.periodEnd}|${column.months}`, (seen.get(`${column.periodEnd}|${column.months}`) ?? 0) + 1);
  for (const column of columns) {
    if (column.kept && (seen.get(`${column.periodEnd}|${column.months}`) ?? 0) > 1) {
      column.kept = false;
      column.reason = 'two columns describe the same period';
    }
  }
  return columns;
}

function phraseMonths(phrase: string): number {
  const text = phrase.toLowerCase();
  return /three|3|quarter/u.test(text) ? 3 : /six|6|half/u.test(text) ? 6 : /nine|9/u.test(text) ? 9 : 12;
}

function monthDay(text: string): string | null {
  const match = MONTH_DATE.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf((match[1] ?? match[4] ?? '').toLowerCase().slice(0, 3)) + 1;
  const day = Number(match[2] ?? match[3]);
  if (month < 1 || day < 1 || day > 31) return null;
  return `-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function columnProblem(periodEnd: string, months: number | null, kind: Statement, filingPeriod: string): string | null {
  const date = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(date) || new Date(date).toISOString().slice(0, 10) !== periodEnd) return 'not a date';
  if (kind !== 'balance' && (months === null || ![3, 6, 9, 12].includes(months))) return 'no period length';
  const reference = /^\d{4}$/u.test(filingPeriod) ? Date.parse(`${filingPeriod}-06-30T00:00:00Z`) : Date.parse(`${filingPeriod}T00:00:00Z`);
  if (!Number.isNaN(reference) && Math.abs(date - reference) > PERIOD_WINDOW_DAYS * 86_400_000) return 'too far from the filing period';
  return null;
}

/**
 * A printed figure as a number: brackets are negative, a dash is nil (rules V2, V3). OCR residue
 * around a figure (a stray bar, a trailing comma or full stop) is trimmed, and a semicolon between
 * digit groups is read as the comma it was printed as. Anything else unreadable is null -- a
 * figure is never guessed.
 */
export function parseFigure(raw: string): number | null {
  let text = raw.replace(/\s+/gu, '').replace(/^[|\[\]'‘’"“”_=—§]+(?=[\d(])/u, '').replace(/[|\[\]'‘’"“”_]+$/u, '').replace(/[.,:]+$/u, '');
  if (DASH.test(text) || text === '') return text === '' ? null : 0;
  text = text.replace(/(\d);(\d{3})/gu, '$1,$2');
  if (!FIGURE.test(text)) return null;
  const negative = text.startsWith('(') || text.startsWith('-');
  const value = Number(text.replace(/[(),-]/gu, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
