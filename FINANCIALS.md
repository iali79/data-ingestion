# Financials payload (schema version 2)

What the ingest webhook receives for each filing. Generated from `src/financials/definitions.ts`.

```json
{
  "schemaVersion": 2,
  "extractorVersion": 3,
  "filing": { "symbol": "HPL", "reportType": "annual", "periodEnded": "2023", "sourceUrl": "https://financials.psx.com.pk/..." },
  "document": { "kind": "pdf", "contentType": "application/pdf", "method": "pdftotext", "pageCount": 114, "confidence": 0.84 },
  "periods": [
    {
      "periodEnd": "2023-12-31",
      "months": 12,
      "periodType": "annual",
      "basis": "unconsolidated",
      "price": { "close": 1200, "date": "2023-12-29", "source": "PSX end-of-day close" },
      "income":   { "revenue": { "value": 21368949000, "source": "reported", "page": 46, "text": "REVENUE - NET 24 21,368,949 18,559,884" }, "gross_profit": { "value": 5526443000, "source": "derived", "formula": "revenue - cost_of_sales" }, "goodwill": null },
      "balance":  { "...": "every balance sheet key" },
      "cashFlow": { "...": "every cash flow key" },
      "ratios":   { "...": "every ratio key" }
    }
  ],
  "pages": [ { "pageNumber": 46, "method": "pdftotext", "confidence": 0.85, "text": "..." } ]
}
```

- **Every key below is present in every period**, as `{ value, source: "reported", page, text }`,
  `{ value, source: "derived", formula }`, or `null` (not printed and not derivable).
- `periodType`: `annual` (12 months), `nine_months`, `half_year`, `quarter` (3 months), or
  `balance_sheet_date` for a balance-sheet column with no flows of its own. A filing's comparative
  columns are separate periods.
- `basis`: `consolidated`, `unconsolidated` or `unknown` (a company with no group statements).
- Money in PKR, already scaled from "Rupees in thousand". Income-statement costs are positive; a loss is
  negative. Cash-flow figures keep the printed sign (outflows negative).
- Sub-annual returns and turnovers are annualised, and say so in their formula. Price multiples use the
  PSX close on or just before the period end; earnings multiples are given for 12-month periods only.

## Income statement

| Key | Label | Unit | Source |
|---|---|---|---|
| `revenue` | Revenue | PKR | Read from the statement: Revenue / net sales / turnover (the net figure) |
| `cost_of_sales` | Cost of Sales | PKR | Read from the statement: Cost of sales / cost of revenue / cost of goods sold |
| `gross_profit` | Gross Profit | PKR | Read from the statement: Gross profit (or gross loss) |
| `distribution_cost` | Distribution & Selling Costs | PKR | Read from the statement: Distribution / selling / marketing costs |
| `admin_expenses` | Administrative Expenses | PKR | Read from the statement: Administrative (and general) expenses |
| `selling_admin_expenses` | Selling & Admin Expenses | PKR | Read from the statement: ONLY a single combined "selling and administrative expenses" line |
| `rd_expenses` | R&D Expenses | PKR | Read from the statement: Research and development expenses |
| `other_operating_expenses` | Other Operating Expenses | PKR | Read from the statement: Other (operating) expenses |
| `other_income` | Other Income | PKR | Read from the statement: Other (operating) income |
| `operating_expenses` | Operating Expenses | PKR | Read from the statement: Total operating expenses, when printed as its own labelled line |
| `operating_profit` | Operating Profit (EBIT) | PKR | Read from the statement: Operating profit / profit from operations |
| `depreciation_amortization` | Depreciation & Amortization | PKR | Read from the statement: Depreciation and amortisation, only if printed on this statement |
| `ebitda` | EBITDA | PKR | Calculated (formula delivered with the value) |
| `interest_income` | Interest Income | PKR | Read from the statement: Interest / mark-up income, profit or return on bank deposits |
| `finance_cost` | Finance Cost (Interest Expense) | PKR | Read from the statement: Finance cost / mark-up / financial charges |
| `net_interest_expense` | Net Interest Expense | PKR | Calculated (formula delivered with the value) |
| `net_interest_income` | Net Interest Income | PKR | Calculated (formula delivered with the value) |
| `levies` | Levies (minimum / final tax) | PKR | Read from the statement: Levies (minimum or final tax shown separately from income tax) |
| `profit_before_tax` | Profit before Taxation | PKR | Read from the statement: Profit before taxation. If levies are shown separately, the profit AFTER levies and BEFORE income tax |
| `taxation` | Taxation | PKR | Read from the statement: Income tax for the period. If split into current/prior/deferred, the TOTAL of those lines |
| `profit_after_tax` | Net Income | PKR | Read from the statement: Profit / (loss) for the year or period |
| `net_income_to_owners` | Net Income Attributable to Owners | PKR | Read from the statement: Profit attributable to owners / equity holders of the parent (consolidated only) |
| `net_income_to_minority` | Net Income Attributable to Minority Interest | PKR | Read from the statement: Profit attributable to non-controlling interest (consolidated only) |
| `preferred_dividends` | Preferred Dividends | PKR | Read from the statement: Dividend on preference shares |
| `eps_basic` | Basic EPS | PKR per share | Read from the statement: Earnings per share - basic (also when one line says "basic and diluted") |
| `eps_diluted` | Diluted EPS | PKR per share | Read from the statement: Earnings per share - diluted, ONLY when printed as its own line |

