/**
 * The financial data model: every figure the extractor delivers, where it comes from, and how a
 * missing one is calculated. This file is the single source of truth -- the model prompts, the
 * derivation engine, the payload and CONTRACT.md are all generated from or checked against it.
 *
 * Each figure is delivered for every period in the filing as one of:
 *   - reported: read from the filing and found verbatim on its page,
 *   - derived:  calculated by a formula below from reported (or earlier derived) figures,
 *   - null:     not printed and not derivable. Never estimated.
 *
 * Units: money in PKR (already scaled from "Rupees in thousand"), per-share figures in PKR per
 * share, `pct` in percent (12.5 = 12.5%), `x` as a plain multiple (0.125), `days` in days,
 * `shares` as a count.
 */
export type Statement = 'income' | 'balance' | 'cash_flow';
export type Unit = 'pkr' | 'per_share' | 'pct' | 'x' | 'days' | 'shares';

export interface ItemDefinition {
  key: string;
  label: string;
  unit: Unit;
  /** How the model recognises it on a page; absent for figures that are only ever derived. */
  read?: string;
  /** Where it is printed when reported. */
  from?: 'statement' | 'note';
}

/**
 * What a row's printed caption must look like for the model's label to be accepted. The model
 * proposes, this decides: "Share capital" can never become preferred stock, nor "Repayment of
 * financing" debt issued. `total`: an uncaptioned row (an unlabelled total) is also acceptable.
 * `side` / `section`: where on the statement the row must sit.
 */
export interface CaptionRule {
  all: RegExp[];
  not?: RegExp;
  total?: boolean;
  side?: 'assets' | 'claims';
  section?: 'operating' | 'investing' | 'financing';
  /** An uncaptioned total must sit under this heading (e.g. "CURRENT ASSETS"). */
  under?: 'current_assets' | 'non_current_assets' | 'current_liabilities' | 'non_current_liabilities' | 'equity';
}

const r = (all: RegExp | RegExp[], extra: Omit<CaptionRule, 'all'> = {}): CaptionRule => ({ all: Array.isArray(all) ? all : [all], ...extra });

