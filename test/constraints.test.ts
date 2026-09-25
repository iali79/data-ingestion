import { describe, expect, it } from 'vitest';
import type { PeriodFigures, ReportedValue } from '../src/financials/derive.js';
import type { Statement } from '../src/financials/definitions.js';
import { holds, residual, type Constraint } from '../src/pipeline/constraint-types.js';
import { buildConstraints, ratioProblems, scaleMismatch } from '../src/pipeline/constraints.js';
import { matchRows } from '../src/pipeline/labels.js';
import { parseFigure, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
import { confirmTotals, valuesFromMatches } from '../src/pipeline/validate.js';

function row(id: string, label: string, cells: string[], headings: string[] = []): StatementRow {
  return { id, page: 1, label, cells, values: cells.map(parseFigure), note: null, headings, ocr: false };
}

function table(statementType: StatementTable['statementType'], rows: StatementRow[], unitScale = 1000): StatementTable {
  const months = statementType === 'balance_sheet' ? 0 : 12;
  return {
    statementType,
    basis: 'unconsolidated',
    pages: [1],
    method: 'docling-pdf',
    title: '',
    unitScale,
    unitPrinted: true,
    columns: [
      { index: 0, header: '2025', periodEnd: '2025-06-30', months, kept: true },
      { index: 1, header: '2024', periodEnd: '2024-06-30', months, kept: true },
    ],
    rows,
    problems: [],
  };
}

const KIND: Record<StatementTable['statementType'], Statement> = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' };

/** The values the pipeline would deliver before applyChecks: matched rows, per kept column, in table order. */
function valuesOf(tables: StatementTable[]): ReportedValue[] {
  return tables.flatMap((item, index) => {
    const kind = KIND[item.statementType];
    return valuesFromMatches(kind, item, matchRows(kind, item.rows).matches, confirmTotals(item), [], index);
  });
}

function build(tables: StatementTable[]) {
  const constraints = buildConstraints(tables, valuesOf(tables));
  const byId = new Map(constraints.map((item) => [item.id, item]));
  const state = (id: string) => {
    const found = byId.get(id);
    return found ? holds(tables, found) : undefined;
  };
  return { constraints, byId, state };
}

/** A balance sheet in thousands whose every total adds up, with a fixed-assets subtotal inside non-current assets. */
function balanceRows(debts = '1,284'): StatementRow[] {
  return [
    row('a1', 'Property, plant and equipment', ['1,768,485', '1,700,000'], ['ASSETS', 'NON-CURRENT ASSETS']),
    row('a2', 'Intangible assets', ['14,012', '15,000']),
    row('a3', '', ['1,782,497', '1,715,000']),
    row('a4', 'Long-term deposits', ['15,983', '16,000']),
    row('a5', '', ['1,798,480', '1,731,000']),
    row('b1', 'Stock-in-trade', ['4,312,764', '4,000,000'], ['CURRENT ASSETS']),
    row('b2', 'Trade debts', [debts, '2,000']),
    row('b3', 'Cash and bank balances', ['331,484', '300,000']),
    row('b4', '', ['4,645,532', '4,302,000']),
    row('b5', 'TOTAL ASSETS', ['6,444,012', '6,033,000']),
    row('e0', '5,000,000 ordinary shares of Rs. 10 each', ['50,000', '50,000'], ['EQUITY AND LIABILITIES', 'SHARE CAPITAL AND RESERVES', 'Authorised capital']),
    row('e1', 'Share capital', ['96,448', '96,448']),
    row('e2', 'Unappropriated profit', ['3,000,000', '2,700,000']),
    row('e3', '', ['3,096,448', '2,796,448']),
    row('n1', 'Long term financing', ['1,000,000', '1,100,000'], ['NON-CURRENT LIABILITIES']),
    row('n2', 'Deferred taxation', ['200,000', '180,000']),
    row('n3', '', ['1,200,000', '1,280,000']),
    row('c1', 'Trade and other payables', ['1,500,000', '1,300,000'], ['CURRENT LIABILITIES']),
    row('c2', 'Short term borrowings', ['647,564', '656,552']),
    row('c3', '', ['2,147,564', '1,956,552']),
    row('c4', 'Contingencies and commitments', ['-', '-']),
    row('c5', 'TOTAL EQUITY AND LIABILITIES', ['6,444,012', '6,033,000']),
  ];
}

function incomeRows(): StatementRow[] {
  return [
    row('i1', 'Revenue', ['10,000', '9,000']),
    row('i2', 'Cost of sales', ['(6,000)', '(5,500)']),
    row('i3', 'Gross profit', ['4,000', '3,500']),
    row('i4', 'Distribution cost', ['(500)', '(400)']),
    row('i5', 'Administrative expenses', ['(700)', '(600)']),
    row('i6', 'Other operating expenses', ['(100)', '(100)']),
    row('i7', 'Other income', ['300', '200']),
    row('i8', 'Operating profit', ['3,000', '2,600']),
    row('i9', 'Finance cost', ['(400)', '(300)']),
    row('i10', 'Profit before levies and income tax', ['2,600', '2,300']),
    row('i11', 'Levies', ['(100)', '(90)']),
    row('i12', 'Profit before income tax', ['2,500', '2,210']),
    row('i13', 'Taxation', ['(750)', '(650)']),
    row('i14', 'Profit for the year', ['1,750', '1,560']),
    row('i15', 'Earnings per share - basic and diluted', ['17.50', '15.60']),
  ];
}

function cashFlowRows(start: [string, string[]] = ['Profit before taxation', ['2,500', '2,210']]): StatementRow[] {
  return [
    row('f1', start[0], start[1], ['CASH FLOWS FROM OPERATING ACTIVITIES']),
    row('f2', 'Depreciation', ['300', '250']),
    row('f3', 'Cash generated from operations', ['2,800', '2,460']),
    row('f4', 'Income tax paid', ['(800)', '(700)']),
    row('f5', 'Net cash generated from operating activities', ['2,000', '1,760']),
    row('f6', 'Purchase of property, plant and equipment', ['(1,200)', '(900)'], ['CASH FLOWS FROM INVESTING ACTIVITIES']),
    row('f7', 'Proceeds from sale of property, plant and equipment', ['200', '100']),
    row('f8', 'Net cash used in investing activities', ['(1,000)', '(800)']),
    row('f9', 'Dividends paid', ['(500)', '(400)'], ['CASH FLOWS FROM FINANCING ACTIVITIES']),
    row('f10', 'Repayment of long term financing', ['(100)', '(100)']),
    row('f11', 'Net cash used in financing activities', ['(600)', '(500)']),
    row('f12', 'Net increase in cash and cash equivalents', ['400', '460']),
    row('f13', 'Cash and cash equivalents at the beginning of the year', ['(316,480)', '(357,012)']),
    row('f14', 'Cash and cash equivalents at the end of the year', ['(316,080)', '(356,552)']),
  ];
}

const ids = (constraints: Constraint[], rule: string) => constraints.filter((item) => item.rule === rule).map((item) => item.id).sort();

describe('A1 table sums at cell level', () => {
  it('gives a holding constraint for every total in every kept column of a balanced table', () => {
    const tables = [table('balance_sheet', balanceRows())];
    const { constraints } = build(tables);
    const sums = constraints.filter((item) => item.rule === 'A1');
    expect(ids(constraints, 'A1')).toEqual(['a3', 'a5', 'b4', 'b5', 'c3', 'c5', 'e3', 'n3'].flatMap((id) => [`A1 t0 ${id} c0`, `A1 t0 ${id} c1`]).sort());
    expect(sums.every((item) => holds(tables, item) === true && !item.advisory)).toBe(true);
    // Terms are printed cells in rupees; the tolerance is the rounding of the printed unit.
    const current = sums.find((item) => item.id === 'A1 t0 b4 c0')!;
    expect(current.terms.map((term) => `${term.sign > 0 ? '+' : '-'}${term.cell.row}`)).toEqual(['+b1', '+b2', '+b3', '-b4']);
    expect(current.terms.every((term) => term.scale === 1000)).toBe(true);
    expect(current.tolerance).toBe(2 * 1000);
  });

  it('flags the column with a misread component while the comparative holds', () => {
    // OCR read 1,284 as 1,234: confirmTotals finds no run in that column, so it confirms nothing
    // there and flags nothing either. The run the comparative column finds says what should add up.
    const tables = [table('balance_sheet', balanceRows('1,234'))];
    const { state, byId } = build(tables);
    expect(state('A1 t0 b4 c0')).toBe(false);
    expect(state('A1 t0 b4 c1')).toBe(true);
    expect(residual(tables, byId.get('A1 t0 b4 c0')!)).toBe(-50_000);
    // The grand total adds the (correct) printed subtotal, so it still holds.
    expect(state('A1 t0 b5 c0')).toBe(true);
  });

  it('never counts a subtotal and the rows it closes in the same run', () => {
    const { byId } = build([table('balance_sheet', balanceRows())]);
    expect(byId.get('A1 t0 a5 c0')!.terms.map((term) => term.cell.row)).toEqual(['a3', 'a4', 'a5']);
    expect(byId.get('A1 t0 b5 c0')!.terms.map((term) => term.cell.row)).toEqual(['a5', 'b4', 'b5']);
    // Authorised capital sits above the equity rows but is not part of their total.
    expect(byId.get('A1 t0 e3 c0')!.terms.map((term) => term.cell.row)).toEqual(['e1', 'e2', 'e3']);
    expect(byId.get('A1 t0 c5 c0')!.terms.map((term) => term.cell.row)).toEqual(['e3', 'n3', 'c3', 'c4', 'c5']);
  });

  it('emits nothing when the columns disagree on which rows a total closes', () => {
    // 2025: 200 + 300 = 500 (b, c); 2024: 50 + 300 + 400 = 750 (a, b, c). Each run explains a
    // column the other does not.
    const rows = [
      row('x', 'Item A', ['100', '50']),
      row('y', 'Item B', ['200', '300']),
      row('z', 'Item C', ['300', '400']),
      row('t', 'Total', ['500', '750']),
    ];
    expect(ids(build([table('cash_flow', rows)]).constraints, 'A1')).toEqual([]);
  });

  it('emits nothing for a total equal to one row plus nils', () => {
    const rows = [
      row('x', 'Long term loan', ['500', '400']),
      row('y', 'Lease liabilities', ['-', '-']),
      row('t', '', ['500', '400']),
    ];
    expect(ids(build([table('cash_flow', rows)]).constraints, 'A1')).toEqual([]);
  });

  it('does not apply a run where a row inside it is printed only in that column', () => {
    const rows = [
      row('x', 'Item A', ['100', '300']),
      row('y', 'Item B', ['200', '']),
      row('z', 'Item C', ['300', '400']),
      row('t', 'Total', ['600', '700']),
    ];
    // 2024 adds up x + z (y blank); in 2025 y is printed, so that run says nothing about 2025.
    const found = ids(build([table('cash_flow', rows)]).constraints, 'A1');
    expect(found).not.toContain('A1 t0 t c0');
  });

  it('names no cell whose row id is not unique in its table', () => {
    const rows = balanceRows();
    rows[1] = { ...rows[1]!, id: 'a1' };
    const { constraints } = build([table('balance_sheet', rows)]);
    expect(constraints.some((item) => item.terms.some((term) => term.cell.row === 'a1'))).toBe(false);
    expect(constraints.some((item) => item.id === 'A1 t0 b4 c0')).toBe(true);
  });

  it('takes a heading total that no column adds up as advisory', () => {
    // A captioned total (an uncaptioned one is claimed only when its rows add up, R3).
    const rows = balanceRows();
    rows[8] = row('b4', 'Total current assets', ['4,645,000', '4,300,000']);
    const tables = [table('balance_sheet', rows)];
    const { byId, state } = build(tables);
    expect(byId.get('A1 t0 b4 c0')?.advisory).toBe(true);
    expect(state('A1 t0 b4 c0')).toBe(false);
  });
});

describe('identities per period', () => {
  const tables = [table('balance_sheet', balanceRows()), table('income_statement', incomeRows()), table('cash_flow', cashFlowRows())];
  const { byId, state } = build(tables);

  it('checks the income statement: I1, I2, I4 levies above, I5', () => {
    for (const period of ['2025-06-30/12 unconsolidated', '2024-06-30/12 unconsolidated']) {
      expect(state(`I1 ${period}`)).toBe(true);
      expect(state(`I2 ${period}`)).toBe(true);
      expect(state(`I4 levies above ${period}`)).toBe(true);
      expect(state(`I5 ${period}`)).toBe(true);
    }
    // Expenses enter as magnitudes (U3).
    expect(byId.get('I1 2025-06-30/12 unconsolidated')!.terms.find((term) => term.cell.row === 'i2')).toMatchObject({ sign: -1, magnitude: true });
  });

  it('checks the balance sheet: B1, B4, B5', () => {
    for (const period of ['2025-06-30 unconsolidated', '2024-06-30 unconsolidated']) {
      expect(state(`B1 ${period}`)).toBe(true);
      expect(state(`B4 ${period}`)).toBe(true);
      expect(state(`B5 t0 ${period}`)).toBe(true);
      expect(byId.get(`B1 ${period}`)!.advisory).toBeUndefined();
    }
  });

  it('checks the cash flow and the ties: F4, F5, X1, X4', () => {
    const period = '2025-06-30/12 unconsolidated';
    expect(state(`F4 ${period}`)).toBe(true);
    expect(state(`F5 ${period}`)).toBe(true);
    // The cash flow starts from profit after levies here; the pre-levy comparison is advisory and fails.
    expect(state(`X1 t2 ${period}`)).toBe(true);
    expect(byId.get(`X1 t2 ${period}`)!.advisory).toBe(true);
    expect(state(`X1 t2 ${period} pre-levy`)).toBe(false);
    // Closing cash is cash and bank less short-term borrowings: that form holds, so it is a proof.
    expect(state(`X4 ${period}`)).toBe(true);
    expect(byId.get(`X4 ${period}`)!.advisory).toBeUndefined();
    expect(byId.get(`X4 ${period}`)!.terms.map((term) => term.cell.row)).toEqual(['f14', 'b3', 'c2']);
  });

  it('fails the identity a misread cell breaks', () => {
    const rows = incomeRows();
    rows[13] = row('i14', 'Profit for the year', ['1,780', '1,560']);
    const found = build([table('income_statement', rows)]);
    expect(found.state('I2 2025-06-30/12 unconsolidated')).toBe(false);
    expect(found.state('I2 2024-06-30/12 unconsolidated')).toBe(true);
    // Neither the charge nor the credit form holds, so the printed-sign form is emitted.
    expect(found.byId.get('I2 2025-06-30/12 unconsolidated')!.text).toMatch(/as printed, costs in brackets/u);
  });

  it('represents a tax credit (I2)', () => {
    const rows = [
      row('p1', 'Revenue', ['1,000', '2,000']),
      row('p2', 'Cost of sales', ['(1,100)', '(1,500)']),
      row('p3', 'Loss before taxation', ['(100)', '500']),
      row('p4', 'Taxation', ['20', '(150)']),
      row('p5', 'Loss for the year', ['(80)', '350']),
    ];
    const found = build([table('income_statement', rows)]);
    const credit = found.byId.get('I2 2025-06-30/12 unconsolidated')!;
    expect(found.state(credit.id)).toBe(true);
    expect(credit.text).toMatch(/a credit/u);
    expect(credit.terms.find((term) => term.cell.row === 'p4')).toMatchObject({ sign: 1, magnitude: true });
    const charge = found.byId.get('I2 2024-06-30/12 unconsolidated')!;
    expect(found.state(charge.id)).toBe(true);
    expect(charge.terms.find((term) => term.cell.row === 'p4')).toMatchObject({ sign: -1, magnitude: true });
  });

  it('takes levies printed below profit before tax into I4', () => {
    const rows = [
      row('p1', 'Profit before taxation', ['1,000', '800']),
      row('p2', 'Levies', ['(50)', '(40)']),
      row('p3', 'Taxation', ['(250)', '(200)']),
      row('p4', 'Profit for the year', ['700', '560']),
    ];
    const found = build([table('income_statement', rows)]);
    expect(found.state('I4 levies below 2025-06-30/12 unconsolidated')).toBe(true);
    expect(found.byId.has('I2 2025-06-30/12 unconsolidated')).toBe(false);
  });

  it('makes B4 advisory when assets held for sale are printed outside current assets', () => {
    const rows = balanceRows();
    rows.splice(9, 1, row('h1', 'Non-current assets held for sale', ['1,000', '-']), row('b5', 'TOTAL ASSETS', ['6,445,012', '6,033,000']));
    const found = build([table('balance_sheet', rows)]);
    expect(found.byId.get('B4 2025-06-30 unconsolidated')!.advisory).toBe(true);
    expect(found.state('B4 2025-06-30 unconsolidated')).toBe(false);
    // In the comparative the line is nil: the identity is exact there.
    expect(found.byId.get('B4 2024-06-30 unconsolidated')!.advisory).toBeUndefined();
    expect(found.state('B4 2024-06-30 unconsolidated')).toBe(true);
  });

  it('makes F5 advisory when an unclaimed line sits among the cash lines', () => {
    const rows = cashFlowRows();
    rows.splice(13, 1, row('fx', 'Cash acquired on amalgamation', ['100', '-']), row('f14', 'Cash and cash equivalents at the end of the year', ['(315,980)', '(356,552)']));
    const found = build([table('cash_flow', rows)]);
    expect(found.byId.get('F5 2025-06-30/12 unconsolidated')!.advisory).toBe(true);
  });

  it('ties a cash flow that starts from profit after tax to the income statement (X3)', () => {
    const found = build([table('income_statement', incomeRows()), table('cash_flow', cashFlowRows(['Profit for the year', ['1,750', '1,560']]))]);
    expect(found.state('X3 t1 2025-06-30/12 unconsolidated')).toBe(true);
    expect(found.byId.get('X3 t1 2025-06-30/12 unconsolidated')!.advisory).toBeUndefined();
  });

  it('checks an item printed in two statements of the same kind (X5), EPS unscaled', () => {
    const found = build([table('income_statement', incomeRows()), table('income_statement', incomeRows())]);
    const eps = found.constraints.filter((item) => item.id.startsWith('X5 eps_basic'));
    expect(eps.length).toBe(2);
    expect(eps.every((item) => item.terms.every((term) => term.scale === 1) && item.tolerance < 0.02)).toBe(true);
    expect(found.constraints.filter((item) => item.rule === 'X5').every((item) => found.state(item.id))).toBe(true);
  });

  it('emits I3 for the profit attribution, not for comprehensive income', () => {
    const rows = [
      row('p1', 'Profit before taxation', ['1,000', '800']),
      row('p2', 'Taxation', ['(300)', '(200)']),
      row('p3', 'Profit for the year', ['700', '600']),
      row('p4', 'Equity holders of the parent', ['650', '560'], ['Attributable to:']),
      row('p5', 'Non-controlling interests', ['50', '40']),
    ];
    expect(build([table('income_statement', rows)]).state('I3 2025-06-30/12 unconsolidated')).toBe(true);
    rows[3] = row('p4', 'Equity holders of the parent', ['650', '560'], ['Total comprehensive income attributable to:']);
    expect(build([table('income_statement', rows)]).byId.has('I3 2025-06-30/12 unconsolidated')).toBe(false);
  });
});

describe('unit scale', () => {
  it('reports a table read in the wrong unit, not a cell', () => {
    // The cash flow printed "Rupees in thousand" where the pipeline missed it: X1 is off by 1,000.
    const tables = [table('income_statement', incomeRows()), table('cash_flow', cashFlowRows(), 1)];
    const constraints = buildConstraints(tables, valuesOf(tables));
    expect(holds(tables, constraints.find((item) => item.id === 'X1 t1 2025-06-30/12 unconsolidated')!)).toBe(false);
    const found = scaleMismatch(tables, constraints);
    expect(found.find((item) => item.table === 1 && item.factor === 1000)?.fixes).toContain('X1 t1 2025-06-30/12 unconsolidated');
    expect(scaleMismatch([table('income_statement', incomeRows()), table('cash_flow', cashFlowRows())], buildConstraints([table('income_statement', incomeRows()), table('cash_flow', cashFlowRows())], valuesOf([table('income_statement', incomeRows()), table('cash_flow', cashFlowRows())])))).toEqual([]);
  });
});

describe('ratio sanity', () => {
  const figure = (value: number) => ({ value, source: 'reported' as const });
  const period = (income: Record<string, number>, balance: Record<string, number>): PeriodFigures => ({
    periodEnd: '2025-06-30',
    months: 12,
    periodType: 'annual',
    basis: 'unconsolidated',
    price: null,
    income: Object.fromEntries(Object.entries(income).map(([key, value]) => [key, figure(value)])),
    balance: Object.fromEntries(Object.entries(balance).map(([key, value]) => [key, figure(value)])),
    cashFlow: {},
    ratios: {},
  });

  it('passes a plausible period', () => {
    expect(ratioProblems(period(
      { revenue: 10_000, cost_of_sales: 6_000, gross_profit: 4_000, profit_before_tax: 2_500, taxation: 750, profit_after_tax: 1_750, eps_basic: 17.5 },
      { total_assets: 50_000, total_current_assets: 20_000, total_current_liabilities: 10_000, cash_and_equivalents: 1_000, shareholders_equity: 30_000, common_shares_outstanding: 100 },
    ))).toEqual([]);
  });

  it('reports each implausible figure with its rule', () => {
    const problems = ratioProblems(period(
      { revenue: 1_000, cost_of_sales: 2_500, gross_profit: 1_200, profit_before_tax: 100, taxation: 150, profit_after_tax: -50, eps_basic: 3 },
      { total_assets: -5, total_current_assets: 20_000, total_current_liabilities: 10_000, cash_and_equivalents: 30_000, shareholders_equity: 30_000, common_shares_outstanding: 100 },
    ));
    expect(problems.map((problem) => problem.slice(0, 2)).sort()).toEqual(['S1', 'S2', 'S4', 'S5', 'S6', 'S7', 'S7', 'S8', 'S9'].sort());
  });
});
