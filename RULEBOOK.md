# Rulebook

Fixed rules for reading a filing. Each is given to the model word for word, and most are also
enforced in code: a model answer that breaks an enforced rule is rejected, whatever the model says.
Generated from `src/financials/rulebook.ts` (`npm run rulebook`); edit that file, not this one.

| Id | Rule | Enforced in code |
|---|---|---|
| V1 | Never write, calculate, round or convert a number. Only point at printed rows; the figures are taken from the page by code. | The reply schema has no field for a number; every value is read from the row the model points at. |
| V2 | A "-" or "–" in a value column means nil (zero), not missing. | figureValue() maps a dash to 0. |
| V3 | Figures in brackets are negative: (1,234) is minus 1,234. | figureValue(). |
| V4 | Leading small numbers such as 24, 3.1.4 or 10.1, 12.1 & 13.3 on a row are note references, not values. | Only the last N figures of a row are values, N = the number of value columns. |
| C1 | Describe every value column left to right, skipping the Note column. | The number of columns and their years come from the printed heading row (e.g. "Note 2023 2022"), not from the model. |
| C2 | period_end is the date the column’s period ends, from the headings: "For the year ended December 31, 2023" with a column "2022" means 2022-12-31. | The year must be printed in the heading; the date must be within 18 months of the filing’s period. |
| C3 | months: 12 for a year, 9 for nine months, 6 for a half year, 3 for a quarter. Balance sheet columns are 0. | Balance sheet columns are forced to 0; other columns must be 3, 6, 9 or 12. |
| C4 | Quarterly and half-yearly statements often print year-to-date AND quarter columns (e.g. "Nine months ended" and "Quarter ended"): give each column its own length. | When the heading mentions no quarter, half year or nine months, every column takes the first column’s length. |
| C5 | In a quarterly or half-yearly balance sheet, the comparative column is usually the last year-end (e.g. "December 31, 2022 (Audited)"), not the same quarter a year earlier. | Column years come from the heading row; month-ends from the model. |
| C6 | Two value columns never describe the same period. | Columns are read from the printed headers by position (the nearest date and period phrase above each year); duplicate periods are dropped. |
| C7 | An interim statement that does not print its period length covers the months since the last financial year-end (e.g. year-end December, period ended September 30: nine months). | The year-end is read from the balance sheet’s comparative column; the length is computed from it. |
| R1 | Most listed items are not printed on a given page. Leave them out. Never map an item to a row that is merely similar (reserves are not retained earnings; share capital is not preferred stock; intangible assets are not goodwill). | Each item has caption rules (definitions.ts CAPTIONS); a row whose caption does not fit is rejected. |
| R2 | A row can only be one item, except one "basic and diluted" EPS line, which is both. | A row used for two items (other than EPS) is rejected for both. |
| R3 | An uncaptioned row is a total of the rows above it. Only map it to a total item (e.g. total current assets under "CURRENT ASSETS", shareholders’ equity under "SHARE CAPITAL AND RESERVES", the total tax under split tax lines). | Uncaptioned rows are accepted only for items marked as totals. |
| R3a | An uncaptioned total belongs to the heading it sits under: the total under "CURRENT ASSETS" is total current assets, under "NON-CURRENT ASSETS" total non-current assets, under "CURRENT LIABILITIES" total current liabilities, under "SHARE CAPITAL AND RESERVES" shareholders’ equity. | An uncaptioned total is accepted only under its own heading. |
| R4 | A row whose caption is printed on the line above its figures is one row (the caption wraps). | rows.ts joins a caption-only line to the figures-only line under it. |
| R5 | If an item appears on two rows with different figures, it is ambiguous: leave it out. | An item mapped to two rows with different figures is dropped. |
| R6 | A page may show two statements side by side. Read only the requested one. | Side-by-side pages are cut at the second statement’s title before rows are built. |
| U1 | unit comes from the heading: "Rupees in thousand" or "Rupees in ’000" is thousands; "in million" is millions; otherwise rupees. | The unit stated on the page overrides the model’s. |
| U2 | Earnings per share is in rupees per share and is never scaled. | EPS is not multiplied by the unit. |
| U3 | Expenses on the income statement are delivered as positive amounts; a loss is negative. | read.ts EXPENSES. |
| U4 | Cash flow figures keep their printed sign: outflows such as capital expenditure or dividends paid are negative. | Cash flow values are not re-signed. |
| I1 | *(income)* When levies (minimum / final tax) are shown before income tax, profit_before_tax is the profit AFTER levies and BEFORE income tax, and levies is the levies total. | profit_before_tax - taxation must equal profit_after_tax. |
| I2 | *(income)* taxation is the total income tax. When it is split into current / prior / deferred lines, use the uncaptioned total under them. | Same identity as I1. |
| I3 | *(income)* revenue is the net figure (after sales tax, discounts and commissions). | revenue - cost_of_sales must equal gross_profit. |
| B1 | *(balance)* shareholders_equity is the total of share capital and reserves (often an uncaptioned total). "TOTAL EQUITY AND LIABILITIES" is not equity and not liabilities. | Caption rules exclude "equity and liabilities" from equity and liability items. |
| B2 | *(balance)* Items above "EQUITY AND LIABILITIES" are assets; items below it are equity or liabilities. "Long-term loans" among assets is a loan given, not debt. | Rows are placed on the assets or claims side from the headings; an item on the wrong side is rejected. |
| B3 | *(balance)* Current maturity / current portion lines belong to the debt they are a portion of: long-term financing -> current_portion_long_term_debt; lease liabilities -> current_portion_lease_liabilities. A current portion of deferred liabilities is neither. | Caption rules. |
| F1 | *(cash flow)* Working capital lines are listed under "(Increase) / decrease in current assets" and "Increase / (decrease) in current liabilities": the trade debts line is change_in_receivables, the stock-in-trade line change_in_inventory, the trade and other payables line change_in_payables. | Caption and section rules. |
| F2 | *(cash flow)* Items belong to their section: operating, investing or financing activities. The section totals ("Net cash ... activities") are cash_from_operations, cash_from_investing and cash_from_financing. | Rows are placed in sections from the headings; an item in the wrong section is rejected. |
| F3 | *(cash flow)* Repayment lines are debt_repaid (or lease_payments for leases); proceeds / loans obtained are debt_issued. Dividends paid is never a stock repurchase. | Caption rules. |
| D1 | A figure that is not printed is calculated only when every input of its formula is available; the formula is delivered with it. Otherwise it is null. | derive.ts. |
| D2 | Average-based ratios need the balance sheet at the start of the period; sub-annual returns and turnovers are annualised (x 12 / months) and say so. | derive.ts. |
| D3 | Price multiples use the PSX closing price on or just before the period end, and earnings multiples only 12-month periods. | derive.ts. |
