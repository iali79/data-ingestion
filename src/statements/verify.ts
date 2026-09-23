import type { ParsedStatementLine, StatementType } from '../parser.js';
import type { ModelReading } from './llm-extract.js';
import type { StatementPage } from './pages.js';

/**
 * Turns a model reading into statement lines, trusting nothing the model said without checking
 * it against the page:
 *
 * 1. Every value must appear verbatim on the page, on the same printed line as the item's other
 *    column values. A number the model invented, transposed or took from another row is dropped.
 * 2. Each column's period must be a real date whose year is printed in the page heading, and near
 *    the filing's own period (the ingest API rejects a whole report over one far-off period).
 * 3. Units come from the page's own heading when it states them; the model's unit is a fallback.
 * 4. Accounting identities, per column: revenue - cost of sales = gross profit, and profit
 *    before tax - tax = profit after tax. Lines that break one are dropped, not guessed at.
 *
 * Signs follow the ingest contract: expenses are positive magnitudes, a loss is negative.
 */
export interface VerifiedStatement {
  lines: ParsedStatementLine[];
  dropped: Array<{ item: string; reason: string }>;
  columns: Array<{ periodEnd: string; months: number; kept: boolean; reason?: string }>;
  unitScale: number;
}

const EXPENSE_ITEMS = new Set([
  'cost_of_sales', 'distribution_cost', 'admin_expenses', 'selling_admin_expenses', 'rd_expenses',
  'depreciation_amortization', 'other_operating_expenses', 'operating_expenses', 'finance_cost',
  'taxation', 'capital_expenditure', 'dividend_paid', 'preferred_dividends',
]);

const NON_NEGATIVE_ITEMS = new Set([
  'revenue', 'total_assets', 'current_assets', 'property_plant_equipment', 'stock_in_trade',
  'trade_debts', 'cash_and_bank', 'current_liabilities', 'trade_and_other_payables',
  'short_term_borrowings', 'long_term_debt', 'total_liabilities', 'share_capital',
]);

