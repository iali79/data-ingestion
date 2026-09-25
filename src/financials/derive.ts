import { BALANCE, CASH_FLOW, INCOME, RATIOS, type ItemDefinition } from './definitions.js';

/**
 * Builds the final per-period figures: every item in `definitions.ts`, each either reported (read
 * from the filing and verified on its page), derived (a formula over other figures, recorded with
 * the value), or null. Nothing is estimated: a derived figure needs every input its formula names.
 *
 * Periods:
 *   - Flows (income, cash flow) exist per period length: 3, 6, 9 or 12 months ending on a date.
 *   - Balance sheet figures exist per date.
 *   - A flow period is joined to the balance sheet on its end date (closing) and on its start date
 *     (opening), when the filing prints them. "Average" ratios need both; otherwise they are null.
 *   - Year-on-year growth compares with the same-length period ending a year earlier, which a
 *     filing prints as its comparative column.
 *   - Sub-annual returns and turnovers are annualised (x 12 / months) and say so in their formula.
 *     Valuation multiples that need a full year of earnings are given for 12-month periods only.
 *
 * Signs: income-statement expenses are positive magnitudes and a loss is negative; cash-flow
 * figures keep the filing's sign (an outflow such as capital expenditure is negative).
 */
export type Source = 'reported' | 'derived' | 'runtime';

export interface Figure {
  value: number;
  source: Source;
  /** Reported: the printed line and page it was read from. */
  page?: number | null;
  text?: string;
  /** Derived: the formula, in terms of other item keys. Runtime: the formula the server applies. */
  formula?: string;
  /** Reported: the checks that confirmed the printed figure (table arithmetic, identities). */
  checks?: string[];
}

export type Figures = Record<string, Figure | null>;

export type PeriodType = 'annual' | 'nine_months' | 'half_year' | 'quarter' | 'balance_sheet_date';

export interface PeriodFigures {
  periodEnd: string;
  months: number;
  periodType: PeriodType;
  basis: string;
  price: { close: number; date: string; source: string } | null;
  income: Figures;
  balance: Figures;
  cashFlow: Figures;
  ratios: Figures;
}

/** A reported figure as verified, keyed by statement. */
export interface ReportedValue {
  statement: 'income' | 'balance' | 'cash_flow';
  key: string;
  periodEnd: string;
  /** 0 for balance-sheet figures. */
  months: number;
  basis: string;
  value: number;
  page: number | null;
  text: string;
  /** The checks that confirmed it (e.g. "sum:p45.r21", "I1"); absent when none applied. */
  checks?: string[];
  /** The printed cell it was read from (statement table index, row id, value column); absent for notes. */
  cell?: { table: number; row: string; column: number };
  /** Set when the repair stage (R7) replaced the first reading of the printed cell. */
  repaired?: { from: number | null; how: string };
}

export type PriceLookup = (date: string) => { close: number; date: string; source: string } | null;

