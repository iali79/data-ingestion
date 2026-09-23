export type StatementType = 'income_statement' | 'balance_sheet' | 'cash_flow';
export type ConsolidationBasis = 'consolidated' | 'unconsolidated' | 'unknown';

export interface ParsedStatementLine {
  statementType: StatementType;
  canonicalLineItem: string;
  label: string;
  periodLabel: string;
  periodEnd: Date | null;
  value: number;
  /** `null` for a derived percentage line, which has no currency. */
  currency: string | null;
  unitScale: number;
  confidence: number;
  sourcePage: number | null;
  sourceText: string;
  consolidationBasis: ConsolidationBasis;
}

export interface ParsedStatementResult {
  promoted: ParsedStatementLine[];
  candidates: ParsedStatementLine[];
}

export interface CorporateActionCandidate {
  symbol: string;
  actionType: 'dividend' | 'bonus' | 'right' | 'split';
  eventDate: Date;
  exDate: Date | null;
  details: Record<string, unknown>;
  confidence: number;
  sourceText: string;
}

const SECTION_MARKERS: Array<[StatementType, RegExp]> = [
  ['income_statement', /^(consolidated\s+|un-?consolidated\s+|separate\s+)?(statement\s+of\s+(profit\s+or\s+loss|income)|profit\s+and\s+loss|income\s+statement)\b/iu],
  ['balance_sheet', /^(consolidated\s+|un-?consolidated\s+|separate\s+)?(statement\s+of\s+financial\s+position|balance\s+sheet)\b/iu],
  ['cash_flow', /^(consolidated\s+|un-?consolidated\s+|separate\s+)?(statement\s+of\s+cash\s+flows?|cash\s+flow\s+statement)\b/iu],
];

/**
 * A document-level "which set of statements am I in" banner, e.g. a cover page reading
 * "CONSOLIDATED FINANCIAL STATEMENTS" ahead of a run of un-prefixed statement headers. Falls
 * back to whatever a statement header itself restates (`SECTION_MARKERS`'s own capture group),
 * which takes precedence when present since it is closer to the numbers.
 */
const BASIS_BANNER: RegExp =
  /^(consolidated|un-?consolidated|separate|standalone)\s+(?:condensed\s+interim\s+)?financial\s+statements?\b/iu;

function basisFromWord(word: string | undefined): ConsolidationBasis {
  const trimmed = word?.trim();
  if (!trimmed) return 'unknown';
  return /^un-?consolidated$|^separate$|^standalone$/iu.test(trimmed) ? 'unconsolidated' : 'consolidated';
}

/**
 * Headings that mark the end of reliable face-of-statement text: the notes (which restate
 * statement-item wording against unrelated breakdown tables), the directors' report, and the
 * statement of changes in equity (a grid of movements, not a value-per-line table). Anchored to
 * the start of the line -- these are checked against every line in the document, and an
 * unanchored match would catch incidental mentions (a table of contents entry, a cross-
 * reference inside a real statement) as well as the real heading.
 */
