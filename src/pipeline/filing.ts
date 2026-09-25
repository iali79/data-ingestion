import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Statement } from '../financials/definitions.js';
import { buildPeriods, type PeriodFigures, type PriceLookup, type ReportedValue } from '../financials/derive.js';
import { analysePdf, ocrWholePages, type DocumentAnalysis } from './analyse.js';
import { classifyPages, type Classification, type SelectedStatement } from './classify.js';
import { applyPageHints, applyUnitHint, readHints } from './hints.js';
import { matchRows, normalizeLabel } from './labels.js';
import { buildStatementTable, type StatementTable } from './normalize.js';
import { readNotes } from './notes.js';
import { subsetPages } from './subset.js';
import { extractTables, type PageTables, type TableExtraction } from './tables.js';
import { applyChecks, confirmTotals, valuesFromMatches, type Drop } from './validate.js';
import { buildConstraints, ratioProblems } from './constraints.js';
import { cellKey, cellValue, residual, type CellRef, type Correction, type Reading } from './constraint-types.js';
import { applyCorrections, repairCells, type RepairResult } from './repair.js';
import { rereadCells } from './reread.js';

/**
 * One filing through every stage:
 *   1 analyse -> 2 classify -> 3 subset -> 4 tables -> 5 normalize -> 6 validate -> 7 derive
 * Each stage's output is written to `workDir` (analysis.json, classification.json, tables.json,
 * statements.json, validation.json), so any delivered or missing figure can be traced to the
 * stage that produced it.
 */
export interface FilingResult {
  periods: PeriodFigures[];
  /** Pages the reported figures came from, with their text: the layout text of a native page, the OCRed rows of a scanned one. */
  evidence: Array<{ pageNumber: number; method: 'pdftotext' | 'docling-ocr'; text: string }>;
  analysis: DocumentAnalysis;
  classification: Classification;
  statements: StatementSummary[];
  drops: Drop[];
  /** Cells the repair stage (R7) proved misread and corrected. */
  corrections: Correction[];
  /** Failing relations the repair stage could not prove a correction for. */
  unresolved: RepairResult['unresolved'];
  /** Plausibility problems (S1-S9) of the delivered periods, for review. */
  plausibility: string[];
  timings: Record<string, number>;
}

export interface StatementSummary {
  statementType: string;
  basis: string;
  pages: number[];
  method: string;
  unitScale: number;
  columns: Array<{ header: string; periodEnd: string | null; months: number | null; kept: boolean; reason?: string }>;
  rows: number;
  matched: number;
  /** Rows with figures that no label rule claims -- where the rules can grow. */
  unmatched: string[];
  confirmedRows: number;
  problems: string[];
}

const KIND = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' } as const satisfies Record<string, Statement>;