const PER_SHARE_ITEMS = new Set(['eps_basic', 'eps_diluted']);
const NIL = /^[-–—]$/u;
const NUMBER = /^\(?-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?$|^\(?-?\d+(?:\.\d+)?\)?$/u;
const PERIOD_WINDOW_DAYS = 540;

export function verifyReading(
  statement: StatementPage,
  reading: ModelReading,
  filing: { periodEnded: string },
): VerifiedStatement {
  const type = statement.statementType;
  const pageText = statement.pages.map((page) => page.text).join('\n');
  const heading = statement.pages.map((page) => page.text.split('\n').slice(0, 25).join('\n')).join('\n');
  const dropped: VerifiedStatement['dropped'] = [];
  const unitScale = unitFromPage(pageText) ?? { rupees: 1, thousands: 1_000, millions: 1_000_000 }[reading.unit] ?? 1;

  const columns = reading.columns.map((column) => {
    const months = type === 'balance_sheet' ? 0 : column.months;
    const reason = columnProblem(column.period_end, months, type, heading, filing.periodEnded);
    return { periodEnd: column.period_end, months, kept: !reason, ...(reason ? { reason } : {}) };
  });

  const lines: ParsedStatementLine[] = [];
  const pageLines = pageText.split('\n');
  for (const entry of reading.items) {
    if (entry.values.length !== columns.length) {
      dropped.push({ item: entry.item, reason: `${entry.values.length} values for ${columns.length} columns` });
      continue;
    }
    const printed = entry.values.map((value) => value?.trim() ?? null);
    const tokens = printed.filter((value): value is string => value !== null && !NIL.test(value));
    if (printed.some((value) => value !== null && !NIL.test(value) && !NUMBER.test(value))) {
      dropped.push({ item: entry.item, reason: 'value is not a number' });
      continue;
    }
    const sourceLine = tokens.length > 0 ? lineWithAll(pageLines, tokens) : null;
    if (tokens.length > 0 && !sourceLine) {
      const missing = tokens.find((token) => !containsToken(pageText, token));
      dropped.push({
        item: entry.item,
        reason: missing ? `value ${missing} is not on the page` : 'values are not on one printed line',
      });
      continue;
    }

    for (const [index, value] of printed.entries()) {
      const column = columns[index]!;
      if (!column.kept || value === null) continue;
      const raw = NIL.test(value) ? 0 : parseNumber(value);
      const perShare = PER_SHARE_ITEMS.has(entry.item);
      let amount = perShare ? raw : raw * unitScale;
      if (EXPENSE_ITEMS.has(entry.item)) amount = Math.abs(amount);
      if (amount < 0 && NON_NEGATIVE_ITEMS.has(entry.item)) {
        dropped.push({ item: entry.item, reason: `negative ${column.periodEnd}` });
        continue;
      }
      lines.push({
        statementType: type,
        canonicalLineItem: entry.item,
        label: labelOf(sourceLine, entry.item),
        periodLabel: periodLabel(column.periodEnd, column.months),
        periodEnd: new Date(`${column.periodEnd}T00:00:00.000Z`),
        value: amount,
        currency: 'PKR',
        unitScale: perShare ? 1 : unitScale,
        confidence: 0.9,
        sourcePage: pageOf(statement, sourceLine),
        sourceText: (sourceLine ?? `${entry.item}: nil`).replace(/\s+/gu, ' ').trim().slice(0, 1_000),
        consolidationBasis: statement.basis,
      });
    }
  }

  // "Basic and diluted" printed as one line: the same figure is both.
  for (const line of [...lines]) {
    if (line.canonicalLineItem !== 'eps_basic') continue;
    const hasDiluted = lines.some((other) => other.canonicalLineItem === 'eps_diluted' && other.periodLabel === line.periodLabel);
    if (!hasDiluted && /diluted/iu.test(line.sourceText)) lines.push({ ...line, canonicalLineItem: 'eps_diluted' });
  }

  return { lines: applyIdentities(lines, dropped, unitScale), dropped, columns, unitScale };
}

export function periodLabel(periodEnd: string, months: number): string {
  return months > 0 ? `${periodEnd}/${months}M` : periodEnd;
}

function columnProblem(periodEnd: string, months: number, type: StatementType, heading: string, filingPeriod: string): string | null {
  const date = Date.parse(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(date) || new Date(date).toISOString().slice(0, 10) !== periodEnd) return 'not a date';
  if (type !== 'balance_sheet' && ![3, 6, 9, 12].includes(months)) return 'no period length';
  if (!heading.includes(periodEnd.slice(0, 4))) return `year ${periodEnd.slice(0, 4)} not in heading`;
  const reference = /^\d{4}$/u.test(filingPeriod) ? Date.parse(`${filingPeriod}-06-30T00:00:00Z`) : Date.parse(`${filingPeriod}T00:00:00Z`);
  if (!Number.isNaN(reference) && Math.abs(date - reference) > PERIOD_WINDOW_DAYS * 86_400_000) return 'too far from the filing period';
  return null;
}

/** Profit or loss identities per period; a line that breaks one is dropped with its partners. */
function applyIdentities(lines: ParsedStatementLine[], dropped: VerifiedStatement['dropped'], unitScale: number): ParsedStatementLine[] {
  const remove = new Set<ParsedStatementLine>();
  const byPeriod = new Map<string, Map<string, ParsedStatementLine>>();
  for (const line of lines) {
    const group = byPeriod.get(line.periodLabel) ?? new Map<string, ParsedStatementLine>();
    group.set(line.canonicalLineItem, line);
    byPeriod.set(line.periodLabel, group);
  }
  for (const [period, group] of byPeriod) {
    const revenue = group.get('revenue');
    const cost = group.get('cost_of_sales');
    const gross = group.get('gross_profit');
    if (revenue && cost && gross && !near(revenue.value - cost.value, gross.value, unitScale)) {
      for (const line of [revenue, cost, gross]) remove.add(line);
      dropped.push({ item: 'revenue/cost_of_sales/gross_profit', reason: `revenue - cost of sales != gross profit (${period})` });
    }
    const before = group.get('profit_before_tax');
    const tax = group.get('taxation');
    const after = group.get('profit_after_tax');
    // Tax may be an expense or a credit; either sign reconciles.
    if (before && tax && after && !near(before.value - tax.value, after.value, unitScale) && !near(before.value + tax.value, after.value, unitScale)) {
      remove.add(tax);
      dropped.push({ item: 'taxation', reason: `profit before tax - tax != profit after tax (${period})` });
    }
  }
  return lines.filter((line) => !remove.has(line));
}

/** Equal up to printed rounding: a couple of units of the filing's own scale, or 0.2%. */
function near(a: number, b: number, unitScale: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(b) * 0.002, unitScale * 2);
}

function unitFromPage(text: string): number | null {
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:millions?|mn)\b|\bin\s+millions?\b/iu.test(text)) return 1_000_000;
  if (/\b(?:rupees|rs\.?|pkr)\s*(?:in\s+)?(?:thousands?|['‘’`]\s*000)\b|\(?\s*rupees\s+in\s+['‘’`]?000|\bin\s+thousands?\b/iu.test(text)) return 1_000;
  return null;
}

function parseNumber(value: string): number {
  const negative = value.startsWith('(') || value.startsWith('-');
  const digits = Number(value.replace(/[(),\s-]/gu, ''));
  return negative ? -digits : digits;
}

/** Digits of `token` on the page as a whole number: "1,234" must not match inside "11,234". */
function containsToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\d,.])${escaped}(?![\\d,]|\\.\\d)`, 'u').test(text);
}

/** The printed line holding every token, in order. */
function lineWithAll(lines: string[], tokens: string[]): string | null {
  const bare = tokens.map((token) => token.replace(/^\(|\)$/gu, ''));
  for (const line of lines) {
    let position = 0;
    let ok = true;
    for (const token of bare) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const match = new RegExp(`(?<![\\d,.])${escaped}(?![\\d,]|\\.\\d)`, 'u').exec(line.slice(position));
      if (!match) {
        ok = false;
        break;
      }
      position += match.index + match[0].length;
    }
    if (ok) return line;
  }
  return null;
}

function labelOf(sourceLine: string | null, item: string): string {
  const label = sourceLine
    ?.split(/\s{2,}|\t/u)
    .map((part) => part.trim())
    .find((part) => /[a-z]/iu.test(part));
  return (label ?? item).slice(0, 160);
}

function pageOf(statement: StatementPage, sourceLine: string | null): number {
  if (sourceLine) {
    const page = statement.pages.find((candidate) => candidate.text.includes(sourceLine));
    if (page) return page.pageNumber;
  }
  return statement.pages[0]!.pageNumber;
}
