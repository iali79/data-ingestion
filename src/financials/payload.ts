import { EXTRACTOR_VERSION, LIMITS } from '../contract.js';
import type { FilingResult } from '../pipeline/filing.js';
import type { PeriodFigures } from './derive.js';

/**
 * The financials result for one filing: what the ingest webhook receives (schema version 2).
 * Every period the filing prints, and for each period every defined item under `income`,
 * `balance`, `cashFlow` and `ratios` -- as a reported figure (with its page, printed line and the
 * checks that confirmed it), a derived figure (with its formula) or null. See FINANCIALS.md for
 * the field list.
 */
export const FINANCIALS_SCHEMA_VERSION = 2;

export interface FinancialsPayload {
  schemaVersion: typeof FINANCIALS_SCHEMA_VERSION;
  extractorVersion: typeof EXTRACTOR_VERSION;
  filing: { symbol: string; reportType: string; periodEnded: string; sourceUrl: string };
  document: { kind: 'pdf'; pageCount: number; pagesRead: number; nativePages: number; scannedPages: number };
  periods: PeriodFigures[];
  /** Only the pages the reported figures were read from. */
  pages: Array<{ pageNumber: number; method: string; text: string }>;
}

export function financialsPayload(filing: FinancialsPayload['filing'], result: FilingResult): FinancialsPayload {
  const read = new Set(result.classification.selectedPages);
  return {
    schemaVersion: FINANCIALS_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    filing,
    document: {
      kind: 'pdf',
      pageCount: result.analysis.pageCount,
      pagesRead: read.size,
      nativePages: result.analysis.pages.filter((page) => read.has(page.pageNumber) && page.kind === 'native').length,
      scannedPages: result.analysis.pages.filter((page) => read.has(page.pageNumber) && page.kind === 'scanned').length,
    },
    periods: result.periods,
    pages: result.evidence.slice(0, LIMITS.pages).map((page) => ({ ...page, text: page.text.slice(0, LIMITS.pageTextChars) })),
  };
}
