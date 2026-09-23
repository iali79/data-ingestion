import type { Statement } from '../financials/definitions.js';
import type { StatementRow } from './normalize.js';

/**
 * Stage 5b -- printed row labels to canonical items, deterministically.
 *
 * Each statement has an ordered list of label rules; the first rule a row satisfies decides its
 * item, so specific wording is listed before general ("current maturity of lease liabilities"
 * before "lease liabilities"). A rule may also require where the row sits: the balance-sheet side
 * (assets / equity and liabilities), the heading it is under ("CURRENT ASSETS"), or the cash-flow
 * section (operating / investing / financing). Rows no rule claims are reported as unmatched, so
 * the rules grow from evidence rather than guesswork.
 *
 * Uncaptioned total rows ("                 7,816,272   10,244,793") are claimed by the heading
 * they close: the last uncaptioned row under "CURRENT ASSETS" is total current assets.
 */
export type Side = 'assets' | 'claims';
export type Section = 'operating' | 'investing' | 'financing';
export type Under = 'current_assets' | 'non_current_assets' | 'current_liabilities' | 'non_current_liabilities' | 'equity';

export interface LabelRule {
  item: string;
  label: RegExp;
  side?: Side;
  section?: Section;
  under?: Under;
  not?: RegExp;
  /** Only below the activity sections (the reconciliation of cash at the foot of a cash flow). */
  outside?: boolean;
}

export interface Placement {
  side?: Side;
  section?: Section;
  under?: Under;
}

export interface Match {
  row: StatementRow;
  items: string[];
  rule: string;
}

const rule = (item: string, label: RegExp, extra: Omit<LabelRule, 'item' | 'label'> = {}): LabelRule => ({ item, label, ...extra });

const PROFIT = String.raw`\(?(?:profit|loss|income|earnings)\)?(?:\s*/\s*\(?(?:profit|loss|income|earnings)\)?)?`;