export async function extractFilingFinancials(
  pdf: string,
  filing: { periodEnded: string; hints?: unknown },
  price: PriceLookup,
  workDir: string,
): Promise<FilingResult> {
  await mkdir(workDir, { recursive: true });
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      timings[name] = Date.now() - started;
    }
  };

  const analysis = await time('analyse', () => analysePdf(pdf));
  // A reviewer's hints for this filing, if well-formed for this document (rule H0).
  const hints = readHints(filing.hints, analysis.pageCount);
  let classification = applyPageHints(classifyPages(analysis), hints);
  // A scanned filing whose title strips did not show every statement, or whose cited notes sit
  // below the strip: read the scanned pages in full (low resolution) and classify again.
  if (analysis.pages.some((page) => page.kind === 'scanned') && needsWholePages(classification)) {
    await time('ocr-pages', () => ocrWholePages(pdf, analysis.pages));
    classification = applyPageHints(classifyPages(analysis), hints);
  }
  await writeJson(workDir, 'analysis.json', { pageCount: analysis.pageCount, ms: analysis.ms, pages: analysis.pages.map(({ text, overlay, ...page }) => ({ ...page, head: text.slice(0, 200) })) });
  await writeJson(workDir, 'classification.json', classification);

  const subset = await time('subset', () => subsetPages(pdf, analysis, classification.selectedPages, workDir));
  const tables: TableExtraction = await time('tables', () => extractTables(subset, workDir));
  await writeJson(workDir, 'tables.json', tables);

  const drops: Drop[] = [];
  const statementTables = buildStatements(classification.statements, tables.pages, filing, analysis);
  applyUnitHint(statementTables, hints);
  const verified = await time('verify', () =>
    verifyStatements(statementTables, drops, (suspect, cells) => rereadCells(pdf, analysis, suspect, cells, path.join(workDir, 'reread'))),
  );
  statementTables.splice(0, statementTables.length, ...verified.tables);
  const { values, summaries, corrections, unresolved } = verified;
  // Notes last: they are delivered only when they reconcile with the checked statements.
  values.push(...readNotes(classification.notes, tables.pages, analysis, statementTables, values, drops));
  await writeJson(workDir, 'statements.json', { statements: summaries, tables: statementTables });
  await writeJson(workDir, 'validation.json', { drops, values, corrections, unresolved });

  const periods = buildPeriods(values, price);
  // S1-S9: plausibility of the delivered figures. Never proof and never a reason to drop (a small
  // profit under minimum tax, a bonus issue restating EPS are real); recorded for review.
  const plausibility = periods.flatMap((period) => ratioProblems(period).map((problem) => `${period.periodEnd}/${period.months} ${period.basis}: ${problem}`));
  const evidencePages = [...new Set(values.map((value) => value.page).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  const evidence = evidencePages.map((pageNumber) => pageEvidence(pageNumber, analysis, statementTables));
  return { periods, evidence, analysis, classification, statements: summaries, drops, corrections, unresolved, plausibility, timings };
}

/**
 * Stage 5 for every selected statement, in the order production needs: the balance sheet first,
 * since its comparative column gives the financial year-end, which dates interim columns that do
 * not print their length (rule C7); then rule U1 across the filing. An admin unit hint (rule H3) is
 * not applied here: the caller applies it after. Production (`extractFilingFinancials`) and the
 * offline replay's `--rebuild` (`replay.ts`) call this one function, so a stage 5 change measured
 * on the corpus is the change production makes.
 *
 * `analysis` gives the native pages' text layer, from which rule R4c rebuilds rows the table
 * model fused or shifted; a scanned page has none.
 */
export function buildStatements(
  statements: SelectedStatement[],
  pages: PageTables[],
  filing: { periodEnded: string },
  analysis: DocumentAnalysis | null,
): StatementTable[] {
  const ordered = [...statements].sort((a, b) => Number(b.statementType === 'balance_sheet') - Number(a.statementType === 'balance_sheet'));
  let yearEndMonthDay: string | null = null;
  const out: StatementTable[] = [];
  for (const statement of ordered) {
    const table = buildStatementTable(statement, pages, { periodEnded: filing.periodEnded, yearEndMonthDay }, layoutText(analysis));
    if (statement.hinted) table.problems.push(`pages ${statement.pages.join('+')} from an admin hint`);
    if (statement.statementType === 'balance_sheet' && !yearEndMonthDay) yearEndMonthDay = financialYearEnd(table);
    out.push(table);
  }
  inheritUnits(out);
  return out;
}

/** A native page's `pdftotext -layout` text, by page number; null for a scanned or blank page. */
function layoutText(analysis: DocumentAnalysis | null): (page: number) => string | null {
  return (page) => {
    const found = analysis?.pages[page - 1];
    return found && found.kind === 'native' && found.textSource === 'pdftotext' ? found.text : null;
  };
}

/**
 * Stage 6 over a filing's statement tables, from the built tables onward: label rules (R1-R5),
 * table arithmetic (A1), reported values with the printed cell each came from, then every relation
 * of constraints.ts and the delivery rule (I1-I5, B1-B5, F4-F5, X1-X5, E1, V6) on the deduplicated
 * values. Pure: it reads only the tables, and records every removal in
 * `drops`. Production (`extractFilingFinancials`) and the offline replay (`replay.ts`, which feeds
 * it the `statements.json` tables a run saved) call this one function, so a figure the replay
 * counts is a figure production would deliver from the same tables.
 *
 * `tables` must already carry their final unit scale (rule U1 and any admin unit hint applied),
 * and their order fixes each value's `cell.table`. Notes are not read here: they need the page
 * grids and text, and reconcile against the values this returns (see `readNotes`).
 */
export function validateStatements(tables: StatementTable[], drops: Drop[]): { values: ReportedValue[]; summaries: StatementSummary[] } {
  const { values, summaries } = matchStatements(tables, drops);
  return { values: applyChecks(values, tables, drops), summaries };
}

/** Second readings of suspect cells, by cell key (reread.ts in production; none offline for OCR pages). */
export type Rereader = (tables: StatementTable[], cells: CellRef[]) => Promise<Map<string, Reading[]>>;

export interface Verified {
  /** The tables with every proven correction applied (the input tables are not modified). */
  tables: StatementTable[];
  values: ReportedValue[];
  summaries: StatementSummary[];
  corrections: Correction[];
  unresolved: RepairResult['unresolved'];
}

/**
 * Stage 6b, verify and repair, then stage 6 on the result:
 *   1. every relation the filing must satisfy is built over the tables as read (constraints.ts);
 *   2. the cells of each relation that fails, or cannot be evaluated because a printed cell is
 *      unreadable, are suspects: they get an independent second reading (the text layer of a
 *      native page, a 300 dpi OCR of a scanned one);
 *   3. the repair stage (R7, repair.ts) replaces a reading only when the arithmetic proves it: the
 *      new value makes two independent relations hold (or one, and a second reading agrees), no
 *      other value would, and nothing that held before breaks;
 *   4. stage 6 runs on the corrected tables, so a corrected figure is confirmed by the same
 *      checks as any other, and V6 delivers nothing unconfirmed.
 * A corrected figure carries an "R7" entry in its checks with the reading it replaced, so the
 * review panel shows what was changed and why.
 */
export async function verifyStatements(tables: StatementTable[], drops: Drop[], reread: Rereader | null): Promise<Verified> {
  const first = matchStatements(tables, []);
  const constraints = buildConstraints(tables, first.values);
  const suspects = new Map<string, CellRef>();
  for (const constraint of constraints) {
    if (constraint.advisory) continue;
    const r = residual(tables, constraint);
    const unreadable = r === null && constraint.terms.some((term) => cellValue(tables, term.cell) === null && printedText(tables, term.cell) !== '');
    if (unreadable || (r !== null && Math.abs(r) > constraint.tolerance)) for (const term of constraint.terms) suspects.set(cellKey(term.cell), term.cell);
  }
  let corrections: Correction[] = [];
  let unresolved: RepairResult['unresolved'] = [];
  if (suspects.size > 0) {
    const readings = reread ? await reread(tables, [...suspects.values()]).catch(() => new Map<string, Reading[]>()) : new Map<string, Reading[]>();
    ({ corrections, unresolved } = repairCells(tables, constraints, readings));
    if (corrections.length > 0) tables = applyCorrections(tables, corrections);
  }
  const { values, summaries } = validateStatements(tables, drops);
  for (const value of values) {
    if (value.repaired) {
      const from = value.repaired.from === null ? 'unreadable' : String(value.repaired.from);
      value.checks = [...(value.checks ?? []), `R7 corrected from ${from}: ${value.repaired.how}`.slice(0, 80)];
    }
    // The ingest API refuses a whole payload when a figure lists more than 20 checks: a figure
    // cross-checked by many relations keeps the first ones, and always its correction record.
    if ((value.checks?.length ?? 0) > MAX_CHECKS) {
      const repair = value.checks!.filter((check) => check.startsWith('R7 '));
      value.checks = [...value.checks!.filter((check) => !check.startsWith('R7 ')).slice(0, MAX_CHECKS - repair.length), ...repair];
    }
  }
  return { tables, values, summaries, corrections, unresolved };
}

/** The ingest API's limit on a figure's checks (financialsPayloadProblems). */
const MAX_CHECKS = 20;

function printedText(tables: StatementTable[], cell: CellRef): string {
  return tables[cell.table]?.rows.find((row) => row.id === cell.row)?.cells[cell.column]?.trim() ?? '';
}

/** Matched rows to reported values, table by table (R1-R5, A1, U1-U4), deduplicated; no identities yet. */
function matchStatements(tables: StatementTable[], drops: Drop[]): { values: ReportedValue[]; summaries: StatementSummary[] } {
  const summaries: StatementSummary[] = [];
  const values: ReportedValue[] = [];
  for (const [tableIndex, table] of tables.entries()) {
    const kind = KIND[table.statementType];
    const { matches, unmatched } = matchRows(kind, table.rows);
    const confirmed = confirmTotals(table);
    values.push(...valuesFromMatches(kind, table, matches, confirmed, drops, tableIndex));
    summaries.push({
      statementType: table.statementType,
      basis: table.basis,
      pages: table.pages,
      method: table.method,
      unitScale: table.unitScale,
      columns: table.columns.map(({ header, periodEnd, months, kept, reason }) => ({ header, periodEnd, months, kept, ...(reason ? { reason } : {}) })),
      rows: table.rows.length,
      matched: matches.length,
      unmatched: unmatched.filter((row) => row.values.some((value) => value !== null)).map((row) => normalizeLabel(row.label)),
      confirmedRows: confirmed.size,
      problems: table.problems,
    });
  }
  return { values: dedupe(values), summaries };
}

function pageEvidence(pageNumber: number, analysis: DocumentAnalysis, tables: StatementTable[]): FilingResult['evidence'][number] {
  const page = analysis.pages[pageNumber - 1]!;
  if (page.kind === 'native') return { pageNumber, method: 'pdftotext', text: page.text };
  const rows = tables.flatMap((table) => table.rows.filter((row) => row.page === pageNumber));
  return { pageNumber, method: 'docling-ocr', text: rows.map((row) => [row.label, row.note ?? '', ...row.cells].filter(Boolean).join(' | ')).join('\n') };
}

/**
 * Rule U1: a statement that prints no unit takes the unit the filing's other statements print,
 * when they all print the same one. Otherwise it stays in rupees as printed, and says so.
 */
function inheritUnits(tables: StatementTable[]): void {
  const printed = new Set(tables.filter((table) => table.unitPrinted).map((table) => table.unitScale));
  for (const table of tables.filter((item) => !item.unitPrinted)) {
    if (printed.size === 1) {
      table.unitScale = [...printed][0]!;
      table.problems.push(`no unit printed; took x${table.unitScale} from the filing's other statements`);
    } else if (printed.size > 1) table.problems.push('no unit printed and the other statements disagree; read as rupees');
  }
}

/** Statements missing (no income statement or balance sheet), or notes cited but not found. */
function needsWholePages(classification: Classification): boolean {
  const types = new Set(classification.statements.map((statement) => statement.statementType));
  return !types.has('income_statement') || !types.has('balance_sheet') || classification.notes.length === 0;
}

/**
 * The financial year-end month-day from the balance sheet's columns: an interim balance sheet
 * compares with the last year-end (its second column); an annual one's own date is the year-end.
 */
function financialYearEnd(table: StatementTable): string | null {
  const [first, second] = table.columns.filter((column) => column.periodEnd);
  const firstDay = first?.periodEnd?.slice(4) ?? null;
  const secondDay = second?.periodEnd?.slice(4) ?? null;
  if (firstDay && secondDay && firstDay !== secondDay) return secondDay;
  return firstDay;
}

/** The same figure read twice (a statement repeated in a filing) keeps its first reading. */
function dedupe(values: ReportedValue[]): ReportedValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.statement}|${value.key}|${value.periodEnd}|${value.months}|${value.basis}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await writeFile(path.join(dir, name), JSON.stringify(data, null, 1));
}