export function buildPeriods(reported: ReportedValue[], price: PriceLookup = () => null): PeriodFigures[] {
  const bases = [...new Set(reported.map((value) => value.basis))];
  const periods: PeriodFigures[] = [];
  for (const basis of bases) {
    const mine = reported.filter((value) => value.basis === basis);
    const flowKeys = unique(mine.filter((value) => value.months > 0).map((value) => `${value.periodEnd}|${value.months}`));
    const balanceDates = unique(mine.filter((value) => value.months === 0).map((value) => value.periodEnd));

    const balanceAt = (date: string | null): Figures | null =>
      date && balanceDates.includes(date) ? deriveBalance(pick(mine, 'balance', date, 0)) : null;
    const flowsFor = (end: string, months: number) => ({
      income: pick(mine, 'income', end, months),
      cashFlow: pick(mine, 'cash_flow', end, months),
    });

    const usedDates = new Set<string>();
    for (const key of flowKeys) {
      const [end, monthsText] = key.split('|') as [string, string];
      const months = Number(monthsText);
      const closing = balanceAt(end);
      if (closing) usedDates.add(end);
      const flows = flowsFor(end, months);
      const income = deriveIncome(flows.income, flows.cashFlow);
      const cashFlow = deriveCashFlow(flows.cashFlow, income);
      const priorEnd = shiftMonths(end, -12);
      const prior = flowKeys.includes(`${priorEnd}|${months}`) ? deriveIncome(flowsFor(priorEnd, months).income, flowsFor(priorEnd, months).cashFlow) : null;
      const context: RatioContext = {
        months,
        income,
        cashFlow,
        closing: closing ?? emptyFigures(BALANCE),
        opening: balanceAt(shiftMonths(end, -months)),
        yearAgoBalance: balanceAt(shiftMonths(end, -12)),
        priorIncome: prior,
        price: price(end),
      };
      periods.push({
        periodEnd: end,
        months,
        periodType: periodType(months),
        basis,
        price: context.price,
        income: complete(INCOME, income),
        balance: complete(BALANCE, context.closing),
        cashFlow: complete(CASH_FLOW, cashFlow),
        ratios: complete(RATIOS, ratios(context)),
      });
    }
    // Balance-sheet dates with no flow period of their own (e.g. the prior year-end printed in a
    // quarterly filing): kept, with the ratios that need only a balance sheet.
    for (const date of balanceDates.filter((value) => !usedDates.has(value))) {
      const closing = balanceAt(date)!;
      const context: RatioContext = {
        months: 0,
        income: {},
        cashFlow: {},
        closing,
        opening: null,
        yearAgoBalance: balanceAt(shiftMonths(date, -12)),
        priorIncome: null,
        price: price(date),
      };
      periods.push({
        periodEnd: date,
        months: 0,
        periodType: 'balance_sheet_date',
        basis,
        price: context.price,
        income: emptyFigures(INCOME),
        balance: complete(BALANCE, closing),
        cashFlow: emptyFigures(CASH_FLOW),
        ratios: complete(RATIOS, ratios(context)),
      });
    }
  }
  return periods.sort((a, b) => (a.basis + b.periodEnd + String(b.months)).localeCompare(b.basis + a.periodEnd + String(a.months)));
}

// --------------------------------------------------------------------------------------------
// Statement-level derivations
// --------------------------------------------------------------------------------------------

function deriveIncome(reported: Figures, cashFlow: Figures): Figures {
  const f: Figures = { ...reported };
  fill(f, 'gross_profit', ['revenue', 'cost_of_sales'], (r, c) => r - c, 'revenue - cost_of_sales');
  fill(f, 'cost_of_sales', ['revenue', 'gross_profit'], (r, g) => r - g, 'revenue - gross_profit');
  fillSum(f, 'selling_admin_expenses', ['distribution_cost', 'admin_expenses']);
  fill(f, 'operating_expenses', ['gross_profit', 'operating_profit'], (g, o) => g - o, 'gross_profit - operating_profit');
  fill(f, 'operating_profit', ['gross_profit', 'operating_expenses'], (g, o) => g - o, 'gross_profit - operating_expenses');
  if (!f.depreciation_amortization && cashFlow.cf_depreciation_amortization) {
    f.depreciation_amortization = derived(cashFlow.cf_depreciation_amortization.value, 'cf_depreciation_amortization (cash flow statement)');
  }
  if (!f.interest_income && cashFlow.cf_interest_income) {
    f.interest_income = derived(Math.abs(cashFlow.cf_interest_income.value), 'cf_interest_income (cash flow adjustment)');
  }
  fill(f, 'ebitda', ['operating_profit', 'depreciation_amortization'], (o, d) => o + d, 'operating_profit + depreciation_amortization');
  fill(f, 'net_interest_expense', ['finance_cost', 'interest_income'], (fc, ii) => fc - ii, 'finance_cost - interest_income');
  fill(f, 'net_interest_income', ['interest_income', 'finance_cost'], (ii, fc) => ii - fc, 'interest_income - finance_cost');
  fill(f, 'profit_after_tax', ['profit_before_tax', 'taxation'], (p, t) => p - t, 'profit_before_tax - taxation');
  fill(f, 'net_income_to_owners', ['profit_after_tax', 'net_income_to_minority'], (p, m) => p - m, 'profit_after_tax - net_income_to_minority');
  if (!f.eps_diluted && f.eps_basic?.source === 'reported' && /diluted/iu.test(f.eps_basic.text ?? '')) {
    f.eps_diluted = { ...f.eps_basic };
  }
  return f;
}

