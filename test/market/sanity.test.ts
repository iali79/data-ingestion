import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExtractedDocument } from '../../src/extraction.js';
import { readMarketDocument, type MarketDocumentSource, type MarketRow } from '../../src/market/index.js';
import { sanityChecks } from '../../src/market/sanity.js';

const read = (path: string) => readFileSync(new URL(`../../samples/market/${path}`, import.meta.url), 'utf8');
const pdfOf = (text: string): MarketDocumentSource => ({
  obtainPdf: async (): Promise<ExtractedDocument> => ({
    kind: 'pdf', method: 'pdftotext', contentType: 'application/pdf', text, confidence: 0.85,
    pages: [{ pageNumber: 1, method: 'pdftotext', text, confidence: 0.85 }],
  }),
  obtainFile: async () => { throw new Error('no file expected'); },
});
const failed = (checks: { id: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.id);

// Invented figures: arrivals 1,000, pressed 900 (unginned 100), sold 300 + 200 + 100 = 600 (unsold 300).
const cotton = (over: Partial<Record<string, number>> = {}): MarketRow => ({
  region: 'punjab', district: 'MULTAN', arrivals: 1000, pressed: 900, soldTcp: 300, soldExporters: 200, soldTextiles: 100,
  soldTotal: 600, unsold: 300, unginned: 100, lastYearArrivals: 800, flow: 50, factories: 4, season: '2026-27', ...over,
});

describe('document sanity checks', () => {
  it('passes the real samples, so they still deliver rows', async () => {
    const ogra = await readMarketDocument('ogra-prices', 'https://ogra.org.pk/x.pdf', pdfOf(read('ogra/price-publication-2026-11-18.txt')), '2026-11-18');
    expect(ogra.payload.rows.length).toBeGreaterThan(0);
    expect(failed(ogra.payload.checks)).toEqual([]);
    expect(ogra.payload.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['sanity:date-window', 'sanity:both-products', 'sanity:retail-range']));

    const pcga = await readMarketDocument('pcga-cotton', 'https://www.pcga.org/x.pdf', pdfOf(read('pcga/arrivals-2026-11-03.txt')), '2026-11-18');
    expect(pcga.payload.rows.length).toBeGreaterThan(0);
    expect(failed(pcga.payload.checks)).toEqual([]);
    expect(pcga.payload.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['sanity:sold-adds-up', 'sanity:unsold', 'sanity:unginned']));
  });

  it('withholds every row when the as-of date is beyond tomorrow or before 2010', async () => {
    const early = await readMarketDocument('ogra-prices', 'https://ogra.org.pk/x.pdf', pdfOf(read('ogra/price-publication-2026-11-18.txt')), '2026-11-01');
    expect(early.payload.rows).toEqual([]);
    expect(failed(early.payload.checks)).toEqual(['sanity:date-window']);
    // OGRA publishes the evening before: a price effective tomorrow is fine.
    const eve = await readMarketDocument('ogra-prices', 'https://ogra.org.pk/x.pdf', pdfOf(read('ogra/price-publication-2026-11-18.txt')), '2026-11-17');
    expect(eve.payload.rows.length).toBeGreaterThan(0);
    expect(failed(sanityChecks('psx-off-market', '2009-12-31', [cotton()], '2026-11-18'))).toContain('sanity:date-window');
  });

  it('catches a misread cotton digit that a column total cannot', () => {
    const today = '2026-11-18';
    expect(failed(sanityChecks('pcga-cotton', '2026-11-03', [cotton()], today))).toEqual([]);
    expect(failed(sanityChecks('pcga-cotton', '2026-11-03', [cotton({ soldTcp: 330 })], today))).toEqual(['sanity:sold-adds-up']);
    expect(failed(sanityChecks('pcga-cotton', '2026-11-03', [cotton({ unsold: 310 })], today))).toEqual(['sanity:unsold']);
    expect(failed(sanityChecks('pcga-cotton', '2026-11-03', [cotton({ unginned: 10 })], today))).toEqual(['sanity:unginned']);
    expect(failed(sanityChecks('pcga-cotton', '2026-11-03', [cotton({ arrivals: 800, unginned: -100 })], today))).toEqual(['sanity:pressed-within-arrivals']);
  });

  it('checks the season only when the report prints one', () => {
    expect(failed(sanityChecks('pcga-cotton', '2027-06-03', [cotton()], '2027-06-10'))).toEqual(['sanity:season']);
    expect(sanityChecks('pcga-cotton', '2017-11-01', [{ ...cotton(), season: null }], '2026-11-18').map((c) => c.id)).not.toContain('sanity:season');
  });

  it('refuses an OGRA publication missing a product or with an absurd pump price', () => {
    const row = (product: string, value: number): MarketRow => ({ product, component: 'retail', value });
    expect(failed(sanityChecks('ogra-prices', '2026-11-18', [row('MS', 263.45)], '2026-11-18'))).toEqual(['sanity:both-products']);
    expect(failed(sanityChecks('ogra-prices', '2026-11-18', [row('MS', 26345), row('HSD', 270.1)], '2026-11-18'))).toEqual(['sanity:retail-range']);
  });

  it('reports a weekend off-market report without withholding it', () => {
    const checks = sanityChecks('psx-off-market', '2026-11-14', [{ section: 'm2m', rowNo: 1 }], '2026-11-18');
    expect(checks.find((c) => c.id === 'sanity:weekday')).toMatchObject({ ok: false, advisory: true });
  });
});
