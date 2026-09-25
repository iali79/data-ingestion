/**
 * Conventions every reported figure follows, whichever stage reads it: signs (rule U3), the items
 * that cannot be negative, per-share items that are never scaled (U2), the unit printed on a page
 * (U1), and interim period lengths counted from the financial year-end (C7).
 */

/** Income-statement costs are delivered as positive amounts whatever sign the filing prints. */
export const EXPENSES = new Set([
  'cost_of_sales', 'distribution_cost', 'admin_expenses', 'selling_admin_expenses', 'rd_expenses',
  'other_operating_expenses', 'operating_expenses', 'depreciation_amortization', 'finance_cost',
  'levies', 'taxation', 'preferred_dividends',
]);

/** Items that cannot be negative; a negative reading is a misread row and is dropped. */
export const NON_NEGATIVE = new Set([
  'revenue', 'cash_and_equivalents', 'short_term_investments', 'net_receivables', 'total_inventory',
  'total_current_assets', 'net_ppe', 'total_assets', 'total_current_liabilities', 'accounts_payable',
  'short_term_borrowings', 'share_capital', 'total_liabilities',
  // Cash flow proceeds are inflows: a negative one is a misprint or a shifted row.
  'sale_of_assets', 'sale_of_investments',
]);

/** Rupees per share: never multiplied by the page's unit. */
export const PER_SHARE = new Set(['eps_basic', 'eps_diluted']);

/** Months from a year-end month-day ("-12-31") to a period end month-day ("-09-30"): 9. A year-end itself is 12. */
export function monthsSince(yearEnd: string, periodEnd: string): number {
  const endMonth = Number(yearEnd.slice(1, 3));
  const periodMonth = Number(periodEnd.slice(1, 3));
  const months = (periodMonth - endMonth + 12) % 12;
  return months === 0 ? 12 : months;
}

/** The unit stated on a page: "Rupees in thousand" / "Rupees in '000" is 1,000; "in million" is 1,000,000. */
export function unitFromText(text: string): number | null {
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:millions?|mn)\b|\bin\s+millions?\b/iu.test(text)) return 1_000_000;
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:thousands?|['‘’`]\s*000)\b|rupees\s+in\s+['‘’`]?\s*000|\bin\s+thousands?\b/iu.test(text)) return 1_000;
  // "(Rs in 000's)": the thousands with no opening apostrophe (TBL's interim statements).
  if (/\b(?:rupees|rs\.?|pkr)\s*in\s+000(?:['‘’`]\s*s)?(?![\d,])/iu.test(text)) return 1_000;
  // A dashed header broken across the page's text pieces: "--(Rupees" ... "in '000)--", with a
  // column date between them (PNSC, BAFL). Bounded to one parenthesis.
  if (/\(\s*(?:rupees|rs\.?|pkr)\b[^()]{0,200}?\bin\s*['‘’`]\s*000['‘’`]?\s*\)/iu.test(text)) return 1_000;
  return null;
}

/** A column header that names only the currency, around a year or an audit note: "2023 (Rupees)", "Rupees", "Rs. (Restated)". */
const BARE_CURRENCY_HEADER = /^(?:(?:19|20)\d{2}|\(?(?:un-?)?audited\)?|\(?restated\)?|\s)*\(?\s*(?:rupees|rs\.?|pkr)\s*\)?(?:(?:19|20)\d{2}|\(?(?:un-?)?audited\)?|\(?restated\)?|\s)*$/iu;

/**
 * Rule U1, plain rupees: value columns headed only by the currency ("2023 (Rupees)") print the
 * unit as rupees, x1. Without this a statement in plain rupees counted as printing no unit and
 * inherited the filing's other tables' unit -- OCTOPUS's 2023 annual report took "Rupees in
 * million" from its six-year analysis and went out a million times too large. Consulted only
 * after unitFromText and the split "Rupees | in '000" header, so a stated scale always wins.
 */
export function unitFromHeaders(headers: string[]): 1 | null {
  return headers.some((header) => BARE_CURRENCY_HEADER.test(header.trim())) ? 1 : null;
}