export const CAPTIONS: Record<string, CaptionRule> = {
  // income statement
  revenue: r(/revenue|sales|turnover/iu, { not: /cost\s+of/iu }),
  cost_of_sales: r(/cost\s+of\s+(sales|revenue|goods|services)/iu),
  gross_profit: r(/gross\s+(profit|loss)/iu),
  distribution_cost: r(/distribution|selling|marketing/iu, { not: /administrative/iu }),
  admin_expenses: r(/administrative|general\s+expenses/iu, { not: /selling|distribution/iu }),
  selling_admin_expenses: r(/(selling|distribution|marketing).*administrative|administrative.*(selling|distribution|marketing)/iu),
  rd_expenses: r(/research/iu),
  other_operating_expenses: r(/other\s+(operating\s+)?(expenses|charges)/iu),
  other_income: r(/other\s+(operating\s+)?income/iu),
  operating_expenses: r(/operating\s+expenses/iu, { total: true }),
  operating_profit: r(/operating\s+(profit|loss)|(profit|loss)\s+from\s+operations|\bebit\b/iu),
  depreciation_amortization: r(/depreciation|amorti[sz]ation/iu),
  interest_income: r(/interest|mark-?\s?up|return\s+on|profit\s+on|finance\s+income/iu, { not: /expense|cost|paid|payable/iu }),
  finance_cost: r(/finance\s+(cost|charges)|financial\s+charges|mark-?\s?up|interest\s+expense|borrowing\s+cost/iu, { not: /income|paid/iu }),
  levies: r(/lev(y|ies)|minimum\s+tax|final\s+tax/iu),
  profit_before_tax: r(/before\s+(income\s+)?tax/iu),
  taxation: r(/tax/iu, { total: true, not: /before|after|deferred\s+tax\s+on/iu }),
  profit_after_tax: r(/(profit|loss|income).{0,20}(for\s+the\s+(year|period)|after\s+tax)|net\s+(profit|income|loss)/iu, { not: /comprehensive/iu }),
  net_income_to_owners: r(/owners|equity\s+holders|parent|shareholders\s+of/iu),
  net_income_to_minority: r(/non-?\s?controlling|minority/iu),
  preferred_dividends: r(/preference|preferred/iu),
  eps_basic: r(/earnings?\s+per\s+share|\beps\b|loss\s+per\s+share/iu),
  eps_diluted: r(/diluted/iu),
  // balance sheet
  cash_and_equivalents: r(/cash/iu, { side: 'assets' }),
  short_term_investments: r(/investment/iu, { side: 'assets', not: /propert|long-?\s?term/iu }),
  net_receivables: r(/trade\s+(debts?|receivables?)|debtors|receivables?/iu, { side: 'assets', not: /other\s+receivable/iu }),
  loans_and_advances: r(/loans?|advances?/iu, { side: 'assets', not: /long-?\s?term/iu }),
  deposits_and_prepayments: r(/deposits?|prepayments?/iu, { side: 'assets', not: /long-?\s?term/iu }),
  other_receivables: r(/other\s+receivable|receivable/iu, { side: 'assets', not: /trade/iu }),
  stores_and_spares: r(/stores|spares|loose\s+tools/iu, { side: 'assets' }),
  total_inventory: r(/stock[-\s]in[-\s]trade|inventor/iu, { side: 'assets' }),
  tax_refunds_due: r(/tax/iu, { side: 'assets', not: /deferred/iu }),
  total_current_assets: r(/current\s+assets/iu, { side: 'assets', total: true, not: /non-?\s?current/iu, under: 'current_assets' }),
  long_term_investments: r(/investment/iu, { side: 'assets', not: /propert|short-?\s?term/iu }),
  long_term_loans_advances: r(/loans?|advances?|deposits?/iu, { side: 'assets', not: /short-?\s?term|trade/iu }),
  net_ppe: r(/property,?\s+plant|fixed\s+assets|operating\s+assets/iu, { side: 'assets' }),
  right_of_use_assets: r(/right[-\s]of[-\s]use/iu, { side: 'assets' }),
  investment_property: r(/investment\s+propert/iu, { side: 'assets' }),
  intangible_assets: r(/intangible/iu, { side: 'assets' }),
  goodwill: r(/goodwill/iu, { side: 'assets' }),
  deferred_tax_asset: r(/deferred\s+tax/iu, { side: 'assets' }),
  total_non_current_assets: r(/non-?\s?current\s+assets/iu, { side: 'assets', total: true, under: 'non_current_assets' }),
  total_assets: r(/total\s+assets/iu, { side: 'assets' }),
  accounts_payable: r(/payables?|creditors|accrued\s+(and\s+other\s+)?liabilit/iu, { side: 'claims' }),
  short_term_borrowings: r(/short-?\s?term\s+(borrowing|financ|loan)|running\s+finance/iu, { side: 'claims' }),
  bank_overdraft: r(/overdraft/iu, { side: 'claims' }),
  current_portion_long_term_debt: r(/current\s+(portion|maturity)/iu, { side: 'claims', not: /lease|deferred/iu }),
  current_portion_lease_liabilities: r([/lease/iu, /current/iu], { side: 'claims' }),
  lease_liabilities_non_current: r(/lease/iu, { side: 'claims', not: /current\s+(portion|maturity)/iu }),
  long_term_debt_excl_leases: r(/long-?\s?term\s+(financ|loan|borrow|debt)|term\s+finance|sukuk|loans?\s+from|redeemable/iu, { side: 'claims', not: /lease|current\s+(portion|maturity)/iu }),
  deferred_taxes: r(/deferred\s+tax/iu, { side: 'claims' }),
  employee_benefits: r(/benefit|gratuity|retirement|employee|staff/iu, { side: 'claims' }),
  total_current_liabilities: r(/current\s+liabilities/iu, { side: 'claims', total: true, not: /non-?\s?current/iu, under: 'current_liabilities' }),
  total_non_current_liabilities: r(/non-?\s?current\s+liabilities/iu, { side: 'claims', total: true, under: 'non_current_liabilities' }),
  total_liabilities: r(/total\s+liabilities/iu, { side: 'claims', not: /equity/iu }),
  share_capital: r(/share\s+capital|paid-?\s?up|issued,?\s+subscribed/iu, { side: 'claims', not: /preference|authori[sz]ed/iu }),
  additional_paid_in_capital: r(/premium/iu, { side: 'claims' }),
  reserves: r(/reserves?/iu, { side: 'claims', not: /revaluation\s+surplus/iu }),
  retained_earnings: r(/unappropriated|retained|accumulated\s+(profit|loss)|revenue\s+reserve/iu, { side: 'claims' }),
  preferred_stock: r(/preference|preferred/iu, { side: 'claims' }),
  treasury_stock: r(/treasury/iu, { side: 'claims' }),
  shareholders_equity: r(/equity|shareholders|owners/iu, { side: 'claims', total: true, not: /liabilit|non-?\s?controlling/iu, under: 'equity' }),
  minority_interest: r(/non-?\s?controlling|minority/iu, { side: 'claims' }),
  total_equity: r(/total\s+equity/iu, { side: 'claims', not: /liabilit/iu }),
  // cash flow
  cf_profit_before_tax: r(/before\s+(income\s+)?tax/iu, { section: 'operating' }),
  cf_depreciation_amortization: r(/depreciation|amorti[sz]ation/iu, { section: 'operating' }),
  cf_deferred_taxes: r(/deferred\s+tax/iu, { section: 'operating' }),
  cf_interest_income: r(/interest|mark-?\s?up|return\s+on|profit\s+on/iu, { section: 'operating', not: /paid|expense|cost/iu }),
  change_in_receivables: r(/trade\s+debts|receivable|debtors/iu, { section: 'operating', not: /other/iu }),
  change_in_inventory: r(/stock|inventor/iu, { section: 'operating' }),
  change_in_payables: r(/payable|creditors/iu, { section: 'operating' }),
  change_in_working_capital: r(/working\s+capital/iu, { section: 'operating' }),
  cash_generated_from_operations: r(/generated\s+from|(used\s+in|from)\s+operations/iu, { section: 'operating', not: /activities/iu }),
  income_tax_paid: r([/tax/iu, /paid/iu], { section: 'operating' }),
  finance_cost_paid: r([/finance\s+cost|mark-?\s?up|interest/iu, /paid/iu], { section: 'operating', not: /lease/iu }),
  cash_from_operations: r(/operating\s+activities/iu),
  capital_expenditure: r(/capital\s+expenditure|(purchase|acquisition|additions?)\s+(of|to)\s+(property|fixed|operating|intangible|assets)/iu, { section: 'investing' }),
  net_acquired_assets: r(/acquisition\s+of\s+(a\s+)?(subsidiar|business)|net\s+of\s+cash\s+acquired/iu, { section: 'investing' }),
  sale_of_assets: r([/proceeds|sale|disposal/iu, /assets|property|fixed|business|equipment/iu], { section: 'investing', not: /investment/iu }),
  purchase_of_investments: r([/investment/iu, /made|purchase|acquired|acquisition|placed/iu], { section: 'investing', not: /propert|proceeds|sale|disposal|redemption|income|received/iu }),
  sale_of_investments: r([/investment/iu, /proceeds|sale|disposal|redemption|matur/iu], { section: 'investing', not: /propert|income/iu }),
  cash_from_investing: r(/investing\s+activities/iu),
  repurchase_of_stock: r(/buy-?\s?back|treasury|repurchase|purchase\s+of\s+own/iu, { section: 'financing' }),
  debt_issued: r([/proceeds|obtained|received|drawn|disburse|availed/iu, /financ|loan|borrow|sukuk|debt|term\s+finance/iu], { section: 'financing', not: /repayment|repaid|lease/iu }),
  debt_repaid: r([/repayment|repaid/iu, /financ|loan|borrow|sukuk|debt/iu], { section: 'financing', not: /lease/iu }),
  lease_payments: r(/lease/iu, { section: 'financing' }),
  net_issuance_of_debt: r(/net\s+(increase|decrease|proceeds|movement|change).{0,30}(borrowing|financ|loan)/iu, { section: 'financing' }),
  dividends_paid: r(/dividend/iu, { section: 'financing' }),
  cash_from_financing: r(/financing\s+activities/iu),
  fx_adjustments: r(/exchange/iu),
  net_change_in_cash: r(/net\s+(increase|decrease|change)/iu),
  cash_at_beginning: r(/beginning|opening/iu),
  cash_at_end: r(/end\s+of|closing/iu),
};