export const LABEL_RULES: Record<Statement, LabelRule[]> = {
  income: [
    rule('cost_of_sales', /^(?:less:?\s*)?cost of (?:sales|revenue|goods sold|services)\b/u),
    rule('revenue', /^(?:net )?(?:sales|revenue|turnover)(?: from contracts? with customers)?(?: - net| net|, net)?(?: \(net\))?$|^(?:net )?(?:sales|revenue)\b.*\bnet$/u, { not: /cost|gross/u }),
    rule('gross_profit', /^gross (?:\(?(?:profit|loss)\)?)/u),
    rule('selling_admin_expenses', /^(?:selling|distribution|marketing)[a-z ,&]*(?:and|&) (?:general )?administrative|^administrative[a-z ,&]*(?:and|&) (?:selling|distribution|marketing)/u),
    rule('distribution_cost', /^(?:selling,? )?(?:distribution|selling|marketing)(?: and (?:selling|distribution|marketing))?(?: costs?| expenses?)?$/u),
    rule('admin_expenses', /^(?:general and )?administrative(?: and general)?(?: expenses?| costs?)?$/u),
    rule('rd_expenses', /^research and development/u),
    rule('other_operating_expenses', /^other (?:operating )?(?:expenses?|charges)$/u),
    rule('other_income', /^other (?:operating )?income(?: - net)?$/u),
    rule('operating_profit', new RegExp(String.raw`^operating ${PROFIT}$|^${PROFIT} from operations$`, 'u')),
    rule('finance_cost', /^(?:finance|financial) (?:costs?|charges)(?: - net)?$|^mark[- ]?up (?:expense|on borrowings)|^interest expense/u),
    rule('interest_income', /^(?:finance|interest|mark[- ]?up) income$/u),
    rule('levies', /^(?:levy|levies|minimum tax|final tax)(?: - net)?$/u),
    rule('profit_before_tax', new RegExp(String.raw`^${PROFIT} before (?:income )?tax(?:ation)?$`, 'u')),
    rule('taxation', /^(?:taxation|income tax(?: expense)?|tax(?:ation)? (?:expense|charge)|provision for taxation)(?: - net| for the (?:year|period))?$/u),
    rule('profit_after_tax', new RegExp(String.raw`^(?:net )?${PROFIT} (?:after (?:income )?tax(?:ation)?|for the (?:year|period))$`, 'u')),
    rule('net_income_to_owners', /^(?:equity holders|owners|shareholders) of the (?:parent|holding company|company)$/u),
    rule('net_income_to_minority', /^non[- ]?controlling interests?$/u),
    rule('eps_basic', new RegExp(String.raw`^${PROFIT} per share\b`, 'u')),
  ],
  balance: [
    rule('right_of_use_assets', /^right[- ]of[- ]use assets?$/u, { side: 'assets' }),
    rule('investment_property', /^investment propert(?:y|ies)$/u, { side: 'assets' }),
    rule('net_ppe', /^(?:property,? plant (?:and|&) equipment|operating fixed assets|fixed assets - tangible)$/u, { side: 'assets' }),
    rule('intangible_assets', /^intangible assets?$/u, { side: 'assets' }),
    rule('goodwill', /^goodwill$/u, { side: 'assets' }),
    rule('long_term_investments', /^(?:long[- ]term investments?|investments? in (?:subsidiar|associate|joint))/u, { side: 'assets' }),
    rule('long_term_loans_advances', /^long[- ]term (?:loans?|advances?)(?: and advances)?(?: to employees)?(?: - considered good)?$/u, { side: 'assets' }),
    rule('deferred_tax_asset', /^deferred tax(?:ation)?(?: asset)?(?: - net)?$/u, { side: 'assets' }),
    rule('stores_and_spares', /^stores(?:,? spares)?(?: (?:and|&) (?:spares|loose tools))?(?: and loose tools)?$/u, { side: 'assets' }),
    rule('total_inventory', /^(?:stock[- ]in[- ]trade|inventor(?:y|ies))(?: - net)?$/u, { side: 'assets' }),
    rule('net_receivables', /^trade (?:debts|receivables?)(?: - net| - considered good)?$/u, { side: 'assets' }),
    rule('loans_and_advances', /^(?:loans and advances|advances)(?: - considered good)?$/u, { side: 'assets', under: 'current_assets' }),
    rule('deposits_and_prepayments', /^(?:trade )?deposits,? (?:and )?(?:short[- ]term )?prepayments$|^deposits and prepayments$/u, { side: 'assets' }),
    rule('other_receivables', /^other receivables?(?: - considered good)?$/u, { side: 'assets' }),
    rule('short_term_investments', /^short[- ]term investments?$/u, { side: 'assets' }),
    rule('tax_refunds_due', /^(?:taxation|income tax)(?: - net| refunds? due(?: from (?:the )?government)?| recoverable)?$|^tax refunds? due/u, { side: 'assets', under: 'current_assets' }),
    rule('cash_and_equivalents', /^cash (?:and|&) (?:bank balances?|cash equivalents|bank)$/u, { side: 'assets' }),
    rule('total_current_assets', /^total current assets$/u, { side: 'assets' }),
    rule('total_non_current_assets', /^total non[- ]?current assets$/u, { side: 'assets' }),
    rule('total_assets', /^total assets$/u),
    rule('share_capital', /^(?:issued,? subscribed and paid[- ]up (?:share )?capital|share capital)$/u, { side: 'claims' }),
    rule('additional_paid_in_capital', /^share premium(?: account| reserve)?$/u, { side: 'claims' }),
    rule('retained_earnings', /^(?:unappropriated profit|accumulated (?:profit|loss)(?:es)?|retained earnings|revenue reserves?)$/u, { side: 'claims' }),
    rule('reserves', /^reserves$/u, { side: 'claims' }),
    rule('treasury_stock', /^treasury (?:shares|stock)$/u, { side: 'claims' }),
    rule('minority_interest', /^non[- ]?controlling interests?$/u, { side: 'claims' }),
    rule('total_equity', /^total equity$/u, { side: 'claims' }),
    rule('shareholders_equity', /^total (?:shareholders'?|owners'?)? ?equity(?: attributable to (?:the )?(?:owners|equity holders|shareholders).*)?$|^equity attributable to (?:the )?(?:owners|equity holders|shareholders)/u, { side: 'claims' }),
    rule('current_portion_lease_liabilities', /^current (?:portion|maturity) of lease liabilit/u, { side: 'claims' }),
    rule('current_portion_long_term_debt', /^current (?:portion|maturity) of long[- ]term (?:financ|loans?|borrow)/u, { side: 'claims' }),
    rule('lease_liabilities_non_current', /^lease liabilit(?:y|ies)$/u, { side: 'claims', under: 'non_current_liabilities' }),
    rule('long_term_debt_excl_leases', /^(?:long[- ]term (?:financ(?:e|ing)|loans?|borrowings?)(?: - secured)?|term finance certificates|sukuks?)$/u, { side: 'claims', under: 'non_current_liabilities' }),
    rule('deferred_taxes', /^deferred tax(?:ation)?(?: liabilit(?:y|ies))?(?: - net)?$/u, { side: 'claims' }),
    rule('employee_benefits', /^(?:staff retirement benefits?|employee benefits?(?: obligations?)?|(?:defined benefit|gratuity)(?: obligations?| plan)?|retirement benefit obligations?)$/u, { side: 'claims' }),
    rule('accounts_payable', /^(?:trade and other payables|trade creditors|creditors,? accrued and other liabilities)$/u, { side: 'claims' }),
    rule('bank_overdraft', /^bank overdrafts?$/u, { side: 'claims' }),
    rule('short_term_borrowings', /^(?:short[- ]term (?:borrowings?|financ(?:e|ing)|loans?|running finance)|running finance(?: under mark[- ]up arrangements?)?)(?: - secured)?$/u, { side: 'claims' }),
    rule('total_current_liabilities', /^total current liabilities$/u, { side: 'claims' }),
    rule('total_non_current_liabilities', /^total non[- ]?current liabilities$/u, { side: 'claims' }),
    rule('total_liabilities', /^total liabilities$/u, { side: 'claims' }),
  ],
  cash_flow: [
    rule('cf_profit_before_tax', new RegExp(String.raw`^${PROFIT} before (?:income )?tax(?:ation)?$`, 'u'), { section: 'operating' }),
    rule('cf_depreciation_amortization', /^depreciation(?: (?:and|&) amorti[sz]ation)?$/u, { section: 'operating' }),
    rule('cash_generated_from_operations', /^cash (?:generated from|\(used in\) \/ generated from|generated from \/ \(used in\)|used in|from) operations$/u, { section: 'operating' }),
    rule('change_in_receivables', /^trade (?:debts|receivables?)$/u, { section: 'operating' }),
    rule('change_in_inventory', /^(?:stock[- ]in[- ]trade|inventor(?:y|ies))$/u, { section: 'operating' }),
    rule('change_in_payables', /^trade and other payables\b|^trade creditors$/u, { section: 'operating' }),
    rule('income_tax_paid', /^(?:income )?tax(?:es|ation)? paid$/u, { section: 'operating' }),
    rule('finance_cost_paid', /^(?:finance costs?|financial charges|mark[- ]?up|interest)(?: on borrowings)? paid$/u, { section: 'operating' }),
    rule('cf_interest_income', /^(?:interest|mark[- ]?up|profit|return) (?:income )?received$/u, { section: 'operating' }),
    rule('cash_from_operations', /^net cash (?:generated from|\(used in\) \/ generated from|generated from \/ \(used in\)|used in|from|inflow from|outflow from)(?: \/ \(used in\))? operating activities$/u),
    rule('capital_expenditure', /^(?:fixed )?capital expenditure(?: incurred)?$|^(?:purchase|acquisition|additions?) (?:of|to) (?:property,? plant (?:and|&) equipment|fixed assets|operating fixed assets)$/u, { section: 'investing' }),
    rule('sale_of_assets', /^(?:sale )?proceeds from (?:the )?(?:sale|disposal) of (?:property,? plant (?:and|&) equipment|fixed assets|operating fixed assets?)$/u, { section: 'investing' }),
    rule('purchase_of_investments', /^(?:investments? made|purchase of (?:short[- ]term )?investments?)$/u, { section: 'investing' }),
    rule('sale_of_investments', /^(?:proceeds from )?(?:sale|disposal|redemption|encashment|maturity) of (?:short[- ]term )?investments?$/u, { section: 'investing' }),
    rule('cash_from_investing', /^net cash (?:generated from|\(used in\) \/ generated from|generated from \/ \(used in\)|used in|from|inflow from|outflow from)(?: \/ \(used in\))? investing activities$/u),
    rule('dividends_paid', /^dividends? paid(?: to (?:the )?(?:ordinary )?shareholders)?$/u, { section: 'financing' }),
    rule('lease_payments', /^(?:repayment of )?(?:principal portion of )?lease (?:liabilit(?:y|ies)|rentals?|payments?)(?: paid)?$|^payments? (?:of|against) lease liabilit/u, { section: 'financing' }),
    rule('debt_repaid', /^repayments? of (?:(?:principal portion(?: of)? )?long[- ]term )?(?:financ(?:e|ing)|loans?|borrowings?)/u, { section: 'financing', not: /lease/u }),
    rule('debt_issued', /^(?:proceeds from |long[- ]term )?(?:long[- ]term )?(?:financ(?:e|ing)|loans?|borrowings?) (?:obtained|received|availed|drawn)$|^proceeds from (?:long[- ]term )?(?:financ(?:e|ing)|loans?|borrowings?)$/u, { section: 'financing' }),
    rule('cash_from_financing', /^net cash (?:generated from|\(used in\) \/ generated from|generated from \/ \(used in\)|used in|from|inflow from|outflow from)(?: \/ \(used in\))? financing activities$/u),
    rule('net_change_in_cash', /^net (?:\(?(?:increase|decrease)\)?(?: \/ \(?(?:increase|decrease)\)?)?|change) in cash and cash equivalents$/u),
    rule('fx_adjustments', /^(?:net )?(?:foreign )?exchange (?:differences?|gain|loss)(?: on cash and cash equivalents)?$|^effect of exchange rate changes|^exchange differences on translation of foreign operations$/u, { outside: true }),
    rule('cash_at_beginning', /^cash and cash equivalents at (?:the )?beginning(?: of the(?: (?:year|period))?)?$|^opening cash and cash equivalents$/u),
    rule('cash_at_end', /^cash and cash equivalents at (?:the )?end(?: of the(?: (?:year|period))?)?$|^closing cash and cash equivalents$/u),
  ],
};

