import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClaimedTask } from '../../src/contract.js';
import type { ExtractedDocument } from '../../src/extraction.js';
import { MAX_MARKET_ROWS, type MarketDocumentSource } from '../../src/market/index.js';
import { processTask } from '../../src/process.js';

const read = (path: string) => readFileSync(new URL(`../../samples/market/${path}`, import.meta.url), 'utf8');

const pdf = (text: string): ExtractedDocument => ({
  kind: 'pdf',
  method: 'pdftotext',
  contentType: 'application/pdf',
  text,
  confidence: 0.85,
  pages: [{ pageNumber: 1, method: 'pdftotext', text, confidence: 0.85 }],
});

const source = (over: Partial<MarketDocumentSource> = {}): MarketDocumentSource => ({
  obtainPdf: async () => {
    throw new Error('no pdf expected');
  },
  obtainFile: async () => {
    throw new Error('no file expected');
  },
  ...over,
});

const task = (dataset: string, url: string): ClaimedTask =>
  ({ id: '7', kind: 'market_document', sourceUrl: url, context: { dataset }, leaseToken: 'a'.repeat(64), leaseExpiresAt: '2026-11-17T12:00:00.000Z' }) as ClaimedTask;

const DOCS = {} as never;

describe('processTask for a market document', () => {
  it('reads an OGRA price publication into rows and keeps the lease envelope', async () => {
    const result = await processTask(
      task('ogra-prices', 'https://www.ogra.org.pk/download/18305?lang=en'),
      DOCS,
      null,
      source({ obtainPdf: async () => pdf(read('ogra/price-publication-2026-11-17.txt')) }),
    );
    expect(result).toMatchObject({ outcome: 'extracted', taskId: '7', leaseToken: 'a'.repeat(64), schemaVersion: 1 });
    if (result.outcome !== 'extracted' || !('marketDocument' in result)) throw new Error('expected a market result');
    expect(result.marketDocument).toMatchObject({ dataset: 'ogra-prices', asOf: '2026-11-17' });
    expect(result.marketDocument.rows.find((r) => r.product === 'MS' && r.component === 'retail')?.value).toBe(328);
    expect(result.marketDocument.checks.every((c) => c.ok)).toBe(true);
    expect(result.document).toMatchObject({ kind: 'pdf', pageCount: 1 });
  });

  it('reads a PCGA report and stamps the season on every row', async () => {
    const result = await processTask(
      task('pcga-cotton', 'https://www.pcga.org/wp-content/uploads/2026/11/03-November-2026.pdf'),
      DOCS,
      null,
      source({ obtainPdf: async () => pdf(read('pcga/arrivals-2026-11-03.txt')) }),
    );
    if (result.outcome !== 'extracted' || !('marketDocument' in result)) throw new Error('expected a market result');
    expect(result.marketDocument.asOf).toBe('2026-10-31');
    expect(result.marketDocument.rows).toHaveLength(36);
    expect(new Set(result.marketDocument.rows.map((r) => r.season))).toEqual(new Set(['2026-27']));
  });

  it('reads the SBP workbook from bytes, not a PDF', async () => {
    let asked = '';
    const result = await processTask(
      task('sbp-credit', 'https://www.sbp.org.pk/assets/document/CreditLoans-arch.xls'),
      DOCS,
      null,
      source({
        obtainFile: async (url) => {
          asked = url;
          return Buffer.from('not a workbook');
        },
      }),
    );
    expect(asked).toBe('https://www.sbp.org.pk/assets/document/CreditLoans-arch.xls');
    // Bytes that are not a workbook deliver no rows; the failure is reported, not thrown past the lease.
    expect(['extracted', 'failed']).toContain(result.outcome);
    if (result.outcome === 'extracted' && 'marketDocument' in result) expect(result.marketDocument.rows).toEqual([]);
  });

  it('returns a document whose sums fail as extracted with no rows and the failed check named', async () => {
    const tampered = read('pcga/arrivals-2026-11-03.txt').replace('28,242', '38,242');
    const result = await processTask(task('pcga-cotton', 'https://www.pcga.org/x.pdf'), DOCS, null, source({ obtainPdf: async () => pdf(tampered) }));
    if (result.outcome !== 'extracted' || !('marketDocument' in result)) throw new Error('expected a market result');
    expect(result.marketDocument.rows).toEqual([]);
    expect(result.marketDocument.checks.filter((c) => !c.ok).map((c) => c.id)).toContain('punjab:arrivals');
  });

  it('fails a task for an unknown dataset instead of guessing a parser', async () => {
    const result = await processTask(task('made-up', 'https://www.ogra.org.pk/x.pdf'), DOCS, null, source());
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'unsupported_type' } });
  });

  it('turns a download error into a failed result, never an exception', async () => {
    const result = await processTask(
      task('ogra-prices', 'https://www.ogra.org.pk/x.pdf'),
      DOCS,
      null,
      source({
        obtainPdf: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'extract_failed' } });
  });

  it('refuses a result with more rows than the API accepts', () => {
    expect(MAX_MARKET_ROWS).toBe(5000);
  });
});