function deriveBalance(reported: Figures): Figures {
  const f: Figures = { ...reported };
  fillSum(f, 'other_short_term_receivables', ['loans_and_advances', 'deposits_and_prepayments', 'other_receivables']);
  fillSum(f, 'total_inventory', ['inventory_raw_materials', 'inventory_work_in_progress', 'inventory_finished_goods'], 3);
  fillSum(f, 'investments_and_advances', ['long_term_investments', 'long_term_loans_advances']);
  fillSum(f, 'short_term_debt', ['short_term_borrowings', 'bank_overdraft']);
  fillSum(f, 'lease_liabilities', ['lease_liabilities_non_current', 'current_portion_lease_liabilities']);
  fillSum(f, 'total_debt', ['short_term_debt', 'current_portion_long_term_debt', 'long_term_debt_excl_leases', 'lease_liabilities']);
  fillSum(f, 'gross_ppe', ['ppe_land', 'ppe_buildings', 'ppe_equipment', 'ppe_other'], 4);
  fill(f, 'total_assets', ['total_current_assets', 'total_non_current_assets'], (c, n) => c + n, 'total_current_assets + total_non_current_assets');
  fill(f, 'total_non_current_assets', ['total_assets', 'total_current_assets'], (t, c) => t - c, 'total_assets - total_current_assets');
  fill(f, 'total_liabilities', ['total_current_liabilities', 'total_non_current_liabilities'], (c, n) => c + n, 'total_current_liabilities + total_non_current_liabilities');
  fill(f, 'shareholders_equity', ['total_equity', 'minority_interest'], (t, m) => t - m, 'total_equity - minority_interest');
  fill(f, 'total_equity', ['shareholders_equity', 'minority_interest'], (s, m) => s + m, 'shareholders_equity + minority_interest');
  fill(f, 'total_liabilities', ['total_assets', 'total_equity'], (a, e) => a - e, 'total_assets - total_equity');
  // A company with no subsidiaries has no minority interest: its total equity is shareholders' equity.
  if (!f.total_equity && f.shareholders_equity && !f.minority_interest) f.total_equity = derived(f.shareholders_equity.value, 'shareholders_equity (no minority interest printed)');
  if (!f.shareholders_equity && f.total_equity && !f.minority_interest) f.shareholders_equity = derived(f.total_equity.value, 'total_equity (no minority interest printed)');
  fill(f, 'total_liabilities', ['total_assets', 'total_equity'], (a, e) => a - e, 'total_assets - total_equity');
  fill(f, 'common_shares_outstanding', ['share_capital', 'par_value_per_share'], (c, p) => (p > 0 ? Math.round(c / p) : Number.NaN), 'share_capital / par_value_per_share');
  if (!f.other_current_assets && f.total_current_assets) {
    const parts = ['cash_and_equivalents', 'short_term_investments', 'net_receivables', 'other_short_term_receivables', 'total_inventory'];
    const known = parts.filter((key) => f[key]);
    if (known.length >= 3) {
      f.other_current_assets = derived(
        f.total_current_assets.value - known.reduce((sum, key) => sum + f[key]!.value, 0),
        `total_current_assets - (${known.join(' + ')})`,
      );
    }
  }
  return f;
}

