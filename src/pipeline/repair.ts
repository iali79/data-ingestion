import { parseFigure, type StatementRow, type StatementTable } from './normalize.js';
import { cellKey, cellValue, holds, type CellRef, type Constraint, type Correction, type Reading } from './constraint-types.js';

/**
 * Stage 6b, rule R7: repair of misread cells, delivered only with an arithmetic proof.
 *
 * A non-advisory constraint that fails (or cannot be evaluated because a cell was unreadable) means
 * some cell in it was read wrong. Failing constraints that share a cell form a cluster. For each
 * cluster the engine looks for the smallest set of cells (one, then two) whose re-reading makes
 * every constraint of the cluster hold, and delivers it only when the arithmetic leaves no other
 * reading. The sub-rules:
 *
 * - R7a candidates. A cell's alternative value comes only from its own printed text or from an
 *   independent re-read of it: one OCR digit confusion from DIGIT_CONFUSIONS, a lost or spurious
 *   bracket, one dropped or one extra digit, two adjacent digits transposed, a comma read for a
 *   period or the reverse, or a Reading. An unreadable cell (value null) adds its text with OCR
 *   noise stripped, letters read for digits (GLYPH_DIGITS), each figure of a fused cell, and, only
 *   when its text yields no figure at all, the value a constraint solves it to. Never an arbitrary
 *   number.
 * - R7b acceptance. With the explanation substituted, every non-advisory constraint containing a
 *   corrected cell holds, and the cell has two witnesses that are independent for it, or one
 *   witness and a Reading equal to the corrected value. A witness is a non-advisory constraint that
 *   contains the cell, did not hold before and holds now. Two witnesses are independent for the
 *   cell when they are not the same relation and no other cell sits in both with the same
 *   coefficient ratio: such a cell could absorb both errors, so the pair would not single out this
 *   one. A single constraint alone never proves anything.
 * - R7c no collateral damage. A constraint (advisory or not) that held before must still hold with
 *   the explanation substituted, in this statement and every other one, and still hold once the
 *   corrections of every cluster are applied together.
 * - R7d uniqueness. When two different explanations (different cells or different values) are both
 *   accepted for a cluster, neither is delivered: the cluster is reported as ambiguous.
 * - R7e two cells. Only when no single cell is accepted or ambiguous, pairs of cells are searched.
 *   A pair must be minimal (neither change alone explains the cluster), each cell must pass R7b,
 *   and together the pair needs at least three pieces of evidence (distinct witnesses plus agreeing
 *   Readings): two unknowns solved from exactly two equations always fit, so that proves nothing.
 *   The search is bounded by REPAIR_BOUNDS.
 * - R7f text layer veto. A pdftotext Reading that equals the cell's first reading confirms what is
 *   printed; that cell is never corrected (the failure is a misprint or a wrong constraint).
 * - R7g advisory constraints never seed a cluster and never count as a witness; they can only
 *   veto a correction under R7c.
 *
 * The engine is pure and deterministic: clusters are taken in the order of their first
 * constraint, cells in the order they first appear in the cluster's constraints, candidates in
 * generation order.
 */

/**
 * R7a: single-digit OCR confusions, symmetric. Each pair is two glyphs that differ by one stroke
 * or one closed loop, which is what a blurred scan or a low resolution render loses or adds.
 */
export const DIGIT_CONFUSIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['0', '8', 'an oval pinched at the waist, or an 8 whose waist fills in'],
  ['0', '6', 'the top stroke of a 6 closes into an oval, or an oval opens'],
  ['0', '9', 'the bottom stroke of a 9 closes into an oval, or an oval opens'],
  ['1', '7', 'the flag of a serif 1 read as the bar of a 7'],
  ['1', '4', 'the diagonal and crossbar of an open-top 4 fade to a stem'],
  ['2', '7', 'the base stroke of a 2 lost, leaving a bar and a diagonal'],
  ['3', '5', 'the top of a 3 flattened into the bar of a 5'],
  ['3', '8', 'the open left side of a 3 closed into two loops'],
  ['4', '9', 'the open top of a 4 closed into the loop of a 9'],
  ['5', '6', 'the lower bowl of a 5 closed into the loop of a 6'],
  ['5', '8', 'the open sides of a 5 closed into two loops'],
  ['6', '8', 'the open top right of a 6 closed into the upper loop of an 8'],
  ['8', '9', 'the lower loop of an 8 opened into the tail of a 9'],
];