// ---------------------------------------------------------------------------------------------
// Income statement (flows: one value per period length -- 3, 6, 9 or 12 months)
// ---------------------------------------------------------------------------------------------
export const INCOME: ItemDefinition[] = [
  { key: 'revenue', label: 'Revenue', unit: 'pkr', from: 'statement', read: 'Revenue / net sales / turnover (the net figure)' },
  { key: 'cost_of_sales', label: 'Cost of Sales', unit: 'pkr', from: 'statement', read: 'Cost of sales / cost of revenue / cost of goods sold' },
  { key: 'gross_profit', label: 'Gross Profit', unit: 'pkr', from: 'statement', read: 'Gross profit (or gross loss)' },
  { key: 'distribution_cost', label: 'Distribution & Selling Costs', unit: 'pkr', from: 'statement', read: 'Distribution / selling / marketing costs' },
  { key: 'admin_expenses', label: 'Administrative Expenses', unit: 'pkr', from: 'statement', read: 'Administrative (and general) expenses' },
  { key: 'selling_admin_expenses', label: 'Selling & Admin Expenses', unit: 'pkr', from: 'statement', read: 'ONLY a single combined "selling and administrative expenses" line' },
  { key: 'rd_expenses', label: 'R&D Expenses', unit: 'pkr', from: 'statement', read: 'Research and development expenses' },
  { key: 'other_operating_expenses', label: 'Other Operating Expenses', unit: 'pkr', from: 'statement', read: 'Other (operating) expenses' },
  { key: 'other_income', label: 'Other Income', unit: 'pkr', from: 'statement', read: 'Other (operating) income' },
  { key: 'operating_expenses', label: 'Operating Expenses', unit: 'pkr', from: 'statement', read: 'Total operating expenses, when printed as its own labelled line' },
  { key: 'operating_profit', label: 'Operating Profit (EBIT)', unit: 'pkr', from: 'statement', read: 'Operating profit / profit from operations' },
  { key: 'depreciation_amortization', label: 'Depreciation & Amortization', unit: 'pkr', from: 'statement', read: 'Depreciation and amortisation, only if printed on this statement' },
  { key: 'ebitda', label: 'EBITDA', unit: 'pkr' },
  { key: 'interest_income', label: 'Interest Income', unit: 'pkr', from: 'statement', read: 'Interest / mark-up income, profit or return on bank deposits' },
  { key: 'finance_cost', label: 'Finance Cost (Interest Expense)', unit: 'pkr', from: 'statement', read: 'Finance cost / mark-up / financial charges' },
  { key: 'net_interest_expense', label: 'Net Interest Expense', unit: 'pkr' },
  { key: 'net_interest_income', label: 'Net Interest Income', unit: 'pkr' },
  { key: 'levies', label: 'Levies (minimum / final tax)', unit: 'pkr', from: 'statement', read: 'Levies (minimum or final tax shown separately from income tax)' },
  { key: 'profit_before_tax', label: 'Profit before Taxation', unit: 'pkr', from: 'statement', read: 'Profit before taxation. If levies are shown separately, the profit AFTER levies and BEFORE income tax' },
  { key: 'taxation', label: 'Taxation', unit: 'pkr', from: 'statement', read: 'Income tax for the period. If split into current/prior/deferred, the TOTAL of those lines' },
  { key: 'profit_after_tax', label: 'Net Income', unit: 'pkr', from: 'statement', read: 'Profit / (loss) for the year or period' },
  { key: 'net_income_to_owners', label: 'Net Income Attributable to Owners', unit: 'pkr', from: 'statement', read: 'Profit attributable to owners / equity holders of the parent (consolidated only)' },
  { key: 'net_income_to_minority', label: 'Net Income Attributable to Minority Interest', unit: 'pkr', from: 'statement', read: 'Profit attributable to non-controlling interest (consolidated only)' },
  { key: 'preferred_dividends', label: 'Preferred Dividends', unit: 'pkr', from: 'statement', read: 'Dividend on preference shares' },
  { key: 'eps_basic', label: 'Basic EPS', unit: 'per_share', from: 'statement', read: 'Earnings per share - basic (also when one line says "basic and diluted")' },
  { key: 'eps_diluted', label: 'Diluted EPS', unit: 'per_share', from: 'statement', read: 'Earnings per share - diluted, ONLY when printed as its own line' },
];