/** Uncaptioned totals are claimed by the heading they close. */
const HEADING_TOTAL: Record<Under, string> = {
  current_assets: 'total_current_assets',
  non_current_assets: 'total_non_current_assets',
  current_liabilities: 'total_current_liabilities',
  non_current_liabilities: 'total_non_current_liabilities',
  equity: 'shareholders_equity',
};

/** A printed label in comparable form: lower case, OCR punctuation removed, spaces collapsed. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‘’`´]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[–—]/gu, '-')
    .replace(/(?<=\w)[.:](?=\s|$)/gu, '')
    .replace(/^[^a-z(]+/u, '')
    // "long-term" is one word; "stock-in-trade - net" and "trade debts- net" are separated.
    .replace(/(\w)(\s*)-(\s*)(?=\w)/gu, (_, before: string, left: string, right: string) => (left || right ? `${before} - ` : `${before}-`))
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Where each row sits: balance-sheet side and heading, cash-flow section. Unknown when the table
 * prints no such heading, in which case position is not required.
 */
export function placeRows(rows: StatementRow[]): Map<string, Placement> {
  const claims = /(?:equity|capital) and liabilities|liabilities and (?:equity|capital)|share capital and reserves|capital and reserves/u;
  const hasClaims = rows.some((row) => [...row.headings, row.label].some((text) => claims.test(normalizeLabel(text))));
  const placed = new Map<string, Placement>();
  let side: Side | undefined = hasClaims ? 'assets' : undefined;
  let section: Section | undefined;
  let under: Under | undefined;
  for (const row of rows) {
    for (const heading of row.headings.map(normalizeLabel)) {
      if (/non[- ]?current assets/u.test(heading)) under = 'non_current_assets';
      else if (/current assets/u.test(heading)) under = 'current_assets';
      else if (/non[- ]?current liabilities/u.test(heading)) under = 'non_current_liabilities';
      else if (/current liabilities/u.test(heading)) under = 'current_liabilities';
      else if (/share capital and reserves|^equity$|shareholders' equity|capital and reserves/u.test(heading)) under = 'equity';
      // Crossing to equity and liabilities closes the assets headings.
      if (hasClaims && claims.test(heading)) {
        side = 'claims';
        if (under === 'current_assets' || under === 'non_current_assets') under = /share capital and reserves|capital and reserves/u.test(heading) ? 'equity' : undefined;
      }
      if (/operating activities/u.test(heading)) section = 'operating';
      if (/investing activities/u.test(heading)) section = 'investing';
      if (/financing activities/u.test(heading)) section = 'financing';
    }
    const label = normalizeLabel(row.label);
    if (hasClaims && claims.test(label)) side = 'claims';
    placed.set(row.id, { ...(side ? { side } : {}), ...(section ? { section } : {}), ...(under ? { under } : {}) });
    // A section total closes its section: "Net cash ... operating activities" is the last row of it.
    if (/^net cash .* activities$/u.test(label)) section = undefined;
  }
  return placed;
}

/**
 * The item for each row (rules R1-R5): the first label rule that fits the row's wording and
 * position; for an uncaptioned total, the heading it closes. One row is one item (a combined
 * "basic and diluted" EPS line is both EPS items).
 */
export function matchRows(kind: Statement, rows: StatementRow[]): { matches: Match[]; unmatched: StatementRow[] } {
  const placed = placeRows(rows);
  const matches: Match[] = [];
  const unmatched: StatementRow[] = [];
  for (const [index, row] of rows.entries()) {
    const where = placed.get(row.id) ?? {};
    const label = normalizeLabel(row.label);
    if (!label) {
      const total = uncaptionedTotal(kind, rows, index, placed);
      if (total) matches.push({ row, items: [total.item], rule: total.rule });
      continue;
    }
    const found = LABEL_RULES[kind].find(
      (candidate) =>
        candidate.label.test(label) &&
        !candidate.not?.test(label) &&
        (!candidate.side || !where.side || candidate.side === where.side) &&
        (!candidate.section || !where.section || candidate.section === where.section) &&
        (!candidate.under || !where.under || candidate.under === where.under) &&
        (!candidate.outside || !where.section),
    );
    if (!found) {
      unmatched.push(row);
      continue;
    }
    const items = found.item === 'eps_basic' ? epsItems(label) : [found.item];
    matches.push({ row, items, rule: `label "${label}"` });
  }
  return { matches, unmatched };
}

function epsItems(label: string): string[] {
  if (/diluted/u.test(label) && /basic/u.test(label)) return ['eps_basic', 'eps_diluted'];
  if (/diluted/u.test(label)) return ['eps_diluted'];
  return ['eps_basic'];
}

/** Authorised capital is printed under the equity heading but is not part of equity. */
const AUTHORISED = /\bauthori[sz]ed\b/u;

function addsUpUnder(rows: StatementRow[], index: number, under: string, placed: Map<string, Placement>): boolean {
  const row = rows[index]!;
  const parts = rows.slice(0, index).filter((item) =>
    placed.get(item.id)?.under === under && normalizeLabel(item.label) && item.values.some((value) => value !== null) &&
    ![...item.headings, item.label].some((text) => AUTHORISED.test(normalizeLabel(text))));
  if (parts.length === 0) return false;
  return row.values.some((value, column) =>
    value !== null && value !== undefined && parts.every((item) => item.values[column] !== null && item.values[column] !== undefined) &&
    Math.abs(parts.reduce((total, item) => total + item.values[column]!, 0) - value) <= 0.5 * parts.length + 0.5);
}

/**
 * An uncaptioned row is a total. On the balance sheet it is the total of the heading it closes --
 * only the last uncaptioned row before the next heading, since a heading can hold a sub-subtotal
 * ("Fixed assets" inside non-current assets). On the income statement, an uncaptioned row right
 * after split tax lines ("Taxation - current / - prior / - deferred") is the tax total.
 */
function uncaptionedTotal(kind: Statement, rows: StatementRow[], index: number, placed: Map<string, Placement>): { item: string; rule: string } | null {
  const row = rows[index]!;
  if (kind === 'balance') {
    const under = placed.get(row.id)?.under;
    if (!under) return null;
    // It must add up: the captioned rows under the heading, down to it, sum to it in a column where
    // every one of them was read; of several that do (a "fixed assets" subtotal inside non-current
    // assets), the last is the heading's total. The last uncaptioned row under "CURRENT
    // LIABILITIES" can be the grand total printed below "Contingencies and commitments", which adds
    // up to nothing under the heading. (Which of the row's figures are right is for validate.ts.)
    if (!addsUpUnder(rows, index, under, placed)) return null;
    for (let later = index + 1; later < rows.length; later++) {
      if (placed.get(rows[later]!.id)?.under !== under) break;
      if (!normalizeLabel(rows[later]!.label) && addsUpUnder(rows, later, under, placed)) return null;
    }
    return { item: HEADING_TOTAL[under], rule: `uncaptioned total closing ${under.replace(/_/gu, ' ')}` };
  }
  if (kind === 'income') {
    // The tax lines directly above: "Taxation - current", "- prior", "- deferred".
    const above: StatementRow[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const label = normalizeLabel(rows[i]!.label);
      if (!/\btax/u.test(label) || /before|after/u.test(label)) break;
      above.unshift(rows[i]!);
    }
    if (above.length >= 2) {
      return { item: 'taxation', rule: 'uncaptioned total of the tax lines above' };
    }
  }
  return null;
}
