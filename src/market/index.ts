/**
 * `market_document` tasks: one public document per task (an OGRA price publication, a PCGA arrivals
 * report, the SBP credit workbook, a PSX off-market report), read into rows the ingest API checks
 * again and applies.
 *
 * Every parser delivers rows only when the document's own arithmetic holds, and always returns the
 * checks it ran, so a rejected document says which one failed.
 */
import { DocumentExtractionError } from '../errors.js';
import { downloadAndExtractDocument, downloadDocument, type ExtractedDocument, type OcrPolicy } from '../extraction.js';
import { parsePricePublication } from './ogra.js';
import { parseCottonArrivals } from './pcga.js';
import { parseOffMarket } from './psx-omts.js';
import { sanityChecks } from './sanity.js';
import { parseSbpCredit, readSbpWorkbook } from './sbp.js';

export const MARKET_DATASETS = ['ogra-prices', 'pcga-cotton', 'sbp-credit', 'psx-off-market'] as const;
export type MarketDataset = (typeof MARKET_DATASETS)[number];

export type MarketRow = Record<string, string | number | null>;

export interface MarketCheck {
  id: string;
  ok: boolean;
  /** A failed advisory check is reported but does not withhold the rows. */
  advisory?: boolean;
  detail?: string;
}

/** What goes on the wire for a `market_document` task. */
export interface MarketDocumentPayload {
  dataset: MarketDataset;
  /** The date the figures describe (effective date, "as on" date, trade date or latest month), `YYYY-MM-DD`. */
  asOf: string;
  rows: MarketRow[];
  checks: MarketCheck[];
}

/** Hard cap on rows in one result; the ingest API enforces the same number. */
export const MAX_MARKET_ROWS = 5_000;

/** These documents are text PDFs: a sparse page is a blank one, never worth OCR. */
export const MARKET_OCR: OcrPolicy = { mode: 'leading', pages: 0 };

export interface MarketDocumentSource {
  /** A text PDF read through `pdftotext -layout`. */
  obtainPdf(sourceUrl: string): Promise<ExtractedDocument>;
  /** The raw bytes of a spreadsheet. */
  obtainFile(sourceUrl: string): Promise<Buffer>;
}

export function isMarketDataset(value: unknown): value is MarketDataset {
  return typeof value === 'string' && (MARKET_DATASETS as readonly string[]).includes(value);
}

/** `today` (`YYYY-MM-DD`) bounds the as-of date; tests pass a fixed one. */
export async function readMarketDocument(
  dataset: MarketDataset,
  sourceUrl: string,
  source: MarketDocumentSource,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ payload: MarketDocumentPayload; document: Pick<ExtractedDocument, 'kind' | 'contentType' | 'method' | 'pages' | 'confidence'> | null }> {
  const finish = (payload: MarketDocumentPayload) => cap(withSanity(payload, today));
  if (dataset === 'sbp-credit') {
    const buffer = await source.obtainFile(sourceUrl);
    const out = parseSbpCredit(await readSbpWorkbook(buffer));
    return { payload: finish({ dataset, asOf: out.asOf, rows: out.rows.map((r) => ({ ...r })), checks: out.checks }), document: null };
  }

  const document = await source.obtainPdf(sourceUrl);
  if (dataset === 'ogra-prices') {
    const out = parsePricePublication(document.text);
    return { payload: finish({ dataset, asOf: out.effectiveDate, rows: out.rows.map((r) => ({ ...r })), checks: out.checks }), document };
  }
  if (dataset === 'pcga-cotton') {
    const out = parseCottonArrivals(document.text);
    return {
      payload: finish({ dataset, asOf: out.asOf, rows: out.rows.map((r) => ({ ...r, season: out.season })), checks: out.checks }),
      document,
    };
  }
  const out = parseOffMarket(document.text);
  return { payload: finish({ dataset, asOf: out.tradeDate, rows: out.rows.map((r) => ({ ...r })), checks: out.checks }), document };
}

/** Adds the document-only checks; a failed hard one withholds every row, as a failed total does. */
function withSanity(payload: MarketDocumentPayload, today: string): MarketDocumentPayload {
  const extra = sanityChecks(payload.dataset, payload.asOf, payload.rows, today);
  const refused = extra.some((c) => !c.ok && !c.advisory);
  return { ...payload, rows: refused ? [] : payload.rows, checks: [...payload.checks, ...extra] };
}

/** A result is rejected rather than truncated: half a workbook is not a workbook. */
function cap(payload: MarketDocumentPayload): MarketDocumentPayload {
  if (payload.rows.length > MAX_MARKET_ROWS) {
    throw new DocumentExtractionError('extract_failed', `${payload.rows.length} rows is more than the ${MAX_MARKET_ROWS} a result may carry`);
  }
  return {
    ...payload,
    checks: payload.checks.slice(0, 200).map((c) => ({ ...c, ...(c.detail ? { detail: c.detail.slice(0, 300) } : {}) })),
  };
}

/** The default source: a plain download. */
export const DOWNLOAD_MARKET_SOURCE: MarketDocumentSource = {
  async obtainPdf(sourceUrl) {
    return downloadAndExtractDocument(sourceUrl, MARKET_OCR);
  },
  async obtainFile(sourceUrl) {
    return (await downloadDocument(sourceUrl)).buffer;
  },
};
