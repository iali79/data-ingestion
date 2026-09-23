import { EXTRACTOR_VERSION, LIMITS, summarizeDocument, type DocumentSummary } from '../contract.js';
import type { ExtractedDocument } from '../extraction.js';
import type { PeriodFigures } from './derive.js';
import type { FilingFinancials } from './filing.js';

/**
 * The financials result for one filing: what the ingest webhook receives (schema version 2).
 * Every period the filing prints, and for each period every defined item under `income`,
 * `balance`, `cashFlow` and `ratios` -- as a reported figure (with its page and printed line), a
 * derived figure (with its formula) or null. See CONTRACT.md for the full field list.
 */
export const FINANCIALS_SCHEMA_VERSION = 2;

export interface FinancialsPayload {
  schemaVersion: typeof FINANCIALS_SCHEMA_VERSION;
  extractorVersion: typeof EXTRACTOR_VERSION;
  filing: { symbol: string; reportType: string; periodEnded: string; sourceUrl: string };
  document: DocumentSummary;
  periods: PeriodFigures[];
  /** Only the pages the reported figures were read from. */
  pages: Array<{ pageNumber: number; method: string; confidence: number; text: string }>;
}

export function financialsPayload(
  filing: FinancialsPayload['filing'],
  document: ExtractedDocument,
  financials: FilingFinancials,
): FinancialsPayload {
  const cited = new Set(financials.evidencePages);
  return {
    schemaVersion: FINANCIALS_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    filing,
    document: summarizeDocument(document),
    periods: financials.periods,
    pages: document.pages
      .filter((page) => cited.has(page.pageNumber))
      .slice(0, LIMITS.pages)
      .map((page) => ({ pageNumber: page.pageNumber, method: page.method, confidence: Math.round(page.confidence * 10_000) / 10_000, text: page.text.slice(0, LIMITS.pageTextChars) })),
  };
}