function deriveCashFlow(reported: Figures, income: Figures): Figures {
  const f: Figures = { ...reported };
  if (!f.net_income_continuing_ops && income.profit_after_tax) {
    f.net_income_continuing_ops = derived(income.profit_after_tax.value, 'profit_after_tax (income statement; no discontinued operations printed)');
  }
  if (!f.change_in_other_working_capital && f.change_in_working_capital) {
    const parts = ['change_in_receivables', 'change_in_inventory', 'change_in_payables'].filter((key) => f[key]);
    if (parts.length > 0) {
      f.change_in_other_working_capital = derived(
        f.change_in_working_capital.value - parts.reduce((sum, key) => sum + f[key]!.value, 0),
        `change_in_working_capital - (${parts.join(' + ')})`,
      );
    }
  }
  if (!f.net_issuance_of_debt && (f.debt_issued || f.debt_repaid)) {
    const parts = ['debt_issued', 'debt_repaid'].filter((key) => f[key]);
    f.net_issuance_of_debt = derived(parts.reduce((sum, key) => sum + f[key]!.value, 0), parts.join(' + '));
  }
  if (!f.other_financing_activities && f.cash_from_financing) {
    const parts = ['net_issuance_of_debt', 'dividends_paid', 'repurchase_of_stock'].filter((key) => f[key]);
    if (parts.length > 0) {
      f.other_financing_activities = derived(
        f.cash_from_financing.value - parts.reduce((sum, key) => sum + f[key]!.value, 0),
        `cash_from_financing - (${parts.join(' + ')})`,
      );
    }
  }
  if (!f.net_change_in_cash && f.cash_from_operations && f.cash_from_investing && f.cash_from_financing) {
    f.net_change_in_cash = derived(
      f.cash_from_operations.value + f.cash_from_investing.value + f.cash_from_financing.value,
      'cash_from_operations + cash_from_investing + cash_from_financing',
    );
  }
  fill(f, 'free_cash_flow', ['cash_from_operations', 'capital_expenditure'], (o, c) => o + c, 'cash_from_operations + capital_expenditure (capex is negative)');
  return f;
}

// --------------------------------------------------------------------------------------------
// Ratios
// --------------------------------------------------------------------------------------------

interface RatioContext {
  months: number;
  income: Figures;
  cashFlow: Figures;
  closing: Figures;
  opening: Figures | null;
  yearAgoBalance: Figures | null;
  priorIncome: Figures | null;
  price: { close: number; date: string; source: string } | null;
}