// ---------------------------------------------------------------------------------------------
// Balance sheet (point in time: one value per balance-sheet date)
// ---------------------------------------------------------------------------------------------
export const BALANCE: ItemDefinition[] = [
  { key: 'cash_and_equivalents', label: 'Cash & Equivalents', unit: 'pkr', from: 'statement', read: 'Cash and bank balances / cash and cash equivalents' },
  { key: 'short_term_investments', label: 'Short-term Investments', unit: 'pkr', from: 'statement', read: 'Short-term investments' },
  { key: 'net_receivables', label: 'Net Receivables', unit: 'pkr', from: 'statement', read: 'Trade debts / trade receivables (net)' },
  { key: 'loans_and_advances', label: 'Loans & Advances (current)', unit: 'pkr', from: 'statement', read: 'Loans and advances (current)' },
  { key: 'deposits_and_prepayments', label: 'Deposits & Prepayments (current)', unit: 'pkr', from: 'statement', read: 'Trade deposits and short-term prepayments' },
  { key: 'other_receivables', label: 'Other Receivables', unit: 'pkr', from: 'statement', read: 'Other receivables (current)' },
  { key: 'other_short_term_receivables', label: 'Other Short-Term Receivables', unit: 'pkr' },
  { key: 'stores_and_spares', label: 'Stores & Spares', unit: 'pkr', from: 'statement', read: 'Stores, spares and loose tools' },
  { key: 'total_inventory', label: 'Total Inventory', unit: 'pkr', from: 'statement', read: 'Stock-in-trade / inventories' },
  { key: 'inventory_raw_materials', label: 'Inventory - Raw Materials', unit: 'pkr', from: 'note', read: 'Raw (and packing) material, net of provision' },
  { key: 'inventory_work_in_progress', label: 'Inventory - Work in Progress', unit: 'pkr', from: 'note', read: 'Work-in-process / work-in-progress' },
  { key: 'inventory_finished_goods', label: 'Inventory - Finished Goods', unit: 'pkr', from: 'note', read: 'Finished goods (including in transit), net of provision' },
  { key: 'tax_refunds_due', label: 'Taxation - Net (asset)', unit: 'pkr', from: 'statement', read: 'Taxation - net / income tax refundable / advance tax (current asset)' },
  { key: 'other_current_assets', label: 'Other Current Assets', unit: 'pkr' },
  { key: 'total_current_assets', label: 'Total Current Assets', unit: 'pkr', from: 'statement', read: 'Total current assets (often an unlabelled total under the current assets list)' },
  { key: 'long_term_investments', label: 'Long-term Investments', unit: 'pkr', from: 'statement', read: 'Long-term investments / investments in subsidiaries or associates' },
  { key: 'long_term_loans_advances', label: 'Long-term Loans, Advances & Deposits', unit: 'pkr', from: 'statement', read: 'Long-term loans, advances and deposits (non-current)' },
  { key: 'investments_and_advances', label: 'Investments & Advances', unit: 'pkr' },
  { key: 'gross_ppe', label: 'Gross PPE', unit: 'pkr', from: 'note', read: 'Operating fixed assets at cost, total (closing)' },
  { key: 'ppe_land', label: 'PPE - Land', unit: 'pkr', from: 'note', read: 'Land (freehold and leasehold), cost' },
  { key: 'ppe_buildings', label: 'PPE - Buildings', unit: 'pkr', from: 'note', read: 'Buildings, cost' },
  { key: 'ppe_equipment', label: 'PPE - Equipment', unit: 'pkr', from: 'note', read: 'Plant, machinery and equipment, cost' },
  { key: 'ppe_construction', label: 'PPE - Construction', unit: 'pkr', from: 'note', read: 'Capital work-in-progress' },
  { key: 'ppe_other', label: 'PPE - Other', unit: 'pkr', from: 'note', read: 'Other fixed assets at cost (furniture, vehicles, computers, ...), total' },
  { key: 'ppe_accumulated_depreciation', label: 'PPE Depreciation', unit: 'pkr', from: 'note', read: 'Accumulated depreciation on operating fixed assets (closing)' },
  { key: 'net_ppe', label: 'Net PPE', unit: 'pkr', from: 'statement', read: 'Property, plant and equipment' },
  { key: 'right_of_use_assets', label: 'Right-of-Use Assets', unit: 'pkr', from: 'statement', read: 'Right-of-use assets' },
  { key: 'investment_property', label: 'Investment Property', unit: 'pkr', from: 'statement', read: 'Investment property' },
  { key: 'intangible_assets', label: 'Intangible Assets', unit: 'pkr', from: 'statement', read: 'Intangible assets' },
  { key: 'goodwill', label: 'Goodwill', unit: 'pkr', from: 'statement', read: 'Goodwill' },
  { key: 'deferred_tax_asset', label: 'Deferred Tax Asset', unit: 'pkr', from: 'statement', read: 'Deferred tax asset' },
  { key: 'total_non_current_assets', label: 'Total Non-current Assets', unit: 'pkr', from: 'statement', read: 'Total non-current assets (often an unlabelled total)' },
  { key: 'total_assets', label: 'Total Assets', unit: 'pkr', from: 'statement', read: 'Total assets' },
  { key: 'accounts_payable', label: 'Accounts Payable', unit: 'pkr', from: 'statement', read: 'Trade and other payables / creditors, accrued and other liabilities' },
  { key: 'short_term_borrowings', label: 'Short-term Borrowings', unit: 'pkr', from: 'statement', read: 'Short-term borrowings / running finance' },
  { key: 'bank_overdraft', label: 'Bank Overdraft', unit: 'pkr', from: 'statement', read: 'Bank overdraft' },
  { key: 'short_term_debt', label: 'Short-Term Debt', unit: 'pkr' },
  { key: 'current_portion_long_term_debt', label: 'Current Portion of Long Term Debt', unit: 'pkr', from: 'statement', read: 'Current portion / maturity of long-term financing or loans' },
  { key: 'current_portion_lease_liabilities', label: 'Current Portion of Lease Liabilities', unit: 'pkr', from: 'statement', read: 'Current portion of lease liabilities' },
  { key: 'lease_liabilities_non_current', label: 'Lease Liabilities (non-current)', unit: 'pkr', from: 'statement', read: 'Lease liabilities (non-current)' },
  { key: 'lease_liabilities', label: 'Lease Liabilities', unit: 'pkr' },
  { key: 'long_term_debt_excl_leases', label: 'Long Term Debt Excluding Lease Liabilities', unit: 'pkr', from: 'statement', read: 'Long-term financing / loans / borrowings (non-current), excluding leases' },
  { key: 'total_debt', label: 'Total Debt', unit: 'pkr' },
  { key: 'deferred_taxes', label: 'Deferred Taxes', unit: 'pkr', from: 'statement', read: 'Deferred tax liability / deferred taxation (liability)' },
  { key: 'employee_benefits', label: 'Employee Benefits', unit: 'pkr', from: 'statement', read: 'Defined benefit plans / staff retirement benefits / employee benefit obligations' },
  { key: 'total_current_liabilities', label: 'Current Liabilities', unit: 'pkr', from: 'statement', read: 'Total current liabilities (often an unlabelled total)' },
  { key: 'total_non_current_liabilities', label: 'Total Non-current Liabilities', unit: 'pkr', from: 'statement', read: 'Total non-current liabilities (often an unlabelled total)' },
  { key: 'total_liabilities', label: 'Total Liabilities', unit: 'pkr', from: 'statement', read: 'Total liabilities, only when printed as its own line' },
  { key: 'share_capital', label: 'Share Capital', unit: 'pkr', from: 'statement', read: 'Issued, subscribed and paid-up (share) capital' },
  { key: 'additional_paid_in_capital', label: 'Additional Paid-In Capital', unit: 'pkr', from: 'statement', read: 'Share premium' },
  { key: 'reserves', label: 'Reserves', unit: 'pkr', from: 'statement', read: 'Reserves (total of capital and revenue reserves) when printed as one line' },
  { key: 'retained_earnings', label: 'Retained Earnings', unit: 'pkr', from: 'statement', read: 'Unappropriated profit / retained earnings / accumulated profit or (loss)' },
  { key: 'preferred_stock', label: 'Preferred Stock', unit: 'pkr', from: 'statement', read: 'Preference share capital' },
  { key: 'treasury_stock', label: 'Treasury Stock', unit: 'pkr', from: 'statement', read: 'Treasury shares' },
  { key: 'shareholders_equity', label: 'Shareholders’ Equity', unit: 'pkr', from: 'statement', read: 'Equity attributable to owners of the parent; for a company with no subsidiaries, total equity (often an unlabelled total of share capital and reserves)' },
  { key: 'minority_interest', label: 'Minority Interest', unit: 'pkr', from: 'statement', read: 'Non-controlling interest' },
  { key: 'total_equity', label: 'Total Equity', unit: 'pkr', from: 'statement', read: 'Total equity including non-controlling interest' },
  { key: 'common_shares_outstanding', label: 'Common Shares Outstanding', unit: 'shares', from: 'note', read: 'Number of issued ordinary shares (total), from the share capital note' },
  { key: 'par_value_per_share', label: 'Par Value per Share', unit: 'per_share', from: 'note', read: 'Face value of one ordinary share, e.g. "Ordinary shares of Rs. 10 each" -> 10' },
];

