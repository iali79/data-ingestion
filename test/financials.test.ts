import { describe, expect, it } from 'vitest';
import { buildPeriods, shiftMonths, type ReportedValue } from '../src/financials/derive.js';
import { BALANCE, CASH_FLOW, CAPTIONS, INCOME, RATIOS } from '../src/financials/definitions.js';
import { RULES } from '../src/financials/rulebook.js';
import { buildRows, figureValue } from '../src/statements/rows.js';

const page = (text: string) => [{ pageNumber: 45, text }];

describe('rows', () => {
  it('separates captions, note references and values', () => {
    const { rows } = buildRows(page('   Property, plant and equipment       3 1,777,765       1,884,260\n   Short-term borrowings                     -         700,000'));
    expect(rows[0]).toMatchObject({ caption: 'Property, plant and equipment', numbers: ['3', '1,777,765', '1,884,260'] });
    expect(rows[1]).toMatchObject({ caption: 'Short-term borrowings', numbers: ['-', '700,000'] });
  });

  it('keeps an unlabelled total as an uncaptioned row, with its heading', () => {
    const { rows } = buildRows(page('CURRENT ASSETS\n   Cash and bank balances   15   117,373   233,196\n                            7,816,272   10,244,793'));
    expect(rows[1]).toMatchObject({ caption: '', leading: ['7,816,272', '10,244,793'] });
    expect(rows[0]!.headingsBefore).toEqual(['CURRENT ASSETS']);
  });

  it('joins a wrapped caption to the figures under it (rule R4)', () => {
    const { rows } = buildRows(page('   Net cash used in investing activities\n                       (998,361)      (434,948)'));
    expect(rows[0]).toMatchObject({ caption: 'Net cash used in investing activities', leading: ['(998,361)', '(434,948)'] });
  });

  it('splits side-by-side statements on one printed line', () => {
    const { rows } = buildRows(page('REVENUE - NET   24   30,928,564   26,747,828      PROFIT FOR THE YEAR   2,909,544   1,857,147'));
    expect(rows.map((row) => row.caption)).toEqual(['REVENUE - NET', 'PROFIT FOR THE YEAR']);
    expect(rows[1]!.numbers).toEqual(['2,909,544', '1,857,147']);
  });

  it('reads brackets as negative and a dash as nil', () => {
    expect(figureValue('(15,842,506)')).toBe(-15842506);
    expect(figureValue('-')).toBe(0);
    expect(figureValue('37.41')).toBe(37.41);
  });
});

function value(statement: ReportedValue['statement'], key: string, periodEnd: string, months: number, v: number): ReportedValue {
  return { statement, key, periodEnd, months, basis: 'unknown', value: v, page: 1, text: `${key} ${v}` };
}

