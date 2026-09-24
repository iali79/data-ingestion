/**
 * The wire contract with the ingest API. CONTRACT.md is the human-readable version of this
 * file; the API validates every field again on its side and rejects anything outside it.
 *
 * `SCHEMA_VERSION` changes only when the payload shape changes. `EXTRACTOR_VERSION` changes
 * whenever the parser's output changes materially -- the API uses it to re-queue filings that
 * were processed by an older extractor.
 */
import type { ExtractedDocument } from './extraction.js';
import type { ExtractionErrorCode } from './errors.js';
import type { CorporateActionCandidate, ConsolidationBasis, ParsedStatementLine, StatementType } from './parser.js';

export const SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = 6;

export const LIMITS = {
  lines: 400,
  pages: 150,
  pageTextChars: 20_000,
  labelChars: 160,
  sourceTextChars: 1_000,
  actions: 10,
  actionSourceTextChars: 300,
  errorMessageChars: 500,
} as const;

export type TaskKind = 'financial_statement' | 'corporate_action_notice';

export interface StatementTaskContext {
  symbol: string;
  reportType: 'annual' | 'quarterly' | 'half_yearly';
  periodEnded: string;
  /** A reviewer's hints for this filing (unit, statement pages); absent when there are none. Checked by `readHints`. */
  hints?: unknown;
}

export interface NoticeTaskContext {
  symbol: string;
  title: string;
  publishedAt: string;
}

export type ClaimedTask =
  | { id: string; kind: 'financial_statement'; sourceUrl: string; context: StatementTaskContext; leaseToken: string; leaseExpiresAt: string }
  | { id: string; kind: 'corporate_action_notice'; sourceUrl: string | null; context: NoticeTaskContext; leaseToken: string; leaseExpiresAt: string };

export type StatementStatus = 'complete' | 'partial' | 'low_confidence' | 'failed' | 'unsupported';

export interface DocumentSummary {
  kind: string;
  contentType: string | null;
  method: string;
  pageCount: number;
  confidence: number;
}

export interface StatementLinePayload {
  statementType: StatementType;
  canonicalLineItem: string;
  consolidationBasis: ConsolidationBasis;
  label: string;
  periodLabel: string;
  periodEnd: string | null;
  value: number;
  currency: string | null;
  unitScale: number;
  confidence: number;
  sourcePage: number | null;
  sourceText: string;
}

export interface CorporateActionPayload {
  actionType: 'dividend' | 'bonus' | 'right' | 'split';
  exDate: string | null;
  details: { dividendPercent: number } | { bonusPercent: number } | { rightPercent: number } | { splitRatio: string };
  confidence: number;
  sourceText: string;
}

interface ResultEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  leaseToken: string;
  extractorVersion: typeof EXTRACTOR_VERSION;
}

export type ResultPayload =
  | (ResultEnvelope & {
      outcome: 'extracted';
      document: DocumentSummary;
      statement: { status: StatementStatus; candidateCount: number; lines: StatementLinePayload[] };
      pages: Array<{ pageNumber: number; method: string; confidence: number; text: string }>;
    })
  | (ResultEnvelope & { outcome: 'extracted'; document: DocumentSummary | null; corporateActions: CorporateActionPayload[] })
  | (ResultEnvelope & { outcome: 'failed'; error: { code: ExtractionErrorCode; message: string } });

export function envelope(task: ClaimedTask): ResultEnvelope {
  return { schemaVersion: SCHEMA_VERSION, taskId: task.id, leaseToken: task.leaseToken, extractorVersion: EXTRACTOR_VERSION };
}

export function summarizeDocument(document: ExtractedDocument): DocumentSummary {
  return {
    kind: document.kind,
    contentType: document.contentType,
    method: document.method,
    pageCount: document.pages.length,
    confidence: round4(document.confidence),
  };
}

/**
 * Whether a filing's promoted lines are enough to call it done: at least two income-statement
 * lines, two balance-sheet lines and one cash-flow line.
 */
export function statementStatus(promoted: ReadonlyArray<{ statementType: StatementType }>, candidateCount: number, kind: string): StatementStatus {
  if (kind === 'unsupported') return 'unsupported';
  const counts = new Map<StatementType, number>();
  for (const line of promoted) counts.set(line.statementType, (counts.get(line.statementType) ?? 0) + 1);
  if ((counts.get('income_statement') ?? 0) >= 2 && (counts.get('balance_sheet') ?? 0) >= 2 && (counts.get('cash_flow') ?? 0) >= 1) {
    return 'complete';
  }
  if (promoted.length > 0) return 'partial';
  if (candidateCount > 0) return 'low_confidence';
  return 'failed';
}

export function toLinePayload(line: ParsedStatementLine): StatementLinePayload {
  return {
    statementType: line.statementType,
    canonicalLineItem: line.canonicalLineItem,
    consolidationBasis: line.consolidationBasis,
    label: line.label.slice(0, LIMITS.labelChars),
    periodLabel: line.periodLabel,
    periodEnd: line.periodEnd && !Number.isNaN(line.periodEnd.getTime()) ? line.periodEnd.toISOString().slice(0, 10) : null,
    value: round4(line.value),
    currency: line.currency,
    unitScale: line.unitScale,
    confidence: round4(line.confidence),
    sourcePage: line.sourcePage,
    sourceText: line.sourceText.slice(0, LIMITS.sourceTextChars),
  };
}

/**
 * Pages kept as audit evidence, within the page cap: every page a promoted line came from
 * first, then the rest in order -- so a truncated long filing still keeps the evidence for
 * every figure it reports.
 */
export function selectEvidencePages(document: ExtractedDocument, lines: StatementLinePayload[]) {
  const cited = new Set(lines.map((line) => line.sourcePage).filter((page): page is number => page !== null));
  const ordered = [
    ...document.pages.filter((page) => cited.has(page.pageNumber)),
    ...document.pages.filter((page) => !cited.has(page.pageNumber)),
  ].slice(0, LIMITS.pages);
  return ordered
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page) => ({
      pageNumber: page.pageNumber,
      method: page.method,
      confidence: round4(page.confidence),
      text: page.text.slice(0, LIMITS.pageTextChars),
    }));
}

const DETAIL_KEY = {
  dividend: 'dividendPercent',
  bonus: 'bonusPercent',
  right: 'rightPercent',
  split: 'splitRatio',
} as const;

/** Maps parser output onto the contract's one-key-per-type `details`, dropping anything else. */
export function toActionPayload(candidate: CorporateActionCandidate): CorporateActionPayload | null {
  const key = DETAIL_KEY[candidate.actionType];
  const raw = candidate.details[key];
  if (key === 'splitRatio') {
    if (typeof raw !== 'string' || !/^\d{1,4}:\d{1,4}$/u.test(raw)) return null;
  } else if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10_000) {
    return null;
  }
  return {
    actionType: candidate.actionType,
    exDate: candidate.exDate && !Number.isNaN(candidate.exDate.getTime()) ? candidate.exDate.toISOString().slice(0, 10) : null,
    details: { [key]: raw } as CorporateActionPayload['details'],
    confidence: round4(candidate.confidence),
    sourceText: candidate.sourceText.slice(0, LIMITS.actionSourceTextChars),
  };
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
