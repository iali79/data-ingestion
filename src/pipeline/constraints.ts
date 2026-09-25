import type { Statement } from '../financials/definitions.js';
import type { Figures, PeriodFigures, ReportedValue } from '../financials/derive.js';
import { EXPENSES, PER_SHARE } from '../financials/conventions.js';
import { holds, residual, type CellRef, type Constraint, type Term } from './constraint-types.js';
import { LABEL_RULES, matchRows, normalizeLabel, placeRows, type Match, type Under } from './labels.js';
import type { StatementRow, StatementTable } from './normalize.js';
import { MAX_RUN, TOTAL_LABEL } from './validate.js';

/**
 * Stage 6b: every relation a filing's printed figures must satisfy, as cell-level constraints
 * (constraint-types.ts). A constraint is emitted whether it holds or fails: a failing one means a
 * misread cell, which the repair stage corrects only when the arithmetic proves the correction.
 * So a constraint must be certain before it is emitted; a relation that is usually but not always
 * an equality is marked advisory, and a structure that cannot be pinned down is not emitted at all.
 *
 * Three kinds:
 *
 * 1. A1, table sums. Where a total row equals the run of live rows above it in some column (as
 *    confirmTotals models it), the same run is emitted as a constraint in every kept value column
 *    of the table, so a total with one misread component fails in that column while the
 *    comparative holds. A total under a balance-sheet heading whose rows no column adds up is
 *    emitted from the heading alone, as advisory.
 * 2. Identities per period (I1-I5, B1-B5, F4-F5) over the cells the delivered items were read
 *    from. An identity is a proof only when the table prints nothing else among its rows (assets
 *    held for sale below current assets, a discontinued operation below profit before tax, cash
 *    acquired on an amalgamation among the cash lines); otherwise it is advisory.
 * 3. Ties between statements (X1, X3, X4, X5): the same figure printed twice must agree.
 *
 * Tolerance is the rounding of the printed unit: half a unit per term plus half a unit, in rupees.
 */

const KIND: Record<StatementTable['statementType'], Statement> = { income_statement: 'income', balance_sheet: 'balance', cash_flow: 'cash_flow' };

/** Rows that are not rupee amounts (earnings per share, share counts): never part of a sum. */
const NOT_AMOUNT = /\bper share\b|\beps\b|number of (?:ordinary )?shares|weighted average|\(rupees\)$/u;
/** The "- Basic" / "- Diluted" lines under an "Earnings per share" heading. */
const EPS_LINE = /^(?:- )?(?:basic|diluted)\b/u;
/** Authorised capital is printed under the equity heading but is not part of equity (R3). */
const AUTHORISED = /\bauthori[sz]ed\b/u;
const PROFIT = String.raw`\(?(?:profit|loss|income|earnings)\)?(?:\s*/\s*\(?(?:profit|loss|income|earnings)\)?)?`;
/** The PSX post-2023 subtotal above levies: "Profit before levies and income tax", "Profit before minimum tax differential, final tax and income tax". */
const PRE_LEVY = new RegExp(String.raw`^(?:net )?${PROFIT}(?: for the (?:year|period))?(?: -)? before\b.*\b(?:lev(?:y|ies)|minimum|final)\b`, 'u');
const PBT_LABEL = new RegExp(String.raw`^(?:net )?${PROFIT}(?: for the (?:year|period))?(?: -)? before (?:income )?tax(?:ation)?$`, 'u');
const PAT_LABEL = new RegExp(String.raw`^(?:net )?${PROFIT} (?:after (?:income )?tax(?:ation)?|for the (?:year|period))$`, 'u');
const CLAIMS_TOTAL = /^total (?:equity|capital) and liabilities$|^total liabilities and (?:equity|capital)$/u;
const LEVY_RULE = LABEL_RULES.income.find((rule) => rule.item === 'levies')!;

