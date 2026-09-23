import { describe, expect, it } from 'vitest';
import { detectDocumentKind, extractDocument } from '../src/extraction.js';
import {
  parseCorporateActionsFromText,
  parseFinancialStatements,
} from '../src/parser.js';

describe('financial statement parsing', () => {
  it('promotes clear statement lines and applies report units', () => {
    const parsed = parseFinancialStatements(
      `
      Statement of Profit or Loss
      Amounts in thousand
      Revenue                         12,000
      Profit after taxation            1,500
      Earnings per share                2.25

      Statement of Financial Position
      Total assets                     30,000
      Total liabilities                10,000
      Shareholders equity              20,000

      Statement of Cash Flows
      Net cash generated from operating activities 700
      Net cash used in investing activities (300)
      Net cash generated from financing activities 100
      `,
      { periodLabel: '2025', periodEnd: new Date('2025-06-30T00:00:00Z') },
    );

    expect(parsed.promoted.map((line) => line.canonicalLineItem)).toEqual(
      expect.arrayContaining([
        'revenue',
        'profit_after_tax',
        'eps_basic',
        'total_assets',
        'total_liabilities',
        'total_equity',
        'operating_cash_flow',
        'investing_cash_flow',
        'financing_cash_flow',
      ]),
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'revenue')?.value).toBe(12_000_000);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'investing_cash_flow')?.value).toBe(-300_000);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'eps_basic')?.value).toBe(2.25);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'eps_basic')?.unitScale).toBe(1);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'revenue')?.consolidationBasis).toBe('unknown');
  });

  it('uses the current-period column instead of the trailing comparative value', () => {
    const parsed = parseFinancialStatements(
      `
      Statement of Profit or Loss
      Amounts in thousand
                                  2025       2024
      Revenue                14  12,000     10,000
      Profit after taxation  22   1,500      1,100
      Earnings per share           2.25       1.75
      `,
      { periodLabel: '2025' },
    );

    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'revenue')?.value).toBe(12_000_000);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'profit_after_tax')?.value).toBe(1_500_000);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'eps_basic')?.value).toBe(2.25);
  });

  it('honors a reversed comparative header', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nAmounts in million\n2024 2025\nRevenue 10,000 12,000`,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'revenue')?.value).toBe(12_000_000_000);
  });

  it('keeps low-confidence OCR evidence out of promoted values', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nRevenue 12,000\nProfit after taxation 1,500`,
      { periodLabel: '2025', pageConfidences: [0.64] },
    );
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.promoted).toEqual([]);
  });

  it('keeps page confidence aligned across consecutive blank PDF pages', () => {
    const parsed = parseFinancialStatements(
      `\f\fStatement of Financial Position\n(Rupees ‘000)\n2025 2024\nTotal assets 30,000 28,000\nTotal liabilities 10,000 9,000`,
      { periodLabel: '2025', pageConfidences: [0.35, 0.35, 0.9] },
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'total_assets')?.value).toBe(30_000_000);
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'total_equity')?.value).toBe(20_000_000);
  });

  it('does not promote statement-like wording from the notes section', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nRevenue 12,000\nProfit after taxation 1,500\nNotes to and forming part of the financial statements\nProfit before tax would have been higher by 27`,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted.map((line) => line.canonicalLineItem)).not.toContain('profit_before_tax');
  });

  it('recognizes generated-from-or-used-in cash-flow totals', () => {
    const parsed = parseFinancialStatements(
      `Statement of Cash Flows\n(Rupees '000)\n2025 2024\nNet cash generated from / (used in) operating activities 6,090,175 2,100,000\nNet cash generated from / (used in) investing activities (1,693,390) (800,000)\nNet cash generated from / (used in) financing activities (1,907,925) (900,000)`,
      { periodLabel: '2025' },
    );

    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'operating_cash_flow')?.value).toBe(
      6_090_175_000,
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'investing_cash_flow')?.value).toBe(
      -1_693_390_000,
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'financing_cash_flow')?.value).toBe(
      -1_907_925_000,
    );
  });

  it('keeps ambiguous lines out of promoted output', () => {
    const parsed = parseFinancialStatements('Revenue 12000\nTotal assets 30000', { periodLabel: '2025' });
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.promoted).toEqual([]);
  });

  it('promotes the expanded income-statement taxonomy without letting "taxation" swallow PBT/PAT', () => {
    const parsed = parseFinancialStatements(
      `
      Statement of Profit or Loss
      Amounts in million
      Revenue                              50,000
      Cost of sales                        30,000
      Gross profit                         20,000
      Distribution cost                     2,000
      Administrative expenses               3,000
      Other operating expenses                500
      Other income                            800
      Operating profit                     15,300
      Interest income                         400
      Finance cost                          1,200
      Profit before taxation               14,500
      Taxation                              4,000
      Profit after taxation                10,500
      Preference dividend                     200
      Earnings per share - basic               8.5
      Earnings per share - diluted             8.1
      `,
      { periodLabel: '2025' },
    );

    const byItem = new Map(parsed.promoted.map((line) => [line.canonicalLineItem, line.value]));
    expect(byItem.get('cost_of_sales')).toBe(30_000_000_000);
    expect(byItem.get('distribution_cost')).toBe(2_000_000_000);
    expect(byItem.get('admin_expenses')).toBe(3_000_000_000);
    expect(byItem.get('other_operating_expenses')).toBe(500_000_000);
    expect(byItem.get('other_income')).toBe(800_000_000);
    expect(byItem.get('interest_income')).toBe(400_000_000);
    expect(byItem.get('preferred_dividends')).toBe(200_000_000);
    // "Taxation" must not have hijacked "Profit before/after taxation" -- both keep their own
    // canonical items, and the generic tax-expense line lands separately.
    expect(byItem.get('profit_before_tax')).toBe(14_500_000_000);
    expect(byItem.get('profit_after_tax')).toBe(10_500_000_000);
    expect(byItem.get('taxation')).toBe(4_000_000_000);
    // "Diluted" must win over the generic EPS alias regardless of which line comes first.
    expect(byItem.get('eps_basic')).toBe(8.5);
    expect(byItem.get('eps_diluted')).toBe(8.1);

    // Derived: selling_admin (distribution + admin), operating_expenses (gross - operating),
    // and net_interest_income (interest income - finance cost).
    expect(byItem.get('selling_admin_expenses')).toBe(5_000_000_000);
    expect(byItem.get('operating_expenses')).toBe(4_700_000_000);
    expect(byItem.get('net_interest_income')).toBe(-800_000_000);
  });

  it('recognizes a combined selling-and-administrative-expenses line without double counting', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nGross profit 20,000\nSelling and administrative expenses 5,000\nOperating profit 15,000`,
      { periodLabel: '2025' },
    );
    const byItem = new Map(parsed.promoted.map((line) => [line.canonicalLineItem, line.value]));
    expect(byItem.get('selling_admin_expenses')).toBe(5_000);
    expect(byItem.has('distribution_cost')).toBe(false);
    expect(byItem.has('admin_expenses')).toBe(false);
  });

  it('derives EBITDA from operating profit and D&A when not stated directly', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nOperating profit 15,000\nDepreciation and amortisation 2,000`,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'ebitda')?.value).toBe(17_000);
  });

  it('prefers a directly-stated EBITDA over the derived one', () => {
    const parsed = parseFinancialStatements(
      `Statement of Profit or Loss\nOperating profit 15,000\nDepreciation and amortisation 2,000\nEBITDA 18,000`,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted.find((line) => line.canonicalLineItem === 'ebitda')?.value).toBe(18_000);
  });

  it('keeps consolidated and unconsolidated figures for the same period as separate rows', () => {
    const parsed = parseFinancialStatements(
      `
      CONSOLIDATED FINANCIAL STATEMENTS
      Consolidated Statement of Profit or Loss
      Profit after taxation 12,000

      UN-CONSOLIDATED FINANCIAL STATEMENTS
      Statement of Profit or Loss
      Profit after taxation 9,000
      `,
      { periodLabel: '2025' },
    );
    const consolidated = parsed.promoted.filter(
      (line) => line.canonicalLineItem === 'profit_after_tax' && line.consolidationBasis === 'consolidated',
    );
    const unconsolidated = parsed.promoted.filter(
      (line) => line.canonicalLineItem === 'profit_after_tax' && line.consolidationBasis === 'unconsolidated',
    );
    expect(consolidated.map((line) => line.value)).toEqual([12_000]);
    expect(unconsolidated.map((line) => line.value)).toEqual([9_000]);
  });

  it('reads the basis restated on the statement header itself over a stale document banner', () => {
    const parsed = parseFinancialStatements(
      `
      CONSOLIDATED FINANCIAL STATEMENTS
      Un-Consolidated Statement of Profit or Loss
      Profit after taxation 9,000
      `,
      { periodLabel: '2025' },
    );
    expect(parsed.promoted[0]?.consolidationBasis).toBe('unconsolidated');
  });
});

