import { describe, expect, it } from 'vitest';
import type { DocumentAnalysis, PageAnalysis } from '../src/pipeline/analyse.js';
import { classifyPages } from '../src/pipeline/classify.js';
import { matchRows, normalizeLabel } from '../src/pipeline/labels.js';
import { buildStatementTable, describeColumns, parseFigure, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
import type { PageTables, TableCell } from '../src/pipeline/tables.js';
import { fromSidecar } from '../src/pipeline/tables.js';
import { applyChecks, confirmTotals, valuesFromMatches, type Drop } from '../src/pipeline/validate.js';

function page(pageNumber: number, text: string, kind: PageAnalysis['kind'] = 'native'): PageAnalysis {
  return { pageNumber, kind, text, overlay: '', textSource: 'pdftotext', chars: text.length, imageCoverage: 0, width: 612, height: 792 };
}

const figures = (captions: string[]) => captions.map((caption, index) => `  ${caption.padEnd(40)} ${(index + 1) * 1_111},${String(index).padStart(3, '0')}   ${(index + 2) * 999},${String(index).padStart(3, '0')}`).join('\n');

describe('page classifier', () => {
  const analysis: DocumentAnalysis = {
    pageCount: 7,
    ms: 0,
    pages: [
      page(1, 'Annual Report 2023\n\nSix Years at a Glance\n' + figures(['Sales', 'Gross profit', 'Profit before tax', 'Total assets', 'Share capital', 'Net cash', 'Taxation'])),
      page(2, "INDEPENDENT AUDITOR'S REPORT\nWe have audited the accompanying statement of financial position,\nstatement of profit or loss, and statement of cash flows"),
      page(3, 'Statement of Financial Position\nAs at December 31, 2023\n                         Note     2023      2022\n' + figures(['NON-CURRENT ASSETS', 'Property, plant and equipment 3', 'Stock-in-trade   9', 'Trade debts', 'Cash and bank balances', 'TOTAL ASSETS', 'Share capital   16', 'CURRENT LIABILITIES', 'TOTAL EQUITY AND LIABILITIES'])),
      page(4, 'Statement of Profit or Loss\nFor the year ended December 31, 2023\n' + figures(['Revenue - net', 'Cost of sales', 'Gross profit', 'Profit before taxation', 'Taxation', 'Profit for the year', 'Earnings per share'])),
      page(5, 'Statement of Cash Flows\nFor the year ended December 31, 2023\n' + figures(['CASH FLOWS FROM OPERATING ACTIVITIES', 'Cash generated from operations', 'Net cash generated from operating activities', 'Net cash used in investing activities', 'Net cash used in financing activities', 'Cash and cash equivalents at the end of the year'])),
      page(6, 'Notes to the Financial Statements\n2.3  Property, plant and equipment\n     Accounting policy text.\n3    PROPERTY, PLANT AND EQUIPMENT\n     Operating fixed assets   3.1   1,000'),
      page(7, 'Notes\n9.   STOCK-IN-TRADE\n     Raw materials   1,000   2,000\n16   SHARE CAPITAL\n     Issued, subscribed and paid-up capital'),
    ],
  };
  const result = classifyPages(analysis);

  it('keeps the statements and the notes the balance sheet cites, nothing else', () => {
    expect(result.statements.map((item) => `${item.statementType}:${item.pages.join('+')}`)).toEqual(['balance_sheet:3', 'income_statement:4', 'cash_flow:5']);
    expect(result.notes.map((note) => `${note.topic}:${note.number}:${note.pages[0]}`).sort()).toEqual(['fixed_assets:3:6', 'share_capital:16:7', 'stock_in_trade:9:7']);
    expect(result.selectedPages).toEqual([3, 4, 5, 6, 7]);
  });

  it('never selects summary pages or titles inside a sentence', () => {
    expect(result.pages[0]!.selected).toBe(false);
    expect(result.pages[0]!.reasons.join()).toMatch(/summary/u);
    expect(result.pages[1]!.selected).toBe(false);
  });

  it('reads a title after a company name, as OCR prints a letterhead', () => {
    const scanned = classifyPages({ pageCount: 1, ms: 0, pages: [page(1, 'ADAM SUGAR MILLS LIMITED STATEMENT OF FINANCIAL POSITION\nAS AT SEPTEMBER 30, 2018\n2018 2017\nProperty, plant and equipment 6 1,814,627,166', 'scanned')] });
    expect(scanned.statements.map((item) => item.statementType)).toEqual(['balance_sheet']);
  });
});

function row(id: string, label: string, cells: string[], headings: string[] = [], ocr = false): StatementRow {
  return { id, page: 1, label, cells, values: cells.map(parseFigure), note: null, headings, ocr };
}

function table(rows: StatementRow[], statementType: StatementTable['statementType'] = 'income_statement'): StatementTable {
  return {
    statementType,
    basis: 'unknown',
    pages: [1],
    method: 'docling-pdf',
    title: '',
    unitScale: 1000,
    unitPrinted: true,
    columns: [{ index: 0, header: '2023', periodEnd: '2023-12-31', months: statementType === 'balance_sheet' ? 0 : 12, kept: true }],
    rows,
  problems: [],
  };
}

describe('labels', () => {
  it('normalises printed labels', () => {
    expect(normalizeLabel('Stock-in-trade - net')).toBe('stock-in-trade - net');
    expect(normalizeLabel('Trade debts- net')).toBe('trade debts - net');
    expect(normalizeLabel('Long-term loans:')).toBe('long-term loans');
  });

  it('matches specific wording first, by side and heading, and claims uncaptioned totals', () => {
    const rows = [
      row('r1', 'Property, plant and equipment', ['1,768,485'], ['ASSETS', 'NON-CURRENT ASSETS']),
      row('r2', 'Long-term deposits', ['15,983']),
      row('r3', '', ['1,784,468']),
      row('r4', 'Stock-in-trade', ['4,312,764'], ['CURRENT ASSETS']),
      row('r5', 'Cash and bank balances', ['331,484']),
      row('r6', '', ['4,644,248']),
      row('r7', 'TOTAL ASSETS', ['6,428,716']),
      row('r8', 'Share capital', ['96,448'], ['EQUITY AND LIABILITIES', 'SHARE CAPITAL AND RESERVES']),
      row('r9', 'Current maturity of lease liabilities', ['1,000'], ['CURRENT LIABILITIES']),
    ];
    const { matches, unmatched } = matchRows('balance', rows);
    const items = Object.fromEntries(matches.map((match) => [match.row.id, match.items.join()]));
    expect(items).toMatchObject({
      r1: 'net_ppe',
      r3: 'total_non_current_assets',
      r4: 'total_inventory',
      r5: 'cash_and_equivalents',
      r6: 'total_current_assets',
      r7: 'total_assets',
      r8: 'share_capital',
      r9: 'current_portion_lease_liabilities',
    });
    expect(unmatched.map((item) => item.label)).toEqual(['Long-term deposits']);
  });

  it('takes the uncaptioned total under split tax lines as taxation', () => {
    const rows = [
      row('a', 'PROFIT BEFORE TAXATION', ['276,363']),
      row('b', 'Taxation - Current', ['(408,584)']),
      row('c', 'Taxation - Deferred', ['79,389']),
      row('d', '', ['(329,195)']),
      row('e', 'EARNINGS PER SHARE - basic and diluted (Rupees)', ['(5.48)']),
    ];
    const items = matchRows('income', rows).matches.map((match) => `${match.row.id}:${match.items.join('+')}`);
    expect(items).toEqual(['a:profit_before_tax', 'd:taxation', 'e:eps_basic+eps_diluted']);
  });
});

describe('table repairs', () => {
  it('separates a heading fused onto its first row and closes the assets headings on the claims side', () => {
    const rows = [
      row('a', 'Stock-in-trade', ['4,312,764'], ['ASSETS', 'CURRENT ASSETS']),
      row('b', '', ['4,312,764']),
      row('c', 'TOTAL ASSETS', ['4,312,764']),
      row('d', 'Share capital', ['96,448'], ['EQUITY AND LIABILITIES', 'SHARE CAPITAL AND RESERVES']),
      row('e', 'Reserves', ['100']),
      row('f', '', ['96,548']),
    ];
    const items = Object.fromEntries(matchRows('balance', rows).matches.map((match) => [match.row.id, match.items.join()]));
    expect(items).toMatchObject({ b: 'total_current_assets', f: 'shareholders_equity' });
  });

  it('takes the exchange line only below the activity sections', () => {
    const rows = [
      row('a', 'Exchange loss - net', ['100'], ['CASH FLOWS FROM OPERATING ACTIVITIES']),
      row('b', 'Net cash generated from operating activities', ['1,000']),
      row('c', 'Net increase in cash and cash equivalents', ['1,000']),
      row('d', 'Net foreign exchange differences', ['(5)']),
    ];
    const items = Object.fromEntries(matchRows('cash_flow', rows).matches.map((match) => [match.row.id, match.items.join()]));
    expect(items.a).toBeUndefined();
    expect(items.d).toBe('fx_adjustments');
  });
});

describe('statement table from a cell grid', () => {
  const cell = (row: number, col: number, text: string, extra: Partial<TableCell> = {}): TableCell => ({ row, col, rowSpan: 1, colSpan: 1, text, columnHeader: false, rowHeader: false, rowSection: false, ...extra });
  const page: PageTables = {
    pageNumber: 10,
    method: 'docling-pdf',
    width: 612,
    height: 792,
    texts: [{ label: 'section_header', text: 'Statement of Cash Flows', bbox: [40, 40, 400, 60] }, { label: 'text', text: 'For the nine months ended September 30, 2025', bbox: [40, 62, 400, 75] }],
    tables: [
      {
        bbox: [40, 80, 580, 700],
        rows: 6,
        cols: 3,
        cells: [
          cell(0, 1, 'September 30, 2025', { columnHeader: true }),
          cell(0, 2, 'September 30,', { columnHeader: true }),
          cell(1, 0, 'Note'),
          cell(1, 1, "2024 ------ Rupees in '000 ------", { columnHeader: true, colSpan: 2 }),
          cell(2, 0, 'CASH FLOWS FROM FINANCING ACTIVITIES Dividends paid'),
          cell(2, 1, '(1,537,772)'),
          cell(2, 2, '(528,293)'),
          cell(3, 0, 'Lease rentals paid Net cash used in financing activities'),
          cell(3, 1, '(29,656) (1,567,428)'),
          cell(3, 2, '- (528,293)'),
          cell(4, 0, 'NET INCREASE IN CASH AND CASH EQUIVALENTS'),
          cell(4, 1, '(29,618)'),
          cell(4, 2, '(1,292,033)'),
        ],
      },
    ],
  };
  const table = buildStatementTable({ statementType: 'cash_flow', basis: 'unconsolidated', pages: [10] }, [page], { periodEnded: '2025-09-30', yearEndMonthDay: '-12-31' });

  it('gives a merged header cell\'s years to the columns under it', () => {
    expect(table.columns.map((column) => `${column.periodEnd}/${column.months}`)).toEqual(['2025-09-30/9', '2024-09-30/9']);
    expect(table.unitScale).toBe(1000);
  });

  it('splits a fused heading and a fused total row (R4b)', () => {
    expect(table.rows.map((item) => item.label)).toEqual(['Dividends paid', 'Lease rentals paid', 'Net cash used in financing activities', 'NET INCREASE IN CASH AND CASH EQUIVALENTS']);
    expect(table.rows[0]!.headings).toEqual(['CASH FLOWS FROM FINANCING ACTIVITIES']);
    expect(table.rows[2]!.values).toEqual([-1_567_428, -528_293]);
  });
});

describe('columns and figures', () => {
  it('dates year-to-date and quarter columns from their headers (C1-C4)', () => {
    const columns = describeColumns(
      ['Nine Months Ended September 30, 2023', 'Nine Months Ended September 30, 2022', 'Quarter Ended September 30, 2023', 'Quarter Ended September 30, 2022'],
      'Condensed Interim Statement of Profit or Loss For the nine-months period and quarter ended September 30, 2023',
      'income',
      { periodEnded: '2023-09-30' },
    );
    expect(columns.map((column) => `${column.periodEnd}/${column.months}`)).toEqual(['2023-09-30/9', '2022-09-30/9', '2023-09-30/3', '2022-09-30/3']);
  });

  it('takes the date and length from the title when the header prints only the year', () => {
    const columns = describeColumns(['2023', '2022'], 'Statement of Profit or Loss For the year ended December 31, 2023', 'income', { periodEnded: '2023' });
    expect(columns.map((column) => `${column.periodEnd}/${column.months}`)).toEqual(['2023-12-31/12', '2022-12-31/12']);
  });

  it('dates an interim column that prints no length from the year-end (C7) and drops duplicates (C6)', () => {
    const columns = describeColumns(['September 30, 2023', 'September 30, 2023'], 'Statement of Cash Flows', 'cash_flow', { periodEnded: '2023-09-30', yearEndMonthDay: '-12-31' });
    expect(columns.map((column) => `${column.months}:${column.kept}`)).toEqual(['9:false', '9:false']);
  });

  it('parses printed figures, trimming OCR residue but never guessing', () => {
    expect(parseFigure('(11,547,720)')).toBe(-11_547_720);
    expect(parseFigure('-')).toBe(0);
    expect(parseFigure('(5.48)')).toBe(-5.48);
    expect(parseFigure('1,244,944,640||')).toBe(1_244_944_640);
    expect(parseFigure('28,661,326,')).toBe(28_661_326);
    expect(parseFigure('(1;748,793,503)')).toBe(-1_748_793_503);
    expect(parseFigure('§94;104,443')).toBe(94_104_443);
    expect(parseFigure('2,48O,000')).toBeNull();
    expect(parseFigure('')).toBeNull();
  });
});

describe('validation', () => {
  const income = [
    row('s', 'NET SALES', ['15,879,229']),
    row('c', 'Cost of sales', ['(11,547,720)']),
    row('g', 'GROSS PROFIT', ['4,331,509']),
    row('d', 'Distribution and marketing costs', ['(1,951,719)']),
    row('a', 'Administrative expenses', ['(686,168)']),
    row('o', 'Other income', ['269,967']),
    row('t', '', ['(2,367,920)']),
    row('p', 'OPERATING PROFIT', ['1,963,589']),
  ];

  it('confirms running totals by arithmetic (A1)', () => {
    const confirmed = confirmTotals(table(income));
    expect([...confirmed.keys()].sort()).toEqual(['a', 'c', 'd', 'g', 'o', 'p', 's', 't']);
  });

  it('does not confirm a total that does not add up', () => {
    const broken = income.map((item) => (item.id === 'g' ? row('g', 'GROSS PROFIT', ['4,331,590']) : item));
    const confirmed = confirmTotals(table(broken));
    expect(confirmed.has('s')).toBe(false);
  });

  it('drops the values of a failed identity (I1) and keeps expenses positive (U3)', () => {
    const rows = [row('s', 'Revenue', ['1,000']), row('c', 'Cost of sales', ['(600)']), row('g', 'Gross profit', ['500'])];
    const t = table(rows);
    const drops: Drop[] = [];
    const values = valuesFromMatches('income', t, matchRows('income', rows).matches, new Map(), drops);
    expect(values.find((value) => value.key === 'cost_of_sales')?.value).toBe(600_000);
    const kept = applyChecks(values, [t], drops);
    expect(kept).toEqual([]);
    expect(drops.map((drop) => drop.reason)).toEqual([expect.stringMatching(/^I1/u)]);
  });

  it('delivers an OCR figure only when a check confirms it (V5)', () => {
    const rows = [row('s', 'Sales - net', ['3,762,793,904'], [], true), row('c', 'Cost of sales', ['(3,658,075,471)'], [], true), row('f', 'Finance cost', ['(108,547,214)'], [], true)];
    const t = { ...table(rows), method: 'docling-ocr' as const, unitScale: 1 };
    const drops: Drop[] = [];
    const values = valuesFromMatches('income', t, matchRows('income', rows).matches, confirmTotals(t), drops);
    const kept = applyChecks(values, [t], drops);
    expect(kept).toEqual([]);
    expect(drops.every((drop) => drop.reason.startsWith('V5'))).toBe(true);
  });
});

describe('sidecar output', () => {
  it('maps pages back to the filing', () => {
    const empty = { width: 612, height: 792, texts: [], tables: [] };
    const mapped = fromSidecar(
      { schemaVersion: 1, native: [{ index: 1, ...empty }, { index: 2, ...empty }], images: [{ file: 'scan-25.png', ...empty }], seconds: {} },
      { nativePdf: 'native.pdf', nativePages: [45, 46], images: [{ file: '/tmp/x/scan-25.png', pageNumber: 25 }] },
    );
    expect(mapped.pages.map((item) => `${item.pageNumber}:${item.method}`)).toEqual(['25:docling-ocr', '45:docling-pdf', '46:docling-pdf']);
  });
});