export function buildConstraints(tables: StatementTable[], values: ReportedValue[]): Constraint[] {
  const context = new Context(tables, values);
  const constraints = [
    ...tables.flatMap((table, index) => tableSums(context, table, index)),
    ...identities(context),
    ...ties(context),
  ];
  // A cell is addressed by its row id, so a row whose id is not unique in its table cannot be
  // named; no relation over it is emitted. Ids are unique; a relation reached twice is kept once.
  const shared = tables.map((table) => {
    const counts = new Map<string, number>();
    for (const row of table.rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
  });
  const seen = new Set<string>();
  return constraints.filter((constraint) => {
    if (constraint.terms.some((term) => shared[term.cell.table]?.has(term.cell.row))) return false;
    if (seen.has(constraint.id)) return false;
    seen.add(constraint.id);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Shared context: cells, terms, tolerances
// ---------------------------------------------------------------------------------------------

class Context {
  private readonly matched = new Map<number, Match[]>();
  /** Delivered values grouped by statement|periodEnd|months|basis; the first reading of an item wins, as `dedupe` in filing.ts. */
  readonly groups = new Map<string, Map<string, ReportedValue>>();
  /** The A1 runs taken as the table's structure (not advisory ones): "table:total row id" -> part row ids. */
  readonly sums = new Map<string, string[]>();

  constructor(readonly tables: StatementTable[], readonly values: ReportedValue[]) {
    for (const value of values) {
      if (!value.cell || !tables[value.cell.table]) continue;
      const key = groupKey(value.statement, value.periodEnd, value.months, value.basis);
      const group = this.groups.get(key) ?? new Map<string, ReportedValue>();
      if (!group.has(value.key)) group.set(value.key, value);
      this.groups.set(key, group);
    }
  }

  matches(index: number): Match[] {
    let found = this.matched.get(index);
    if (!found) {
      const table = this.tables[index]!;
      found = matchRows(KIND[table.statementType], table.rows).matches;
      this.matched.set(index, found);
    }
    return found;
  }

  row(cell: CellRef): StatementRow | undefined {
    return this.tables[cell.table]?.rows.find((row) => row.id === cell.row);
  }

  rowIndex(cell: CellRef): number {
    return this.tables[cell.table]?.rows.findIndex((row) => row.id === cell.row) ?? -1;
  }

  scale(cell: CellRef, perShare: boolean): number {
    return perShare ? 1 : this.tables[cell.table]!.unitScale;
  }

  /** A term for a delivered value; income-statement expenses as magnitudes (U3). */
  term(value: ReportedValue, sign: 1 | -1): Term {
    const magnitude = value.statement === 'income' && EXPENSES.has(value.key);
    return { cell: value.cell!, sign, scale: this.scale(value.cell!, PER_SHARE.has(value.key)), ...(magnitude ? { magnitude } : {}) };
  }

  holds(constraint: Constraint): boolean | null {
    return holds(this.tables, constraint);
  }
}

function groupKey(statement: string, periodEnd: string, months: number, basis: string): string {
  return `${statement}|${periodEnd}|${months}|${basis}`;
}

/** Rounding of the printed unit: half a unit per term, plus half a unit (A1's allowance), in rupees. Per-share figures print to the paisa. */
function tolerance(terms: Term[], perShare = false): number {
  if (perShare) return 0.005 * terms.length + 0.005;
  return terms.reduce((sum, term) => sum + 0.5 * term.scale, 0) + 0.5 * Math.max(...terms.map((term) => term.scale));
}

function constraint(rule: string, id: string, text: string, terms: Term[], extra: { advisory?: boolean; perShare?: boolean } = {}): Constraint {
  return { rule, id, terms, tolerance: tolerance(terms, extra.perShare), text, ...(extra.advisory ? { advisory: true } : {}) };
}

function isAmountRow(row: StatementRow): boolean {
  const texts = [row.label, ...row.headings].map(normalizeLabel);
  return !texts.some((text) => NOT_AMOUNT.test(text)) && !EPS_LINE.test(normalizeLabel(row.label));
}

const hasValue = (row: StatementRow, column: number) => row.values[column] !== null && row.values[column] !== undefined;
const isPrinted = (row: StatementRow, column: number) => (row.cells[column] ?? '').trim() !== '';
const isTotalRow = (row: StatementRow) => {
  const label = normalizeLabel(row.label);
  return !label || TOTAL_LABEL.test(label);
};

// ---------------------------------------------------------------------------------------------
// A1: table sums
// ---------------------------------------------------------------------------------------------

/** A total row and the rows (indexes into table.rows) that add up to it, in printed order. */
interface Structure {
  total: number;
  parts: number[];
  /** Columns whose own running totals found this run; empty for a structure read from a heading. */
  origins: number[];
}

/**
 * The runs confirmTotals finds in one column: a live stack of rows, a total row consuming the
 * shortest run of live rows (at least two) that adds up to it, the total then live in their place.
 * So a subtotal and the rows it closes are never both in a larger run.
 */
function runsInColumn(table: StatementTable, column: number): Array<{ total: number; parts: number[] }> {
  const runs: Array<{ total: number; parts: number[] }> = [];
  const live: number[] = [];
  for (const [index, row] of table.rows.entries()) {
    const value = row.values[column];
    if (value === null || value === undefined) continue;
    if (isTotalRow(row)) {
      let sum = 0;
      for (let k = 1; k <= Math.min(MAX_RUN, live.length); k++) {
        sum += table.rows[live[live.length - k]!]!.values[column]!;
        if (k >= 2 && Math.abs(sum - value) <= 0.5 * k + 0.5) {
          runs.push({ total: index, parts: live.splice(live.length - k, k) });
          break;
        }
      }
    }
    live.push(index);
  }
  return runs;
}

/**
 * Whether a structure can be read in `column`: the total and every part are printed there, and
 * every other row inside the run prints nothing there, unless it has a figure in a column that
 * found the run (where a subtotal inside the run consumed it). A row printed only in this column,
 * or printed but unreadable ("(2,700,000) (157,546,568)", two lines fused), would belong to the
 * sum here, so the run is not the same.
 */
function applies(table: StatementTable, structure: Structure, column: number): boolean {
  const total = table.rows[structure.total]!;
  if (!isPrinted(total, column)) return false;
  const parts = new Set(structure.parts);
  for (let index = structure.parts[0]!; index < structure.total; index++) {
    const row = table.rows[index]!;
    if (parts.has(index)) {
      if (!isPrinted(row, column)) return false;
    } else if (isPrinted(row, column) && !structure.origins.some((origin) => hasValue(row, origin))) return false;
  }
  return true;
}

/** Columns a structure is read from and applied to: the dated, kept columns (C1-C6). A column left out is often the other half of a side-by-side page, whose rows are not these rows. */
const valueColumns = (table: StatementTable) => table.columns.filter((column) => column.kept).map((column) => column.index);

/**
 * Balances in `column` with at least two non-zero parts (a total equal to one row plus nils says
 * nothing about which rows it closes), and with figures large beside the rounding allowance: in a
 * summary table of one-decimal figures ("31.9", "17.5") a two-unit allowance lets unrelated rows
 * add up.
 */
function balancesInformatively(table: StatementTable, structure: Structure, column: number): boolean {
  if (!applies(table, structure, column)) return false;
  const total = table.rows[structure.total]!.values[column];
  const parts = structure.parts.map((index) => table.rows[index]!.values[column]);
  if (total === null || total === undefined || parts.some((value) => value === null || value === undefined)) return false;
  const sum = (parts as number[]).reduce((a, b) => a + b, 0);
  const allowance = 0.5 * parts.length + 0.5;
  const largest = Math.max(Math.abs(total), ...(parts as number[]).map(Math.abs));
  return Math.abs(sum - total) <= allowance && largest >= 100 * allowance && (parts as number[]).filter((value) => Math.abs(value) >= 1).length >= 2;
}

/**
 * The run of rows a total closes, when the table's columns agree on it. Every column proposes the
 * run it finds; a proposal counts where it balances with two non-zero parts. The proposal that
 * balances in the most columns is taken when every other proposal balances only in columns it
 * also balances in (a nil row at the edge of a run can let a shorter run balance in one column);
 * two proposals that each explain a column the other does not are ambiguous, and neither is used,
 * unless one is exactly the rows under the heading the total closes.
 */
function resolve(table: StatementTable, proposals: Structure[], heading: Structure | undefined): Structure | undefined {
  const columns = valueColumns(table);
  const scored = proposals
    .map((structure) => ({ structure, balanced: new Set(columns.filter((column) => balancesInformatively(table, structure, column))) }))
    .filter((item) => item.balanced.size > 0);
  if (scored.length === 0) return undefined;
  const byHeading = heading && scored.find((item) => item.structure.parts.join() === heading.parts.join());
  if (byHeading) return byHeading.structure;
  scored.sort((a, b) => b.balanced.size - a.balanced.size || a.structure.parts.length - b.structure.parts.length);
  const best = scored[0]!;
  if (scored.slice(1).some((item) => [...item.balanced].some((column) => !best.balanced.has(column)))) return undefined;
  return best.structure;
}

/**
 * A balance-sheet total closing a heading ("CURRENT ASSETS" ... "Total current assets"): the rows
 * under the heading directly above it. Only when none of them is itself a total, so nesting cannot
 * make it ambiguous; authorised capital is left out.
 */
function headingStructures(context: Context, table: StatementTable, index: number): Map<number, Structure> {
  const found = new Map<number, Structure>();
  if (table.statementType !== 'balance_sheet') return found;
  const placed = placeRows(table.rows);
  const closing: Record<string, Under> = {
    total_current_assets: 'current_assets',
    total_non_current_assets: 'non_current_assets',
    total_current_liabilities: 'current_liabilities',
    total_non_current_liabilities: 'non_current_liabilities',
    shareholders_equity: 'equity',
  };
  for (const match of context.matches(index)) {
    const under = match.items.map((item) => closing[item]).find(Boolean);
    const total = table.rows.indexOf(match.row);
    if (!under || total < 0 || placed.get(match.row.id)?.under !== under) continue;
    const parts: number[] = [];
    let nested = false;
    for (let above = total - 1; above >= 0; above--) {
      const row = table.rows[above]!;
      if (placed.get(row.id)?.under !== under) break;
      if (row.values.every((value) => value === null)) continue;
      if ([row.label, ...row.headings].some((text) => AUTHORISED.test(normalizeLabel(text)))) continue;
      if (isTotalRow(row) || !isAmountRow(row)) nested = true;
      parts.unshift(above);
    }
    if (!nested && parts.length >= 2) found.set(total, { total, parts, origins: [] });
  }
  return found;
}

function tableSums(context: Context, table: StatementTable, index: number): Constraint[] {
  const proposals = new Map<number, Map<string, Structure>>();
  for (const column of valueColumns(table)) {
    for (const run of runsInColumn(table, column)) {
      const rows = [run.total, ...run.parts].map((row) => table.rows[row]!);
      if (!rows.every(isAmountRow)) continue;
      const byParts = proposals.get(run.total) ?? new Map<string, Structure>();
      const key = run.parts.join();
      const structure = byParts.get(key) ?? { total: run.total, parts: run.parts, origins: [] };
      structure.origins.push(column);
      byParts.set(key, structure);
      proposals.set(run.total, byParts);
    }
  }
  const headings = headingStructures(context, table, index);
  const accepted: Array<{ structure: Structure; advisory: boolean; confirmed: number[] }> = [];
  for (const total of new Set([...proposals.keys(), ...headings.keys()])) {
    const heading = headings.get(total);
    const found = [...(proposals.get(total)?.values() ?? [])];
    const structure = resolve(table, found, heading);
    const columns = valueColumns(table);
    if (structure) {
      accepted.push({ structure, advisory: false, confirmed: columns.filter((column) => balancesInformatively(table, structure, column)) });
    } else if (heading && !found.some((item) => columns.some((column) => balancesInformatively(table, item, column)))) {
      // No column adds up to this total in any way: the heading's rows are the claim of the labels
      // alone, so the relation is reported but never used to repair.
      accepted.push({ structure: heading, advisory: true, confirmed: [] });
    }
  }
  // A row is a part of at most one total. Two totals claiming the same row cannot both be right:
  // the one confirmed by fewer columns is dropped, both when they tie.
  const owner = new Map<number, number>();
  const dropped = new Set<number>();
  for (const [position, item] of accepted.entries()) {
    for (const part of item.structure.parts) {
      const other = owner.get(part);
      if (other === undefined) {
        owner.set(part, position);
        continue;
      }
      const confirmedOther = accepted[other]!.confirmed.length;
      if (confirmedOther >= item.confirmed.length) dropped.add(position);
      if (confirmedOther <= item.confirmed.length) dropped.add(other);
    }
  }
  const constraints: Constraint[] = [];
  for (const [position, { structure, advisory, confirmed }] of accepted.entries()) {
    if (dropped.has(position)) continue;
    const total = table.rows[structure.total]!;
    if (!advisory) context.sums.set(`${index}:${total.id}`, structure.parts.map((row) => table.rows[row]!.id));
    // A part that is nil in every column that confirmed the run was never tested: it may be a
    // one-line subtotal already inside another part ("Defined benefit plan" and the uncaptioned
    // total of it, both "-" in the comparative). Where it has a figure, the run is not emitted.
    const nil = (row: number, column: number) => Math.abs(table.rows[row]!.values[column] ?? 0) < 1;
    const untested = advisory ? [] : structure.parts.filter((row) => confirmed.every((column) => nil(row, column)));
    for (const column of table.columns.filter((item) => item.kept)) {
      if (!applies(table, structure, column.index)) continue;
      if (untested.some((row) => !nil(row, column.index))) continue;
      const cell = (row: number): CellRef => ({ table: index, row: table.rows[row]!.id, column: column.index });
      const terms: Term[] = [
        ...structure.parts.map((row): Term => ({ cell: cell(row), sign: 1, scale: table.unitScale })),
        { cell: cell(structure.total), sign: -1, scale: table.unitScale },
      ];
      const label = normalizeLabel(total.label) || '(uncaptioned total)';
      const how = structure.origins.length ? 'the rows above it' : 'the rows under its heading';
      constraints.push({
        rule: 'A1',
        id: `A1 t${index} ${total.id} c${column.index}`,
        terms,
        tolerance: (0.5 * structure.parts.length + 0.5) * table.unitScale,
        text: `${label} = ${how} (${structure.parts.length} rows, ${table.rows[structure.parts[0]!]!.id}..${table.rows[structure.parts.at(-1)!]!.id}), column "${column.header}"`,
        ...(advisory ? { advisory: true } : {}),
      });
    }
  }
  return constraints;
}

// ---------------------------------------------------------------------------------------------
// Identities per period
// ---------------------------------------------------------------------------------------------

/**
 * How the income statement prints its costs: +1 when in brackets (negative), -1 when as positive
 * figures, null when its cost lines disagree or there are none. Read from the printed cells of the
 * table's matched expense lines other than taxation and levies, in every column.
 */
function costSign(context: Context, table: number): 1 | -1 | null {
  let negative = 0;
  let positive = 0;
  for (const value of context.values) {
    if (value.statement !== 'income' || value.cell?.table !== table || !EXPENSES.has(value.key) || value.key === 'taxation' || value.key === 'levies') continue;
    const printed = context.row(value.cell)?.values[value.cell.column];
    if (printed === null || printed === undefined || printed === 0) continue;
    if (printed < 0) negative++;
    else positive++;
  }
  if (negative > positive) return 1;
  if (positive > negative) return -1;
  return null;
}

/** Rows strictly between two rows of one table. Null when they are not on the same table or not in that order. */
function between(context: Context, from: CellRef, to: CellRef): StatementRow[] | null {
  if (from.table !== to.table) return null;
  const start = context.rowIndex(from);
  const end = context.rowIndex(to);
  if (start < 0 || end < 0 || start >= end) return null;
  return context.tables[from.table]!.rows.slice(start + 1, end);
}

/** A figure other than nil in the column: the rows an identity must account for. */
const counts = (row: StatementRow, column: number) => Math.abs(row.values[column] ?? 0) >= 1 || (isPrinted(row, column) && !hasValue(row, column));

/** A row and every row its A1 run adds up, recursively. */
function descendants(context: Context, table: number, row: string, into = new Set<string>()): Set<string> {
  if (into.has(row)) return into;
  into.add(row);
  for (const part of context.sums.get(`${table}:${row}`) ?? []) descendants(context, table, part, into);
  return into;
}

/** Lines that print no amount of their own: authorised capital (and its "... shares of Rs. 10 each" line), contingencies, the grand total. */
const NOT_A_FIGURE = /\bauthori[sz]ed\b|\bshares of rs\b|^contingenc/u;

/**
 * Whether every figure among `rows` is accounted for by the identity's cells: it is one of them,
 * a row one of them adds up (A1, recursively), a total that adds up one of them, or nil. A figure
 * outside them (assets held for sale printed below current assets, liabilities of a window takaful
 * operation below total liabilities, a surplus on revaluation printed outside equity) means the
 * identity is not an identity for this filing.
 */
function accountsFor(context: Context, table: number, cells: CellRef[], rows: StatementRow[], column: number): boolean {
  const covered = new Set<string>();
  for (const cell of cells) if (cell.table === table) descendants(context, table, cell.row, covered);
  return rows.every((row) =>
    covered.has(row.id) || !counts(row, column) ||
    [row.label, ...row.headings].some((text) => NOT_A_FIGURE.test(normalizeLabel(text))) || CLAIMS_TOTAL.test(normalizeLabel(row.label)) ||
    [...descendants(context, table, row.id)].some((id) => id !== row.id && covered.has(id)));
}

const ASSET_HEADING = (text: string) => /\bassets\b/u.test(text) && !/liabilit|equity|capital/u.test(text);
const CLAIM_HEADING = (text: string) => /liabilit|equity|capital and reserves|share capital/u.test(text);

/**
 * The rows of a balance-sheet side, by position: the assets side ends at the total assets row and
 * starts after the claims side (or at the top); the claims side runs from its first heading to the
 * printed "total equity and liabilities" (or to the assets side, or the end).
 */
function side(table: StatementTable, which: 'assets' | 'claims', totalAssets: number): StatementRow[] {
  const headings = (row: StatementRow) => row.headings.map(normalizeLabel);
  if (which === 'assets') {
    const rows: StatementRow[] = [];
    for (let index = totalAssets - 1; index >= 0; index--) {
      const row = table.rows[index]!;
      if (CLAIMS_TOTAL.test(normalizeLabel(row.label))) break;
      rows.unshift(row);
      if (headings(row).some(CLAIM_HEADING)) return rows.slice(1);
    }
    return rows;
  }
  const start = table.rows.findIndex((row) => headings(row).some(CLAIM_HEADING));
  if (start < 0) return [];
  const rows: StatementRow[] = [];
  for (let index = start; index < table.rows.length; index++) {
    const row = table.rows[index]!;
    if (index > start && headings(row).some(ASSET_HEADING)) break;
    rows.push(row);
    if (CLAIMS_TOTAL.test(normalizeLabel(row.label))) break;
  }
  return rows;
}

function isLevyRow(row: StatementRow): boolean {
  const label = normalizeLabel(row.label);
  return LEVY_RULE.label.test(label) && !LEVY_RULE.not?.test(label);
}

/**
 * I4, levies above profit before tax (the PSX layout since 2023): the "Profit before levies and
 * income tax" row, the levy rows directly below it, then profit before tax. Returns the pre-levy
 * row and the levy rows, or null when anything else is printed between them.
 */
function preLevy(context: Context, pbt: CellRef): { row: StatementRow; levies: StatementRow[] } | null {
  const rows = context.tables[pbt.table]!.rows;
  const levies: StatementRow[] = [];
  for (let index = context.rowIndex(pbt) - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (!isPrinted(row, pbt.column)) continue;
    const label = normalizeLabel(row.label);
    if (PRE_LEVY.test(label)) return levies.length ? { row, levies } : null;
    if (!isLevyRow(row)) return null;
    levies.unshift(row);
  }
  return null;
}

const cellOf = (row: StatementRow, like: CellRef): CellRef => ({ table: like.table, row: row.id, column: like.column });

/**
 * A relation over a charge that can also be a credit (taxation, levies). U3 delivers both as
 * magnitudes, so the charge form alone (x - |tax| = y) cannot represent a credit. The form emitted:
 *   - the first combination of charge (-|x|) and credit (+|x|) for the flexible cells that holds,
 *     all charges tried first (with non-nil figures at most one combination can hold);
 *   - when none holds (a cell is misread), the printed-sign form, each flexible cell taken with the
 *     sign s the statement prints its costs with (+1 bracketed, -1 as positive figures): that form
 *     holds for a charge and a credit alike, so the repair stage can find the misread cell,
 *     including a bracket lost on the tax line;
 *   - when the statement's cost convention cannot be read either, the all-charge form, advisory.
 */
function flexibleForm(context: Context, rule: string, id: string, text: string, base: Term[], flexible: Term[], advisory: boolean): Constraint {
  const combinations = 1 << flexible.length;
  let first: Constraint | undefined;
  for (let mask = 0; mask < combinations; mask++) {
    const signs = flexible.map((_, index) => ((mask >> index) & 1 ? 1 : -1) as 1 | -1);
    const credit = signs.some((sign) => sign === 1);
    const terms = [...base, ...flexible.map((term, index): Term => ({ ...term, sign: signs[index]!, magnitude: true }))];
    const found = constraint(rule, id, `${text}${credit ? ` (${flexible.length > 1 ? 'with a credit' : 'a credit'})` : ''}`, terms, { advisory });
    first ??= found;
    if (context.holds(found)) return found;
  }
  const sign = costSign(context, flexible[0]!.cell.table);
  if (sign === null) return { ...first!, advisory: true };
  const terms = [...base, ...flexible.map((term): Term => ({ cell: term.cell, sign, scale: term.scale }))];
  return constraint(rule, id, `${text} (as printed, costs ${sign === 1 ? 'in brackets' : 'as positive figures'})`, terms, { advisory });
}

function identities(context: Context): Constraint[] {
  const constraints: Constraint[] = [];
  for (const [key, group] of context.groups) {
    const [statement, periodEnd, months, basis] = key.split('|') as [Statement, string, string, string];
    const period = statement === 'balance' ? `${periodEnd} ${basis}` : `${periodEnd}/${months} ${basis}`;
    const all = (...items: string[]) => items.every((item) => group.has(item));
    const get = (item: string) => group.get(item)!;
    const t = (item: string, sign: 1 | -1) => context.term(get(item), sign);
    /** The rows strictly between the first and the last of these items' rows, when all sit in one table. */
    const span = (items: string[]): { rows: StatementRow[]; column: number; table: number } | null => {
      const cells = items.map((item) => get(item).cell!);
      if (cells.some((cell) => cell.table !== cells[0]!.table)) return null;
      const ordered = [...cells].sort((a, b) => context.rowIndex(a) - context.rowIndex(b));
      const rows = between(context, ordered[0]!, ordered.at(-1)!) ?? [];
      return { rows: rows.filter((row) => !cells.some((cell) => cell.row === row.id)), column: cells[0]!.column, table: cells[0]!.table };
    };
    /**
     * Advisory unless every figure printed between the identity's rows is accounted for by its
     * parts (not by the whole, whose own A1 run may add up the very line the identity leaves out).
     */
    const loose = (items: string[], whole: string) => {
      const found = span(items);
      return !found || !accountsFor(context, found.table, items.filter((item) => item !== whole).map((item) => get(item).cell!), found.rows, found.column);
    };

    if (statement === 'income') {
      // I1: revenue - cost of sales = gross profit (cost of sales as a magnitude, U3).
      if (all('revenue', 'cost_of_sales', 'gross_profit')) {
        const items = ['revenue', 'cost_of_sales', 'gross_profit'];
        constraints.push(constraint('I1', `I1 ${period}`, 'revenue - cost of sales = gross profit', [t('revenue', 1), t('cost_of_sales', -1), t('gross_profit', -1)], { advisory: loose(items, 'gross_profit') }));
      }
      if (all('profit_before_tax', 'taxation', 'profit_after_tax')) constraints.push(taxIdentity(context, group, period));
      // I4, levies above profit before tax: profit before levies - levies = profit before tax.
      if (group.has('profit_before_tax')) {
        const pbt = get('profit_before_tax').cell!;
        const found = preLevy(context, pbt);
        if (found) {
          const scale = context.scale(pbt, false);
          const levies = found.levies.map((row): Term => ({ cell: cellOf(row, pbt), sign: -1, scale }));
          constraints.push(flexibleForm(context, 'I4', `I4 levies above ${period}`, 'profit before levies and income tax - levies = profit before income tax', [{ cell: cellOf(found.row, pbt), sign: 1, scale }, t('profit_before_tax', -1)], levies, false));
        }
      }
      // I3: profit after tax = the owners' share + the non-controlling interests' share.
      if (all('profit_after_tax', 'net_income_to_owners', 'net_income_to_minority') && attributesProfit(context, group)) {
        constraints.push(constraint('I3', `I3 ${period}`, 'profit after tax = attributable to owners + attributable to non-controlling interests', [t('net_income_to_owners', 1), t('net_income_to_minority', 1), t('profit_after_tax', -1)]));
      }
      const i5 = operatingIdentity(context, group);
      if (i5) constraints.push(constraint('I5', `I5 ${period}`, 'gross profit - operating costs + other income = operating profit', i5));
    }

    if (statement === 'balance') {
      const assets = group.get('total_assets');
      const assetsTable = assets ? context.tables[assets.cell!.table]! : undefined;
      const assetsRow = assets ? context.rowIndex(assets.cell!) : -1;
      /** Advisory unless every figure on that side of the balance sheet is accounted for by the cells. */
      const sideLoose = (which: 'assets' | 'claims', cells: CellRef[]) =>
        !assets || cells.some((cell) => cell.table !== assets.cell!.table) || !accountsFor(context, assets.cell!.table, cells, side(assetsTable!, which, assetsRow), assets.cell!.column);
      // B4: current + non-current assets = total assets.
      if (all('total_current_assets', 'total_non_current_assets', 'total_assets')) {
        const terms = [t('total_current_assets', 1), t('total_non_current_assets', 1), t('total_assets', -1)];
        constraints.push(constraint('B4', `B4 ${period}`, 'current + non-current assets = total assets', terms, { advisory: sideLoose('assets', terms.slice(0, 2).map((term) => term.cell)) }));
      }
      // B2: total liabilities = current + non-current liabilities.
      if (all('total_liabilities', 'total_current_liabilities', 'total_non_current_liabilities')) {
        const cells = ['total_current_liabilities', 'total_non_current_liabilities'].map((item) => get(item).cell!);
        const liabilities = get('total_liabilities').cell!;
        const parts = context.sums.get(`${liabilities.table}:${liabilities.row}`);
        const rows = parts ? context.tables[liabilities.table]!.rows.filter((row) => parts.includes(row.id)) : [];
        constraints.push(constraint('B2', `B2 ${period}`, 'current + non-current liabilities = total liabilities', [t('total_current_liabilities', 1), t('total_non_current_liabilities', 1), t('total_liabilities', -1)], { advisory: !!parts && !accountsFor(context, liabilities.table, cells, rows, liabilities.column) }));
      }
      // B3: total equity = equity attributable to owners + non-controlling interests.
      if (all('total_equity', 'shareholders_equity', 'minority_interest')) {
        constraints.push(constraint('B3', `B3 ${period}`, "owners' equity + non-controlling interests = total equity", [t('shareholders_equity', 1), t('minority_interest', 1), t('total_equity', -1)]));
      }
      // B1: total assets = total equity + total liabilities. Equity is total equity; or, without
      // it, owners' equity plus non-controlling interests (owners' equity alone when no
      // non-controlling interest is printed). Liabilities are total liabilities, or current plus
      // non-current when no total is printed. Advisory unless every figure on the claims side is
      // part of those totals.
      const equity = group.has('total_equity') ? [t('total_equity', 1)]
        : group.has('shareholders_equity') ? [t('shareholders_equity', 1), ...(group.has('minority_interest') ? [t('minority_interest', 1)] : [])]
        : null;
      const liabilities = group.has('total_liabilities') ? [t('total_liabilities', 1)]
        : all('total_current_liabilities', 'total_non_current_liabilities') ? [t('total_current_liabilities', 1), t('total_non_current_liabilities', 1)]
        : null;
      if (assets && equity && liabilities) {
        const claims = [...equity, ...liabilities];
        constraints.push(constraint('B1', `B1 ${period}`, 'total assets = total equity + total liabilities', [...claims, t('total_assets', -1)], { advisory: sideLoose('claims', claims.map((term) => term.cell)) }));
      }
      // B5: total assets = the printed "total equity and liabilities".
      if (assets) {
        for (const [index, table] of context.tables.entries()) {
          if (table.statementType !== 'balance_sheet' || table.basis !== basis) continue;
          const claims = table.rows.find((row) => CLAIMS_TOTAL.test(normalizeLabel(row.label)));
          const column = index === assets.cell!.table ? assets.cell!.column : table.columns.find((item) => item.periodEnd === periodEnd && item.months === 0)?.index;
          if (!claims || column === undefined || !isPrinted(claims, column)) continue;
          const terms: Term[] = [t('total_assets', 1), { cell: { table: index, row: claims.id, column }, sign: -1, scale: table.unitScale }];
          constraints.push(constraint('B5', `B5 t${index} ${period}`, 'total assets = total equity and liabilities', terms));
        }
      }
    }

    if (statement === 'cash_flow') {
      // F4: operating + investing + financing = net change in cash; advisory when a figure is
      // printed between the last section total and the net change.
      const f4 = ['cash_from_operations', 'cash_from_investing', 'cash_from_financing', 'net_change_in_cash'];
      if (all(...f4)) {
        const cells = f4.map((item) => get(item).cell!);
        const last = [...cells.slice(0, 3)].sort((a, b) => context.rowIndex(b) - context.rowIndex(a))[0]!;
        const rows = between(context, last, cells[3]!);
        const advisory = !rows || !accountsFor(context, last.table, cells.slice(0, 3), rows, last.column);
        constraints.push(constraint('F4', `F4 ${period}`, 'operating + investing + financing = net change in cash', [t('cash_from_operations', 1), t('cash_from_investing', 1), t('cash_from_financing', 1), t('net_change_in_cash', -1)], { advisory }));
      }
      // F5: opening cash + net change (+ exchange differences, when printed) = closing cash;
      // advisory when another figure is printed among them (cash acquired on an amalgamation, an
      // exchange line no label rule claims, an IFRS 9 adjustment to opening cash).
      if (all('cash_at_beginning', 'net_change_in_cash', 'cash_at_end')) {
        const items = ['cash_at_beginning', 'net_change_in_cash', ...(group.has('fx_adjustments') ? ['fx_adjustments'] : []), 'cash_at_end'];
        const terms = [t('cash_at_beginning', 1), t('net_change_in_cash', 1), ...(group.has('fx_adjustments') ? [t('fx_adjustments', 1)] : []), t('cash_at_end', -1)];
        constraints.push(constraint('F5', `F5 ${period}`, 'opening cash + net change (+ exchange differences) = closing cash', terms, { advisory: loose(items, 'cash_at_end') }));
      }
    }
  }
  return constraints;
}

/**
 * I2, profit before tax - taxation = profit after tax; I4 when levies are printed between the two
 * (PBT - levies - taxation = PAT, the layout that prints no "profit before income tax" line). The
 * sign of taxation and levies is read as `flexibleForm` describes, so a tax credit is representable.
 *
 * Advisory when anything else is printed between profit before and after tax: the split tax lines
 * a taxation total closes are part of it, but a discontinued operation's result, or a "profit
 * after tax from continuing operations" subtotal, is not taxation.
 */
function taxIdentity(context: Context, group: Map<string, ReportedValue>, period: string): Constraint {
  const pbt = group.get('profit_before_tax')!;
  const tax = group.get('taxation')!;
  const pat = group.get('profit_after_tax')!;
  const levies = group.get('levies');
  const rows = between(context, pbt.cell!, pat.cell!);
  const leviesBelow = !!levies && !!rows && rows.some((row) => row.id === levies.cell!.row);
  const rule = leviesBelow ? 'I4' : 'I2';
  const id = leviesBelow ? `I4 levies below ${period}` : `I2 ${period}`;
  const text = leviesBelow ? 'profit before tax - levies - taxation = profit after tax' : 'profit before tax - taxation = profit after tax';
  const accounted = !!rows && rows.every((row) => {
    if (row.id === tax.cell!.row || (leviesBelow && row.id === levies.cell!.row) || !counts(row, pbt.cell!.column)) return true;
    if (context.sums.get(`${tax.cell!.table}:${tax.cell!.row}`)?.includes(row.id)) return true;
    // Split tax lines ("Income tax - current", "- deferred") above the taxation total they make up.
    return context.rowIndex(cellOf(row, pbt.cell!)) < context.rowIndex(tax.cell!) && !isLevyRow(row) && /\btax|current|deferred|prior|previous/u.test(normalizeLabel(row.label));
  });
  const flexible = [...(leviesBelow ? [context.term(levies, -1)] : []), context.term(tax, -1)];
  return flexibleForm(context, rule, id, text, [context.term(pbt, 1), context.term(pat, -1)], flexible, !accounted);
}

/**
 * I3 applies to the "Profit attributable to:" lines below profit after tax, not to the lines under
 * "Total comprehensive income attributable to:", which a combined statement also prints.
 */
function attributesProfit(context: Context, group: Map<string, ReportedValue>): boolean {
  const pat = group.get('profit_after_tax')!.cell!;
  for (const item of ['net_income_to_owners', 'net_income_to_minority']) {
    const cell = group.get(item)!.cell!;
    const rows = between(context, pat, cell);
    if (!rows) return false;
    const target = context.row(cell)!;
    if ([...rows, target].some((row) => [row.label, ...row.headings].some((text) => /comprehensive/u.test(normalizeLabel(text))))) return false;
  }
  return true;
}

const OPERATING_COSTS = new Set(['distribution_cost', 'admin_expenses', 'selling_admin_expenses', 'rd_expenses', 'other_operating_expenses']);

/**
 * I5: gross profit - distribution - administrative - other operating expenses + other income =
 * operating profit, only when every row printed between gross profit and operating profit is one of
 * those items and was delivered from that row. An unmatched line between them (an impairment, a
 * share of an associate's profit) would make the identity fail for no misread, so then it is not
 * emitted.
 */
function operatingIdentity(context: Context, group: Map<string, ReportedValue>): Term[] | null {
  const gross = group.get('gross_profit');
  const operating = group.get('operating_profit');
  if (!gross || !operating) return null;
  const rows = between(context, gross.cell!, operating.cell!)?.filter((row) => isPrinted(row, gross.cell!.column));
  if (!rows || rows.length === 0) return null;
  const items = new Map(context.matches(gross.cell!.table).map((match) => [match.row.id, match.items]));
  const terms: Term[] = [context.term(gross, 1)];
  for (const row of rows) {
    const [item, ...more] = items.get(row.id) ?? [];
    if (!item || more.length || !(OPERATING_COSTS.has(item) || item === 'other_income')) return null;
    const value = group.get(item);
    if (value?.cell?.row !== row.id || value.cell.table !== gross.cell!.table) return null;
    terms.push(context.term(value, OPERATING_COSTS.has(item) ? -1 : 1));
  }
  terms.push(context.term(operating, -1));
  return terms;
}

// ---------------------------------------------------------------------------------------------
// Ties between statements
// ---------------------------------------------------------------------------------------------

/**
 * The profit line the cash flow starts from: the first row in (or before) its operating section
 * whose label is a profit before or after tax, not "profit before working capital changes".
 */
function cashFlowStart(table: StatementTable): StatementRow | undefined {
  const placed = placeRows(table.rows);
  for (const row of table.rows) {
    const section = placed.get(row.id)?.section;
    if (section && section !== 'operating') return undefined;
    const label = normalizeLabel(row.label);
    if (!row.values.some((value) => value !== null)) continue;
    if (/working capital/u.test(label)) return undefined;
    if (PRE_LEVY.test(label) || PBT_LABEL.test(label) || PAT_LABEL.test(label)) return row;
  }
  return undefined;
}

function ties(context: Context): Constraint[] {
  const constraints: Constraint[] = [];
  const { tables, groups } = context;

  // X1 / X3: the cash flow's starting profit is the income statement's.
  for (const [index, table] of tables.entries()) {
    if (table.statementType !== 'cash_flow') continue;
    const start = cashFlowStart(table);
    if (!start) continue;
    const label = normalizeLabel(start.label);
    for (const column of table.columns) {
      if (!column.periodEnd || !column.months || !isPrinted(start, column.index)) continue;
      const income = groups.get(groupKey('income', column.periodEnd, column.months, table.basis));
      if (!income) continue;
      const period = `${column.periodEnd}/${column.months} ${table.basis}`;
      const cf: Term = { cell: { table: index, row: start.id, column: column.index }, sign: 1, scale: table.unitScale };
      const pbt = income.get('profit_before_tax');
      const found = pbt ? preLevy(context, pbt.cell!) : null;
      if (PAT_LABEL.test(label)) {
        // X3: a cash flow that starts from profit after tax starts from the income statement's.
        const pat = income.get('profit_after_tax');
        if (pat) constraints.push(constraint('X3', `X3 t${index} ${period}`, "cash flow's starting profit after tax = income statement's profit after tax", [cf, context.term(pat, -1)]));
        continue;
      }
      // X1 (advisory): levies, and what a company counts in the cash flow's first line, can sit
      // between the two figures. Compared with the pre-levy profit too, when the income statement
      // prints one: the cash flow often starts from it.
      if (PBT_LABEL.test(label) && pbt) {
        constraints.push(constraint('X1', `X1 t${index} ${period}`, "cash flow's profit before tax = income statement's profit before tax", [cf, context.term(pbt, -1)], { advisory: true }));
      }
      if (found && pbt) {
        const scale = context.scale(pbt.cell!, false);
        constraints.push(constraint('X1', `X1 t${index} ${period} pre-levy`, "cash flow's profit before tax = income statement's profit before levies and income tax", [cf, { cell: cellOf(found.row, pbt.cell!), sign: -1, scale }], { advisory: true }));
      }
    }
  }

  // X4: closing cash on the cash flow = the balance sheet's cash, or cash less short-term
  // borrowings and overdrafts (running finance is a cash equivalent in most PSX cash flows).
  // Emitted, as a proof, in the form that holds exactly; when neither does, the plain form as advisory.
  for (const [key, group] of groups) {
    const [statement, periodEnd, months, basis] = key.split('|') as [Statement, string, string, string];
    if (statement !== 'cash_flow' || !group.has('cash_at_end')) continue;
    const balance = groups.get(groupKey('balance', periodEnd, 0, basis));
    const cash = balance?.get('cash_and_equivalents');
    if (!balance || !cash) continue;
    const period = `${periodEnd}/${months} ${basis}`;
    const end = context.term(group.get('cash_at_end')!, 1);
    const plain = constraint('X4', `X4 ${period}`, "cash flow's closing cash = balance sheet cash", [end, context.term(cash, -1)]);
    const borrowings = ['short_term_borrowings', 'bank_overdraft'].filter((item) => balance.has(item));
    const net = borrowings.length
      ? constraint('X4', `X4 ${period}`, "cash flow's closing cash = balance sheet cash - short-term borrowings", [end, context.term(cash, -1), ...borrowings.map((item) => context.term(balance.get(item)!, 1))])
      : null;
    if (context.holds(plain)) constraints.push(plain);
    else if (net && context.holds(net)) constraints.push(net);
    else constraints.push({ ...plain, advisory: true });
  }

  // X5: an item printed in two statement tables of the same kind and basis (a statement read
  // twice, a profit and loss account and a statement of comprehensive income that both print the
  // profit for the year) has the same figure in both, for the same period.
  const printed = tables.map((table, index) => {
    const rows = new Map<string, StatementRow[]>();
    for (const match of context.matches(index)) for (const item of match.items) rows.set(item, [...(rows.get(item) ?? []), match.row]);
    // One row per item, or rows printing the same figures (R5).
    return new Map([...rows].filter(([, found]) => new Set(found.map((row) => row.values.join('|'))).size === 1).map(([item, found]) => [item, found[0]!]));
  });
  for (let a = 0; a < tables.length; a++) {
    for (let b = a + 1; b < tables.length; b++) {
      const [first, second] = [tables[a]!, tables[b]!];
      if (first.statementType !== second.statementType || first.basis !== second.basis) continue;
      const kind = KIND[first.statementType];
      for (const [item, rowA] of printed[a]!) {
        const rowB = printed[b]!.get(item);
        if (!rowB) continue;
        const perShare = PER_SHARE.has(item);
        const magnitude = kind === 'income' && EXPENSES.has(item);
        for (const columnA of first.columns) {
          if (!columnA.periodEnd || columnA.months === null || !isPrinted(rowA, columnA.index)) continue;
          const columnB = second.columns.find((column) => column.periodEnd === columnA.periodEnd && column.months === columnA.months);
          if (!columnB || !isPrinted(rowB, columnB.index)) continue;
          const terms: Term[] = [
            { cell: { table: a, row: rowA.id, column: columnA.index }, sign: 1, scale: perShare ? 1 : first.unitScale, ...(magnitude ? { magnitude } : {}) },
            { cell: { table: b, row: rowB.id, column: columnB.index }, sign: -1, scale: perShare ? 1 : second.unitScale, ...(magnitude ? { magnitude } : {}) },
          ];
          constraints.push(constraint('X5', `X5 ${item} t${a}.c${columnA.index}=t${b}.c${columnB.index}`, `${item} printed in two statements agrees (${columnA.periodEnd}/${columnA.months})`, terms, { perShare }));
        }
      }
    }
  }
  return constraints;
}

// ---------------------------------------------------------------------------------------------
// Unit-scale consistency
// ---------------------------------------------------------------------------------------------

export interface ScaleMismatch {
  /** The table whose unit looks misread. */
  table: number;
  /** What its unit scale should be multiplied by: 1000, 1e6, 0.001 or 1e-6. */
  factor: number;
  /** Failing constraints that hold once the table's figures are rescaled. */
  fixes: string[];
  /** Holding constraints that would fail after rescaling (evidence against). */
  breaks: string[];
  text: string;
}

const FACTORS = [1_000, 1_000_000, 1 / 1_000, 1 / 1_000_000];

/**
 * A relation between two tables off by exactly x1,000 or x1,000,000 is a unit misread of a whole
 * table (a "Rupees in '000" missed or invented), not a misread cell: no single cell should be
 * repaired for it. For every failing constraint whose cells span more than one table, each table
 * is rescaled in turn; the (table, factor) pairs that make it hold are reported, with the holding
 * constraints the same rescale would break. Per-share cells are never rescaled (U2). Relations
 * within one table cannot show a unit misread: rescaling all their terms changes nothing.
 */
export function scaleMismatch(tables: StatementTable[], constraints: Constraint[]): ScaleMismatch[] {
  const isAmount = (term: Term) => {
    const table = tables[term.cell.table];
    const row = table?.rows.find((item) => item.id === term.cell.row);
    return !!table && !!row && term.scale === table.unitScale && isAmountRow(row);
  };
  const rescaled = (constraint: Constraint, table: number, factor: number): Constraint => ({
    ...constraint,
    terms: constraint.terms.map((term) => (term.cell.table === table && isAmount(term) ? { ...term, scale: term.scale * factor } : term)),
    tolerance: constraint.tolerance * Math.max(1, factor),
  });
  const spans = (constraint: Constraint) => new Set(constraint.terms.map((term) => term.cell.table)).size > 1;
  const found = new Map<string, ScaleMismatch>();
  for (const item of constraints.filter(spans)) {
    if (holds(tables, item) !== false) continue;
    for (const table of new Set(item.terms.filter(isAmount).map((term) => term.cell.table))) {
      for (const factor of FACTORS) {
        if (!holds(tables, rescaled(item, table, factor))) continue;
        const key = `${table}|${factor}`;
        const entry = found.get(key) ?? { table, factor, fixes: [], breaks: [], text: '' };
        entry.fixes.push(item.id);
        found.set(key, entry);
      }
    }
  }
  for (const entry of found.values()) {
    entry.breaks = constraints
      .filter((item) => spans(item) && item.terms.some((term) => term.cell.table === entry.table) && holds(tables, item) === true && !holds(tables, rescaled(item, entry.table, entry.factor)))
      .map((item) => item.id);
    const scale = tables[entry.table]!.unitScale;
    entry.text = `table ${entry.table} (${tables[entry.table]!.statementType}) read in units of ${scale}; ${entry.fixes.length} relation(s) hold at ${scale * entry.factor}` + (entry.breaks.length ? `, ${entry.breaks.length} would then fail` : '');
  }
  return [...found.values()].sort((a, b) => b.fixes.length - b.breaks.length - (a.fixes.length - a.breaks.length));
}

// ---------------------------------------------------------------------------------------------
// Ratio sanity
// ---------------------------------------------------------------------------------------------

/**
 * Plausibility checks on a period's figures (rules S1-S9). A problem is not proof of a misread (a
 * filing can be genuinely unusual), so these are reported for review, never used to drop or
 * repair a figure.
 *
 *   S1 gross profit <= revenue (gross margin at most 100%), when revenue is positive.
 *   S2 cost of sales <= 2 x revenue (gross margin not below -100%), when revenue is positive.
 *   S3 current ratio > 0: current assets and current liabilities both positive.
 *   S4 total assets > 0.
 *   S5 tax rate within [-100%, 100%] when profit before tax is positive: |taxation| <= PBT. Under
 *      the minimum tax regime taxation (before levies were split out, 2023) can exceed a small profit.
 *   S6 basic EPS x shares outstanding within 5% of the profit attributable to owners (profit after
 *      tax when no attribution is printed), or within the EPS rounding (half a paisa per share).
 *      Shares are period-end, EPS uses the weighted average: a share issue in the period can trip it.
 *   S7 a current asset (cash, receivables, inventory, short-term investments) <= total current
 *      assets; current assets and net PPE <= total assets; current liabilities <= total liabilities.
 *   S8 EPS has the sign of the profit attributable to owners (or profit after tax).
 *   S9 equity <= total assets (liabilities cannot be negative).
 */
export function ratioProblems(period: PeriodFigures): string[] {
  const problems: string[] = [];
  const v = (figures: Figures, key: string): number | null => figures[key]?.value ?? null;
  const income = (key: string) => v(period.income, key);
  const balance = (key: string) => v(period.balance, key);
  const money = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

  const revenue = income('revenue');
  const gross = income('gross_profit');
  const cost = income('cost_of_sales');
  if (revenue !== null && revenue > 0) {
    if (gross !== null && gross > revenue) problems.push(`S1: gross profit ${money(gross)} exceeds revenue ${money(revenue)} (gross margin ${((gross / revenue) * 100).toFixed(1)}%)`);
    if (cost !== null && cost > 2 * revenue) problems.push(`S2: cost of sales ${money(cost)} is more than twice revenue ${money(revenue)}`);
  }

  const currentAssets = balance('total_current_assets');
  const currentLiabilities = balance('total_current_liabilities');
  if (currentAssets !== null && currentLiabilities !== null && (currentAssets <= 0 || currentLiabilities <= 0)) {
    problems.push(`S3: current ratio not positive (current assets ${money(currentAssets)}, current liabilities ${money(currentLiabilities)})`);
  }
  const assets = balance('total_assets');
  if (assets !== null && assets <= 0) problems.push(`S4: total assets ${money(assets)} not positive`);

  const pbt = income('profit_before_tax');
  const tax = income('taxation');
  if (pbt !== null && pbt > 0 && tax !== null && Math.abs(tax) > pbt) problems.push(`S5: taxation ${money(tax)} is outside -100%..100% of profit before tax ${money(pbt)}`);

  const eps = income('eps_basic') ?? v(period.ratios, 'eps_basic');
  const owners = income('net_income_to_owners') ?? income('profit_after_tax');
  const shares = balance('common_shares_outstanding') ?? v(period.ratios, 'common_shares_outstanding');
  if (eps !== null && owners !== null && shares !== null && shares > 0) {
    const implied = eps * shares;
    if (Math.abs(implied - owners) > Math.max(0.05 * Math.abs(owners), 0.005 * shares)) {
      problems.push(`S6: EPS ${eps} x ${money(shares)} shares = ${money(implied)}, not within 5% of profit to owners ${money(owners)}`);
    }
  }

  const within = (part: string, total: number | null, totalName: string) => {
    const value = balance(part);
    if (value !== null && total !== null && value > total) problems.push(`S7: ${part} ${money(value)} exceeds ${totalName} ${money(total)}`);
  };
  for (const part of ['cash_and_equivalents', 'net_receivables', 'total_inventory', 'short_term_investments']) within(part, currentAssets, 'total current assets');
  within('total_current_assets', assets, 'total assets');
  within('net_ppe', assets, 'total assets');
  within('total_current_liabilities', balance('total_liabilities'), 'total liabilities');

  if (eps !== null && owners !== null && eps !== 0 && owners !== 0 && Math.sign(eps) !== Math.sign(owners)) {
    problems.push(`S8: EPS ${eps} and profit to owners ${money(owners)} have opposite signs`);
  }

  const equity = balance('total_equity') ?? balance('shareholders_equity');
  if (equity !== null && assets !== null && equity > assets) problems.push(`S9: equity ${money(equity)} exceeds total assets ${money(assets)}`);
  return problems;
}

/** The constraints a cell takes part in, for the repair stage. */
export function constraintsOf(constraints: Constraint[], cell: CellRef): Constraint[] {
  return constraints.filter((item) => item.terms.some((term) => term.cell.table === cell.table && term.cell.row === cell.row && term.cell.column === cell.column));
}

/** The failing constraints, with their residual in rupees; advisory ones are left out unless asked. */
export function failing(tables: StatementTable[], constraints: Constraint[], includeAdvisory = false): Array<{ constraint: Constraint; residual: number }> {
  return constraints
    .filter((item) => includeAdvisory || !item.advisory)
    .flatMap((constraint) => {
      const r = residual(tables, constraint);
      return r !== null && Math.abs(r) > constraint.tolerance ? [{ constraint, residual: r }] : [];
    });
}