// ---------------------------------------------------------------------------------------------
// Cash flow statement (flows)
// ---------------------------------------------------------------------------------------------
export const CASH_FLOW: ItemDefinition[] = [
  { key: 'net_income_continuing_ops', label: 'Net Income from Continuing Operations', unit: 'pkr' },
  { key: 'cf_profit_before_tax', label: 'Profit before Taxation (cash flow)', unit: 'pkr', from: 'statement', read: 'Profit before taxation, as the first line of operating activities' },
  { key: 'cf_depreciation_amortization', label: 'Depreciation and Amortization', unit: 'pkr', from: 'statement', read: 'Depreciation and amortisation adjustment (sum if listed separately)' },
  { key: 'cf_deferred_taxes', label: 'Deferred Taxes', unit: 'pkr', from: 'statement', read: 'Deferred tax adjustment' },
  { key: 'cf_interest_income', label: 'Interest Income (cash flow adjustment)', unit: 'pkr', from: 'statement', read: 'Interest / mark-up income, listed among the non-cash adjustments' },
  { key: 'change_in_receivables', label: 'Change in Receivables', unit: 'pkr', from: 'statement', read: 'Working capital change: trade debts / receivables' },
  { key: 'change_in_inventory', label: 'Change in Inventory', unit: 'pkr', from: 'statement', read: 'Working capital change: stock-in-trade / inventories' },
  { key: 'change_in_payables', label: 'Change in Payables', unit: 'pkr', from: 'statement', read: 'Working capital change: trade and other payables' },
  { key: 'change_in_working_capital', label: 'Change in Working Capital', unit: 'pkr', from: 'statement', read: 'Total working capital changes (net), when printed' },
  { key: 'change_in_other_working_capital', label: 'Change in Other Working Capital', unit: 'pkr' },
  { key: 'cash_generated_from_operations', label: 'Cash Generated from Operations', unit: 'pkr', from: 'statement', read: 'Cash generated from / (used in) operations (before tax and interest paid)' },
  { key: 'income_tax_paid', label: 'Income Tax Paid', unit: 'pkr', from: 'statement', read: 'Income tax / taxes paid' },
  { key: 'finance_cost_paid', label: 'Finance Cost Paid', unit: 'pkr', from: 'statement', read: 'Finance costs / mark-up paid' },
  { key: 'cash_from_operations', label: 'Cashflow from Operations', unit: 'pkr', from: 'statement', read: 'Net cash generated from / (used in) operating activities' },
  { key: 'capital_expenditure', label: 'Capital Expenditures', unit: 'pkr', from: 'statement', read: 'Fixed capital expenditure / purchase of property, plant and equipment and intangibles' },
  { key: 'net_acquired_assets', label: 'Net Acquired Assets', unit: 'pkr', from: 'statement', read: 'Acquisition of subsidiary / business, net of cash acquired' },
  { key: 'sale_of_assets', label: 'Sale of Asset or Business', unit: 'pkr', from: 'statement', read: 'Proceeds from disposal / sale of fixed assets or a business' },
  { key: 'purchase_of_investments', label: 'Purchase of Investments', unit: 'pkr', from: 'statement', read: 'Investments made / purchased' },
  { key: 'sale_of_investments', label: 'Sale of Investments', unit: 'pkr', from: 'statement', read: 'Proceeds from sale / redemption of investments' },
  { key: 'cash_from_investing', label: 'Cashflow from Investing', unit: 'pkr', from: 'statement', read: 'Net cash (used in) / from investing activities' },
  { key: 'repurchase_of_stock', label: 'Repurchase of Stock', unit: 'pkr', from: 'statement', read: 'Buy-back / purchase of own (treasury) shares' },
  { key: 'debt_issued', label: 'Debt Issued', unit: 'pkr', from: 'statement', read: 'Proceeds from long-term or short-term borrowings / financing obtained' },
  { key: 'debt_repaid', label: 'Debt Repaid', unit: 'pkr', from: 'statement', read: 'Repayment of long-term or short-term borrowings / financing, excluding lease payments' },
  { key: 'lease_payments', label: 'Lease Payments', unit: 'pkr', from: 'statement', read: 'Repayment of lease liabilities (principal)' },
  { key: 'net_issuance_of_debt', label: 'Net Issuance of Debt', unit: 'pkr', from: 'statement', read: 'Net increase / (decrease) in borrowings, when printed as one line' },
  { key: 'dividends_paid', label: 'Dividends Paid', unit: 'pkr', from: 'statement', read: 'Dividends paid' },
  { key: 'other_financing_activities', label: 'Other Financing Activities', unit: 'pkr' },
  { key: 'cash_from_financing', label: 'Cashflow from Financing', unit: 'pkr', from: 'statement', read: 'Net cash (used in) / from financing activities' },
  { key: 'fx_adjustments', label: 'Foreign Exchange Rate Adjustments', unit: 'pkr', from: 'statement', read: 'Effect of exchange rate changes / net foreign exchange differences on cash' },
  { key: 'net_change_in_cash', label: 'Net Change in Cash', unit: 'pkr', from: 'statement', read: 'Net increase / (decrease) in cash and cash equivalents' },
  { key: 'cash_at_beginning', label: 'Cash at Beginning of Period', unit: 'pkr', from: 'statement', read: 'Cash and cash equivalents at the beginning of the period' },
  { key: 'cash_at_end', label: 'Cash at End of Period', unit: 'pkr', from: 'statement', read: 'Cash and cash equivalents at the end of the period' },
  { key: 'free_cash_flow', label: 'Free Cash Flow', unit: 'pkr' },
];