function ratios(c: RatioContext): Figures {
  const r: Figures = {};
  const I = (key: string) => c.income[key]?.value;
  const B = (key: string) => c.closing[key]?.value;
  const O = (key: string) => c.opening?.[key]?.value;
  const CF = (key: string) => c.cashFlow[key]?.value;
  const flows = c.months > 0;
  const annual = c.months === 12;
  const a = flows ? 12 / c.months : Number.NaN;
  const ann = annual ? '' : ` x 12/${c.months} (annualised)`;
  const days = flows ? (c.months * 365) / 12 : Number.NaN;
  const avg = (key: string) => (B(key) !== undefined && O(key) !== undefined ? (B(key)! + O(key)!) / 2 : undefined);
  const set = (key: string, value: number | undefined, formula: string) => {
    if (value !== undefined && Number.isFinite(value)) r[key] = derived(round(value), formula);
  };
  const div = (x: number | undefined, y: number | undefined) => (x !== undefined && y !== undefined && y !== 0 ? x / y : undefined);
  const pct = (x: number | undefined, y: number | undefined) => mapNum(div(x, y), (v) => v * 100);

  const shares = B('common_shares_outstanding');
  const equity = B('total_equity') ?? B('shareholders_equity');
  const commonEquity = B('shareholders_equity') ?? B('total_equity');
  const cash = sumDefined(B('cash_and_equivalents'), B('short_term_investments'));
  const debt = B('total_debt');
  const investedCapital = debt !== undefined && equity !== undefined ? debt + equity - (cash ?? 0) : undefined;
  const openingInvested = O('total_debt') !== undefined && (O('total_equity') ?? O('shareholders_equity')) !== undefined
    ? O('total_debt')! + (O('total_equity') ?? O('shareholders_equity'))! - (sumDefined(O('cash_and_equivalents'), O('short_term_investments')) ?? 0)
    : undefined;
  const avgInvested = investedCapital !== undefined && openingInvested !== undefined ? (investedCapital + openingInvested) / 2 : undefined;
  const avgEquity = equity !== undefined && (O('total_equity') ?? O('shareholders_equity')) !== undefined ? (equity + (O('total_equity') ?? O('shareholders_equity'))!) / 2 : undefined;
  const avgCommonEquity = commonEquity !== undefined && (O('shareholders_equity') ?? O('total_equity')) !== undefined ? (commonEquity + (O('shareholders_equity') ?? O('total_equity'))!) / 2 : undefined;
  const avgCapital = debt !== undefined && equity !== undefined && O('total_debt') !== undefined && (O('total_equity') ?? O('shareholders_equity')) !== undefined
    ? (debt + equity + O('total_debt')! + (O('total_equity') ?? O('shareholders_equity'))!) / 2
    : undefined;
  const revenue = I('revenue');
  const cogs = I('cost_of_sales');
  const netIncome = I('profit_after_tax');
  const ebit = I('operating_profit');
  const ebitda = I('ebitda');
  const fcf = CF('free_cash_flow');
  const eps = I('eps_basic');
  const bvps = div(commonEquity, shares);
  const taxRate = I('profit_before_tax') !== undefined && I('profit_before_tax')! > 0 ? div(I('taxation'), I('profit_before_tax')) : undefined;
  const avgInventory = avg('total_inventory');

  // Margins and mix (same period, no annualisation needed)
  set('gross_income_margin', div(I('gross_profit'), revenue), 'gross_profit / revenue');
  set('gross_margin_pct', pct(I('gross_profit'), revenue), 'gross_profit / revenue x 100');
  set('operating_margin', div(ebit, revenue), 'operating_profit / revenue');
  set('operating_margin_pct', pct(ebit, revenue), 'operating_profit / revenue x 100');
  set('net_income_margin', pct(netIncome, revenue), 'profit_after_tax / revenue x 100');
  set('ebitda_margin', pct(ebitda, revenue), 'ebitda / revenue x 100');
  set('cogs_to_sales', pct(cogs, revenue), 'cost_of_sales / revenue x 100');
  set('tax_rate', mapNum(taxRate, (v) => v * 100), 'taxation / profit_before_tax x 100 (positive profit only)');
  set('interest_coverage', div(ebit, I('finance_cost')), 'operating_profit / finance_cost');
  set('interest_coverage_ebitda', div(ebitda, I('finance_cost')), 'ebitda / finance_cost');
  set('capex_to_sales', mapNum(pct(CF('capital_expenditure'), revenue), (v) => -v), '-capital_expenditure / revenue x 100');
  set('fcf_to_sales', pct(fcf, revenue), 'free_cash_flow / revenue x 100');
  set('fcf_to_cfo', pct(fcf, CF('cash_from_operations')), 'free_cash_flow / cash_from_operations x 100');

  // Balance sheet only
  set('current_ratio', div(B('total_current_assets'), B('total_current_liabilities')), 'total_current_assets / total_current_liabilities');
  const quickAssets = B('total_current_assets') !== undefined && B('total_inventory') !== undefined
    ? B('total_current_assets')! - B('total_inventory')! - (B('stores_and_spares') ?? 0)
    : undefined;
  set('quick_ratio', div(quickAssets, B('total_current_liabilities')), '(total_current_assets - total_inventory - stores_and_spares) / total_current_liabilities');
  set('equity_to_assets', pct(equity, B('total_assets')), 'total_equity / total_assets x 100');
  set('debt_to_equity', pct(debt, equity), 'total_debt / total_equity x 100');
  set('debt_to_asset', pct(debt, B('total_assets')), 'total_debt / total_assets x 100');
  set('debt_to_capital', pct(debt, debt !== undefined && equity !== undefined ? debt + equity : undefined), 'total_debt / (total_debt + total_equity) x 100');
  set('cash_to_debt', div(cash, debt), '(cash_and_equivalents + short_term_investments) / total_debt');
  set('net_debt', debt !== undefined && cash !== undefined ? debt - cash : undefined, 'total_debt - cash_and_equivalents - short_term_investments');
  set('working_capital', B('total_current_assets') !== undefined && B('total_current_liabilities') !== undefined ? B('total_current_assets')! - B('total_current_liabilities')! : undefined, 'total_current_assets - total_current_liabilities');
  set('invested_assets_to_liabilities', div(B('total_assets'), B('total_liabilities')), 'total_assets / total_liabilities');
  if (shares !== undefined) r.common_shares_outstanding = derived(shares, c.closing.common_shares_outstanding?.source === 'reported' ? 'common_shares_outstanding (share capital note)' : c.closing.common_shares_outstanding?.formula ?? 'common_shares_outstanding');
  set('book_value_per_share', bvps, 'shareholders_equity / common_shares_outstanding');
  const tangible = commonEquity !== undefined ? commonEquity - (B('intangible_assets') ?? 0) - (B('goodwill') ?? 0) : undefined;
  set('tangible_book_value_per_share', div(tangible, shares), '(shareholders_equity - intangible_assets - goodwill) / common_shares_outstanding');
  set('cash_per_share', div(cash, shares), '(cash_and_equivalents + short_term_investments) / common_shares_outstanding');
  if (c.yearAgoBalance) {
    const before = c.yearAgoBalance.total_equity?.value ?? c.yearAgoBalance.shareholders_equity?.value;
    set('equity_yoy_growth', before !== undefined && before > 0 && equity !== undefined ? (equity / before - 1) * 100 : undefined, 'total_equity / total_equity a year earlier - 1, x 100');
  }

  // Flow over balance: turnover, days, returns (averages need the opening balance sheet)
  if (flows) {
    set('eps_basic', eps, 'eps_basic (income statement)');
    set('fcf_per_share', div(fcf, shares), 'free_cash_flow / common_shares_outstanding');
    set('asset_turnover', mapNum(div(revenue, avg('total_assets')), (v) => v * a), `revenue / average total_assets${ann}`);
    set('inventory_turnover', mapNum(div(cogs, avgInventory), (v) => v * a), `cost_of_sales / average total_inventory${ann}`);
    set('sales_to_inventory_turnover', mapNum(div(revenue, avgInventory), (v) => v * a), `revenue / average total_inventory${ann}`);
    set('days_sales_outstanding', mapNum(div(avg('net_receivables'), revenue), (v) => v * days), 'average net_receivables / revenue x days in period');
    set('days_sales_in_inventory', mapNum(div(avgInventory, cogs), (v) => v * days), 'average total_inventory / cost_of_sales x days in period');
    set('days_payables_outstanding', mapNum(div(avg('accounts_payable'), cogs), (v) => v * days), 'average accounts_payable / cost_of_sales x days in period');
    const dso = r.days_sales_outstanding?.value;
    const dio = r.days_sales_in_inventory?.value;
    const dpo = r.days_payables_outstanding?.value;
    set('cash_conversion_cycle', dso !== undefined && dio !== undefined && dpo !== undefined ? dso + dio - dpo : undefined, 'days_sales_outstanding + days_sales_in_inventory - days_payables_outstanding');
    set('return_on_average_assets', mapNum(pct(netIncome, avg('total_assets')), (v) => v * a), `profit_after_tax / average total_assets x 100${ann}`);
    set('return_on_average_total_equity', mapNum(pct(netIncome, avgEquity), (v) => v * a), `profit_after_tax / average total_equity x 100${ann}`);
    const toCommon = I('net_income_to_owners') ?? netIncome;
    const commonIncome = toCommon !== undefined ? toCommon - (I('preferred_dividends') ?? 0) : undefined;
    set('return_on_common_equity', mapNum(pct(commonIncome, avgCommonEquity), (v) => v * a), `(net_income_to_owners - preferred_dividends) / average shareholders_equity x 100${ann}`);
    const nopat = ebit !== undefined && taxRate !== undefined ? ebit * (1 - taxRate) : undefined;
    set('return_on_average_invested_capital', mapNum(pct(nopat, avgInvested), (v) => v * a), `operating_profit x (1 - tax_rate) / average (total_debt + total_equity - cash - short_term_investments) x 100${ann}`);
    set('return_on_average_total_capital', mapNum(pct(ebit, avgCapital), (v) => v * a), `operating_profit / average (total_debt + total_equity) x 100${ann}`);
    set('cash_flow_return_on_invested_capital', mapNum(pct(CF('cash_from_operations'), avgInvested), (v) => v * a), `cash_from_operations / average invested capital x 100${ann}`);
    set('return_on_equity', mapNum(pct(netIncome, equity), (v) => v * a), `profit_after_tax / closing total_equity x 100${ann}`);
    set('return_on_assets', mapNum(pct(netIncome, B('total_assets')), (v) => v * a), `profit_after_tax / closing total_assets x 100${ann}`);
    set('effective_interest_rate', mapNum(pct(I('finance_cost'), avg('total_debt')), (v) => v * a), `finance_cost / average total_debt x 100${ann}`);
    set('net_debt_to_ebitda', mapNum(div(r.net_debt?.value, ebitda), (v) => v / a), `net_debt / ebitda${annual ? '' : ` (ebitda x 12/${c.months}, annualised)`}`);
    if (c.priorIncome) {
      const priorRevenue = c.priorIncome.revenue?.value;
      const priorEps = c.priorIncome.eps_basic?.value;
      set('net_sales_yoy_growth', priorRevenue !== undefined && priorRevenue > 0 && revenue !== undefined ? (revenue / priorRevenue - 1) * 100 : undefined, 'revenue / revenue for the same period a year earlier - 1, x 100');
      set('eps_basic_yoy_growth', priorEps !== undefined && priorEps > 0 && eps !== undefined ? (eps / priorEps - 1) * 100 : undefined, 'eps_basic / eps_basic for the same period a year earlier - 1, x 100 (positive base only)');
    }
    if (annual && eps !== undefined && bvps !== undefined && eps > 0 && bvps > 0) {
      set('graham_value', Math.sqrt(22.5 * eps * bvps), 'sqrt(22.5 x eps_basic x book_value_per_share)');
    }
  }

  // Market-based: the closing price on (or just before) the period end. Multiples that need a
  // full year of earnings are for 12-month periods only.
  if (c.price && shares !== undefined) {
    const p = c.price.close;
    const cap = p * shares;
    const priceNote = ` (close ${c.price.date})`;
    set('market_capitalization', cap, `price x common_shares_outstanding${priceNote}`);
    const ev = debt !== undefined && cash !== undefined ? cap + debt + (B('minority_interest') ?? 0) + (B('preferred_stock') ?? 0) - cash : undefined;
    set('enterprise_value', ev, `market_capitalization + total_debt + minority_interest + preferred_stock - cash_and_equivalents - short_term_investments${priceNote}`);
    set('price_to_book', div(p, bvps), `price / book_value_per_share${priceNote}`);
    set('price_to_tangible_book', div(cap, tangible), `market_capitalization / (shareholders_equity - intangible_assets - goodwill)${priceNote}`);
    if (annual) {
      set('price_to_earnings', eps !== undefined && eps > 0 ? p / eps : undefined, `price / eps_basic (positive earnings only)${priceNote}`);
      set('earning_yield', mapNum(div(eps, p), (v) => v * 100), `eps_basic / price x 100${priceNote}`);
      set('price_to_sales', div(cap, revenue), `market_capitalization / revenue${priceNote}`);
      set('price_to_fcf', fcf !== undefined && fcf > 0 ? cap / fcf : undefined, `market_capitalization / free_cash_flow (positive only)${priceNote}`);
      set('ev_to_ebitda', ebitda !== undefined && ebitda > 0 ? div(ev, ebitda) : undefined, `enterprise_value / ebitda (positive only)${priceNote}`);
      set('ev_to_sales', div(ev, revenue), `enterprise_value / revenue${priceNote}`);
    }
  } else {
    // Without a price the market-based items are calculated at runtime, from the day's close, by
    // the server's valuation job. They are marked, with value 0, so they are never mistaken for
    // a reported or derived figure.
    for (const item of RUNTIME_ITEMS) if (flows ? !item.annualOnly || annual : !item.annualOnly) r[item.key] = { value: 0, source: 'runtime', formula: item.formula };
  }
  return r;
}