describe('corporate action parsing', () => {
  it('extracts dividends, bonus shares, right shares, and splits', () => {
    const parsed = parseCorporateActionsFromText(
      'Cash dividend 20% Bonus shares 10% Right shares 15% Split 2:1 Ex-date 05 Sep 2026',
      { symbol: 'ABC', announcedAt: new Date('2026-09-01T10:00:00Z') },
    );

    expect(parsed.map((item) => item.actionType)).toEqual(['dividend', 'bonus', 'right', 'split']);
    expect(parsed[0]?.exDate?.toISOString().slice(0, 10)).toBe('2026-09-05');
  });
});

describe('document type detection', () => {
  it('detects common report formats from magic bytes, headers, and extensions', () => {
    expect(detectDocumentKind(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(detectDocumentKind(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image');
    expect(detectDocumentKind(Buffer.from('a,b\n1,2'), { url: 'https://x.test/report.csv' })).toBe('csv');
    expect(detectDocumentKind(Buffer.from('<table><tr><td>Revenue</td></tr></table>'))).toBe('html');
    expect(detectDocumentKind(Buffer.from([0x50, 0x4b, 0x03, 0x04]), { url: 'https://x.test/report.xlsx' })).toBe('spreadsheet');
    expect(detectDocumentKind(Buffer.from([0x50, 0x4b, 0x03, 0x04]), { url: 'https://x.test/report.docx' })).toBe('unsupported');
    expect(detectDocumentKind(Buffer.from([0, 1, 2, 3]))).toBe('unsupported');
  });

  it('extracts HTML and XLSX rows into parseable text', async () => {
    const html = await extractDocument(Buffer.from('<table><tr><td>Revenue</td><td>120</td></tr></table>'), {
      contentType: 'text/html',
    });
    expect(html.text).toContain('Revenue 120');

    const XLSX = await import('@e965/xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Revenue', 120]]), 'Income');
    const xlsx = await extractDocument(Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })), {
      url: 'https://x.test/report.xlsx',
    });
    expect(xlsx.text).toContain('Revenue,120');
  });
});
