/**
 * The rulebook: fixed rules for reading a filing. Every rule has an id, is given to the model
 * word for word (`modelRules`), and -- where marked `enforced` -- is also checked in code, so a
 * model answer that breaks it is rejected whatever the model says. RULEBOOK.md is generated from
 * this file (`npm run rulebook`), so the document and the running rules can never differ.
 */
export interface Rule {
  id: string;
  text: string;
  /** Where the code enforces it, or null for guidance the model follows and verification catches indirectly. */
  enforced: string | null;
  /** Applies to one statement only. */
  statement?: 'income' | 'balance' | 'cash_flow';
}

export const RULES: Rule[] = [
  // --- values -----------------------------------------------------------------------------
  { id: 'V1', text: 'Never write, calculate, round or convert a number. Only point at printed rows; the figures are taken from the page by code.', enforced: 'The reply schema has no field for a number; every value is read from the row the model points at.' },
  { id: 'V2', text: 'A "-" or "–" in a value column means nil (zero), not missing.', enforced: 'figureValue() maps a dash to 0.' },
  { id: 'V3', text: 'Figures in brackets are negative: (1,234) is minus 1,234.', enforced: 'figureValue().' },
  { id: 'V4', text: 'Leading small numbers such as 24, 3.1.4 or 10.1, 12.1 & 13.3 on a row are note references, not values.', enforced: 'Only the last N figures of a row are values, N = the number of value columns.' },
  // --- columns and periods ---------------------------------------------------------------
  { id: 'C1', text: 'Describe every value column left to right, skipping the Note column.', enforced: 'The number of columns and their years come from the printed heading row (e.g. "Note 2023 2022"), not from the model.' },
  { id: 'C2', text: 'period_end is the date the column’s period ends, from the headings: "For the year ended December 31, 2023" with a column "2022" means 2022-12-31.', enforced: 'The year must be printed in the heading; the date must be within 18 months of the filing’s period.' },
  { id: 'C3', text: 'months: 12 for a year, 9 for nine months, 6 for a half year, 3 for a quarter. Balance sheet columns are 0.', enforced: 'Balance sheet columns are forced to 0; other columns must be 3, 6, 9 or 12.' },
  { id: 'C4', text: 'Quarterly and half-yearly statements often print year-to-date AND quarter columns (e.g. "Nine months ended" and "Quarter ended"): give each column its own length.', enforced: 'When the heading mentions no quarter, half year or nine months, every column takes the first column’s length.' },
  { id: 'C5', text: 'In a quarterly or half-yearly balance sheet, the comparative column is usually the last year-end (e.g. "December 31, 2022 (Audited)"), not the same quarter a year earlier.', enforced: 'Column years come from the heading row; month-ends from the model.' },
  { id: 'C6', text: 'Two value columns never describe the same period.', enforced: 'Columns are read from the printed headers by position (the nearest date and period phrase above each year); duplicate periods are dropped.' },
  { id: 'C7', text: 'An interim statement that does not print its period length covers the months since the last financial year-end (e.g. year-end December, period ended September 30: nine months).', enforced: 'The year-end is read from the balance sheet\u2019s comparative column; the length is computed from it.' },
  // --- choosing rows ----------------------------------------------------------------------
  { id: 'R1', text: 'Most listed items are not printed on a given page. Leave them out. Never map an item to a row that is merely similar (reserves are not retained earnings; share capital is not preferred stock; intangible assets are not goodwill).', enforced: 'Each item has caption rules (definitions.ts CAPTIONS); a row whose caption does not fit is rejected.' },
  { id: 'R2', text: 'A row can only be one item, except one "basic and diluted" EPS line, which is both.', enforced: 'A row used for two items (other than EPS) is rejected for both.' },
  { id: 'R3', text: 'An uncaptioned row is a total of the rows above it. Only map it to a total item (e.g. total current assets under "CURRENT ASSETS", shareholders’ equity under "SHARE CAPITAL AND RESERVES", the total tax under split tax lines).', enforced: 'Uncaptioned rows are accepted only for items marked as totals.' },
  { id: 'R3a', text: 'An uncaptioned total belongs to the heading it sits under: the total under "CURRENT ASSETS" is total current assets, under "NON-CURRENT ASSETS" total non-current assets, under "CURRENT LIABILITIES" total current liabilities, under "SHARE CAPITAL AND RESERVES" shareholders\u2019 equity.', enforced: 'An uncaptioned total is accepted only under its own heading.' },
  { id: 'R4', text: 'A row whose caption is printed on the line above its figures is one row (the caption wraps).', enforced: 'rows.ts joins a caption-only line to the figures-only line under it.' },
  { id: 'R5', text: 'If an item appears on two rows with different figures, it is ambiguous: leave it out.', enforced: 'An item mapped to two rows with different figures is dropped.' },
  { id: 'R6', text: 'A page may show two statements side by side. Read only the requested one.', enforced: 'Side-by-side pages are cut at the second statement’s title before rows are built.' },
  // --- units and signs --------------------------------------------------------------------
  { id: 'U1', text: 'unit comes from the heading: "Rupees in thousand" or "Rupees in ’000" is thousands; "in million" is millions; otherwise rupees.', enforced: 'The unit stated on the page overrides the model’s.' },
  { id: 'U2', text: 'Earnings per share is in rupees per share and is never scaled.', enforced: 'EPS is not multiplied by the unit.' },
  { id: 'U3', text: 'Expenses on the income statement are delivered as positive amounts; a loss is negative.', enforced: 'read.ts EXPENSES.' },
  { id: 'U4', text: 'Cash flow figures keep their printed sign: outflows such as capital expenditure or dividends paid are negative.', enforced: 'Cash flow values are not re-signed.' },
  // --- statement-specific ---------------------------------------------------------------
  { id: 'I1', statement: 'income', text: 'When levies (minimum / final tax) are shown before income tax, profit_before_tax is the profit AFTER levies and BEFORE income tax, and levies is the levies total.', enforced: 'profit_before_tax - taxation must equal profit_after_tax.' },
  { id: 'I2', statement: 'income', text: 'taxation is the total income tax. When it is split into current / prior / deferred lines, use the uncaptioned total under them.', enforced: 'Same identity as I1.' },
  { id: 'I3', statement: 'income', text: 'revenue is the net figure (after sales tax, discounts and commissions).', enforced: 'revenue - cost_of_sales must equal gross_profit.' },
  { id: 'B1', statement: 'balance', text: 'shareholders_equity is the total of share capital and reserves (often an uncaptioned total). "TOTAL EQUITY AND LIABILITIES" is not equity and not liabilities.', enforced: 'Caption rules exclude "equity and liabilities" from equity and liability items.' },
  { id: 'B2', statement: 'balance', text: 'Items above "EQUITY AND LIABILITIES" are assets; items below it are equity or liabilities. "Long-term loans" among assets is a loan given, not debt.', enforced: 'Rows are placed on the assets or claims side from the headings; an item on the wrong side is rejected.' },
  { id: 'B3', statement: 'balance', text: 'Current maturity / current portion lines belong to the debt they are a portion of: long-term financing -> current_portion_long_term_debt; lease liabilities -> current_portion_lease_liabilities. A current portion of deferred liabilities is neither.', enforced: 'Caption rules.' },
  { id: 'F1', statement: 'cash_flow', text: 'Working capital lines are listed under "(Increase) / decrease in current assets" and "Increase / (decrease) in current liabilities": the trade debts line is change_in_receivables, the stock-in-trade line change_in_inventory, the trade and other payables line change_in_payables.', enforced: 'Caption and section rules.' },
  { id: 'F2', statement: 'cash_flow', text: 'Items belong to their section: operating, investing or financing activities. The section totals ("Net cash ... activities") are cash_from_operations, cash_from_investing and cash_from_financing.', enforced: 'Rows are placed in sections from the headings; an item in the wrong section is rejected.' },
  { id: 'F3', statement: 'cash_flow', text: 'Repayment lines are debt_repaid (or lease_payments for leases); proceeds / loans obtained are debt_issued. Dividends paid is never a stock repurchase.', enforced: 'Caption rules.' },
  // --- calculation (code only) ---------------------------------------------------------------
  { id: 'D1', text: 'A figure that is not printed is calculated only when every input of its formula is available; the formula is delivered with it. Otherwise it is null.', enforced: 'derive.ts.' },
  { id: 'D2', text: 'Average-based ratios need the balance sheet at the start of the period; sub-annual returns and turnovers are annualised (x 12 / months) and say so.', enforced: 'derive.ts.' },
  { id: 'D3', text: 'Price multiples use the PSX closing price on or just before the period end, and earnings multiples only 12-month periods.', enforced: 'derive.ts.' },
];

/** The rules as given to the model for one statement. */
export function modelRules(statement: 'income' | 'balance' | 'cash_flow'): string {
  return RULES.filter((rule) => !rule.id.startsWith('D') && (!rule.statement || rule.statement === statement))
    .map((rule) => `${rule.id}. ${rule.text}`)
    .join('\n');
}

export function rulebookMarkdown(): string {
  const lines = [
    '# Rulebook',
    '',
    'Fixed rules for reading a filing. Each is given to the model word for word, and most are also',
    'enforced in code: a model answer that breaks an enforced rule is rejected, whatever the model says.',
    'Generated from `src/financials/rulebook.ts` (`npm run rulebook`); edit that file, not this one.',
    '',
    '| Id | Rule | Enforced in code |',
    '|---|---|---|',
    ...RULES.map((rule) => `| ${rule.id} | ${rule.statement ? `*(${rule.statement.replace('_', ' ')})* ` : ''}${rule.text.replace(/\|/gu, '\\|')} | ${rule.enforced ? rule.enforced.replace(/\|/gu, '\\|') : 'Guidance only'} |`),
    '',
  ];
  return lines.join('\n');
}