/**
 * Items that depend on the market price. Without a price they are delivered as
 * `{ value: 0, source: "runtime" }` with the formula the server applies to the day's close.
 */
export const RUNTIME_ITEMS: ReadonlyArray<{ key: string; formula: string; annualOnly: boolean }> = [
  { key: 'market_capitalization', formula: 'price x common_shares_outstanding', annualOnly: false },
  { key: 'enterprise_value', formula: 'market_capitalization + total_debt + minority_interest + preferred_stock - cash_and_equivalents - short_term_investments', annualOnly: false },
  { key: 'price_to_book', formula: 'price / book_value_per_share', annualOnly: false },
  { key: 'price_to_tangible_book', formula: 'market_capitalization / (shareholders_equity - intangible_assets - goodwill)', annualOnly: false },
  { key: 'price_to_earnings', formula: 'price / eps_basic, trailing twelve months (positive earnings only)', annualOnly: true },
  { key: 'earning_yield', formula: 'eps_basic / price x 100, trailing twelve months', annualOnly: true },
  { key: 'price_to_sales', formula: 'market_capitalization / revenue, trailing twelve months', annualOnly: true },
  { key: 'price_to_fcf', formula: 'market_capitalization / free_cash_flow, trailing twelve months (positive only)', annualOnly: true },
  { key: 'ev_to_ebitda', formula: 'enterprise_value / ebitda, trailing twelve months (positive only)', annualOnly: true },
  { key: 'ev_to_sales', formula: 'enterprise_value / revenue, trailing twelve months', annualOnly: true },
  { key: 'dividend_yield', formula: 'dividends_per_share, trailing twelve months / price x 100', annualOnly: true },
];

