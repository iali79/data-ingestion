import type { Statement } from '../financials/definitions.js';
import type { ReportedValue } from '../financials/derive.js';
import { EXPENSES, NON_NEGATIVE, PER_SHARE } from '../financials/conventions.js';
import { normalizeLabel, type Match } from './labels.js';
import type { StatementRow, StatementTable } from './normalize.js';

/**
 * Stage 6 -- financial validation. Three independent kinds of check:
 *
 * 1. Table arithmetic (rule A1). A statement is built from running totals: gross profit is sales
 *    less cost of sales, an uncaptioned line totals the rows above it, "Net cash from operating
 *    activities" sums its section. For every total row and every column, the rows directly above it
 *    are added up; when they equal the printed total exactly (to rounding), the total and each row
 *    in the sum are confirmed. This checks the printed figures themselves, before any labelling.
 * 2. Accounting identities per period (I1-I3, B4-B5, F4-F5): revenue - cost of sales = gross
 *    profit, profit before tax - tax = profit after tax, total assets = total equity and
 *    liabilities, the cash flow sections add up to the change in cash, and opening cash plus the
 *    change is closing cash. Values in a failed identity are dropped -- null beats wrong.
 * 3. Cross-statement ties (X1): the cash flow's profit before tax equals the income statement's.
 *
 * Figures read by OCR must also be confirmed by at least one check (rule V5): a misread digit
 * breaks the arithmetic, so an unconfirmed OCR figure is never delivered.
 */
export interface Drop {
  item: string;
  reason: string;
}