## Balance sheet

| Key | Label | Unit | Source |
|---|---|---|---|
| `cash_and_equivalents` | Cash & Equivalents | PKR | Read from the statement: Cash and bank balances / cash and cash equivalents |
| `short_term_investments` | Short-term Investments | PKR | Read from the statement: Short-term investments |
| `net_receivables` | Net Receivables | PKR | Read from the statement: Trade debts / trade receivables (net) |
| `loans_and_advances` | Loans & Advances (current) | PKR | Read from the statement: Loans and advances (current) |
| `deposits_and_prepayments` | Deposits & Prepayments (current) | PKR | Read from the statement: Trade deposits and short-term prepayments |
| `other_receivables` | Other Receivables | PKR | Read from the statement: Other receivables (current) |
| `other_short_term_receivables` | Other Short-Term Receivables | PKR | Calculated (formula delivered with the value) |
| `stores_and_spares` | Stores & Spares | PKR | Read from the statement: Stores, spares and loose tools |
| `total_inventory` | Total Inventory | PKR | Read from the statement: Stock-in-trade / inventories |
| `inventory_raw_materials` | Inventory - Raw Materials | PKR | Read from the notes: Raw (and packing) material, net of provision |
| `inventory_work_in_progress` | Inventory - Work in Progress | PKR | Read from the notes: Work-in-process / work-in-progress |
| `inventory_finished_goods` | Inventory - Finished Goods | PKR | Read from the notes: Finished goods (including in transit), net of provision |
| `tax_refunds_due` | Taxation - Net (asset) | PKR | Read from the statement: Taxation - net / income tax refundable / advance tax (current asset) |
| `other_current_assets` | Other Current Assets | PKR | Calculated (formula delivered with the value) |
| `total_current_assets` | Total Current Assets | PKR | Read from the statement: Total current assets (often an unlabelled total under the current assets list) |
| `long_term_investments` | Long-term Investments | PKR | Read from the statement: Long-term investments / investments in subsidiaries or associates |
| `long_term_loans_advances` | Long-term Loans, Advances & Deposits | PKR | Read from the statement: Long-term loans, advances and deposits (non-current) |
| `investments_and_advances` | Investments & Advances | PKR | Calculated (formula delivered with the value) |
| `gross_ppe` | Gross PPE | PKR | Read from the notes: Operating fixed assets at cost, total (closing) |
| `ppe_land` | PPE - Land | PKR | Read from the notes: Land (freehold and leasehold), cost |
| `ppe_buildings` | PPE - Buildings | PKR | Read from the notes: Buildings, cost |
| `ppe_equipment` | PPE - Equipment | PKR | Read from the notes: Plant, machinery and equipment, cost |
| `ppe_construction` | PPE - Construction | PKR | Read from the notes: Capital work-in-progress |
| `ppe_other` | PPE - Other | PKR | Read from the notes: Other fixed assets at cost (furniture, vehicles, computers, ...), total |
| `ppe_accumulated_depreciation` | PPE Depreciation | PKR | Read from the notes: Accumulated depreciation on operating fixed assets (closing) |
| `net_ppe` | Net PPE | PKR | Read from the statement: Property, plant and equipment |
| `right_of_use_assets` | Right-of-Use Assets | PKR | Read from the statement: Right-of-use assets |
| `investment_property` | Investment Property | PKR | Read from the statement: Investment property |
| `intangible_assets` | Intangible Assets | PKR | Read from the statement: Intangible assets |
| `goodwill` | Goodwill | PKR | Read from the statement: Goodwill |
| `deferred_tax_asset` | Deferred Tax Asset | PKR | Read from the statement: Deferred tax asset |
| `total_non_current_assets` | Total Non-current Assets | PKR | Read from the statement: Total non-current assets (often an unlabelled total) |
| `total_assets` | Total Assets | PKR | Read from the statement: Total assets |
| `accounts_payable` | Accounts Payable | PKR | Read from the statement: Trade and other payables / creditors, accrued and other liabilities |
| `short_term_borrowings` | Short-term Borrowings | PKR | Read from the statement: Short-term borrowings / running finance |
| `bank_overdraft` | Bank Overdraft | PKR | Read from the statement: Bank overdraft |
| `short_term_debt` | Short-Term Debt | PKR | Calculated (formula delivered with the value) |
| `current_portion_long_term_debt` | Current Portion of Long Term Debt | PKR | Read from the statement: Current portion / maturity of long-term financing or loans |
| `current_portion_lease_liabilities` | Current Portion of Lease Liabilities | PKR | Read from the statement: Current portion of lease liabilities |
| `lease_liabilities_non_current` | Lease Liabilities (non-current) | PKR | Read from the statement: Lease liabilities (non-current) |
| `lease_liabilities` | Lease Liabilities | PKR | Calculated (formula delivered with the value) |
| `long_term_debt_excl_leases` | Long Term Debt Excluding Lease Liabilities | PKR | Read from the statement: Long-term financing / loans / borrowings (non-current), excluding leases |
| `total_debt` | Total Debt | PKR | Calculated (formula delivered with the value) |
| `deferred_taxes` | Deferred Taxes | PKR | Read from the statement: Deferred tax liability / deferred taxation (liability) |
| `employee_benefits` | Employee Benefits | PKR | Read from the statement: Defined benefit plans / staff retirement benefits / employee benefit obligations |
| `total_current_liabilities` | Current Liabilities | PKR | Read from the statement: Total current liabilities (often an unlabelled total) |
| `total_non_current_liabilities` | Total Non-current Liabilities | PKR | Read from the statement: Total non-current liabilities (often an unlabelled total) |
| `total_liabilities` | Total Liabilities | PKR | Read from the statement: Total liabilities, only when printed as its own line |
| `share_capital` | Share Capital | PKR | Read from the statement: Issued, subscribed and paid-up (share) capital |
| `additional_paid_in_capital` | Additional Paid-In Capital | PKR | Read from the statement: Share premium |
| `reserves` | Reserves | PKR | Read from the statement: Reserves (total of capital and revenue reserves) when printed as one line |
| `retained_earnings` | Retained Earnings | PKR | Read from the statement: Unappropriated profit / retained earnings / accumulated profit or (loss) |
| `preferred_stock` | Preferred Stock | PKR | Read from the statement: Preference share capital |
| `treasury_stock` | Treasury Stock | PKR | Read from the statement: Treasury shares |
| `shareholders_equity` | Shareholders’ Equity | PKR | Read from the statement: Equity attributable to owners of the parent; for a company with no subsidiaries, total equity (often an unlabelled total of share capital and reserves) |
| `minority_interest` | Minority Interest | PKR | Read from the statement: Non-controlling interest |
| `total_equity` | Total Equity | PKR | Read from the statement: Total equity including non-controlling interest |
| `common_shares_outstanding` | Common Shares Outstanding | shares | Read from the notes: Number of issued ordinary shares (total), from the share capital note |
| `par_value_per_share` | Par Value per Share | PKR per share | Read from the notes: Face value of one ordinary share, e.g. "Ordinary shares of Rs. 10 each" -> 10 |