const NON_STATEMENT_BOUNDARY = /^(notes?\s+to\b|directors?'?\s+report|statement\s+of\s+changes|shareholding\s+pattern)\b/iu;

/**
 * A "Financial Highlights" / multi-year summary page: a trend table with interleaved
 * percentage columns that reuses face-of-statement wording ("Cost of sales", "Current assets")
 * against a completely different table shape. Confirmed against a real PSX annual report, where
 * it produced a false `cost_of_sales` and a false, negative `current_assets`. Unlike
 * `NON_STATEMENT_BOUNDARY` this is deliberately unanchored and phrase-based rather than
 * heading-only, since real filings word it inconsistently ("Operating & Financial Highlights",
 * "The Year at a Glance", "Six Years' Summary").
 */
const HIGHLIGHTS_HEADING =
  /\bfinancial\s+highlights\b|\byear\s+at\s+a\s+glance\b|\b(?:six|6)[\s-]years?'?\s+summary\b|\bkey\s+(?:financial\s+)?(?:data|indicators)\b|\bhorizontal\s+analysis\b|\bvertical\s+analysis\b/iu;

const LINE_ALIASES: Array<{
  statementType: StatementType;
  canonical: string;
  confidence: number;
  pattern: RegExp;
}> = [
  // --- income statement ----------------------------------------------------------------
  // Order matters: `.find()` takes the first match, so a more specific alias (e.g. a combined
  // "selling and administrative expenses" line, or "profit before taxation") must be listed
  // ahead of a narrower one it would otherwise also satisfy (e.g. a bare "taxation" line).
  { statementType: 'income_statement', canonical: 'revenue', confidence: 0.9, pattern: /\b(revenue|turnover|net\s+sales|sales)\b/iu },
  { statementType: 'income_statement', canonical: 'cost_of_sales', confidence: 0.88, pattern: /\bcost\s+of\s+(sales|goods\s+sold|revenue|services\s+rendered)\b/iu },
  { statementType: 'income_statement', canonical: 'gross_profit', confidence: 0.88, pattern: /\bgross\s+profit\b/iu },
  { statementType: 'income_statement', canonical: 'selling_admin_expenses', confidence: 0.85, pattern: /\b(selling\s*(?:,|and|&)\s*(?:distribution\s*(?:,|and|&)\s*)?administrative\s+expenses|administrative\s*(?:,|and|&)\s*selling\s+expenses)\b/iu },
  { statementType: 'income_statement', canonical: 'distribution_cost', confidence: 0.82, pattern: /\b(distribution\s+(?:cost|expenses?)|selling\s+(?:and\s+distribution\s+)?expenses?|selling\s+cost)\b/iu },
  { statementType: 'income_statement', canonical: 'admin_expenses', confidence: 0.82, pattern: /\b(administrative\s+expenses?|general\s+and\s+administrative\s+expenses?)\b/iu },
  { statementType: 'income_statement', canonical: 'rd_expenses', confidence: 0.85, pattern: /\b(research\s+and\s+development\s+expenses?|r\s*&\s*d\s+expenses?)\b/iu },
  { statementType: 'income_statement', canonical: 'depreciation_amortization', confidence: 0.8, pattern: /\bdepreciation\s*(?:and|&)\s*amorti[sz]ation\b/iu },
  { statementType: 'income_statement', canonical: 'other_operating_expenses', confidence: 0.8, pattern: /\bother\s+operating\s+expenses?\b/iu },
  { statementType: 'income_statement', canonical: 'other_income', confidence: 0.78, pattern: /\bother\s+income\b/iu },
  { statementType: 'income_statement', canonical: 'operating_expenses', confidence: 0.8, pattern: /\btotal\s+operating\s+expenses?\b/iu },
  { statementType: 'income_statement', canonical: 'operating_profit', confidence: 0.88, pattern: /\b(operating\s+profit|profit\s+from\s+operations|ebit)\b/iu },
  { statementType: 'income_statement', canonical: 'ebitda', confidence: 0.85, pattern: /\bebitda\b/iu },
  { statementType: 'income_statement', canonical: 'interest_income', confidence: 0.78, pattern: /\b(interest\s+income|return\s+on\s+(?:bank\s+)?deposits)\b/iu },
  { statementType: 'income_statement', canonical: 'finance_cost', confidence: 0.86, pattern: /\b(finance\s+cost|financial\s+charges?|mark-?up)\b/iu },
  { statementType: 'income_statement', canonical: 'profit_before_tax', confidence: 0.9, pattern: /\bprofit\s+before\s+(?:income\s+)?(?:tax|taxation)\b/iu },
  { statementType: 'income_statement', canonical: 'profit_after_tax', confidence: 0.92, pattern: /\b(profit\s+after\s+(tax|taxation)|profit\s+for\s+the\s+(year|period)|net\s+income)\b/iu },
  // Generic tax-expense line, checked last of the three so it never pre-empts "profit before/
  // after taxation" -- both of those phrases contain the word "taxation" too.
  { statementType: 'income_statement', canonical: 'taxation', confidence: 0.85, pattern: /\b(taxation|income\s+tax\s+expense|provision\s+for\s+taxation)\b/iu },
  { statementType: 'income_statement', canonical: 'preferred_dividends', confidence: 0.82, pattern: /\b(preferen[cs]e\s+(?:share\s+)?dividends?|dividend\s+on\s+preference\s+shares|preferred\s+dividends?)\b/iu },
  { statementType: 'income_statement', canonical: 'eps_diluted', confidence: 0.9, pattern: /\bdiluted\b.{0,30}\b(earnings?\s+per\s+share|eps)\b|\b(earnings?\s+per\s+share|eps)\b.{0,30}\bdiluted\b/iu },
  { statementType: 'income_statement', canonical: 'eps_basic', confidence: 0.9, pattern: /\b(?:basic\s+)?(earnings?\s+per\s+share|eps)\b/iu },
  // --- balance sheet --------------------------------------------------------------------
  { statementType: 'balance_sheet', canonical: 'total_assets', confidence: 0.9, pattern: /\btotal\s+assets\b/iu },
  { statementType: 'balance_sheet', canonical: 'current_assets', confidence: 0.84, pattern: /(?<!non[-\s])\bcurrent\s+assets\b/iu },
  { statementType: 'balance_sheet', canonical: 'property_plant_equipment', confidence: 0.82, pattern: /\bproperty,?\s+plant\s+and\s+equipment\b/iu },
  { statementType: 'balance_sheet', canonical: 'stock_in_trade', confidence: 0.8, pattern: /\b(stock[-\s]in[-\s]trade|inventor(?:y|ies))\b/iu },
  { statementType: 'balance_sheet', canonical: 'trade_debts', confidence: 0.8, pattern: /\b(trade\s+debts?|trade\s+receivables?)\b/iu },
  { statementType: 'balance_sheet', canonical: 'total_liabilities', confidence: 0.9, pattern: /\btotal\s+liabilit(?:y|ies)\b/iu },
  { statementType: 'balance_sheet', canonical: 'current_liabilities', confidence: 0.84, pattern: /(?<!non[-\s])\bcurrent\s+liabilit(?:y|ies)\b/iu },
  { statementType: 'balance_sheet', canonical: 'trade_and_other_payables', confidence: 0.8, pattern: /\btrade\s+and\s+other\s+payables\b/iu },
  { statementType: 'balance_sheet', canonical: 'short_term_borrowings', confidence: 0.8, pattern: /\bshort[-\s]term\s+borrowings?\b/iu },
  { statementType: 'balance_sheet', canonical: 'long_term_debt', confidence: 0.8, pattern: /\blong[-\s]term\s+(?:debt|financing|borrowings?)\b/iu },
  { statementType: 'balance_sheet', canonical: 'total_debt', confidence: 0.88, pattern: /\b(total\s+(?:debt|borrowings)|borrowings\s+total)\b/iu },
  { statementType: 'balance_sheet', canonical: 'share_capital', confidence: 0.8, pattern: /\b(issued,?\s+subscribed\s+and\s+paid[-\s]up\s+capital|share\s+capital)\b/iu },
  { statementType: 'balance_sheet', canonical: 'retained_earnings', confidence: 0.8, pattern: /\b(retained\s+earnings|unappropriated\s+profit|accumulated\s+(?:profit|loss))\b/iu },
  { statementType: 'balance_sheet', canonical: 'non_controlling_interest', confidence: 0.82, pattern: /\bnon[-\s]controlling\s+interests?\b/iu },
  { statementType: 'balance_sheet', canonical: 'total_equity', confidence: 0.9, pattern: /\b(total\s+equity(?!\s+and\s+liabilit)|shareholders'? equity|equity\s+attributable)\b/iu },
  { statementType: 'balance_sheet', canonical: 'cash_and_bank', confidence: 0.86, pattern: /\b(cash\s+and\s+bank|cash\s+and\s+cash\s+equivalents|bank\s+balances?)\b/iu },
  // --- cash flow --------------------------------------------------------------------------
  { statementType: 'cash_flow', canonical: 'operating_cash_flow', confidence: 0.9, pattern: /\b(net\s+cash.{0,45}operating\s+activities|cash\s+flows?\s+from\s+operating)\b/iu },
  { statementType: 'cash_flow', canonical: 'capital_expenditure', confidence: 0.78, pattern: /\b(?:purchase|acquisition|additions?)\s+of\s+(?:property,?\s+plant\s+and\s+equipment|fixed\s+assets)\b/iu },
  { statementType: 'cash_flow', canonical: 'investing_cash_flow', confidence: 0.9, pattern: /\b(net\s+cash.{0,45}investing\s+activities|cash\s+flows?\s+from\s+investing)\b/iu },
  { statementType: 'cash_flow', canonical: 'dividend_paid', confidence: 0.8, pattern: /\bdividends?\s+paid\b/iu },
  { statementType: 'cash_flow', canonical: 'financing_cash_flow', confidence: 0.9, pattern: /\b(net\s+cash.{0,45}financing\s+activities|cash\s+flows?\s+from\s+financing)\b/iu },
];

const PROMOTION_CONFIDENCE = 0.75;

/** Expense/cost lines, normalized to a positive magnitude regardless of how the source PDF
 *  signs them -- see the comment at their one use site. */
const EXPENSE_MAGNITUDE_ITEMS = new Set([
  'cost_of_sales',
  'distribution_cost',
  'admin_expenses',
  'selling_admin_expenses',
  'rd_expenses',
  'depreciation_amortization',
  'other_operating_expenses',
  'operating_expenses',
  'finance_cost',
  'taxation',
]);

/** Structurally non-negative items -- a negative reading is dropped as a parsing artifact. */
const NON_NEGATIVE_ITEMS = new Set([
  'revenue',
  'gross_profit',
  'total_assets',
  'current_assets',
  'property_plant_equipment',
  'stock_in_trade',
  'trade_debts',
  'cash_and_bank',
  'total_liabilities',
  'current_liabilities',
  'trade_and_other_payables',
  'short_term_borrowings',
  'long_term_debt',
  'total_debt',
  'share_capital',
]);

export function parseFinancialStatements(
  text: string,
  options: {
    periodLabel: string;
    periodEnd?: Date | null;
    pageConfidences?: number[];
  } = { periodLabel: 'unknown' },
): ParsedStatementResult {
  const candidates: ParsedStatementLine[] = [];
  let section: StatementType | null = null;
  // The banner's basis persists until a later banner or a restating section header overrides
  // it; the section header's own capture (closer to the numbers) always wins when present.
  let documentBasis: ConsolidationBasis = 'unknown';
  let sectionBasis: ConsolidationBasis = 'unknown';
  let unitScale = 1;
  let linesSinceSection = 0;
  let currentValueFromRight = 2;
  // Whether we have EVER been inside a real section, or inside a non-statement zone that reuses
  // statement wording (a "Financial Highlights" / six-year summary page is the concrete case
  // that motivated this: it repeats "Cost of sales" and "Current assets" against a completely
  // different, multi-year-plus-percentage table shape). Real annual reports run to 100+ pages,
  // most of it Notes -- being permissive about matching outside an active section is only safe
  // before the document's real structure has been seen at all (which is what the no-header
  // synthetic-text case below relies on); once it has, a line with no active section is Notes
  // or similar, and letting any alias match it regardless of statement type produces false
  // positives from disclosure tables that reuse face-of-statement label wording.
  let structureSeen = false;
  const targetYear = extractTargetYear(options.periodLabel, options.periodEnd);

  const pages = text.split(/\f/u);
  pages.forEach((page, pageIndex) => {
    const pageScale = inferUnitScale(page);
    for (const rawLine of page.split(/\r?\n/u)) {
      const line = rawLine.replace(/\s+/gu, ' ').trim();
      if (!line) continue;

      const declaredScale = inferUnitScale(line);
      if (declaredScale !== 1) unitScale = declaredScale;

      const headerOrder = comparativeColumnFromRight(line, targetYear);
      if (headerOrder !== null) currentValueFromRight = headerOrder;

      const banner = BASIS_BANNER.exec(line);
      if (banner) documentBasis = basisFromWord(banner[1]);

      const marker = SECTION_MARKERS.find(([, pattern]) => pattern.test(line));
      if (marker) {
        section = marker[0];
        sectionBasis = basisFromWord(marker[1].exec(line)?.[1]);
        unitScale = declaredScale !== 1 ? declaredScale : pageScale;
        linesSinceSection = 0;
        structureSeen = true;
        continue;
      }

      if ((NON_STATEMENT_BOUNDARY.test(line) || HIGHLIGHTS_HEADING.test(line)) && (section || !structureSeen)) {
        section = null;
        structureSeen = true;
      }
      if (section && ++linesSinceSection > 120) section = null;

      const alias = LINE_ALIASES.find(
        (entry) =>
          entry.pattern.test(line) &&
          (section ? entry.statementType === section : !structureSeen) &&
          !(entry.canonical === 'revenue' && /\b(cost\s+of\s+sales|sales\s+tax|selling\s+and\s+distribution|profit\s+for\s+the|profit\s+after\s+tax)\b/iu.test(line)),
      );
      if (!alias) continue;

      const parsedNumber = parseCurrentPeriodNumber(line, currentValueFromRight);
      let value = parsedNumber.value;
      if (value === null) continue;
      // A parenthesized figure is negative by PDF convention, but whether an issuer prints an
      // expense line that way or as a plain positive deduction varies company to company -- the
      // canonical value should be a consistent magnitude either way. Assets, liabilities, equity
      // components and revenue have no such ambiguity: they are structurally non-negative, so a
      // negative reading here is a parsing artifact (almost always a multi-column PDF page
      // linearized onto one text line, pulling a number from an unrelated adjacent table) rather
      // than a real value, and is dropped instead of promoted.
      if (EXPENSE_MAGNITUDE_ITEMS.has(alias.canonical)) value = Math.abs(value);
      else if (value < 0 && NON_NEGATIVE_ITEMS.has(alias.canonical)) continue;

      const sameSection = section === alias.statementType;
      const pageConfidence = options.pageConfidences?.[pageIndex] ?? 0.8;
      const parserConfidence = alias.confidence + (sameSection ? 0.06 : -0.18) - parsedNumber.confidencePenalty;
      const confidence = Math.min(0.99, pageConfidence, parserConfidence);
      const valueScale = alias.canonical === 'eps_basic' || alias.canonical === 'eps_diluted' ? 1 : unitScale;
      candidates.push({
        statementType: alias.statementType,
        canonicalLineItem: alias.canonical,
        label: labelFromLine(line),
        consolidationBasis: sectionBasis !== 'unknown' ? sectionBasis : documentBasis,
        periodLabel: options.periodLabel,
        periodEnd: options.periodEnd ?? null,
        value: value * valueScale,
        currency: 'PKR',
        unitScale: valueScale,
        confidence,
        sourcePage: pageIndex + 1,
        sourceText: line,
      });
    }
  });

  const promoted = dedupeBest(candidates.filter((line) => line.confidence >= PROMOTION_CONFIDENCE));
  addDerivedLines(promoted);
  return { candidates, promoted };
}

export function parseCorporateActionsFromText(
  text: string,
  context: { symbol: string; announcedAt?: Date | null },
): CorporateActionCandidate[] {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  const eventDate = context.announcedAt ?? new Date();
  const exDate = parseDateNear(normalized, /\bex-?date\b/iu);
  const out: CorporateActionCandidate[] = [];

  const dividend = /(?:cash\s+)?dividend\b.{0,80}?(\d+(?:\.\d+)?)\s*%/iu.exec(normalized);
  if (dividend) {
    out.push(action(context.symbol, 'dividend', eventDate, exDate, { dividendPercent: Number(dividend[1]) }, dividend[0]));
  }

  const bonus = /bonus(?:\s+shares?)?\b.{0,50}?(\d+(?:\.\d+)?)\s*%/iu.exec(normalized);
  if (bonus) {
    out.push(action(context.symbol, 'bonus', eventDate, exDate, { bonusPercent: Number(bonus[1]) }, bonus[0]));
  }

  const right = /rights?(?:\s+(?:shares?|issue))?\b.{0,50}?(\d+(?:\.\d+)?)\s*%/iu.exec(normalized);
  if (right) {
    out.push(action(context.symbol, 'right', eventDate, exDate, { rightPercent: Number(right[1]) }, right[0]));
  }

  const split = /split\s+(?:of\s+)?(?:shares?\s+)?(\d+)\s*[:/]\s*(\d+)/iu.exec(normalized);
  if (split) {
    out.push(action(context.symbol, 'split', eventDate, exDate, { splitRatio: `${split[1]}:${split[2]}` }, split[0]));
  }

  return out;
}

function action(
  symbol: string,
  actionType: CorporateActionCandidate['actionType'],
  eventDate: Date,
  exDate: Date | null,
  details: Record<string, unknown>,
  sourceText: string,
): CorporateActionCandidate {
  return { symbol, actionType, eventDate, exDate, details, confidence: 0.82, sourceText };
}

function dedupeBest(lines: ParsedStatementLine[]): ParsedStatementLine[] {
  const best = new Map<string, ParsedStatementLine>();
  for (const line of lines) {
    // Basis is part of the identity: a holding company's consolidated and unconsolidated
    // profit_after_tax for the same period are two different, both-worth-keeping numbers, not
    // duplicates of each other.
    const key = `${line.statementType}|${line.canonicalLineItem}|${line.periodLabel}|${line.consolidationBasis}`;
    const current = best.get(key);
    if (!current || line.confidence > current.confidence) best.set(key, line);
  }
  return [...best.values()];
}

function inferUnitScale(text: string): number {
  if (/\b(?:amounts?|figures?|rupees?|rs\.?|pkr)[^a-z0-9]{0,8}(?:are\s+)?(?:stated\s+)?(?:in\s+)?(?:millions?|mn)\b/iu.test(text)) {
    return 1_000_000;
  }
  if (/\b(?:amounts?|figures?|rupees?|rs\.?|pkr)[^a-z0-9]{0,8}(?:are\s+)?(?:stated\s+)?(?:in\s+)?(?:thousands?|['’]?000s?)\b/iu.test(text)) {
    return 1_000;
  }
  return 1;
}

/**
 * Fills in canonical items that are more reliably computed from two already-promoted items
 * than matched as their own text line -- either because issuers rarely state them verbatim
 * (`operating_expenses` as a face-of-P&L rollup is uncommon; "Gross profit less Operating
 * profit" holds regardless of how a given issuer itemizes the pieces in between) or because
 * the two halves are commonly split across separate lines (`distribution_cost` +
 * `admin_expenses` where no combined "selling and administrative expenses" line exists).
 *
 * Runs once per (period, consolidation basis) group -- a holding company's consolidated and
 * unconsolidated equity for the same period are different numbers and must be derived
 * separately, not averaged or cross-contaminated.
 */
function addDerivedLines(lines: ParsedStatementLine[]): void {
  const groups = new Map<string, Map<string, ParsedStatementLine>>();
  for (const line of lines) {
    const key = `${line.periodLabel}|${line.consolidationBasis}`;
    const byItem = groups.get(key);
    if (byItem) byItem.set(line.canonicalLineItem, line);
    else groups.set(key, new Map([[line.canonicalLineItem, line]]));
  }

  const additions: ParsedStatementLine[] = [];
  for (const byItem of groups.values()) {
    derive(additions, byItem, 'total_equity', ['total_assets', 'total_liabilities'], (a, b) => a - b, 'Total equity (derived, assets less liabilities)');
    derive(additions, byItem, 'operating_expenses', ['gross_profit', 'operating_profit'], (a, b) => a - b, 'Operating expenses (derived, gross profit less operating profit)');
    derive(additions, byItem, 'selling_admin_expenses', ['distribution_cost', 'admin_expenses'], (a, b) => a + b, 'Selling & admin expenses (derived, distribution cost plus admin expenses)');
    derive(additions, byItem, 'ebitda', ['operating_profit', 'depreciation_amortization'], (a, b) => a + b, 'EBITDA (derived, operating profit plus D&A)');
    derive(additions, byItem, 'net_interest_income', ['interest_income', 'finance_cost'], (a, b) => a - b, 'Net interest income (derived, interest income less finance cost)');
    deriveRatio(additions, byItem, 'gross_margin_pct', 'gross_profit', 'revenue', 'Gross margin % (derived)');
    deriveRatio(additions, byItem, 'operating_margin_pct', 'operating_profit', 'revenue', 'Operating margin % (derived)');
    deriveRatio(additions, byItem, 'net_margin_pct', 'profit_after_tax', 'revenue', 'Net margin % (derived)');
    deriveRatio(additions, byItem, 'tax_rate_pct', 'taxation', 'profit_before_tax', 'Tax rate % (derived)');
  }
  lines.push(...additions);
}

/**
 * A percentage line (numerator / denominator x 100). Only for a positive denominator: a margin
 * on zero or negative revenue, or a tax rate on a pre-tax loss, has no meaning and is omitted
 * rather than emitted as a nonsense number.
 */
function deriveRatio(
  additions: ParsedStatementLine[],
  byItem: Map<string, ParsedStatementLine>,
  canonical: string,
  numeratorKey: string,
  denominatorKey: string,
  label: string,
): void {
  if (byItem.has(canonical)) return;
  const numerator = byItem.get(numeratorKey);
  const denominator = byItem.get(denominatorKey);
  if (!numerator || !denominator || !(denominator.value > 0)) return;
  const derived: ParsedStatementLine = {
    ...numerator,
    statementType: 'income_statement',
    canonicalLineItem: canonical,
    label,
    value: Number(((numerator.value / denominator.value) * 100).toFixed(4)),
    currency: null,
    unitScale: 1,
    confidence: Math.max(PROMOTION_CONFIDENCE, Math.min(numerator.confidence, denominator.confidence) - 0.02),
    sourceText: `Derived from ${numeratorKey} / ${denominatorKey}: ${numerator.sourceText} | ${denominator.sourceText}`,
  };
  additions.push(derived);
  byItem.set(canonical, derived);
}

function derive(
  additions: ParsedStatementLine[],
  byItem: Map<string, ParsedStatementLine>,
  canonical: string,
  [aKey, bKey]: [string, string],
  combine: (a: number, b: number) => number,
  label: string,
): void {
  if (byItem.has(canonical)) return;
  const a = byItem.get(aKey);
  const b = byItem.get(bKey);
  if (!a || !b) return;
  const derived: ParsedStatementLine = {
    ...a,
    canonicalLineItem: canonical,
    label,
    value: combine(a.value, b.value),
    confidence: Math.max(PROMOTION_CONFIDENCE, Math.min(a.confidence, b.confidence) - 0.02),
    sourceText: `Derived from ${aKey} and ${bKey}: ${a.sourceText} | ${b.sourceText}`,
  };
  additions.push(derived);
  byItem.set(canonical, derived);
}

function parseCurrentPeriodNumber(
  line: string,
  currentValueFromRight: number,
): { value: number | null; confidencePenalty: number } {
  const cleaned = line.replace(/Rs\.?|PKR|rupees/giu, ' ');
  const matches = [...cleaned.matchAll(/\(?-?\d[\d,]*(?:\.\d+)?\)?/gu)];
  if (matches.length === 0) return { value: null, confidencePenalty: 0 };

  // Published statements normally place current and comparative values in the final two
  // numeric columns, with an optional note number before them. The old parser took the final
  // token, which is usually the comparative year. One value is unambiguous; two or more use
  // the period-header ordering, defaulting to the conventional current-then-comparative order.
  const fromRight = matches.length === 1 ? 1 : Math.min(currentValueFromRight, matches.length);
  const token = matches[matches.length - fromRight]![0];
  const negative = token.startsWith('(') && token.endsWith(')');
  const value = Number(token.replace(/[(),]/gu, ''));
  if (!Number.isFinite(value)) return { value: null, confidencePenalty: 0 };
  return {
    value: negative ? -value : value,
    confidencePenalty: matches.length === 1 ? 0 : 0.03,
  };
}

function extractTargetYear(periodLabel: string, periodEnd?: Date | null): number | null {
  if (periodEnd && !Number.isNaN(periodEnd.getTime())) return periodEnd.getUTCFullYear();
  const match = /\b(20\d{2})\b/u.exec(periodLabel);
  return match ? Number(match[1]) : null;
}

function comparativeColumnFromRight(line: string, targetYear: number | null): number | null {
  if (targetYear === null) return null;
  const years = [...line.matchAll(/\b(20\d{2})\b/gu)].map((match) => Number(match[1]));
  const unique = years.filter((year, index) => years.indexOf(year) === index);
  if (unique.length < 2 || unique.length > 4) return null;
  const index = unique.indexOf(targetYear);
  if (index === -1) return null;
  return unique.length - index;
}

function labelFromLine(line: string): string {
  return line.replace(/\(?-?\d[\d,]*(?:\.\d+)?\)?/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function parseDateNear(text: string, marker: RegExp): Date | null {
  const match = marker.exec(text);
  if (match?.index == null) return null;
  const fragment = text.slice(match.index, match.index + 120);
  const date = /(\d{1,2})[-/\s]([A-Za-z]{3,9}|\d{1,2})[-/\s](\d{2,4})/u.exec(fragment);
  if (!date) return null;
  const [, day, month, year = ''] = date;
  const parsed = new Date(`${day} ${month} ${year.length === 2 ? `20${year}` : year} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