const CONFUSABLE: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [a, b] of DIGIT_CONFUSIONS) {
    map.set(a, [...(map.get(a) ?? []), b]);
    map.set(b, [...(map.get(b) ?? []), a]);
  }
  for (const list of map.values()) list.sort();
  return map;
})();

/**
 * R7a, unreadable cells only: letters and signs OCR returns in place of a digit of the same shape
 * ("~$71,104" is 571,104). Applied only to a cell whose text is not a figure and that holds at
 * least two real digits, so a stray "z" or "s" never becomes a number.
 */
export const GLYPH_DIGITS: Readonly<Record<string, string>> = {
  O: '0', o: '0', D: '0',
  I: '1', l: '1', i: '1',
  Z: '2', z: '2',
  A: '4',
  S: '5', s: '5', $: '5', '§': '5',
  G: '6', b: '6',
  T: '7',
  B: '8',
  g: '9', q: '9',
};

/**
 * R7e search bounds. A cluster with more cells than `pairCells` is not searched for two-cell
 * explanations; otherwise at most `pairTests` pairs of candidates are checked in full against the
 * cluster (a pair is only checked in full when the second value lies in the range the first
 * change leaves open for it). Past either bound the cluster is reported, never guessed.
 */
export const REPAIR_BOUNDS = { pairCells: 60, pairTests: 20_000 } as const;

export interface RepairResult {
  corrections: Correction[];
  unresolved: Array<{ constraint: string; reason: string }>;
}

/** A candidate value for a cell and every way the printed text or a re-read produces it. */
export interface Candidate {
  value: number;
  how: string;
}

