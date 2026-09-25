import type { Statement } from '../financials/definitions.js';
import type { ReportedValue } from '../financials/derive.js';
import { EXPENSES, NON_NEGATIVE, PER_SHARE } from '../financials/conventions.js';
import { buildConstraints } from './constraints.js';
import { cellKey, holds } from './constraint-types.js';
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

/**
 * Applies every relation the filing must satisfy (constraints.ts: table sums, accounting
 * identities, ties between statements), then rules E1 and V6. Returns the values that survive;
 * every removal is recorded in `drops`.
 *
 * - A relation that holds confirms each figure in it: the figure's `checks` name it. An advisory
 *   relation (one that is not always an equality, such as X1 with levies between the two figures)
 *   still confirms when it holds exactly; when it fails it drops nothing.
 * - A failed identity or tie drops every figure in it: one of them is wrong and the arithmetic
 *   alone cannot say which (null beats wrong). The repair stage (repair.ts) has already corrected
 *   whatever the arithmetic could prove, so what fails here is what stayed unproven. A failed
 *   table sum (A1) drops nothing directly: a total confirmed elsewhere stands, and the figures
 *   nothing confirms fall to V6.
 * - Taxation and levies may be credits. U3 delivered them as positive expenses; where the
 *   identity holds only with the credit sign, that sign is the figure (U3 note in RULEBOOK.md).
 * - V6: a figure is delivered only when at least one relation confirms it, whether it was read
 *   from a text layer or by OCR. A figure no arithmetic touches is not verified.
 */
export function applyChecks(values: ReportedValue[], tables: StatementTable[], drops: Drop[]): ReportedValue[] {
  const removed = new Set<ReportedValue>();
  const confirm = (value: ReportedValue, id: string) => {
    value.checks = [...new Set([...(value.checks ?? []), id.slice(0, 80)])];
  };
  const byCell = new Map<string, ReportedValue>();
  for (const value of values) if (value.cell) byCell.set(cellKey(value.cell), value);

  for (const constraint of buildConstraints(tables, values)) {
    const outcome = holds(tables, constraint);
    if (outcome === null) continue;
    const inputs = constraint.terms.map((term) => byCell.get(cellKey(term.cell))).filter((value): value is ReportedValue => value !== undefined);
    if (outcome) {
      const id = constraint.rule === 'A1' ? constraint.id : constraint.rule;
      inputs.forEach((value) => confirm(value, id));
      for (const term of constraint.terms) {
        const value = byCell.get(cellKey(term.cell));
        // A charge enters these identities as -|x|; a term that holds as +|x| is a credit.
        if (value && term.magnitude && term.sign === 1 && CREDITABLE.has(value.key) && /^I[24]$/u.test(constraint.rule)) value.value = -Math.abs(value.value);
      }
    } else if (!constraint.advisory && constraint.rule !== 'A1') {
      inputs.forEach((value) => removed.add(value));
      drops.push({ item: [...new Set(inputs.map((value) => value.key))].join('/') || constraint.rule, reason: `${constraint.id}: ${constraint.text} does not hold` });
    }
  }

  confirmEps(values, removed);

  // V6: nothing unconfirmed is delivered.
  for (const value of values) {
    if (removed.has(value) || value.checks?.length) continue;
    removed.add(value);
    drops.push({ item: value.key, reason: `V6: no check confirms it (${value.periodEnd}${value.months ? `/${value.months}` : ''})` });
  }
  return values.filter((value) => !removed.has(value));
}

/** Items U3 delivers as positive expenses that can be credits. */
const CREDITABLE = new Set(['taxation', 'levies']);

/**
 * E1: earnings per share are profit attributable to owners over the weighted number of shares, so
 * every column of the same statement implies the same share count (comparatives are restated for
 * bonus and right issues). Each EPS printed to two decimals gives an interval of share counts;
 * when two or more columns' intervals overlap, the EPS figures and the profits agree with each
 * other, and the EPS figures are confirmed. EPS below 0.10 in size is too coarse to prove
 * anything (its rounding alone is 5%) and is not used.
 */
function confirmEps(values: ReportedValue[], removed: Set<ReportedValue>): void {
  const live = values.filter((value) => !removed.has(value) && value.statement === 'income');
  for (const key of ['eps_basic', 'eps_diluted']) {
    const groups = new Map<string, Array<[number, number, ReportedValue]>>();
    for (const eps of live.filter((value) => value.key === key && Math.abs(value.value) >= 0.1)) {
      const same = (item: string) => live.find((value) => value.key === item && value.periodEnd === eps.periodEnd && value.months === eps.months && value.basis === eps.basis && value.checks?.length);
      const profit = same('net_income_to_owners') ?? same('profit_after_tax');
      if (!profit || profit.value === 0 || Math.sign(profit.value) !== Math.sign(eps.value)) continue;
      const low = Math.abs(profit.value) / (Math.abs(eps.value) + 0.005);
      const high = Math.abs(profit.value) / (Math.abs(eps.value) - 0.005);
      const group = `${eps.basis}|${eps.cell?.table ?? ''}`;
      groups.set(group, [...(groups.get(group) ?? []), [low, high, eps]]);
    }
    for (const intervals of groups.values()) {
      if (intervals.length < 2) continue;
      const low = Math.max(...intervals.map(([l]) => l));
      const high = Math.min(...intervals.map(([, h]) => h));
      if (low > high) continue;
      for (const [, , eps] of intervals) eps.checks = [...new Set([...(eps.checks ?? []), 'E1 same share count in every column'])];
    }
  }
}