## Cash flow

| Key | Label | Unit | Source |
|---|---|---|---|
| `net_income_continuing_ops` | Net Income from Continuing Operations | PKR | Calculated (formula delivered with the value) |
| `cf_profit_before_tax` | Profit before Taxation (cash flow) | PKR | Read from the statement: Profit before taxation, as the first line of operating activities |
| `cf_depreciation_amortization` | Depreciation and Amortization | PKR | Read from the statement: Depreciation and amortisation adjustment (sum if listed separately) |
| `cf_deferred_taxes` | Deferred Taxes | PKR | Read from the statement: Deferred tax adjustment |
| `cf_interest_income` | Interest Income (cash flow adjustment) | PKR | Read from the statement: Interest / mark-up income, listed among the non-cash adjustments |
| `change_in_receivables` | Change in Receivables | PKR | Read from the statement: Working capital change: trade debts / receivables |
| `change_in_inventory` | Change in Inventory | PKR | Read from the statement: Working capital change: stock-in-trade / inventories |
| `change_in_payables` | Change in Payables | PKR | Read from the statement: Working capital change: trade and other payables |
| `change_in_working_capital` | Change in Working Capital | PKR | Read from the statement: Total working capital changes (net), when printed |
| `change_in_other_working_capital` | Change in Other Working Capital | PKR | Calculated (formula delivered with the value) |
| `cash_generated_from_operations` | Cash Generated from Operations | PKR | Read from the statement: Cash generated from / (used in) operations (before tax and interest paid) |
| `income_tax_paid` | Income Tax Paid | PKR | Read from the statement: Income tax / taxes paid |
| `finance_cost_paid` | Finance Cost Paid | PKR | Read from the statement: Finance costs / mark-up paid |
| `cash_from_operations` | Cashflow from Operations | PKR | Read from the statement: Net cash generated from / (used in) operating activities |
| `capital_expenditure` | Capital Expenditures | PKR | Read from the statement: Fixed capital expenditure / purchase of property, plant and equipment and intangibles |
| `net_acquired_assets` | Net Acquired Assets | PKR | Read from the statement: Acquisition of subsidiary / business, net of cash acquired |
| `sale_of_assets` | Sale of Asset or Business | PKR | Read from the statement: Proceeds from disposal / sale of fixed assets or a business |
| `purchase_of_investments` | Purchase of Investments | PKR | Read from the statement: Investments made / purchased |
| `sale_of_investments` | Sale of Investments | PKR | Read from the statement: Proceeds from sale / redemption of investments |
| `cash_from_investing` | Cashflow from Investing | PKR | Read from the statement: Net cash (used in) / from investing activities |
| `repurchase_of_stock` | Repurchase of Stock | PKR | Read from the statement: Buy-back / purchase of own (treasury) shares |
| `debt_issued` | Debt Issued | PKR | Read from the statement: Proceeds from long-term or short-term borrowings / financing obtained |
| `debt_repaid` | Debt Repaid | PKR | Read from the statement: Repayment of long-term or short-term borrowings / financing, excluding lease payments |
| `lease_payments` | Lease Payments | PKR | Read from the statement: Repayment of lease liabilities (principal) |
| `net_issuance_of_debt` | Net Issuance of Debt | PKR | Read from the statement: Net increase / (decrease) in borrowings, when printed as one line |
| `dividends_paid` | Dividends Paid | PKR | Read from the statement: Dividends paid |
| `other_financing_activities` | Other Financing Activities | PKR | Calculated (formula delivered with the value) |
| `cash_from_financing` | Cashflow from Financing | PKR | Read from the statement: Net cash (used in) / from financing activities |
| `fx_adjustments` | Foreign Exchange Rate Adjustments | PKR | Read from the statement: Effect of exchange rate changes / net foreign exchange differences on cash |
| `net_change_in_cash` | Net Change in Cash | PKR | Read from the statement: Net increase / (decrease) in cash and cash equivalents |
| `cash_at_beginning` | Cash at Beginning of Period | PKR | Read from the statement: Cash and cash equivalents at the beginning of the period |
| `cash_at_end` | Cash at End of Period | PKR | Read from the statement: Cash and cash equivalents at the end of the period |
| `free_cash_flow` | Free Cash Flow | PKR | Calculated (formula delivered with the value) |

