import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXTRACTOR_VERSION, LIMITS, type ClaimedTask } from '../contract.js';
import { DocumentExtractionError, type ExtractionErrorCode } from '../errors.js';
import { downloadDocument } from '../extraction.js';
import { extractFilingFinancials, type FilingResult } from '../pipeline/filing.js';
import type { PeriodFigures } from './derive.js';
import { FINANCIALS_SCHEMA_VERSION, financialsPayload, type FinancialsPayload } from './payload.js';

/**
 * A financial-statement task through the staged pipeline (schema version 2): download the filing,
 * run analyse -> classify -> subset -> tables -> normalize -> validate -> derive, and return the
 * result the ingest webhook receives. Market-based items are left to the server (`source:
 * "runtime"`), so no price is looked up here.
 */
export interface FinancialsLog {
  timings: Record<string, number>;
  pagesKept: Array<{ page: number; class: string; basis: string; topic?: string }>;
  statements: Array<{
    statementType: string;
    basis: string;
    pages: number[];
    method: string;
    unitScale: number;
    rows: number;
    matched: number;
    confirmedRows: number;
    columns: string[];
    unmatched: string[];
    problems: string[];
  }>;
  drops: Array<{ item: string; reason: string }>;
}

interface Envelope {
  schemaVersion: typeof FINANCIALS_SCHEMA_VERSION;
  taskId: string;
  leaseToken: string;
  extractorVersion: typeof EXTRACTOR_VERSION;
}

export type FinancialsResult =
  | (Envelope & {
      outcome: 'extracted';
      document: FinancialsPayload['document'];
      periods: PeriodFigures[];
      pages: FinancialsPayload['pages'];
      log: FinancialsLog;
    })
  | (Envelope & { outcome: 'failed'; error: { code: ExtractionErrorCode; message: string } });

type StatementTask = Extract<ClaimedTask, { kind: 'financial_statement' }>;

/** Never throws: any failure becomes a `failed` result with a code the API knows. */
export async function processFinancialsTask(task: StatementTask): Promise<FinancialsResult> {
  const envelope: Envelope = { schemaVersion: FINANCIALS_SCHEMA_VERSION, taskId: task.id, leaseToken: task.leaseToken, extractorVersion: EXTRACTOR_VERSION };
  const workDir = await mkdtemp(path.join(tmpdir(), 'filing-'));
  try {
    const { buffer } = await downloadDocument(task.sourceUrl);
    if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') throw new DocumentExtractionError('unsupported_type', 'the filing is not a PDF');
    const pdf = path.join(workDir, 'source.pdf');
    await mkdir(workDir, { recursive: true });
    await writeFile(pdf, buffer);
    const result = await extractFilingFinancials(pdf, { periodEnded: task.context.periodEnded, hints: task.context.hints }, () => null, path.join(workDir, 'stages'));
    const payload = financialsPayload(
      { symbol: task.context.symbol, reportType: task.context.reportType, periodEnded: task.context.periodEnded, sourceUrl: task.sourceUrl },
      result,
    );
    return { ...envelope, outcome: 'extracted', document: payload.document, periods: payload.periods.slice(0, 40), pages: payload.pages, log: financialsLog(result) };
  } catch (error) {
    const known = error instanceof DocumentExtractionError;
    return {
      ...envelope,
      outcome: 'failed',
      error: { code: known ? error.code : 'extract_failed', message: (known ? error.message : 'unexpected extraction error').slice(0, LIMITS.errorMessageChars) },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** What each stage did, for the admin panel's history. Labels and reasons only, never page text. */
export function financialsLog(result: FilingResult): FinancialsLog {
  return {
    timings: result.timings,
    pagesKept: result.classification.pages
      .filter((page) => page.selected)
      .slice(0, 60)
      .map((page) => ({ page: page.pageNumber, class: page.class, basis: page.basis, ...(page.topic ? { topic: page.topic } : {}) })),
    statements: result.statements.slice(0, 12).map((statement) => ({
      statementType: statement.statementType,
      basis: statement.basis,
      pages: statement.pages,
      method: statement.method,
      unitScale: statement.unitScale,
      rows: statement.rows,
      matched: statement.matched,
      confirmedRows: statement.confirmedRows,
      columns: statement.columns.map((column) => `${column.periodEnd ?? '?'}/${column.months ?? '?'}${column.kept ? '' : ` dropped: ${column.reason ?? ''}`}`.slice(0, 120)),
      unmatched: statement.unmatched.slice(0, 40).map((label) => label.slice(0, 120)),
      problems: statement.problems.slice(0, 10).map((problem) => problem.slice(0, 200)),
    })),
    drops: result.drops.slice(0, 200).map((drop) => ({ item: drop.item.slice(0, 120), reason: drop.reason.slice(0, 200) })),
  };
}
