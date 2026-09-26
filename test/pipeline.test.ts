import { describe, expect, it } from 'vitest';
import type { DocumentAnalysis, PageAnalysis } from '../src/pipeline/analyse.js';
import { compare } from '../src/crosscheck.js';
import { classifyPages } from '../src/pipeline/classify.js';
import { matchRows, normalizeLabel } from '../src/pipeline/labels.js';
import { buildStatementTable, describeColumns, expandShortDates, parseFigure, splitSideBySide, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
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

  it('reads a wrapped combined title, the older account wording and a title under a running header', () => {
    const types = (text: string) => classifyPages({ pageCount: 1, ms: 0, pages: [page(1, text)] }).statements.map((item) => item.statementType);
    const income = figures(['Sales - net', 'Cost of sales', 'Gross profit', 'Profit before taxation', 'Taxation', 'Profit for the year', 'Earnings per share']);
    expect(types('STATEMENT OF PROFIT OR LOSS AND\nOTHER COMPREHENSIVE INCOME\nFOR THE YEAR ENDED JUNE 30, 2026\n' + income)).toEqual(['income_statement']);
    expect(types('SALLY TEXTILE MILLS LIMITED Condensed Interim Profit Or Loss Account (Un-audited)\n' + income)).toEqual(['income_statement']);
    expect(types('ANNUAL REPORT 2025 STATEMENT OF FINANCIAL POSITION\nAS AT DECEMBER 31, 2025\n' + figures(['NON-CURRENT ASSETS', 'Property, plant and equipment', 'Stock-in-trade', 'Trade debts', 'TOTAL ASSETS', 'Share capital', 'CURRENT LIABILITIES', 'TOTAL EQUITY AND LIABILITIES']))).toEqual(['balance_sheet']);
    // Still not a title: the auditor's sentence, and the combined title followed by prose.
    expect(types('We have audited the statement of profit or loss and other comprehensive income, and notes\n' + income)).toEqual([]);
  });

  it('reads a title followed by a bracketed "[unaudited]" and one printed twice over itself', () => {
    const types = (text: string) => classifyPages({ pageCount: 1, ms: 0, pages: [page(1, text)] }).statements.map((item) => `${item.statementType}:${item.basis}`);
    const income = figures(['Sales - net', 'Royalty', 'Gross profit', 'Profit before taxation', 'Taxation', 'Profit for the period', 'Earnings per share']);
    expect(types('Condensed Interim Statement of Profit or Loss [unaudited]\nFor the Quarter ended 30 September 2025\n' + income)).toEqual(['income_statement:unknown']);
    // UBL H1 2026, p.50 as pdftotext -layout reads it.
    const balance = figures(['Cash and balances with treasury banks', 'Advances', 'Other assets', 'TOTAL ASSETS', 'Deposits and other accounts', 'Share capital', 'Other liabilities']);
    expect(types('CONSOLIDATED\nCONSOLIDATED       CONDENSED\n               CONDENSED INTERIM INTERIM  STATEMENT\n                                 STATEMENT OF FINANCIAL OF  FINANCIAL POSITION\n                                                       POSITION\nAS AT\nAS AT JUNE\n' + balance)).toEqual(['balance_sheet:consolidated']);
    // Words kept once never make a title out of a page that has none.
    expect(types('NOTES TO THE CONSOLIDATED FINANCIAL STATEMENTS\nSTATEMENT OF FINANCIAL POSITION items\n' + balance)).toEqual([]);
  });

  it('follows a balance sheet that prints equity and liabilities before its assets', () => {
    // OGDC Q1 FY2026: p.9 ends at "TOTAL LIABILITIES", the assets are overleaf.
    const result = classifyPages({
      pageCount: 3,
      ms: 0,
      pages: [
        page(1, 'Condensed Interim Statement of Financial Position [unaudited]\nAs at 30 September 2025\n' + figures(['Share capital', 'Reserves', 'Unappropriated profit', 'NON CURRENT LIABILITIES', 'Deferred taxation', 'CURRENT LIABILITIES', 'Trade and other payables', 'TOTAL LIABILITIES'])),
        page(2, '                     Unaudited   Audited\n' + figures(['NON CURRENT ASSETS', 'Property, plant and equipment', 'CURRENT ASSETS', 'Trade debts', 'Cash and bank balances', 'Other receivables'])),
        page(3, 'Condensed Interim Statement of Profit or Loss [unaudited]\n' + figures(['Sales - net', 'Royalty', 'Gross profit', 'Profit before taxation', 'Taxation', 'Profit for the period'])),
      ],
    });
    expect(result.statements.map((item) => `${item.statementType}:${item.pages.join('+')}`)).toEqual(['balance_sheet:1+2', 'income_statement:3']);
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

  it('gives a heading only the uncaptioned total its rows add up to (R3)', () => {
    const rows = [
      row('a1', 'Property, plant and equipment', ['1,768,485'], ['ASSETS', 'NON-CURRENT ASSETS']),
      row('a2', 'Intangible assets', ['14,012']),
      row('a3', '', ['1,782,497']),
      row('a4', 'Long-term deposits', ['15,983']),
      row('a5', '', ['1,798,480']),
      row('e1', '25,000,000 ordinary shares of Rs 10/= each', ['250,000,000'], ['EQUITY AND LIABILITIES', 'Share capital and reserves', 'Authorized Capital']),
      row('e2', 'Issued, subscribed and paid up capital', ['172,909,620']),
      row('e3', 'Accumulated profit', ['185,203,797']),
      row('e4', '', ['358,113,417']),
      row('c1', 'Short term borrowings', ['1,233,855,153'], ['CURRENT LIABILITIES']),
      row('c2', 'Accrued markup', ['26,176,195']),
      row('c3', '', ['1,260,031,348']),
      row('c4', 'Contingencies and commitments', ['-']),
      row('c5', '', ['3,700,987,123']),
    ];
    const items = Object.fromEntries(matchRows('balance', rows).matches.map((match) => [match.row.id, match.items.join()]));
    // The fixed-assets subtotal (a3) adds up too, but the last row that adds up closes the heading.
    expect(items.a3).toBeUndefined();
    expect(items.a5).toBe('total_non_current_assets');
    // Authorised capital is printed under equity but is not part of it.
    expect(items.e4).toBe('shareholders_equity');
    // The grand total below "Contingencies" is not the current liabilities.
    expect(items.c3).toBe('total_current_liabilities');
    expect(items.c5).toBeUndefined();
  });

  it('knows the wording PSX filings print for tax, levies, EPS, Islamic financing and older lease terms', () => {
    const cases: Array<[Parameters<typeof matchRows>[0], string, string, string[]]> = [
      ['income', 'Income tax (expense) / credit', 'taxation', []],
      ['income', 'Taxation (charge) / credit', 'taxation', []],
      ['income', 'Levies - minimum and final taxes', 'levies', []],
      ['income', 'Minimum tax differential', 'levies', []],
      ['income', 'Basic and diluted earnings per share', 'eps_basic+eps_diluted', []],
      ['income', 'Direct costs', 'cost_of_sales', []],
      ['income', 'Profit on bank deposits', 'interest_income', []],
      ['income', 'Mark-up / return / interest earned', 'interest_income', []],
      ['income', 'Mark-up / return / interest expensed', 'finance_cost', []],
      ['balance', 'Paid-up capital', 'share_capital', ['EQUITY AND LIABILITIES', 'SHARE CAPITAL AND RESERVES']],
      ['balance', 'Unappropriated profit / (accumulated loss)', 'retained_earnings', ['EQUITY AND LIABILITIES', 'SHARE CAPITAL AND RESERVES']],
      ['balance', 'Diminishing musharaka', 'long_term_debt_excl_leases', ['EQUITY AND LIABILITIES', 'NON-CURRENT LIABILITIES']],
      ['balance', 'Liabilities against assets subject to finance lease', 'lease_liabilities_non_current', ['EQUITY AND LIABILITIES', 'NON-CURRENT LIABILITIES']],
      ['balance', 'Current portion of liabilities against assets subject to finance lease', 'current_portion_lease_liabilities', ['EQUITY AND LIABILITIES', 'CURRENT LIABILITIES']],
      ['balance', 'Short-term finances', 'short_term_borrowings', ['EQUITY AND LIABILITIES', 'CURRENT LIABILITIES']],
      ['cash_flow', 'Profit received on bank deposits', 'cf_interest_income', ['CASH FLOWS FROM OPERATING ACTIVITIES']],
      ['cash_flow', 'Sale proceeds of property, plant and equipment', 'sale_of_assets', ['CASH FLOWS FROM INVESTING ACTIVITIES']],
    ];
    for (const [kind, label, item, headings] of cases) {
      const found = matchRows(kind, [row('r', label, ['1'], headings)]).matches[0]?.items.join('+');
      expect(found, label).toBe(item);
    }
    // The subtotal before levies is not profit before tax (which is after levies), nor is a levy line.
    expect(matchRows('income', [row('r', 'Profit before levies and income tax', ['1'])]).matches).toEqual([]);
    expect(matchRows('income', [row('r', 'Levy', ['1'])]).matches[0]?.items).toEqual(['levies']);
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

describe('an OCR table whose first rows mix headings and column headers', () => {
  const cell = (row: number, col: number, text: string, extra: Partial<TableCell> = {}): TableCell => ({ row, col, rowSpan: 1, colSpan: 1, text, columnHeader: false, rowHeader: false, rowSection: false, ...extra });
  const page: PageTables = {
    pageNumber: 25,
    method: 'docling-ocr',
    width: 648,
    height: 828,
    texts: [{ label: 'section_header', text: 'ADAM SUGAR MILLS LIMITED STATEMENT OF FINANCIAL POSITION AS AT SEPTEMBER 30, 2018', bbox: [77, 98, 224, 126] }],
    tables: [
      {
        bbox: [75, 127, 579, 643],
        rows: 5,
        cols: 4,
        cells: [
          cell(0, 0, 'ASSETS'),
          cell(0, 1, 'Note', { columnHeader: true }),
          cell(0, 2, '2018 =£————————__', { columnHeader: true }),
          cell(0, 3, '2017 Rupees', { columnHeader: true }),
          cell(1, 0, 'Non-current assets'),
          cell(1, 3, '(Restated)'),
          cell(2, 0, 'Property, plant and equipment'),
          cell(2, 1, '6'),
          cell(2, 2, '1,814,627,166'),
          cell(2, 3, '= 1,580,825,659'),
          cell(3, 0, 'Long term deposits'),
          cell(3, 2, '32,400'),
          cell(3, 3, '32,400.'),
          cell(4, 2, '1,814,659,566'),
          cell(4, 3, '1,580,858,059'),
        ],
      },
    ],
  };
  const table = buildStatementTable({ statementType: 'balance_sheet', basis: 'unknown', pages: [25] }, [page], { periodEnded: '2018-09-30', yearEndMonthDay: null });

  it('reads the column headers beside the heading and keeps the headings', () => {
    expect(table.columns.map((column) => column.periodEnd)).toEqual(['2018-09-30', '2017-09-30']);
    expect(table.rows[0]!.label).toBe('Property, plant and equipment');
    expect(table.rows[0]!.headings).toEqual(['ASSETS', 'Non-current assets']);
  });
});

describe('header dates and side-by-side tables', () => {
  it('reads short header dates as full dates', () => {
    expect(expandShortDates('30-Jun-23 Rupees')).toBe('June 30, 2023 Rupees');
    expect(expandShortDates('30 Sep 2025')).toBe('September 30, 2025');
    expect(expandShortDates('31.12.2025')).toBe('December 31, 2025');
    expect(expandShortDates('1,234,567')).toBe('1,234,567');
    expect(describeColumns(['30-Jun-25', '30-Jun-24'], 'STATEMENT OF FINANCIAL POSITION', 'balance', { periodEnded: '2025' }).map((column) => column.periodEnd)).toEqual(['2025-06-30', '2024-06-30']);
  });

  it('splits a balance sheet printed in two halves into assets first, then equity and liabilities', () => {
    const cell = (row: number, col: number, text: string, columnHeader = false): TableCell => ({ row, col, rowSpan: 1, colSpan: 1, text, columnHeader, rowHeader: false, rowSection: false });
    const rows = ['Share capital|100|90|Property, plant|300|280', 'Reserves|50|40|Stock in trade|60|50', 'Trade payables|210|200|Cash and bank|0|0', 'Total|360|330|Total|360|330'];
    const table = {
      bbox: [0, 0, 800, 400] as [number, number, number, number],
      rows: rows.length + 1,
      cols: 6,
      cells: [
        cell(0, 0, 'EQUITY & LIABILITIES', true), cell(0, 1, '2023', true), cell(0, 2, '2022', true), cell(0, 3, 'ASSETS', true), cell(0, 4, '2023', true), cell(0, 5, '2022', true),
        ...rows.flatMap((line, index) => line.split('|').map((text, col) => cell(index + 1, col, text))),
      ],
    };
    const [first, second] = splitSideBySide(table);
    expect(first!.cells.find((item) => item.row === 1 && item.col === 0)?.text).toBe('Property, plant');
    expect(second!.cells.find((item) => item.row === 1 && item.col === 0)?.text).toBe('Share capital');
    expect(first!.cols).toBe(3);
    expect(splitSideBySide({ ...table, cells: table.cells.filter((item) => item.col < 3), cols: 3 })).toHaveLength(1);

    // The two halves come from one page: their rows keep distinct ids, or a cell could not be named
    // and one half's arithmetic would confirm the other's rows.
    const statement = buildStatementTable(
      { statementType: 'balance_sheet', basis: 'unconsolidated', pages: [5] },
      [{ pageNumber: 5, method: 'docling-pdf', width: 800, height: 600, texts: [{ label: 'section_header', text: 'Statement of Financial Position as at June 30, 2023', bbox: [0, 0, 400, 20] }], tables: [table] }],
      { periodEnded: '2023-06-30' },
    );
    const idsOf = statement.rows.map((item) => item.id);
    expect(idsOf.length).toBe(8);
    expect(new Set(idsOf).size).toBe(idsOf.length);
    expect(idsOf.slice(4)).toEqual(['p5.t1.r1', 'p5.t1.r2', 'p5.t1.r3', 'p5.t1.r4']);
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

  it('reads a month-range header as the period it spans (C10)', () => {
    // UBL's half-year profit and loss prints no "months ended": every column took the title's six
    // months, the quarter and half-year columns collided, and C6 dropped all four.
    const columns = describeColumns(
      ['April - June 2026', 'April - June 2025', 'January - June 2026', 'January - June 2025'],
      'UNCONSOLIDATED CONDENSED INTERIM PROFIT AND LOSS ACCOUNT (UN-AUDITED) FOR THE SIX MONTHS ENDED JUNE 30, 2026',
      'income',
      { periodEnded: '2026-06-30', yearEndMonthDay: '-12-31' },
    );
    expect(columns.map((column) => `${column.periodEnd}/${column.months}/${column.kept}`)).toEqual([
      '2026-06-30/3/true', '2025-06-30/3/true', '2026-06-30/6/true', '2025-06-30/6/true',
    ]);
    const nine = describeColumns(['Jul-Mar 2026', 'Jan-Mar 2026', 'July 2025 to June 2026'], 'Profit and loss account', 'income', { periodEnded: '2026-03-31' });
    expect(nine.map((column) => `${column.periodEnd}/${column.months}`)).toEqual(['2026-03-31/9', '2026-03-31/3', '2026-06-30/12']);
    // A range that disagrees with a printed phrase has no length it can be trusted for.
    expect(describeColumns(['Quarter ended April - June 2026'], 'P&L', 'income', { periodEnded: '2026-06-30' })[0]!.months).toBe(3);
    expect(describeColumns(['Six months January - March 2026'], 'P&L', 'income', { periodEnded: '2026-03-31' })[0]!.months).toBeNull();
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
    // Two figures fused into one cell are unreadable, never glued into a third number.
    expect(parseFigure('8 45,533,482')).toBeNull();
    expect(parseFigure('- 1,289')).toBeNull();
    expect(parseFigure('3 6,279')).toBeNull();
    expect(parseFigure('( 18,320,291 )')).toBe(-18_320_291);
    expect(parseFigure('( 18,320,291)')).toBe(-18_320_291);
    expect(parseFigure('(1;748,793,503)')).toBe(-1_748_793_503);
    expect(parseFigure('§94;104,443')).toBe(94_104_443);
    expect(parseFigure('2,48O,000')).toBeNull();
    expect(parseFigure('')).toBeNull();
  });

  it('keeps a figure negative when OCR lost one bracket, and reads a minus sign, footnote marks and Nil (V2, V3)', () => {
    expect(parseFigure('(1,234')).toBe(-1_234);
    expect(parseFigure('1,234)')).toBe(-1_234);
    expect(parseFigure('\u22121,234')).toBe(-1_234);
    expect(parseFigure('1,234*')).toBe(1_234);
    expect(parseFigure('(1,234)†')).toBe(-1_234);
    expect(parseFigure('Nil')).toBe(0);
    expect(parseFigure('nil')).toBe(0);
    // Still never guessed: lakh grouping and a dash before digits (a table rule as often as a minus).
    expect(parseFigure('12,34,567')).toBeNull();
    expect(parseFigure('\u20131,234')).toBeNull();
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

  it('delivers a tax credit negative and a tax charge positive, whichever sign the filing prints (U3, I2)', () => {
    const run = (cells: [string, string, string]) => {
      const rows = [row('b', 'Loss before taxation', [cells[0]]), row('t', 'Taxation', [cells[1]]), row('a', 'Loss for the year', [cells[2]])];
      const t = table(rows);
      const drops: Drop[] = [];
      const kept = applyChecks(valuesFromMatches('income', t, matchRows('income', rows).matches, new Map(), drops), [t], drops);
      return Object.fromEntries(kept.map((value) => [value.key, value.value]));
    };
    // Expenses in brackets, so an unbracketed tax line is a credit: -1,000 + 200 = -800.
    expect(run(['(1,000)', '200', '(800)'])).toEqual({ profit_before_tax: -1_000_000, taxation: -200_000, profit_after_tax: -800_000 });
    // A charge, printed in brackets: 1,000 - 300 = 700.
    expect(run(['1,000', '(300)', '700'])).toEqual({ profit_before_tax: 1_000_000, taxation: 300_000, profit_after_tax: 700_000 });
    // A filing that prints expenses unbracketed and the credit in brackets: -1,000 + 200 = -800.
    expect(run(['(1,000)', '(200)', '(800)'])).toEqual({ profit_before_tax: -1_000_000, taxation: -200_000, profit_after_tax: -800_000 });
  });

  it('delivers an OCR figure only when a check confirms it (V6)', () => {
    const rows = [row('s', 'Sales - net', ['3,762,793,904'], [], true), row('c', 'Cost of sales', ['(3,658,075,471)'], [], true), row('f', 'Finance cost', ['(108,547,214)'], [], true)];
    const t = { ...table(rows), method: 'docling-ocr' as const, unitScale: 1 };
    const drops: Drop[] = [];
    const values = valuesFromMatches('income', t, matchRows('income', rows).matches, confirmTotals(t), drops);
    const kept = applyChecks(values, [t], drops);
    expect(kept).toEqual([]);
    expect(drops.every((drop) => drop.reason.startsWith('V6'))).toBe(true);
  });

  it('drops a native figure no check confirms too, and keeps the ones a sum confirms (V6)', () => {
    const rows = [row('s', 'Revenue', ['1,000']), row('c', 'Cost of sales', ['(600)']), row('g', 'Gross profit', ['400']), row('f', 'Finance cost', ['(50)'])];
    const t = table(rows);
    const drops: Drop[] = [];
    const kept = applyChecks(valuesFromMatches('income', t, matchRows('income', rows).matches, confirmTotals(t), drops), [t], drops);
    expect(kept.map((value) => value.key).sort()).toEqual(['cost_of_sales', 'gross_profit', 'revenue']);
    expect(drops).toEqual([{ item: 'finance_cost', reason: 'V6: no check confirms it (2023-12-31/12)' }]);
  });

  it('confirms EPS when every column implies the same share count (E1), and not otherwise', () => {
    const run = (eps: [string, string]) => {
      const rows = [
        row('b', 'Profit before taxation', ['1,000', '800']),
        row('t', 'Taxation', ['(300)', '(240)']),
        row('a', 'Profit for the year', ['700', '560']),
        row('e', 'Earnings per share - basic and diluted', eps),
      ];
      const t = { ...table(rows), columns: [
        { index: 0, header: '2023', periodEnd: '2023-12-31', months: 12, kept: true },
        { index: 1, header: '2022', periodEnd: '2022-12-31', months: 12, kept: true },
      ] };
      const drops: Drop[] = [];
      return applyChecks(valuesFromMatches('income', t, matchRows('income', rows).matches, new Map(), drops), [t], drops).filter((value) => value.key === 'eps_basic');
    };
    // 700,000 / 7.00 = 100,000 shares and 560,000 / 5.60 = 100,000 shares.
    expect(run(['7.00', '5.60']).map((value) => value.checks)).toEqual([['E1 same share count in every column'], ['E1 same share count in every column']]);
    // 5.60 misread as 8.60: the columns no longer agree, so neither EPS is delivered.
    expect(run(['7.00', '8.60'])).toEqual([]);
  });

  it('drops negative sale proceeds, a misprint or a shifted row (U4)', () => {
    const rows = [
      row('p', 'Sale proceeds from disposal of operating fixed assets', ['(136,311)'], ['CASH FLOWS FROM INVESTING ACTIVITIES']),
      row('i', 'Short-term investments made', ['59,157']),
    ];
    const t = table(rows, 'cash_flow');
    const drops: Drop[] = [];
    const values = valuesFromMatches('cash_flow', t, matchRows('cash_flow', rows).matches, confirmTotals(t), drops);
    expect(values.map((value) => value.key)).not.toContain('sale_of_assets');
    expect(drops).toEqual([{ item: 'sale_of_assets', reason: 'negative for 2023-12-31' }]);
  });
});

describe('cross-filing comparison', () => {
  const filing = (id: string, value: number, periodEnd = '2024-12-31') => ({
    schemaVersion: 2,
    filing: { symbol: 'HPL', url: `https://financials.psx.com.pk/lib/DownloadPDF.php?id=${id}`, periodEnded: periodEnd },
    periods: [{ periodEnd, months: 0, basis: 'consolidated', balance: { total_current_liabilities: { value, source: 'reported', page: 26, text: '(total) | 6,532,317' } } }],
  });

  it('reports a figure two filings print differently, and nothing else', () => {
    const { compared, disagreements } = compare([filing('264465', 6_532_317_000), filing('253213', 6_532_317_000), filing('258531', 13_556_735_000)]);
    expect(compared).toBe(1);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toContain('258531: 13,556,735,000');
    expect(compare([filing('264465', 1), filing('253213', 1)]).disagreements).toEqual([]);
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