// --------------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------------

function pick(values: ReportedValue[], statement: ReportedValue['statement'], periodEnd: string, months: number): Figures {
  const figures: Figures = {};
  for (const value of values) {
    if (value.statement !== statement || value.periodEnd !== periodEnd || value.months !== months) continue;
    figures[value.key] = { value: value.value, source: 'reported', page: value.page, text: value.text, ...(value.checks?.length ? { checks: value.checks } : {}) };
  }
  return figures;
}

function fill(f: Figures, key: string, inputs: [string, string], compute: (a: number, b: number) => number, formula: string): void {
  if (f[key]) return;
  const [a, b] = inputs.map((input) => f[input]);
  if (!a || !b) return;
  const value = compute(a.value, b.value);
  if (Number.isFinite(value)) f[key] = derived(value, formula);
}

/** Sum of the parts that are present; `minimum` of them must be. */
function fillSum(f: Figures, key: string, parts: string[], minimum = 1): void {
  if (f[key]) return;
  const present = parts.filter((part) => f[part]);
  if (present.length < minimum) return;
  f[key] = derived(present.reduce((sum, part) => sum + f[part]!.value, 0), present.join(' + '));
}

function derived(value: number, formula: string): Figure {
  return { value: round(value), source: 'derived', formula };
}

function complete(definitions: ItemDefinition[], figures: Figures): Figures {
  const out: Figures = {};
  for (const definition of definitions) out[definition.key] = figures[definition.key] ?? null;
  return out;
}

function emptyFigures(definitions: ItemDefinition[]): Figures {
  return complete(definitions, {});
}

function periodType(months: number): PeriodType {
  return months === 12 ? 'annual' : months === 9 ? 'nine_months' : months === 6 ? 'half_year' : months === 3 ? 'quarter' : 'balance_sheet_date';
}

/** The same calendar day `months` later (or earlier), clamped to month end: 2024-02-29 - 12 -> 2023-02-28. */
export function shiftMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const wasMonthEnd = d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  target.setUTCDate(wasMonthEnd ? lastDay : Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}

function mapNum(value: number | undefined, fn: (v: number) => number): number | undefined {
  return value === undefined ? undefined : fn(value);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
