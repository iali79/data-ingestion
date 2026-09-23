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
  return null;
}