## Ratios

| Key | Label | Unit | Source |
|---|---|---|---|
| `asset_turnover` | Asset Turnover (x) | multiple | Calculated (formula delivered with the value) |
| `eps_basic` | Basic EPS | PKR per share | Calculated (formula delivered with the value) |
| `book_value_per_share` | Book Value Per Share | PKR per share | Calculated (formula delivered with the value) |
| `cash_conversion_cycle` | Cash Conversion Cycle | days | Calculated (formula delivered with the value) |
| `fcf_per_share` | Free Cash Flow Per Share | PKR per share | Calculated (formula delivered with the value) |
| `equity_to_assets` | Equity to Assets (%) | percent | Calculated (formula delivered with the value) |
| `equity_yoy_growth` | Equity YoY Growth (%) | percent | Calculated (formula delivered with the value) |
| `common_shares_outstanding` | Common Shares Outstanding | shares | Calculated (formula delivered with the value) |
| `cogs_to_sales` | Cost of Goods Sold to Sales (%) | percent | Calculated (formula delivered with the value) |
| `current_ratio` | Current Ratio (x) | multiple | Calculated (formula delivered with the value) |
| `days_payables_outstanding` | Days of Payables Outstanding | days | Calculated (formula delivered with the value) |
| `days_sales_in_inventory` | Days Sales in Inventory | days | Calculated (formula delivered with the value) |
| `days_sales_outstanding` | Days Sales Outstanding | days | Calculated (formula delivered with the value) |
| `debt_to_equity` | Debt to Equity (%) | percent | Calculated (formula delivered with the value) |
| `dividend_payout_ratio` | Dividend Payout Ratio | percent | Calculated (formula delivered with the value) |
| `dividend_yield` | Dividend Yield (%) | percent | Calculated (formula delivered with the value) |
| `dividends_per_share` | Dividends Per Share | PKR per share | Calculated (formula delivered with the value) |
| `interest_coverage` | Interest Coverage (x) | multiple | Calculated (formula delivered with the value) |
| `ebitda_margin` | EBITDA Margin (%) | percent | Calculated (formula delivered with the value) |
| `enterprise_value` | Enterprise Value | PKR | Calculated (formula delivered with the value) |
| `ev_to_ebitda` | Enterprise Value to EBITDA (x) | multiple | Calculated (formula delivered with the value) |
| `ev_to_sales` | Enterprise Value to Sales (x) | multiple | Calculated (formula delivered with the value) |
| `eps_basic_yoy_growth` | EPS Basic YoY Growth (%) | percent | Calculated (formula delivered with the value) |
| `float_shares` | Float Shares | shares | Calculated (formula delivered with the value) |
| `gross_income_margin` | Gross Income Margin (x) | multiple | Calculated (formula delivered with the value) |
| `effective_interest_rate` | Effective Interest Rate (%) | percent | Calculated (formula delivered with the value) |
| `inventory_turnover` | Inventory Turnover (x) | multiple | Calculated (formula delivered with the value) |
| `invested_assets_to_liabilities` | Invested Assets to Liabilities | multiple | Calculated (formula delivered with the value) |
| `net_income_margin` | Net Income Margin (%) | percent | Calculated (formula delivered with the value) |
| `operating_margin` | Operating Margin (x) | multiple | Calculated (formula delivered with the value) |
| `price_to_book` | Price to Book Value | multiple | Calculated (formula delivered with the value) |
| `price_to_earnings` | Price to Earnings | multiple | Calculated (formula delivered with the value) |
| `dps_yoy_growth` | DPS YoY Growth (%) | percent | Calculated (formula delivered with the value) |
| `price_to_fcf` | Price to Free Cash Flow | multiple | Calculated (formula delivered with the value) |
| `price_to_sales` | Price to Sales | multiple | Calculated (formula delivered with the value) |
| `price_to_tangible_book` | Price to Tangible Book Value | multiple | Calculated (formula delivered with the value) |
| `quick_ratio` | Quick Ratio (x) | multiple | Calculated (formula delivered with the value) |
| `return_on_average_assets` | Return on Average Assets (%) | percent | Calculated (formula delivered with the value) |
| `return_on_average_invested_capital` | Return on Average Invested Capital (%) | percent | Calculated (formula delivered with the value) |
| `return_on_average_total_capital` | Return on Average Total Capital (%) | percent | Calculated (formula delivered with the value) |
| `return_on_average_total_equity` | Return on Average Total Equity (%) | percent | Calculated (formula delivered with the value) |
| `return_on_common_equity` | Return on Common Equity (%) | percent | Calculated (formula delivered with the value) |
| `sales_to_inventory_turnover` | Sales to Inventory Turnover (x) | multiple | Calculated (formula delivered with the value) |
| `tax_rate` | Tax Rate (%) | percent | Calculated (formula delivered with the value) |
| `capex_to_sales` | Capex to Sales (%) | percent | Calculated (formula delivered with the value) |
| `debt_to_asset` | Debt to Asset (%) | percent | Calculated (formula delivered with the value) |
| `debt_to_capital` | Debt to Capital (%) | percent | Calculated (formula delivered with the value) |
| `net_sales_yoy_growth` | Net Sales YoY Growth (%) | percent | Calculated (formula delivered with the value) |
| `earning_yield` | Earning Yield (%) | percent | Calculated (formula delivered with the value) |
| `cash_flow_return_on_invested_capital` | Cash Flow Return on Invested Capital (%) | percent | Calculated (formula delivered with the value) |
| `graham_value` | Graham Value | PKR per share | Calculated (formula delivered with the value) |
| `fcf_to_sales` | Free Cash Flow per Sales (%) | percent | Calculated (formula delivered with the value) |
| `cash_to_debt` | Cash to Debt Ratio (x) | multiple | Calculated (formula delivered with the value) |
| `cash_per_share` | Cash per Share | PKR per share | Calculated (formula delivered with the value) |
| `fcf_to_cfo` | Free Cash Flow per CFO (%) | percent | Calculated (formula delivered with the value) |
| `gross_margin_pct` | Gross Margin (%) | percent | Calculated (formula delivered with the value) |
| `operating_margin_pct` | Operating Margin (%) | percent | Calculated (formula delivered with the value) |
| `net_debt` | Net Debt | PKR | Calculated (formula delivered with the value) |
| `net_debt_to_ebitda` | Net Debt to EBITDA (x) | multiple | Calculated (formula delivered with the value) |
| `working_capital` | Working Capital | PKR | Calculated (formula delivered with the value) |
| `market_capitalization` | Market Capitalization | PKR | Calculated (formula delivered with the value) |
| `tangible_book_value_per_share` | Tangible Book Value Per Share | PKR per share | Calculated (formula delivered with the value) |
| `return_on_equity` | Return on Equity (%) | percent | Calculated (formula delivered with the value) |
| `return_on_assets` | Return on Assets (%) | percent | Calculated (formula delivered with the value) |
| `interest_coverage_ebitda` | EBITDA Interest Coverage (x) | multiple | Calculated (formula delivered with the value) |