describe('derivations', () => {
  const reported: ReportedValue[] = [
    value('income', 'revenue', '2023-12-31', 12, 21_368_949_000),
    value('income', 'cost_of_sales', '2023-12-31', 12, 15_842_506_000),
    value('income', 'operating_profit', '2023-12-31', 12, 1_090_872_000),
    value('income', 'finance_cost', '2023-12-31', 12, 174_773_000),
    value('income', 'profit_before_tax', '2023-12-31', 12, 916_099_000),
    value('income', 'taxation', '2023-12-31', 12, 555_292_000),
    value('income', 'profit_after_tax', '2023-12-31', 12, 360_807_000),
    value('income', 'eps_basic', '2023-12-31', 12, 37.41),
    value('income', 'revenue', '2022-12-31', 12, 18_559_884_000),
    value('income', 'eps_basic', '2022-12-31', 12, 17.29),
    value('cash_flow', 'cf_depreciation_amortization', '2023-12-31', 12, 315_247_000),
    value('cash_flow', 'cash_from_operations', '2023-12-31', 12, 2_515_573_000),
    value('cash_flow', 'capital_expenditure', '2023-12-31', 12, -286_730_000),
    value('balance', 'total_assets', '2023-12-31', 0, 9_870_362_000),
    value('balance', 'total_assets', '2022-12-31', 0, 12_331_671_000),
    value('balance', 'shareholders_equity', '2023-12-31', 0, 5_471_438_000),
    value('balance', 'shareholders_equity', '2022-12-31', 0, 5_029_692_000),
    value('balance', 'share_capital', '2023-12-31', 0, 96_448_000),
    value('balance', 'par_value_per_share', '2023-12-31', 0, 10),
    value('balance', 'short_term_borrowings', '2023-12-31', 0, 0),
    value('balance', 'cash_and_equivalents', '2023-12-31', 0, 117_373_000),
  ];
  const periods = buildPeriods(reported, (date) => (date === '2023-12-31' ? { close: 1200, date: '2023-12-29', source: 'test' } : null));
  const fy2023 = periods.find((period) => period.periodEnd === '2023-12-31' && period.months === 12)!;

  it('delivers every defined item in every section, null when unknown', () => {
    expect(Object.keys(fy2023.income)).toEqual(INCOME.map((item) => item.key));
    expect(Object.keys(fy2023.balance)).toEqual(BALANCE.map((item) => item.key));
    expect(Object.keys(fy2023.cashFlow)).toEqual(CASH_FLOW.map((item) => item.key));
    expect(Object.keys(fy2023.ratios)).toEqual(RATIOS.map((item) => item.key));
    expect(fy2023.balance.goodwill).toBeNull();
    expect(fy2023.periodType).toBe('annual');
  });

  it('derives with a recorded formula', () => {
    expect(fy2023.income.gross_profit).toMatchObject({ value: 5_526_443_000, source: 'derived', formula: 'revenue - cost_of_sales' });
    expect(fy2023.income.ebitda?.value).toBe(1_090_872_000 + 315_247_000);
    expect(fy2023.cashFlow.free_cash_flow?.value).toBe(2_515_573_000 - 286_730_000);
    expect(fy2023.balance.common_shares_outstanding?.value).toBe(9_644_800);
  });

  it('computes ratios from averages, comparatives and the period-end price', () => {
    expect(fy2023.ratios.tax_rate?.value).toBeCloseTo(60.6148, 3);
    expect(fy2023.ratios.return_on_average_assets?.value).toBeCloseTo((360_807_000 / ((9_870_362_000 + 12_331_671_000) / 2)) * 100, 3);
    expect(fy2023.ratios.net_sales_yoy_growth?.value).toBeCloseTo((21_368_949_000 / 18_559_884_000 - 1) * 100, 3);
    expect(fy2023.ratios.price_to_earnings?.value).toBeCloseTo(1200 / 37.41, 3);
    expect(fy2023.ratios.float_shares).toBeNull();
  });

  it('never fills a ratio whose inputs are missing', () => {
    expect(fy2023.ratios.inventory_turnover).toBeNull();
    expect(fy2023.ratios.dividend_yield).toBeNull();
  });

  it('leaves market-based items to the server when no price is given (runtime, value 0)', () => {
    const noPrice = buildPeriods([...reported, value('income', 'revenue', '2023-09-30', 3, 5_000_000_000)]);
    const annual = noPrice.find((period) => period.periodEnd === '2023-12-31' && period.months === 12)!;
    const quarter = noPrice.find((period) => period.periodEnd === '2023-09-30' && period.months === 3)!;
    expect(annual.ratios.price_to_earnings).toMatchObject({ value: 0, source: 'runtime' });
    expect(annual.ratios.market_capitalization).toMatchObject({ value: 0, source: 'runtime', formula: 'price x common_shares_outstanding' });
    expect(annual.ratios.dividend_yield?.source).toBe('runtime');
    // Earnings multiples need twelve months; a quarter gets only the point-in-time ones.
    expect(quarter.ratios.price_to_earnings).toBeNull();
    expect(quarter.ratios.price_to_book?.source).toBe('runtime');
    // Nothing reported or derived is ever marked runtime.
    expect(annual.income.revenue?.source).toBe('reported');
  });

  it('shifts dates by months, clamping to month end', () => {
    expect(shiftMonths('2023-12-31', -12)).toBe('2022-12-31');
    expect(shiftMonths('2024-02-29', -12)).toBe('2023-02-28');
    expect(shiftMonths('2023-09-30', -9)).toBe('2022-12-31');
  });
});

describe('rulebook', () => {
  it('has unique ids, each tied to the stage that enforces it', () => {
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    expect(RULES.every((rule) => rule.stage.length > 0 && rule.enforced.length > 0)).toBe(true);
  });

  it('has a caption rule for every item the model can read', () => {
    const readable = [...INCOME, ...BALANCE, ...CASH_FLOW].filter((item) => item.read && item.from === 'statement');
    expect(readable.filter((item) => !CAPTIONS[item.key]).map((item) => item.key)).toEqual([]);
  });
});

describe('conventions', () => {
  it('computes an unprinted interim length from the year-end (rule C7)', async () => {
    const { monthsSince } = await import('../src/financials/conventions.js');
    expect(monthsSince('-12-31', '-09-30')).toBe(9);
    expect(monthsSince('-06-30', '-12-31')).toBe(6);
    expect(monthsSince('-12-31', '-12-31')).toBe(12);
  });

  it('reads a currency-only column header as plain rupees, and nothing else as a unit (rule U1)', async () => {
    const { unitFromHeaders } = await import('../src/financials/conventions.js');
    // OCTOPUS 2023 annual: the statements' columns are headed "2023 (Rupees)".
    expect(unitFromHeaders(['2023 (Rupees)', '2022 (Rupees)'])).toBe(1);
    expect(unitFromHeaders(['Rupees'])).toBe(1);
    expect(unitFromHeaders(['2022 Rs. (Restated)'])).toBe(1);
    expect(unitFromHeaders(['(Un-audited) Rupees'])).toBe(1);
    // A year alone, a scale, or prose is not a bare-rupees header.
    expect(unitFromHeaders(['2023', '2022'])).toBeNull();
    expect(unitFromHeaders(["Rupees in '000"])).toBeNull();
    expect(unitFromHeaders(['Rupees in million'])).toBeNull();
    expect(unitFromHeaders(['Shares of Rs. 10 each'])).toBeNull();
  });
});
