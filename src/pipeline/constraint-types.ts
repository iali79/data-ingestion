import type { StatementTable } from './normalize.js';

/**
 * Shared vocabulary of the verify-and-repair stage (6b). Every mathematical relation the filing
 * must satisfy -- a column adding up to its printed total, an accounting identity, two statements
 * agreeing -- is a linear constraint over printed cells. A constraint that fails means at least
 * one of its cells was read wrong; the repair stage looks for the single reading that makes every
 * constraint touching that cell hold, and delivers it only when the arithmetic proves it.
 */

/** A printed figure's place: the statement table (index in the filing's table list), row id and value column. */
export interface CellRef {
  table: number;
  row: string;
  column: number;
}

export function cellKey(cell: CellRef): string {
  return `${cell.table}:${cell.row}:${cell.column}`;
}

export interface Term {
  cell: CellRef;
  sign: 1 | -1;
  /** The term uses the figure's magnitude, |value|: income-statement expenses are delivered positive (U3). */
  magnitude?: boolean;
  /** Brings the printed figure to rupees: the table's unit scale, or 1 for per-share figures. */
  scale: number;
}

export interface Constraint {
  /** Rule family, as in RULEBOOK.md: A1, I1, I2, B4, F4, X1 ... */
  rule: string;
  /** This instance, unique within the filing: "A1 t0 p45.r21 c1", "I2 2024-06-30/12 unconsolidated". */
  id: string;
  /** Holds when |sum of sign x value x scale| <= tolerance (rupees). */
  terms: Term[];
  tolerance: number;
  text: string;
  /** Reported but never used to drop or repair (e.g. X1, where levies can sit between the two figures). */
  advisory?: boolean;
}

/** An independent second reading of a printed cell. */
export interface Reading {
  value: number;
  source: 'pdftotext' | 'ocr-300' | 'ocr-digits';
  /** The text the value was parsed from, as evidence. */
  text: string;
}

/** A cell whose reading was replaced, with the constraints that prove the new value. */
export interface Correction {
  cell: CellRef;
  /** The first reading; null when the cell was unreadable. */
  from: number | null;
  to: number;
  /** What kind of misread it was: "sign", "digit 8->3", "transposed", "dropped digit", "reread pdftotext" ... */
  how: string;
  /** Ids of the constraints that hold with the new value and include this cell. */
  proof: string[];
}

/** The printed value of a cell, or null (empty or unreadable). */
export function cellValue(tables: StatementTable[], cell: CellRef): number | null {
  const row = tables[cell.table]?.rows.find((item) => item.id === cell.row);
  const value = row?.values[cell.column];
  return value === undefined ? null : value;
}

/**
 * The signed residual of a constraint (0 when it balances exactly), or null when a cell is
 * missing. `override` substitutes values by cell key -- how a candidate correction is tried.
 */
export function residual(tables: StatementTable[], constraint: Constraint, override?: Map<string, number>): number | null {
  let sum = 0;
  for (const term of constraint.terms) {
    const value = override?.get(cellKey(term.cell)) ?? cellValue(tables, term.cell);
    if (value === null) return null;
    sum += term.sign * (term.magnitude ? Math.abs(value) : value) * term.scale;
  }
  return sum;
}

export function holds(tables: StatementTable[], constraint: Constraint, override?: Map<string, number>): boolean | null {
  const r = residual(tables, constraint, override);
  return r === null ? null : Math.abs(r) <= constraint.tolerance;
}