/** Characters OCR leaves around or inside a figure that carry no digit. */
const NOISE = /[~"'‘’“”_|\\=<>*†‡`^;:!?]/gu;

/** The text parseFigure reads a figure from, with the same trimming. */
function figureText(raw: string): string {
  return raw
    .replace(/\s+/gu, '')
    .replace(/−/gu, '-')
    .replace(/^[|[\]'‘’"“”_=—§]+(?=[\d(])/u, '')
    .replace(/[|[\]'‘’"“”_*†‡]+$/u, '')
    .replace(/[.,:]+$/u, '')
    .replace(/(\d);(\d{3})/gu, '$1,$2');
}

const digitsOf = (text: string) => [...text].flatMap((char, index) => (/\d/u.test(char) ? [index] : []));
const clean = (value: number) => (Object.is(value, -0) ? 0 : value);
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * R7a: the single misreads of a figure's text, as candidate texts. Positions count digits from
 * the left, starting at 1, in the text as read. "digit a->b" is the digit as read and the digit it
 * is corrected to.
 */
function misreadTexts(text: string): Array<{ text: string; how: string }> {
  const out: Array<{ text: string; how: string }> = [];
  const digits = digitsOf(text);
  digits.forEach((index, n) => {
    for (const alternative of CONFUSABLE.get(text[index]!) ?? []) {
      out.push({ text: text.slice(0, index) + alternative + text.slice(index + 1), how: `digit ${text[index]}->${alternative} at position ${n + 1}` });
    }
  });
  if (digits.length > 0) {
    const value = parseFigure(text);
    const negative = value !== null ? value < 0 : /[()-]/u.test(text);
    out.push(negative ? { text: text.replace(/[()-]/gu, ''), how: 'sign (spurious bracket)' } : { text: `(${text})`, how: 'sign (lost bracket)' });
  }
  // A digit the read lost: every place in the text, before the first digit to after the last.
  for (let at = 0; at <= text.length; at++) {
    const before = digitsOf(text.slice(0, at)).length;
    for (let d = 0; d <= 9; d++) out.push({ text: text.slice(0, at) + d + text.slice(at), how: `dropped digit ${d} at position ${before + 1}` });
  }
  digits.forEach((index, n) => out.push({ text: text.slice(0, index) + text.slice(index + 1), how: `extra digit ${text[index]} at position ${n + 1}` }));
  for (let n = 0; n + 1 < digits.length; n++) {
    const [i, j] = [digits[n]!, digits[n + 1]!];
    if (text[i] === text[j]) continue;
    out.push({ text: text.slice(0, i) + text[j] + text.slice(i + 1, j) + text[i] + text.slice(j + 1), how: `transposed ${text[i]},${text[j]} at positions ${n + 1}-${n + 2}` });
  }
  [...text].forEach((char, index) => {
    if (char === ',') out.push({ text: `${text.slice(0, index)}.${text.slice(index + 1)}`, how: 'period read as comma' });
    if (char === '.') out.push({ text: `${text.slice(0, index)},${text.slice(index + 1)}`, how: 'comma read as period' });
  });
  return out;
}

/**
 * R7a: the candidate values of a cell from its raw printed text, merged by value in generation
 * order, without the value it was first read as. Exported for tests and for reviewers who want to
 * see what the engine may consider.
 */
export function misreadCandidates(raw: string, value: number | null): Candidate[] {
  const found = new Map<number, string[]>();
  const add = (text: string, how: string) => {
    const parsed = parseFigure(text);
    if (parsed === null) return;
    const candidate = clean(parsed);
    if (value !== null && same(candidate, value)) return;
    // The first explanation of a value is the simplest (the text as printed, then one edit); a later
    // one that reaches the same number (a leading 0 inserted) adds nothing but noise to the log.
    if (!found.has(candidate)) found.set(candidate, [how]);
  };
  if (value !== null) {
    for (const variant of misreadTexts(figureText(raw))) add(variant.text, variant.how);
  } else {
    const shown = raw.replace(/\s+/gu, ' ').trim();
    const tokens = raw.replace(/(\d);(\d{3})/gu, '$1,$2').split(/\s+/u).map((token) => token.replace(NOISE, '')).filter(Boolean);
    const kept = tokens.filter((token) => /\d/u.test(token) || /^[-–—()]+$/u.test(token));
    const whole = figureText(kept.join(''));
    const stripped = whole !== figureText(raw);
    if (whole !== '') {
      add(whole, stripped ? `noise stripped from '${shown}'` : `read '${shown}'`);
      for (const variant of misreadTexts(whole)) add(variant.text, stripped ? `${variant.how} (noise stripped from '${shown}')` : variant.how);
    }
    const figures = kept.filter((token) => parseFigure(token) !== null && (digitsOf(token).length >= 2 || /^[-–—]+$/u.test(token)));
    if (figures.length >= 2) figures.forEach((token, n) => add(token, `figure ${n + 1} of ${figures.length} fused in '${shown}'`));
    const letters = tokens.filter((token) => /\d/u.test(token)).join('');
    if (digitsOf(letters).length >= 2) {
      const swaps: string[] = [];
      let digit = 0;
      const read = [...letters].map((char) => {
        if (/\d/u.test(char)) digit++;
        const glyph = GLYPH_DIGITS[char];
        if (glyph === undefined) return char;
        digit++;
        swaps.push(`glyph '${char}'->${glyph} at position ${digit}`);
        return glyph;
      }).join('');
      if (swaps.length > 0) add(read, swaps.join(', '));
    }
  }
  return [...found].map(([candidate, hows]) => ({ value: candidate, how: hows.join('; ') }));
}

interface Coefficient {
  coef: number;
  magnitude: boolean;
}

interface Context {
  tables: StatementTable[];
  constraints: Constraint[];
  before: Array<boolean | null>;
  coefficients: Array<Map<string, Coefficient>>;
  /** Cell key -> indices of every constraint containing it, ascending. */
  byCell: Map<string, number[]>;
  refs: Map<string, CellRef>;
  readings: Map<string, Reading[]>;
  cache: Map<string, Candidate[]>;
}

interface Change {
  key: string;
  value: number;
  how: string;
}

type Verdict = { ok: true; corrections: Correction[] } | { ok: false; reason: string };

function rowOf(tables: StatementTable[], cell: CellRef): StatementRow | undefined {
  return tables[cell.table]?.rows.find((row) => row.id === cell.row);
}

/** Decimal places the row prints its figures with, for rounding a solved value (R7a). */
function rowDecimals(row: StatementRow): number {
  let decimals = 0;
  for (const cell of row.cells) {
    if (parseFigure(cell) === null) continue;
    const match = /\.(\d+)\)?$/u.exec(figureText(cell));
    if (match) decimals = Math.max(decimals, match[1]!.length);
  }
  return Math.min(decimals, 6);
}

/** The sum of a constraint's terms other than `key`, or null when one of them is unreadable. */
function othersSum(context: Context, index: number, key: string, override: Map<string, number>): number | null {
  let sum = 0;
  for (const term of context.constraints[index]!.terms) {
    const termKey = cellKey(term.cell);
    if (termKey === key) continue;
    const value = override.get(termKey) ?? cellValue(context.tables, term.cell);
    if (value === null) return null;
    sum += term.sign * (term.magnitude ? Math.abs(value) : value) * term.scale;
  }
  return sum;
}

/** Ranges of `key`'s value that make constraint `index` hold, or null when they cannot be known. */
function openRanges(context: Context, index: number, key: string, override: Map<string, number>): Array<[number, number]> | null {
  const own = context.coefficients[index]!.get(key);
  const others = othersSum(context, index, key, override);
  if (!own || own.coef === 0 || others === null) return null;
  const tolerance = context.constraints[index]!.tolerance;
  const [a, b] = [(-others - tolerance) / own.coef, (-others + tolerance) / own.coef];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (!own.magnitude) return [[lo, hi]];
  if (hi < 0) return [];
  const floor = Math.max(lo, 0);
  return [[floor, hi], [-hi, -floor]];
}

/** R7a, last resort for an unreadable cell: the value each constraint solves it to, rounded as the row prints. */
function solvedCandidates(context: Context, key: string, override: Map<string, number>): Candidate[] {
  const cell = context.refs.get(key)!;
  const row = rowOf(context.tables, cell);
  if (!row) return [];
  const step = 10 ** rowDecimals(row);
  const found = new Map<number, string[]>();
  for (const index of context.byCell.get(key) ?? []) {
    const constraint = context.constraints[index]!;
    if (constraint.advisory) continue;
    const own = context.coefficients[index]!.get(key)!;
    const others = othersSum(context, index, key, override);
    if (others === null || own.coef === 0) continue;
    const solved = Math.round((-others / own.coef) * step) / step;
    const values = own.magnitude ? (solved < 0 ? [] : [solved, -solved]) : [solved];
    for (const value of values.map(clean)) {
      const ids = found.get(value) ?? [];
      if (!ids.includes(constraint.id)) ids.push(constraint.id);
      found.set(value, ids);
    }
  }
  const shown = row.cells[cell.column]?.replace(/\s+/gu, ' ').trim() ?? '';
  return [...found].map(([value, ids]) => ({ value, how: `unreadable${shown ? ` '${shown}'` : ''}, solved from ${ids.join(', ')}` }));
}

/** R7a: every candidate for a cell: its text's misreads, its Readings, and for an unreadable cell with no figure in its text, the solved values. */
function candidatesFor(context: Context, key: string, override: Map<string, number>): Candidate[] {
  const cached = context.cache.get(key);
  const cell = context.refs.get(key)!;
  const row = rowOf(context.tables, cell);
  if (!row) return [];
  const original = row.values[cell.column] ?? null;
  let base = cached;
  if (!base) {
    const merged = new Map<number, string[]>();
    const add = (value: number, how: string) => {
      if (original !== null && same(value, original)) return;
      merged.set(value, [...(merged.get(value) ?? []), how]);
    };
    for (const candidate of misreadCandidates(row.cells[cell.column] ?? '', original)) add(candidate.value, candidate.how);
    for (const reading of context.readings.get(key) ?? []) add(clean(reading.value), `reread ${reading.source} '${reading.text}'`);
    base = [...merged].map(([value, hows]) => ({ value, how: hows.join('; ') }));
    context.cache.set(key, base);
  }
  if (original !== null || base.length > 0) return base;
  return solvedCandidates(context, key, override);
}

/**
 * R7b: whether two witnesses are independent for `key`: not the same relation, and no other cell
 * in both with the same coefficient ratio (compared by magnitude when a term uses |value|).
 */
function independent(context: Context, a: number, b: number, key: string): boolean {
  const [first, second] = [context.coefficients[a]!, context.coefficients[b]!];
  const [x, y] = [first.get(key)!, second.get(key)!];
  if (x.coef === 0 || y.coef === 0) return false;
  let shared = 0;
  for (const [other, p] of first) {
    if (other === key) continue;
    const q = second.get(other);
    if (!q) continue;
    shared++;
    const loose = p.magnitude || q.magnitude || x.magnitude || y.magnitude;
    const [left, right] = [p.coef * y.coef, q.coef * x.coef];
    if (loose ? same(Math.abs(left), Math.abs(right)) : same(left, right)) return false;
  }
  // Both constraints hold only this cell: the same relation unless one of them has another cell.
  return !(shared === 0 && first.size === 1 && second.size === 1);
}

/** R7b, R7c, R7e, R7f: whether an explanation proves itself; the corrections it delivers if so. */
function judge(context: Context, cluster: number[], changes: Change[]): Verdict {
  const override = new Map(changes.map((change) => [change.key, change.value]));
  const { tables, constraints, before } = context;
  for (const index of cluster) {
    if (holds(tables, constraints[index]!, override) !== true) return { ok: false, reason: `${constraints[index]!.id} still fails` };
  }
  const corrections: Correction[] = [];
  const evidence = new Set<string>();
  let agreeing = 0;
  for (const change of changes) {
    const cell = context.refs.get(change.key)!;
    const original = cellValue(tables, cell);
    const described = `${change.key} ${original ?? 'unreadable'} -> ${change.value} (${change.how})`;
    const readings = context.readings.get(change.key) ?? [];
    if (original !== null && readings.some((reading) => reading.source === 'pdftotext' && same(reading.value, original))) {
      return { ok: false, reason: `${described}: the pdftotext re-read confirms ${original} (R7f)` };
    }
    const witnesses: number[] = [];
    for (const index of context.byCell.get(change.key) ?? []) {
      const constraint = constraints[index]!;
      const now = holds(tables, constraint, override);
      if (now !== true && (!constraint.advisory || before[index] === true)) return { ok: false, reason: `${described} breaks ${constraint.id} (R7c)` };
      if (!constraint.advisory && before[index] !== true) witnesses.push(index);
    }
    const agrees = readings.find((reading) => same(reading.value, change.value));
    let proven = false;
    for (let i = 0; i < witnesses.length && !proven; i++) {
      for (let j = i + 1; j < witnesses.length && !proven; j++) proven = independent(context, witnesses[i]!, witnesses[j]!, change.key);
    }
    if (!proven && !(agrees && witnesses.length >= 1)) {
      const covered = witnesses.map((index) => constraints[index]!.id).join(', ') || 'nothing';
      return { ok: false, reason: `${described} is supported only by ${covered}; a cell needs two independent constraints, or one and an agreeing re-read (R7b)` };
    }
    witnesses.forEach((index) => evidence.add(constraints[index]!.id));
    if (agrees) agreeing++;
    const how = agrees && !change.how.includes(`reread ${agrees.source}`) ? `${change.how}; reread ${agrees.source} '${agrees.text}' agrees` : change.how;
    corrections.push({ cell: { ...cell }, from: original, to: change.value, how, proof: witnesses.map((index) => constraints[index]!.id) });
  }
  if (changes.length > 1 && evidence.size + agreeing < changes.length + 1) {
    return { ok: false, reason: `${changes.map((change) => `${change.key} -> ${change.value}`).join(' and ')} fit only ${evidence.size + agreeing} pieces of evidence for ${changes.length} unknowns (R7e)` };
  }
  return { ok: true, corrections };
}

const describe = (changes: Change[]) => changes.map((change) => `${change.key} -> ${change.value} (${change.how})`).join(' + ');
const signature = (changes: Change[]) => changes.map((change) => `${change.key}=${change.value}`).join('|');

interface ClusterOutcome {
  corrections: Correction[];
  reason: string | null;
}

/** R7b to R7e for one cluster: the single-cell search, then (only if nothing single fits) the bounded pair search. */
function solveCluster(context: Context, cluster: number[]): ClusterOutcome {
  const { tables, constraints } = context;
  const cells: string[] = [];
  for (const index of cluster) {
    for (const term of constraints[index]!.terms) {
      const key = cellKey(term.cell);
      if (!cells.includes(key)) cells.push(key);
    }
  }
  const empty = new Map<string, number>();
  const explains = (override: Map<string, number>) => cluster.every((index) => holds(tables, constraints[index]!, override) === true);

  let rejected: string | null = null;
  const accepted: Array<{ changes: Change[]; corrections: Correction[] }> = [];
  for (const key of cells) {
    for (const candidate of candidatesFor(context, key, empty)) {
      const changes = [{ key, value: candidate.value, how: candidate.how }];
      if (!explains(new Map([[key, candidate.value]]))) continue;
      const verdict = judge(context, cluster, changes);
      if (verdict.ok) accepted.push({ changes, corrections: verdict.corrections });
      else rejected ??= verdict.reason;
    }
  }
  if (accepted.length === 1) return { corrections: accepted[0]!.corrections, reason: null };
  if (accepted.length > 1) return { corrections: [], reason: `ambiguous (R7d): ${accepted.map((item) => describe(item.changes)).join(' or ')}` };

  if (cells.length > REPAIR_BOUNDS.pairCells) {
    return { corrections: [], reason: rejected ?? `no single misread explains it, and ${cells.length} cells exceed the two-cell search bound of ${REPAIR_BOUNDS.pairCells} (R7e)` };
  }
  const seen = new Set<string>();
  let tests = 0;
  for (const first of cells) {
    for (const one of candidatesFor(context, first, empty)) {
      const override = new Map([[first, one.value]]);
      const open = cluster.filter((index) => holds(tables, constraints[index]!, override) !== true);
      if (open.length === 0) continue;
      for (const second of cells) {
        if (second === first) continue;
        const touching = context.byCell.get(second) ?? [];
        if (!open.every((index) => touching.includes(index))) continue;
        const ranges = openRanges(context, open[0]!, second, override);
        for (const two of candidatesFor(context, second, override)) {
          if (ranges && !ranges.some(([lo, hi]) => two.value >= lo - 1e-9 && two.value <= hi + 1e-9)) continue;
          const changes = [{ key: first, value: one.value, how: one.how }, { key: second, value: two.value, how: two.how }]
            .sort((a, b) => cells.indexOf(a.key) - cells.indexOf(b.key));
          const id = signature(changes);
          if (seen.has(id)) continue;
          seen.add(id);
          if (++tests > REPAIR_BOUNDS.pairTests) {
            return { corrections: [], reason: `no single misread explains it, and the two-cell search passed its bound of ${REPAIR_BOUNDS.pairTests} checks (R7e)` };
          }
          const both = new Map(changes.map((change) => [change.key, change.value]));
          // Minimal: the second change alone must not already explain the cluster.
          if (!explains(both) || explains(new Map([[second, two.value]]))) continue;
          const verdict = judge(context, cluster, changes);
          if (verdict.ok) accepted.push({ changes, corrections: verdict.corrections });
          else rejected ??= verdict.reason;
        }
      }
    }
  }
  if (accepted.length === 1) return { corrections: accepted[0]!.corrections, reason: null };
  if (accepted.length > 1) return { corrections: [], reason: `ambiguous (R7d): ${accepted.map((item) => describe(item.changes)).join(' or ')}` };
  return { corrections: [], reason: rejected ?? 'no plausible misread of one or two cells makes every constraint hold' };
}

/**
 * Rule R7: finds the misread cells that failing constraints expose and returns the corrections the
 * arithmetic proves, with every failing constraint it could not settle and why. Pure: the tables
 * are not changed (see applyCorrections).
 */
export function repairCells(tables: StatementTable[], constraints: Constraint[], readings: Map<string, Reading[]>): RepairResult {
  const context: Context = {
    tables,
    constraints,
    before: constraints.map((constraint) => holds(tables, constraint)),
    coefficients: constraints.map((constraint) => {
      const map = new Map<string, Coefficient>();
      for (const term of constraint.terms) {
        const key = cellKey(term.cell);
        const known = map.get(key);
        map.set(key, { coef: (known?.coef ?? 0) + term.sign * term.scale, magnitude: (known?.magnitude ?? false) || term.magnitude === true });
      }
      return map;
    }),
    byCell: new Map(),
    refs: new Map(),
    readings,
    cache: new Map(),
  };
  constraints.forEach((constraint, index) => {
    for (const term of constraint.terms) {
      const key = cellKey(term.cell);
      if (!context.refs.has(key)) context.refs.set(key, { table: term.cell.table, row: term.cell.row, column: term.cell.column });
      const list = context.byCell.get(key) ?? [];
      if (list.at(-1) !== index) list.push(index);
      context.byCell.set(key, list);
    }
  });

  // Clusters (R7g): non-advisory constraints that fail or cannot be evaluated, joined by shared cells.
  const seeds = constraints.flatMap((constraint, index) => (!constraint.advisory && context.before[index] !== true ? [index] : []));
  const parent = new Map(seeds.map((index) => [index, index]));
  const find = (index: number): number => {
    let root = index;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const owner = new Map<string, number>();
  for (const index of seeds) {
    for (const key of context.coefficients[index]!.keys()) {
      const other = owner.get(key);
      if (other === undefined) owner.set(key, index);
      else {
        const [a, b] = [find(other), find(index)];
        if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
      }
    }
  }
  const clusters = new Map<number, number[]>();
  for (const index of seeds) {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), index]);
  }
  const ordered = [...clusters.values()].sort((a, b) => a[0]! - b[0]!);

  const outcomes = ordered.map((cluster) => solveCluster(context, cluster));

  // R7c across clusters: every correction applied together must still leave what held holding.
  for (;;) {
    const override = new Map<string, number>();
    const home = new Map<string, number>();
    outcomes.forEach((outcome, n) => outcome.corrections.forEach((correction) => {
      override.set(cellKey(correction.cell), correction.to);
      home.set(cellKey(correction.cell), n);
    }));
    let broken = false;
    constraints.forEach((constraint, index) => {
      const involved = [...context.coefficients[index]!.keys()].filter((key) => home.has(key));
      if (involved.length === 0) return;
      const was = context.before[index] === true || (!constraint.advisory && seeds.includes(index));
      if (!was || holds(tables, constraint, override) === true) return;
      for (const key of involved) {
        const outcome = outcomes[home.get(key)!]!;
        if (outcome.corrections.length === 0) continue;
        outcome.corrections = [];
        outcome.reason = `corrections from separate clusters together break ${constraint.id} (R7c)`;
        broken = true;
      }
    });
    if (!broken) break;
  }

  const corrections = outcomes.flatMap((outcome) => outcome.corrections);
  const unresolved = ordered.flatMap((cluster, n) => {
    const reason = outcomes[n]!.reason;
    return reason === null ? [] : cluster.map((index) => ({ index, constraint: constraints[index]!.id, reason }));
  }).sort((a, b) => a.index - b.index).map(({ constraint, reason }) => ({ constraint, reason }));
  return { corrections, unresolved };
}

/**
 * R7: the tables with corrections applied, deep-copied; the input is not changed. Each repaired
 * row records, per column, the first reading and the kind of misread (`repaired`), and keeps its
 * raw printed text as the evidence.
 */
export function applyCorrections(tables: StatementTable[], corrections: Correction[]): StatementTable[] {
  const copy = structuredClone(tables);
  for (const correction of corrections) {
    const row = rowOf(copy, correction.cell);
    if (!row) throw new Error(`correction for a cell that is not in the tables: ${cellKey(correction.cell)}`);
    row.values[correction.cell.column] = correction.to;
    row.repaired = { ...row.repaired, [correction.cell.column]: { from: correction.from, how: correction.how } };
  }
  return copy;
}
