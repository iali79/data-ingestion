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
  /** Rupees per printed unit; null when the statement prints no unit (see `inheritUnits`). */
  unitScale: number;
  unitPrinted: boolean;
  columns: StatementColumn[];
  rows: StatementRow[];
  problems: string[];
}

const KIND: Record<StatementType, Statement> = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DATE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*(\d{1,2})\b|\b(\d{1,2})\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/iu;
/**
 * Header dates written short -- "30-Jun-23", "30 June 25", "30.06.2025" -- as "June 30, 2023", the
 * form the column rules read. A two-digit year is this century's. Only header and title text is
 * rewritten; figures never pass through here.
 */
const SHORT_MONTH_DATE = /\b(\d{1,2})[-\s./](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[-\s./,]*'?((?:19|20)\d{2}|\d{2})(?![\d,])/giu;
const NUMERIC_DATE = /\b(\d{1,2})[./-](\d{1,2})[./-]((?:19|20)\d{2})\b/gu;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function expandShortDates(text: string): string {
  return text
    .replace(SHORT_MONTH_DATE, (whole, day: string, month: string, year: string) => {
      const index = MONTHS.indexOf(month.toLowerCase().slice(0, 3));
      if (index < 0 || Number(day) < 1 || Number(day) > 31) return whole;
      return `${MONTH_NAMES[index]} ${Number(day)}, ${year.length === 2 ? `20${year}` : year}`;
    })
    .replace(NUMERIC_DATE, (whole, day: string, month: string, year: string) => {
      const index = Number(month) - 1;
      if (index < 0 || index > 11 || Number(day) < 1 || Number(day) > 31) return whole;
      return `${MONTH_NAMES[index]} ${Number(day)}, ${year}`;
    });
}

const PERIOD_PHRASE = /\b(three|3)[-\s]months?\b|\bquarter\b|\b(six|6)[-\s]months?\b|\bhalf[-\s]?year|\b(nine|9)[-\s]months?\b|\b(twelve|12)[-\s]months?\b|\byear\s+ended\b/iu;
const NOTE_REF = /^\d{1,2}(?:\.\d{1,2}){0,2}(?:\s*[&,]\s*\d{1,2}(?:\.\d{1,2}){0,2})*$/u;
const FIGURE = /^\(?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?$|^\(?-?\d+(?:\.\d+)?\)?$/u;
const DASH = /^[-–—]+$/u;
const PERIOD_WINDOW_DAYS = 540;
/** Section headings printed in capitals, which a table model can fuse onto the row below them. */
const FUSED_HEADING =
  /^((?:NON[- ]?CURRENT |CURRENT )?(?:ASSETS|LIABILITIES)|EQUITY AND LIABILITIES|SHARE CAPITAL AND RESERVES|CAPITAL AND RESERVES|EQUITY|CASH FLOWS? (?:FROM|USED IN) (?:OPERATING|INVESTING|FINANCING) ACTIVITIES)\s+([A-Z][a-z].*)$/u;

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
  const titleExtra: string[] = [];
  let title = titleAbove(statement, pages, pieces);
  const methods = new Set(pieces.map((piece) => piece.page.method));
  const base: StatementTable = {
    statementType: statement.statementType,
    basis: statement.basis,
    pages: statement.pages,
    method: methods.size > 1 ? 'mixed' : ([...methods][0] ?? 'docling-pdf'),
    title,
    unitScale: 1,
    unitPrinted: false,
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
    for (const [position, text] of grid.valueHeaders(layout.values).entries()) {
      if (text && !headerTexts[position]!.includes(text)) headerTexts[position] = `${headerTexts[position]} ${text}`.trim();
    }
    // The label column's header cell is often the first heading ("ASSETS", "CASH FLOWS FROM
    // OPERATING ACTIVITIES").
    const labelHeader = grid.header(layout.label);
    // A dating line printed inside the table ("For the Year Ended December 31, 2025") belongs to
    // the title, not to the rows.
    const dating = /(?:for\s+the|as\s+(?:at|on))\s.*$/iu.exec(labelHeader)?.[0];
    if (dating && !titleExtra.includes(dating)) titleExtra.push(dating);
    const heading = labelHeader.replace(/(?:for\s+the|as\s+(?:at|on))\s.*$/iu, '').trim();
    if (heading && !/^note$/iu.test(heading)) pending.push(heading);
    for (const text of grid.leading(layout.label)) pending.push(clean(text));
    for (let r = grid.bodyStart; r < grid.rows; r++) {
      let label = clean(grid.cell(r, layout.label));
      const cells = layout.values.map((col) => clean(grid.cell(r, col)));
      const note = layout.note === null ? null : clean(grid.cell(r, layout.note)) || null;
      const values = cells.map(parseFigure);
      // No figure anywhere on the row ("ASSETS   (Un-audited)   (Audited)"): a heading.
      if (values.every((value) => value === null) && cells.every((cell) => !/\d/u.test(cell))) {
        if (label) pending.push(label);
        continue;
      }
      // A heading fused onto the first row under it ("SHARE CAPITAL AND RESERVES Share capital").
      const fused = FUSED_HEADING.exec(label);
      if (fused && fused[2]) {
        pending.push(fused[1]!);
        label = fused[2];
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

  splitFusedRows(rows);
  mergeSplitRows(rows);
  if (titleExtra.length > 0) title = `${title} ${titleExtra.join(' ')}`.trim();
  // The unit ("Rupees in '000") is printed in the header, the title block, or a body cell of the
  // first row, depending on how the table was drawn.
  const cellTexts = grids.flatMap(({ grid }) => Array.from({ length: Math.min(grid.rows, 4) }, (_, r) => Array.from({ length: grid.cols }, (_, c) => grid.cell(r, c))).flat());
  const unitText = [...headerTexts, title, ...pageTexts.map((text) => text.text), ...cellTexts].join('\n');
  // "Rupees (Un-audited) | in '000" -- the unit split across two header cells.
  const unitScale = unitFromText(unitText) ?? (/\brupees\b[^\n]{0,40}?\n?[^\n]{0,20}?['‘’`]\s*000\b/iu.test(unitText) ? 1_000 : null);
  const columns = describeColumns(headerTexts, title, kind, filing);
  return { ...base, title, unitScale: unitScale ?? 1, unitPrinted: unitScale !== null, columns, rows };
}

/**
 * Rule R4b: two printed lines that the table model fused into one row, each cell holding both
 * lines' figures ("Lease rentals paid Net cash used in financing activities" | "(29,656)
 * (2,767,428)"). Split back only when every value cell holds exactly two figures (or dashes) and
 * the second label starts a total ("Net cash ...", "Net increase ...", "Cash and cash equivalents
 * ...", "Total ..."). The two rows still have to pass the arithmetic checks.
 */
function splitFusedRows(rows: StatementRow[]): void {
  const second = /^(.+?)\s+((?:net\s+(?:cash|increase|decrease|\(?(?:increase|decrease)\)?|foreign)|cash\s+and\s+cash\s+equivalents|total)\b.*)$/iu;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const labels = second.exec(row.label);
    if (!labels) continue;
    const parts = row.cells.map((cell) => cell.split(/\s+/u).filter(Boolean));
    if (!parts.every((tokens) => tokens.length === 2 && tokens.every((token) => parseFigure(token) !== null))) continue;
    const [firstCells, secondCells] = [parts.map((tokens) => tokens[0]!), parts.map((tokens) => tokens[1]!)];
    rows.splice(i, 1,
      { ...row, label: labels[1]!, cells: firstCells, values: firstCells.map(parseFigure) },
      { ...row, id: `${row.id}b`, label: labels[2]!, cells: secondCells, values: secondCells.map(parseFigure), note: null, headings: [] },
    );
    i++;
  }
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

/**
 * The statement's title block: the headings and lines printed above its table, in the same
 * horizontal band -- not whatever else shares the page (the end of an auditor's report on the
 * other half of a spread).
 */
function titleAbove(statement: SelectedStatement, pages: PageTables[], pieces: Array<{ page: PageTables; table: PageTable }>): string {
  const first = pieces[0];
  const kinds = new Set(['section_header', 'title', 'text', 'page_header']);
  if (!first) {
    const page = pages.find((item) => item.pageNumber === statement.pages[0]);
    return (page?.texts ?? []).filter((text) => kinds.has(text.label)).slice(0, 6).map((text) => text.text).join(' ');
  }
  const [left, top, right] = first.table.bbox;
  return first.page.texts
    .filter((text) => kinds.has(text.label) && text.bbox[1] < top && text.bbox[2] > left && text.bbox[0] < right)
    .slice(-6)
    .map((text) => text.text)
    .join(' ');
}

/** The tables of a page that belong to this statement: all of them, or on a shared page those under its title. */
function tablesFor(statement: SelectedStatement, page: PageTables): PageTable[] {
  const usable = page.tables.filter((table) => table.rows >= 3 && table.cols >= 2).flatMap(splitSideBySide);
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

/**
 * A balance sheet printed in two halves side by side (EQUITY & LIABILITIES | Note | 2023 | 2022 ||
 * ASSETS | Note | 2023 | 2022) that the table model read as one table: two label columns, each
 * followed by its own figures. Split at the second label column into two tables, the assets half
 * first, as a balance sheet reads top to bottom. Anything else is returned as it is.
 */
export function splitSideBySide(table: PageTable): PageTable[] {
  const texts = new Array<number>(table.cols).fill(0);
  const figures = new Array<number>(table.cols).fill(0);
  for (const cell of table.cells) {
    const text = clean(cell.text);
    if (!text || cell.columnHeader) continue;
    if (parseFigure(text) !== null) figures[cell.col] = (figures[cell.col] ?? 0) + 1;
    else if (!NOTE_REF.test(text) && /[a-z]{3}/iu.test(text)) texts[cell.col] = (texts[cell.col] ?? 0) + 1;
  }
  const labelColumns = texts.map((count, col) => ({ count, col })).filter(({ count }) => count >= Math.max(3, table.rows * 0.25)).map(({ col }) => col);
  if (labelColumns.length !== 2) return [table];
  const [first, split] = labelColumns as [number, number];
  const between = figures.slice(first + 1, split).filter((count) => count >= 3).length;
  const after = figures.slice(split + 1).filter((count) => count >= 3).length;
  if (between === 0 || between !== after) return [table];
  const width = table.bbox[2] - table.bbox[0];
  const at = table.bbox[0] + (width * split) / table.cols;
  const left: PageTable = { bbox: [table.bbox[0], table.bbox[1], at, table.bbox[3]], rows: table.rows, cols: split, cells: table.cells.filter((cell) => cell.col < split).map((cell) => ({ ...cell, colSpan: Math.min(cell.colSpan, split - cell.col) })) };
  const right: PageTable = { bbox: [at, table.bbox[1], table.bbox[2], table.bbox[3]], rows: table.rows, cols: table.cols - split, cells: table.cells.filter((cell) => cell.col >= split).map((cell) => ({ ...cell, col: cell.col - split })) };
  const words = (half: PageTable) => half.cells.map((cell) => cell.text.toLowerCase()).join(' ');
  const assetsFirst = /\bassets\b/u.test(words(right)) && !/\bliabilit/u.test(words(right)) && /\bliabilit|\bequity\b/u.test(words(left));
  return assetsFirst ? [right, left] : [left, right];
}

export interface Grid {
  rows: number;
  cols: number;
  bodyStart: number;
  cell(row: number, col: number): string;
  header(col: number): string;
  /**
   * Header text per value column. A header cell spanning several value columns that prints one
   * year per column ("2024 2024 --- Rupees in '000 ---") gives its years, in order, to the columns
   * under it that print no year of their own.
   */
  valueHeaders(cols: number[]): string[];
  /** Non-header text above the body in a column, in reading order: headings beside the column headers. */
  leading(col: number): string[];
}

/** A dense view of Docling's cells; header rows are the leading rows made only of column headers. */
export function toGrid(table: PageTable): Grid {
  const matrix: string[][] = Array.from({ length: table.rows }, () => Array.from({ length: table.cols }, () => ''));
  const headerCells: Array<{ col: number; colSpan: number; row: number; text: string }> = [];
  const headerRow = new Array<boolean>(table.rows).fill(true);
  const filled = new Array<boolean>(table.rows).fill(false);
  const headerCount = new Array<number>(table.rows).fill(0);
  // Non-header text in a row, by column: a heading beside the column headers ("ASSETS | Note | 2018").
  const other: Array<Array<{ col: number; text: string }>> = Array.from({ length: table.rows }, () => []);
  for (const cell of table.cells) {
    if (cell.row >= table.rows || cell.col >= table.cols) continue;
    matrix[cell.row]![cell.col] = cell.text;
    if (cell.text.trim()) filled[cell.row] = true;
    // A cell the table model did not flag can still be header wording ("Note", "'000'-----").
    if (cell.columnHeader || HEADER_WORDS.test(cell.text.trim()) || HEADER_WORDS.test(expandShortDates(cell.text.trim()))) {
      headerCells.push({ col: cell.col, colSpan: cell.colSpan, row: cell.row, text: expandShortDates(cell.text) });
      headerCount[cell.row]!++;
    } else if (cell.text.trim()) other[cell.row]!.push({ col: cell.col, text: cell.text.trim() });
  }
  // A row is a header row when all its text is header wording, or when it carries column headers
  // and only one other cell, a heading with no digits (OCR'd tables rarely flag that cell).
  for (let r = 0; r < table.rows; r++) {
    const rest = other[r]!;
    headerRow[r] = rest.length === 0 || (headerCount[r]! > 0 && rest.length === 1 && !/\d/u.test(rest[0]!.text));
  }
  let bodyStart = 0;
  while (bodyStart < table.rows && (headerRow[bodyStart] || !filled[bodyStart])) bodyStart++;
  const leading = (col: number): string[] =>
    other.slice(0, bodyStart).flatMap((cells) => cells.filter((cell) => cell.col === col).map((cell) => cell.text));
  const header = (col: number): string =>
    headerCells
      .filter((cell) => cell.row < bodyStart && cell.col <= col && col < cell.col + Math.max(1, cell.colSpan))
      .sort((a, b) => a.row - b.row)
      .map((cell) => cell.text.trim())
      .filter(Boolean)
      .join(' ');
  const valueHeaders = (cols: number[]): string[] => {
    const own = cols.map((col) =>
      headerCells
        .filter((cell) => cell.row < bodyStart && cell.col === col && Math.max(1, cell.colSpan) === 1)
        .sort((a, b) => a.row - b.row)
        .map((cell) => cell.text.trim())
        .filter(Boolean)
        .join(' '),
    );
    const extra = cols.map(() => [] as string[]);
    for (const cell of headerCells.filter((item) => item.row < bodyStart).sort((a, b) => a.row - b.row)) {
      const spanned = cols.map((col, index) => ({ col, index })).filter(({ col }) => cell.col <= col && col < cell.col + Math.max(1, cell.colSpan));
      if (spanned.length === 0 || (spanned.length === 1 && Math.max(1, cell.colSpan) === 1 && spanned[0]!.col === cell.col)) continue;
      const years = [...cell.text.matchAll(/(?<![\d,.])((?:19|20)\d{2})(?![\d,.])/gu)].map((match) => match[1]!);
      const rest = cell.text.replace(/(?<![\d,.])(?:19|20)\d{2}(?![\d,.])/gu, ' ').replace(/\s+/gu, ' ').trim();
      const lacking = spanned.filter(({ index }) => !YEAR.test(own[index]!) && !extra[index]!.some((text) => YEAR.test(text)));
      if (years.length > 0 && years.length === lacking.length) {
        lacking.forEach(({ index }, position) => extra[index]!.push(years[position]!));
        for (const { index } of spanned) if (rest) extra[index]!.push(rest);
      } else for (const { index } of spanned) extra[index]!.push(cell.text.trim());
    }
    const texts = cols.map((_, index) => [...extra[index]!.filter((text) => !YEAR.test(text)), own[index]!, ...extra[index]!.filter((text) => YEAR.test(text))].filter(Boolean).join(' ').trim());
    // A table model can put every year in one column's cell ("March 31, March 2025 2024" / "31,").
    // When some column has no year and the header prints exactly one year per column, the years
    // are the columns' in reading order.
    const yearsOf = (text: string) => [...text.matchAll(/(?<![\d,.])((?:19|20)\d{2})(?![\d,.])/gu)].map((match) => match[1]!);
    if (texts.some((text) => !YEAR.test(text))) {
      const all = texts.flatMap(yearsOf);
      if (all.length === cols.length) return texts.map((text, index) => `${text.replace(/(?<![\d,.])(?:19|20)\d{2}(?![\d,.])/gu, ' ').replace(/\s+/gu, ' ').trim()} ${all[index]}`.trim());
    }
    return texts;
  };
  return { rows: table.rows, cols: table.cols, bodyStart, cell: (row, col) => matrix[row]?.[col] ?? '', header, leading, valueHeaders };
}

const YEAR = /(?<![\d,.])(?:19|20)\d{2}(?![\d,.])/u;
/** Header wording: note, unit, audit status, dates and years -- never a caption or a figure. */
const HEADER_WORDS =
  /^(?:(?:for\s+the|as\s+(?:at|on))\s.*|notes?|\(?(?:un-?)?audited\)?|\(?restated\)?|[-–—_ ]*(?:rupees|rs\.?|pkr)?[^a-z\d]*(?:in\s+)?['‘’`]?\s*000['‘’`]?[-–—_ ]*|[-–—_ ]*(?:rupees|rs\.?)(?:\s+in\s+(?:thousands?|millions?))?[-–—_ ]*|(?:(?:19|20)\d{2}\s*)+|[a-z]+\s+\d{1,2},?(?:\s+(?:19|20)\d{2})?)$/iu;

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
  headers = headers.map(expandShortDates);
  title = expandShortDates(title);
  const titleDate = monthDay(title);
  const titlePhrase = PERIOD_PHRASE.exec(title);
  const titleMonths = titlePhrase && /year\s+ended/iu.test(titlePhrase[0]) && !/quarter|months|half/iu.test(title) ? 12 : null;
  const columns: StatementColumn[] = headers.map((header, index) => {
    const years = [...header.matchAll(/(?<![\d,.])((?:19|20)\d{2})(?![\d,.])/gu)].map((match) => match[1]!);
    const year = years.at(-1) ?? null;
    // C8: an annual filing's column that prints only its year ends at the financial year-end.
    const annualFiling = /^\d{4}$/u.test(filing.periodEnded);
    const date = monthDay(header) ?? titleDate ?? (annualFiling ? filing.yearEndMonthDay ?? null : null);
    const phrase = PERIOD_PHRASE.exec(header);
    const months =
      kind === 'balance'
        ? 0
        : phrase
          ? phraseMonths(phrase[0])
          : titleMonths ?? (date && filing.yearEndMonthDay ? monthsSince(filing.yearEndMonthDay, date) : null);
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
 * A printed figure as a number: brackets are negative, a dash or "Nil" is nil (rules V2, V3). OCR
 * residue around a figure (a stray bar, a footnote mark, a trailing comma or full stop) is trimmed,
 * and a semicolon between digit groups is read as the comma it was printed as. A bracket OCR lost on
 * either side still makes the figure negative: "(1,234" and "1,234)" are both -1,234, since nothing
 * positive is printed with one. The typographic minus sign (U+2212) is a minus. Anything else
 * unreadable is null -- a figure is never guessed.
 */
export function parseFigure(raw: string): number | null {
  let text = raw.replace(/\s+/gu, '').replace(/−/gu, '-').replace(/^[|\[\]'‘’"“”_=—§]+(?=[\d(])/u, '').replace(/[|\[\]'‘’"“”_*†‡]+$/u, '').replace(/[.,:]+$/u, '');
  if (DASH.test(text) || /^nil$/iu.test(text)) return 0;
  if (text === '') return null;
  text = text.replace(/(\d);(\d{3})/gu, '$1,$2');
  if (!FIGURE.test(text)) return null;
  const negative = text.startsWith('(') || text.startsWith('-') || text.endsWith(')');
  const value = Number(text.replace(/[(),-]/gu, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
