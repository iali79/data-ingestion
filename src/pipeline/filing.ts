import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Statement } from '../financials/definitions.js';
import { buildPeriods, type PeriodFigures, type PriceLookup, type ReportedValue } from '../financials/derive.js';
import { analysePdf, ocrWholePages, type DocumentAnalysis } from './analyse.js';
import { classifyPages, type Classification } from './classify.js';
import { applyPageHints, applyUnitHint, readHints } from './hints.js';
import { matchRows, normalizeLabel } from './labels.js';
import { buildStatementTable, type StatementTable } from './normalize.js';
import { readNotes } from './notes.js';
import { subsetPages } from './subset.js';
import { extractTables, type TableExtraction } from './tables.js';
import { applyChecks, confirmTotals, valuesFromMatches, type Drop } from './validate.js';

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

  // The balance sheet first: its comparative column gives the financial year-end, which dates
  // interim columns that do not print their length (rule C7).
  const ordered = [...classification.statements].sort((a, b) => Number(b.statementType === 'balance_sheet') - Number(a.statementType === 'balance_sheet'));
  let yearEndMonthDay: string | null = null;
  const statementTables: StatementTable[] = [];
  const summaries: StatementSummary[] = [];
  const drops: Drop[] = [];
  let values: ReportedValue[] = [];
  for (const statement of ordered) {
    const table = buildStatementTable(statement, tables.pages, { periodEnded: filing.periodEnded, yearEndMonthDay });
    if (statement.hinted) table.problems.push(`pages ${statement.pages.join('+')} from an admin hint`);
    if (statement.statementType === 'balance_sheet' && !yearEndMonthDay) yearEndMonthDay = financialYearEnd(table);
    statementTables.push(table);
  }
  inheritUnits(statementTables);
  applyUnitHint(statementTables, hints);
  for (const table of statementTables) {
    const kind = KIND[table.statementType];
    const { matches, unmatched } = matchRows(kind, table.rows);
    const confirmed = confirmTotals(table);
    values.push(...valuesFromMatches(kind, table, matches, confirmed, drops));
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
  values = applyChecks(dedupe(values), statementTables, drops);
  // Notes last: they are delivered only when they reconcile with the checked statements.
  values.push(...readNotes(classification.notes, tables.pages, analysis, statementTables, values, drops));
  await writeJson(workDir, 'statements.json', { statements: summaries, tables: statementTables });
  await writeJson(workDir, 'validation.json', { drops, values });

  const periods = buildPeriods(values, price);
  const evidencePages = [...new Set(values.map((value) => value.page).filter((page): page is number => page !== null))].sort((a, b) => a - b);
  const evidence = evidencePages.map((pageNumber) => pageEvidence(pageNumber, analysis, statementTables));
  return { periods, evidence, analysis, classification, statements: summaries, drops, timings };
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
