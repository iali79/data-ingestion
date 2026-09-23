import { describe, expect, it } from 'vitest';
import {
  EXTRACTOR_VERSION,
  LIMITS,
  SCHEMA_VERSION,
  selectEvidencePages,
  statementStatus,
  toActionPayload,
  toLinePayload,
  type ClaimedTask,
} from '../src/contract.js';
import { DocumentExtractionError } from '../src/errors.js';
import { assertAllowedDocumentUrl } from '../src/http.js';
import { parseFinancialStatements } from '../src/parser.js';
import { processTask } from '../src/process.js';

describe('derived ratio lines', () => {
  it('adds margin and tax-rate percentages with no currency', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nRevenue 1,000\nGross profit 400\nOperating profit 250\nProfit before taxation 200\nTaxation 58\nProfit after taxation 142`,
      { periodLabel: '2025' },
    );
    const byItem = new Map(parsed.promoted.map((line) => [line.canonicalLineItem, line]));
    expect(byItem.get('gross_margin_pct')?.value).toBe(40);
    expect(byItem.get('operating_margin_pct')?.value).toBe(25);
    expect(byItem.get('net_margin_pct')?.value).toBe(14.2);
    expect(byItem.get('tax_rate_pct')?.value).toBe(29);
    expect(byItem.get('tax_rate_pct')?.currency).toBeNull();
    expect(byItem.get('tax_rate_pct')?.unitScale).toBe(1);
  });

  it('omits a tax rate on a pre-tax loss instead of emitting a nonsense percentage', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nProfit before taxation (200)\nTaxation 30`,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted.some((line) => line.canonicalLineItem === 'tax_rate_pct')).toBe(false);
  });
});

describe('document host allowlist', () => {
  it('accepts only https PSX hosts', () => {
    expect(assertAllowedDocumentUrl('https://financials.psx.com.pk/lib/DownloadPDF.php?id=1').hostname).toBe(
      'financials.psx.com.pk',
    );
    expect(assertAllowedDocumentUrl('https://dps.psx.com.pk/download/attachment/1.pdf').hostname).toBe('dps.psx.com.pk');
  });

  it.each([
    'http://financials.psx.com.pk/lib/DownloadPDF.php?id=1',
    'https://financials.psx.com.pk.evil.example/x.pdf',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertAllowedDocumentUrl(url)).toThrow(DocumentExtractionError);
  });

  it('rejects an allowed host carrying embedded credentials', () => {
    const url = new URL('https://financials.psx.com.pk/x.pdf');
    url.username = 'someone';
    url.password = 'anything';
    expect(() => assertAllowedDocumentUrl(url.toString())).toThrow(DocumentExtractionError);
  });

  it('fails a task whose URL is off the allowlist without downloading anything', async () => {
    const task: ClaimedTask = {
      id: '1',
      kind: 'financial_statement',
      sourceUrl: 'https://example.com/report.pdf',
      context: { symbol: 'ABC', reportType: 'annual', periodEnded: '2025' },
      leaseToken: 'x'.repeat(64),
      leaseExpiresAt: new Date().toISOString(),
    };
    const result = await processTask(task);
    expect(result).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      outcome: 'failed',
      error: { code: 'host_not_allowed' },
    });
  });
});

describe('contract shaping', () => {
  it('serialises a line with an ISO date and capped strings', () => {
    const payload = toLinePayload({
      statementType: 'income_statement',
      canonicalLineItem: 'revenue',
      consolidationBasis: 'consolidated',
      label: 'x'.repeat(500),
      periodLabel: '2025-06-30',
      periodEnd: new Date('2025-06-30T00:00:00Z'),
      value: 12_000_000.123456,
      currency: 'PKR',
      unitScale: 1_000,
      confidence: 0.912345,
      sourcePage: 3,
      sourceText: 'y'.repeat(5_000),
    });
    expect(payload.periodEnd).toBe('2025-06-30');
    expect(payload.label).toHaveLength(LIMITS.labelChars);
    expect(payload.sourceText).toHaveLength(LIMITS.sourceTextChars);
    expect(payload.value).toBe(12_000_000.1235);
    expect(payload.confidence).toBe(0.9123);
  });

  it('keeps cited pages first when a filing exceeds the page cap', () => {
    const pages = Array.from({ length: 200 }, (_, index) => ({
      pageNumber: index + 1,
      method: 'pdftotext',
      text: 'p',
      confidence: 0.9,
    }));
    const document = { kind: 'pdf' as const, method: 'pdftotext', contentType: null, text: '', confidence: 0.9, pages };
    const line = { sourcePage: 190 } as ReturnType<typeof toLinePayload>;
    const kept = selectEvidencePages(document, [line]);
    expect(kept).toHaveLength(LIMITS.pages);
    expect(kept.some((page) => page.pageNumber === 190)).toBe(true);
  });

  it('maps corporate actions onto exactly one detail key, dropping out-of-range values', () => {
    const base = { symbol: 'ABC', eventDate: new Date(), exDate: new Date('2026-09-05T00:00:00Z'), confidence: 0.82, sourceText: 's' };
    expect(toActionPayload({ ...base, actionType: 'dividend', details: { dividendPercent: 20, other: 1 } })).toEqual({
      actionType: 'dividend',
      exDate: '2026-09-05',
      details: { dividendPercent: 20 },
      confidence: 0.82,
      sourceText: 's',
    });
    expect(toActionPayload({ ...base, actionType: 'split', details: { splitRatio: '2:1' } })?.details).toEqual({
      splitRatio: '2:1',
    });
    expect(toActionPayload({ ...base, actionType: 'bonus', details: { bonusPercent: 50_000 } })).toBeNull();
    expect(toActionPayload({ ...base, actionType: 'split', details: { splitRatio: '2;drop' } })).toBeNull();
  });

  it('classifies statement completeness with the historical thresholds', () => {
    const line = (statementType: 'income_statement' | 'balance_sheet' | 'cash_flow') =>
      ({ statementType }) as Parameters<typeof statementStatus>[0][number];
    const full = [line('income_statement'), line('income_statement'), line('balance_sheet'), line('balance_sheet'), line('cash_flow')];
    expect(statementStatus(full, 5, 'pdf')).toBe('complete');
    expect(statementStatus([line('income_statement')], 3, 'pdf')).toBe('partial');
    expect(statementStatus([], 3, 'pdf')).toBe('low_confidence');
    expect(statementStatus([], 0, 'pdf')).toBe('failed');
  });
});