/** Labels of rows that close a running total. Uncaptioned rows are totals too. */
export const TOTAL_LABEL =
  /^(?:total\b|gross\b|operating \(?(?:profit|loss)|.*\b(?:profit|loss)\)?(?: \/ \(?(?:profit|loss)\)?)? (?:before|after|for the)\b|net cash\b|net \(?(?:increase|decrease)|cash (?:generated|used|\(used in\)|from)\b.*operations$|cash and cash equivalents at (?:the )?end)/u;
/** How far above a total its components may start. */
export const MAX_RUN = 40;

/** Row id -> columns (value indexes) confirmed by table arithmetic, with the total that confirmed them. */
export type Confirmed = Map<string, Map<number, string>>;

export function confirmTotals(table: StatementTable): Confirmed {
  const confirmed: Confirmed = new Map();
  const mark = (row: StatementRow, column: number, by: string) => {
    const columns = confirmed.get(row.id) ?? new Map<number, string>();
    if (!columns.has(column)) columns.set(column, by);
    confirmed.set(row.id, columns);
  };
  for (const column of table.columns) {
    const live: StatementRow[] = [];
    for (const row of table.rows) {
      const value = row.values[column.index];
      if (value === null || value === undefined) continue;
      const label = normalizeLabel(row.label);
      if (!label || TOTAL_LABEL.test(label)) {
        let sum = 0;
        let found = -1;
        for (let k = 1; k <= Math.min(MAX_RUN, live.length); k++) {
          sum += live[live.length - k]!.values[column.index]!;
          if (k >= 2 && Math.abs(sum - value) <= 0.5 * k + 0.5) {
            found = k;
            break;
          }
        }
        if (found > 0) {
          const parts = live.splice(live.length - found, found);
          const by = `A1 sum to ${row.id}`;
          for (const part of parts) mark(part, column.index, by);
          mark(row, column.index, by);
        }
      }
      live.push(row);
    }
  }
  return confirmed;
}

/**
 * Matched rows to reported values: one per item and kept column, scaled to rupees, expenses as
 * positive amounts (U1-U3), with the checks that confirmed the printed figure. Rows that break the
 * one-row-one-item and one-item-one-figure rules (R2, R5) are dropped here.
 */
export function valuesFromMatches(kind: Statement, table: StatementTable, matches: Match[], confirmed: Confirmed, drops: Drop[], tableIndex = 0): ReportedValue[] {
  const byItem = new Map<string, Match[]>();
  for (const match of matches) for (const item of match.items) byItem.set(item, [...(byItem.get(item) ?? []), match]);
  const values: ReportedValue[] = [];
  for (const [item, found] of byItem) {
    const rows = [...new Map(found.map((match) => [match.row.id, match.row])).values()];
    if (rows.length > 1 && new Set(rows.map((row) => row.values.join('|'))).size > 1) {
      drops.push({ item, reason: `R5: printed on ${rows.length} rows with different figures (${rows.map((row) => `"${row.label || '(no caption)'}"`).join(', ')})` });
      continue;
    }
    const row = rows[0]!;
    for (const column of table.columns) {
      if (!column.kept || !column.periodEnd || column.months === null) continue;
      const raw = row.values[column.index];
      if (raw === null || raw === undefined) continue;
      let value = PER_SHARE.has(item) ? raw : raw * table.unitScale;
      if (kind === 'income' && EXPENSES.has(item)) value = Math.abs(value);
      if (value < 0 && NON_NEGATIVE.has(item)) {
        drops.push({ item, reason: `negative for ${column.periodEnd}` });
        continue;
      }
      const by = confirmed.get(row.id)?.get(column.index);
      values.push({
        statement: kind,
        key: item,
        periodEnd: column.periodEnd,
        months: column.months,
        basis: table.basis,
        value,
        page: row.page,
        text: evidence(row),
        cell: { table: tableIndex, row: row.id, column: column.index },
        ...(by ? { checks: [by] } : {}),
      });
    }
  }
  return values;
}

/** The printed row as evidence: its label and figures, as on the page. */
function evidence(row: StatementRow): string {
  return [row.label || '(total)', row.note ?? '', ...row.cells].filter((part) => part !== '').join(' | ').slice(0, 300);
}

interface Identity {
  id: string;
  statement: Statement;
  /** Items and their signs; the identity holds when the signed sum is zero. */
  terms: Array<[string, 1 | -1]>;
  text: string;
}

/**
 * Identities on delivered values (expenses already positive). Each holds when the signed sum of
 * its terms is zero, to within rounding of the printed unit.
 */
const IDENTITIES: Identity[] = [
  { id: 'I1', statement: 'income', terms: [['revenue', 1], ['cost_of_sales', -1], ['gross_profit', -1]], text: 'revenue - cost of sales = gross profit' },
  { id: 'I2', statement: 'income', terms: [['profit_before_tax', 1], ['taxation', -1], ['profit_after_tax', -1]], text: 'profit before tax - taxation = profit after tax' },
  { id: 'B4', statement: 'balance', terms: [['total_current_assets', 1], ['total_non_current_assets', 1], ['total_assets', -1]], text: 'current + non-current assets = total assets' },
  { id: 'F4', statement: 'cash_flow', terms: [['cash_from_operations', 1], ['cash_from_investing', 1], ['cash_from_financing', 1], ['net_change_in_cash', -1]], text: 'operating + investing + financing = net change in cash' },
  { id: 'F5', statement: 'cash_flow', terms: [['cash_at_beginning', 1], ['net_change_in_cash', 1], ['fx_adjustments', 1], ['cash_at_end', -1]], text: 'opening cash + net change (+ exchange differences) = closing cash' },
];
/** Terms that may be absent (not printed) without making the identity unusable. */
const OPTIONAL = new Set(['fx_adjustments']);

/**
 * Applies identities, the balance-sheet equality and the cross-statement tie, then rule V5. Returns
 * the values that survive; every removal is recorded in `drops`.
 */
export function applyChecks(values: ReportedValue[], tables: StatementTable[], drops: Drop[]): ReportedValue[] {
  const removed = new Set<ReportedValue>();
  const confirm = (value: ReportedValue, id: string) => {
    value.checks = [...new Set([...(value.checks ?? []), id])];
  };
  const groups = new Map<string, Map<string, ReportedValue>>();
  for (const value of values) {
    const key = `${value.statement}|${value.periodEnd}|${value.months}|${value.basis}`;
    const group = groups.get(key) ?? new Map<string, ReportedValue>();
    group.set(value.key, value);
    groups.set(key, group);
  }
  const tolerance = (value: ReportedValue, terms: number) => Math.max(terms * scaleOf(value, tables) * 1.0, Math.abs(value.value) * 1e-6);

  for (const [key, group] of groups) {
    const [statement] = key.split('|') as [Statement];
    for (const identity of IDENTITIES.filter((item) => item.statement === statement)) {
      const present = identity.terms.filter(([item]) => group.has(item));
      const required = identity.terms.filter(([item]) => !OPTIONAL.has(item));
      if (required.some(([item]) => !group.has(item))) continue;
      let sum = 0;
      for (const [item, sign] of present) sum += sign * group.get(item)!.value;
      const direct = Math.abs(sum) <= tolerance(group.get(present[0]![0])!, present.length);
      // Taxation may be a credit (a tax income). U3 delivered it as a positive expense, so the
      // identity holds only with its sign reversed -- and that reversal is then the figure: a
      // credit is delivered negative, or the site would show a tax income as a tax charge.
      const credit = !direct && identity.id === 'I2' && Math.abs(sum + 2 * group.get('taxation')!.value) <= tolerance(group.get('taxation')!, 3);
      if (credit) {
        const tax = group.get('taxation')!;
        tax.value = -tax.value;
      }
      const holds = direct || credit;
      const inputs = present.map(([item]) => group.get(item)!);
      if (holds) inputs.forEach((value) => confirm(value, identity.id));
      else {
        inputs.forEach((value) => removed.add(value));
        drops.push({ item: present.map(([item]) => item).join('/'), reason: `${identity.id}: ${identity.text} does not hold (${key.split('|').slice(1).join(' ')})` });
      }
    }
  }

  // B5: total assets equal the printed "total equity and liabilities".
  for (const table of tables.filter((item) => item.statementType === 'balance_sheet')) {
    const claimsTotal = table.rows.find((row) => /^total (?:equity|capital) and liabilities$|^total liabilities and (?:equity|capital)$/u.test(normalizeLabel(row.label)));
    if (!claimsTotal) continue;
    for (const column of table.columns) {
      const printed = claimsTotal.values[column.index];
      const assets = values.find((value) => value.key === 'total_assets' && value.basis === table.basis && value.periodEnd === column.periodEnd && value.statement === 'balance');
      if (printed === null || printed === undefined || !assets) continue;
      if (Math.abs(printed * table.unitScale - assets.value) <= 2 * table.unitScale) confirm(assets, 'B5');
      else {
        removed.add(assets);
        drops.push({ item: 'total_assets', reason: `B5: total assets != total equity and liabilities (${column.periodEnd})` });
      }
    }
  }

  // X1: the cash flow's profit before tax is the income statement's.
  for (const value of values.filter((item) => item.key === 'cf_profit_before_tax')) {
    const income = values.find((item) => item.key === 'profit_before_tax' && item.periodEnd === value.periodEnd && item.months === value.months && item.basis === value.basis);
    if (!income) continue;
    if (Math.abs(income.value - value.value) <= 2 * scaleOf(value, tables)) {
      confirm(value, 'X1');
      confirm(income, 'X1');
    } else drops.push({ item: 'cf_profit_before_tax', reason: `X1: differs from the income statement's profit before tax (${value.periodEnd}), kept -- levies can sit between them` });
  }

  // V5: an OCR-read figure needs a confirmation.
  const ocrPages = new Set(tables.flatMap((table) => table.rows.filter((row) => row.ocr).map((row) => row.page)));
  for (const value of values) {
    if (removed.has(value) || value.page === null || !ocrPages.has(value.page)) continue;
    if (!value.checks?.length) {
      removed.add(value);
      drops.push({ item: value.key, reason: `V5: read by OCR and not confirmed by any check (${value.periodEnd})` });
    }
  }
  return values.filter((value) => !removed.has(value));
}

function scaleOf(value: ReportedValue, tables: StatementTable[]): number {
  if (PER_SHARE.has(value.key)) return 0.01;
  return tables.find((table) => table.basis === value.basis && table.rows.some((row) => row.page === value.page))?.unitScale ?? 1;
}