// ---------------------------------------------------------------------------------------------
// Ratios and per-share figures (per period; calculated only)
// ---------------------------------------------------------------------------------------------
export const RATIOS: ItemDefinition[] = [
  { key: 'asset_turnover', label: 'Asset Turnover (x)', unit: 'x' },
  { key: 'eps_basic', label: 'Basic EPS', unit: 'per_share' },
  { key: 'book_value_per_share', label: 'Book Value Per Share', unit: 'per_share' },
  { key: 'cash_conversion_cycle', label: 'Cash Conversion Cycle', unit: 'days' },
  { key: 'fcf_per_share', label: 'Free Cash Flow Per Share', unit: 'per_share' },
  { key: 'equity_to_assets', label: 'Equity to Assets (%)', unit: 'pct' },
  { key: 'equity_yoy_growth', label: 'Equity YoY Growth (%)', unit: 'pct' },
  { key: 'common_shares_outstanding', label: 'Common Shares Outstanding', unit: 'shares' },
  { key: 'cogs_to_sales', label: 'Cost of Goods Sold to Sales (%)', unit: 'pct' },
  { key: 'current_ratio', label: 'Current Ratio (x)', unit: 'x' },
  { key: 'days_payables_outstanding', label: 'Days of Payables Outstanding', unit: 'days' },
  { key: 'days_sales_in_inventory', label: 'Days Sales in Inventory', unit: 'days' },
  { key: 'days_sales_outstanding', label: 'Days Sales Outstanding', unit: 'days' },
  { key: 'debt_to_equity', label: 'Debt to Equity (%)', unit: 'pct' },
  { key: 'dividend_payout_ratio', label: 'Dividend Payout Ratio', unit: 'pct' },
  { key: 'dividend_yield', label: 'Dividend Yield (%)', unit: 'pct' },
  { key: 'dividends_per_share', label: 'Dividends Per Share', unit: 'per_share' },
  { key: 'interest_coverage', label: 'Interest Coverage (x)', unit: 'x' },
  { key: 'ebitda_margin', label: 'EBITDA Margin (%)', unit: 'pct' },
  { key: 'enterprise_value', label: 'Enterprise Value', unit: 'pkr' },
  { key: 'ev_to_ebitda', label: 'Enterprise Value to EBITDA (x)', unit: 'x' },
  { key: 'ev_to_sales', label: 'Enterprise Value to Sales (x)', unit: 'x' },
  { key: 'eps_basic_yoy_growth', label: 'EPS Basic YoY Growth (%)', unit: 'pct' },
  { key: 'float_shares', label: 'Float Shares', unit: 'shares' },
  { key: 'gross_income_margin', label: 'Gross Income Margin (x)', unit: 'x' },
  { key: 'effective_interest_rate', label: 'Effective Interest Rate (%)', unit: 'pct' },
  { key: 'inventory_turnover', label: 'Inventory Turnover (x)', unit: 'x' },
  { key: 'invested_assets_to_liabilities', label: 'Invested Assets to Liabilities', unit: 'x' },
  { key: 'net_income_margin', label: 'Net Income Margin (%)', unit: 'pct' },
  { key: 'operating_margin', label: 'Operating Margin (x)', unit: 'x' },
  { key: 'price_to_book', label: 'Price to Book Value', unit: 'x' },
  { key: 'price_to_earnings', label: 'Price to Earnings', unit: 'x' },
  { key: 'dps_yoy_growth', label: 'DPS YoY Growth (%)', unit: 'pct' },
  { key: 'price_to_fcf', label: 'Price to Free Cash Flow', unit: 'x' },
  { key: 'price_to_sales', label: 'Price to Sales', unit: 'x' },
  { key: 'price_to_tangible_book', label: 'Price to Tangible Book Value', unit: 'x' },
  { key: 'quick_ratio', label: 'Quick Ratio (x)', unit: 'x' },
  { key: 'return_on_average_assets', label: 'Return on Average Assets (%)', unit: 'pct' },
  { key: 'return_on_average_invested_capital', label: 'Return on Average Invested Capital (%)', unit: 'pct' },
  { key: 'return_on_average_total_capital', label: 'Return on Average Total Capital (%)', unit: 'pct' },
  { key: 'return_on_average_total_equity', label: 'Return on Average Total Equity (%)', unit: 'pct' },
  { key: 'return_on_common_equity', label: 'Return on Common Equity (%)', unit: 'pct' },
  { key: 'sales_to_inventory_turnover', label: 'Sales to Inventory Turnover (x)', unit: 'x' },
  { key: 'tax_rate', label: 'Tax Rate (%)', unit: 'pct' },
  { key: 'capex_to_sales', label: 'Capex to Sales (%)', unit: 'pct' },
  { key: 'debt_to_asset', label: 'Debt to Asset (%)', unit: 'pct' },
  { key: 'debt_to_capital', label: 'Debt to Capital (%)', unit: 'pct' },
  { key: 'net_sales_yoy_growth', label: 'Net Sales YoY Growth (%)', unit: 'pct' },
  { key: 'earning_yield', label: 'Earning Yield (%)', unit: 'pct' },
  { key: 'cash_flow_return_on_invested_capital', label: 'Cash Flow Return on Invested Capital (%)', unit: 'pct' },
  { key: 'graham_value', label: 'Graham Value', unit: 'per_share' },
  { key: 'fcf_to_sales', label: 'Free Cash Flow per Sales (%)', unit: 'pct' },
  { key: 'cash_to_debt', label: 'Cash to Debt Ratio (x)', unit: 'x' },
  { key: 'cash_per_share', label: 'Cash per Share', unit: 'per_share' },
  { key: 'fcf_to_cfo', label: 'Free Cash Flow per CFO (%)', unit: 'pct' },
  // Added: standard figures the list implies or analysts expect alongside it.
  { key: 'gross_margin_pct', label: 'Gross Margin (%)', unit: 'pct' },
  { key: 'operating_margin_pct', label: 'Operating Margin (%)', unit: 'pct' },
  { key: 'net_debt', label: 'Net Debt', unit: 'pkr' },
  { key: 'net_debt_to_ebitda', label: 'Net Debt to EBITDA (x)', unit: 'x' },
  { key: 'working_capital', label: 'Working Capital', unit: 'pkr' },
  { key: 'market_capitalization', label: 'Market Capitalization', unit: 'pkr' },
  { key: 'tangible_book_value_per_share', label: 'Tangible Book Value Per Share', unit: 'per_share' },
  { key: 'return_on_equity', label: 'Return on Equity (%)', unit: 'pct' },
  { key: 'return_on_assets', label: 'Return on Assets (%)', unit: 'pct' },
  { key: 'interest_coverage_ebitda', label: 'EBITDA Interest Coverage (x)', unit: 'x' },
];

export const STATEMENT_ITEMS: Record<Statement, ItemDefinition[]> = { income: INCOME, balance: BALANCE, cash_flow: CASH_FLOW };

/** Items the model is asked to read, per statement or note. */
export function readableItems(statement: Statement, from: 'statement' | 'note'): ItemDefinition[] {
  return STATEMENT_ITEMS[statement].filter((item) => item.read && item.from === from);
}
