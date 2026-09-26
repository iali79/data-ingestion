import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPeriods, droppedItemKeys, type PeriodFigures, type ReportedValue } from './financials/derive.js';
import { runCommand } from './extraction.js';
import type { DocumentAnalysis, PageAnalysis } from './pipeline/analyse.js';
import type { Classification } from './pipeline/classify.js';
import { buildStatements, verifyStatements, type Rereader, type StatementSummary } from './pipeline/filing.js';
import type { Correction } from './pipeline/constraint-types.js';
import { rereadCells } from './pipeline/reread.js';
import { normalizeLabel } from './pipeline/labels.js';
import type { StatementRow, StatementTable } from './pipeline/normalize.js';
import { readNotes } from './pipeline/notes.js';
import type { TableExtraction } from './pipeline/tables.js';
import { confirmTotals, MAX_RUN, TOTAL_LABEL, type Drop } from './pipeline/validate.js';
import { countFigures, scorePeriods, type AnswerKey, type Score } from './score.js';

/**
 * Offline replay of stage 6 onward over saved evaluation artifacts: no Docling, no OCR, no network.
 *
 *   node dist/replay.js [--rebuild] <corpusDir> [outJson] [answerKey.json ...]
 *
 * `corpusDir` holds downloaded "Evaluate" workflow artifacts: `run-<id>/evaluation-<n>/<SYMBOL-ID>/`
 * with the stage outputs a run wrote (statements.json, tables.json, classification.json,
 * analysis.json, validation.json, source.pdf), and `<SYMBOL-ID>.json` beside it, the payload the
 * webhook would have received. A filing present in several runs is replayed once, from the newest
 * run (the highest run id). A directory without a readable statements.json is skipped (a download
 * still in progress, or a filing whose run failed).
 *
 * For each filing the saved statement tables (built by stage 5 and already carrying their final
 * unit scale) go through `validateStatements`, the same function production calls, then the note
 * readers and `buildPeriods`. So a change to the label rules, the checks or the derivations can be
 * measured before and after on the whole corpus in seconds. A change to stages 1-5 (classifier,
 * table building, parseFigure) is NOT measured: the tables are replayed as the run built them.
 *
 * `--rebuild` measures stage 5 as well: the statement tables are built again by `buildStatements`
 * (the function production calls) from the saved page grids (tables.json), the saved page
 * selection (classification.json, hints already applied to it) and the page text of stage 1
 * (see `replayAnalysis`), with the filing period from the payload. Stages 1-4 are still as the run
 * left them. An admin unit hint (rule H3) is not in the corpus and is not applied. A filing whose
 * payload has no period, or whose grids or classification are missing, is skipped.
 *
 * Notes are replayed from the saved page grids (tables.json) and classification. Their only use of
 * page text, the par value line, reads native pages; that text is `pdftotext -layout` of
 * source.pdf, as stage 1 reads it. Scanned pages' OCR text was not saved, and no note reader uses
 * it, so it is left empty.
 *
 * Answer keys (default samples/hpl-answers.json) are the formats evaluate.ts reads: a key map by
 * source URL, or a review-panel export `{ samples, answers }`. Figures are scored with the same
 * `scorePeriods`.
 *
 * Besides what production does, the replay measures A1 structure it cannot see: confirmTotals
 * only confirms a run of rows whose sum already equals its total, so a total with one misread
 * component is silently unconfirmed. `crossColumnFailures` takes each run found in one value
 * column and adds the same rows in every other column; where they do not add up there, a cell in
 * that column is misread (or the run was a coincidence), and nothing today says so.
 */

export interface FilingDir {
  id: string;
  dir: string;
  run: string;
}

export interface FilingMeta {
  id: string;
  symbol: string;
  url: string;
  reportType: string | null;
  periodEnded: string | null;
}

/** One A1 run: rows `parts` sum to row `total` in value column `column`. */
export interface A1Run {
  table: number;
  column: number;
  total: string;
  parts: string[];
}

/** A run that holds in one column and fails in another: a hidden misread. */
export interface CrossColumnFailure {
  table: number;
  /** The column the run was found in (it holds there). */
  foundIn: number;
  /** The column where the same rows do not add up. */
  column: number;
  total: string;
  parts: string[];
  /** Sum of the parts minus the printed total, in printed units. */
  residual: number;
  /** The total is confirmed in `column` by a different run: the structure differs, not necessarily a misread. */
  confirmedOtherwise: boolean;
}

export interface FilingMetrics extends FilingMeta {
  run: string;
  dir: string;
  tables: number;
  ocrTables: number;
  /** Reported statement figures delivered (after every check). */
  delivered: number;
  checked: number;
  /** Delivered with no check at all; V5 makes this native pages only. */
  unchecked: number;
  uncheckedOcr: number;
  /** Delivered figures carrying each check family (A1, I1, B5, X1 ...). */
  byCheck: Record<string, number>;
  notes: number;
  drops: number;
  dropsByRule: Record<string, number>;
  unmatchedRows: number;
  periods: number;
  reported: number;
  derived: number;
  ratios: number;
  runtime: number;
  empty: number;
  a1: {
    runs: number;
    /** Printed total cells (a total row in a kept column) that no run confirms. */
    unconfirmedTotals: number;
    crossColumnFailures: number;
    /** Cells where the mirror in this file and confirmTotals disagree; must be 0. */
    mirrorMismatches: number;
  };
  score: Score | null;
  /** What the run itself recorded, to see how far the current code has moved from it. */
  recorded: { values: number | null; drops: number | null; reported: number | null };
  failures: CrossColumnFailure[];
  dropList: Drop[];
  /** Cells the repair stage corrected, and relations it could not settle. */
  corrections: Correction[];
  unresolved: Array<{ constraint: string; reason: string }>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Filing directories under the corpus, one per SYMBOL-ID, from the newest run that holds it. */
export async function findFilings(corpusDir: string): Promise<FilingDir[]> {
  const found = new Map<string, FilingDir>();
  const walk = async (dir: string, run: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const full = path.join(dir, entry.name);
      const runHere = /^run-\d+$/u.test(entry.name) ? entry.name : run;
      if (/^[A-Z0-9]+-\d+$/u.test(entry.name) && (await stat(path.join(full, 'statements.json')).catch(() => null))) {
        const previous = found.get(entry.name);
        if (!previous || runNumber(runHere) > runNumber(previous.run)) found.set(entry.name, { id: entry.name, dir: full, run: runHere });
      } else if (depth < 4) await walk(full, runHere, depth + 1);
    }
  };
  await walk(corpusDir, '', 0);
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function runNumber(run: string): number {
  return Number(/(\d+)$/u.exec(run)?.[1] ?? 0);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Every A1 run confirmTotals finds, with its rows. The same walk as confirmTotals, recording the runs. */
export function a1Runs(table: StatementTable, tableIndex = 0): A1Run[] {
  const runs: A1Run[] = [];
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
          runs.push({ table: tableIndex, column: column.index, total: row.id, parts: parts.map((part) => part.id) });
        }
      }
      live.push(row);
    }
  }
  return runs;
}

/**
 * Runs that hold in one kept value column, added up in every other kept column where all their
 * cells were read. Each distinct run (same total, same rows) is tested once per column. Columns
 * production does not deliver are left out: an undated column is often the other half of a
 * side-by-side balance sheet, whose rows are different items.
 *
 * A run is evidence of the statement's structure only when nothing in its column leaves the
 * structure open. A nil part ("-") would fit any run, and a row inside the run's span, or directly
 * above it, that is empty or nil in that column (and not already inside a smaller total) may belong
 * to the total in a column where it has a figure: a financing inflow printed only this year. Such
 * runs are not carried to other columns; without this, most "failures" are those rows.
 */
export function crossColumnFailures(table: StatementTable, runs: A1Run[], tableIndex = 0): CrossColumnFailure[] {
  const confirmed = confirmTotals(table);
  const byId = new Map(table.rows.map((row) => [row.id, row]));
  const failures: CrossColumnFailure[] = [];
  const tested = new Set<string>();
  const position = new Map(table.rows.map((row, index) => [row.id, index]));
  const kept = new Set(table.columns.filter((column) => column.kept).map((column) => column.index));
  for (const run of runs) {
    const nil = (id: string) => !byId.get(id)?.values[run.column];
    const consumed = new Set(runs.filter((other) => other.column === run.column && other.total !== run.total).flatMap((other) => other.parts));
    const first = Math.min(...run.parts.map((id) => position.get(id)!));
    const inside = table.rows.slice(first, position.get(run.total)!).filter((row) => !run.parts.includes(row.id) && !consumed.has(row.id));
    // Nil rows directly above the run could belong to it just as well.
    const above: StatementRow[] = [];
    for (let index = first - 1; index >= 0; index--) {
      const candidate = table.rows[index]!;
      if (consumed.has(candidate.id)) continue;
      if (!nil(candidate.id)) break;
      above.push(candidate);
    }
    if (!kept.has(run.column) || run.parts.some(nil) || [...inside, ...above].some((row) => nil(row.id))) continue;
    for (const column of table.columns) {
      if (column.index === run.column || !column.kept) continue;
      const key = `${run.total}|${run.parts.join(',')}|${column.index}`;
      if (tested.has(key)) continue;
      tested.add(key);
      // Held in this column too, by some run of its own: nothing to report.
      if (runs.some((other) => other.column === column.index && other.total === run.total && other.parts.join(',') === run.parts.join(','))) continue;
      const total = byId.get(run.total)?.values[column.index];
      const parts = run.parts.map((id) => byId.get(id)?.values[column.index]);
      if (total === null || total === undefined || parts.some((value) => value === null || value === undefined)) continue;
      const residual = parts.reduce<number>((sum, value) => sum + value!, 0) - total;
      if (Math.abs(residual) <= 0.5 * parts.length + 0.5) continue;
      failures.push({
        table: tableIndex,
        foundIn: run.column,
        column: column.index,
        total: run.total,
        parts: run.parts,
        residual,
        confirmedOtherwise: confirmed.get(run.total)?.has(column.index) ?? false,
      });
    }
  }
  return failures;
}

/**
 * Total rows (captioned as a total, or uncaptioned) with a figure in a kept column that no run of
 * their own closes. A total whose own rows do not add up can still be "confirmed" as a component of
 * a later total (operating profit inside profit before tax); it is counted here all the same, since
 * the rows above it were never checked.
 */
export function unconfirmedTotals(table: StatementTable): Array<{ row: string; column: number }> {
  const confirmed = confirmTotals(table);
  const out: Array<{ row: string; column: number }> = [];
  for (const row of table.rows) {
    const label = normalizeLabel(row.label);
    if (label && !TOTAL_LABEL.test(label)) continue;
    for (const column of table.columns.filter((item) => item.kept)) {
      const value = row.values[column.index];
      if (value === null || value === undefined || confirmed.get(row.id)?.get(column.index) === `A1 sum to ${row.id}`) continue;
      out.push({ row: row.id, column: column.index });
    }
  }
  return out;
}

/** The rule a drop was made under: its reason's leading rule id, or "negative" for rule V1's sign check. */
export function dropRule(drop: Drop): string {
  const id = /^([A-Z]\d+):/u.exec(drop.reason)?.[1];
  if (id) return id;
  if (/^negative for\b/u.test(drop.reason)) return 'negative';
  return 'other';
}

/** Loads answer keys in either format evaluate.ts reads, merged by source URL and period label. */
export async function readAnswerKeys(files: string[]): Promise<AnswerKey> {
  const merged: AnswerKey = {};
  for (const file of files) {
    const loaded = await readJson<AnswerKey | { samples: unknown[]; answers: AnswerKey }>(file);
    if (!loaded) continue;
    const key = Array.isArray((loaded as { samples?: unknown }).samples) ? (loaded as { answers: AnswerKey }).answers : (loaded as AnswerKey);
    for (const [url, labels] of Object.entries(key)) {
      if (!/^https?:/u.test(url) || typeof labels !== 'object') continue;
      const target = (merged[url] ??= {});
      for (const [label, items] of Object.entries(labels)) target[label] = { ...(target[label] ?? {}), ...items };
    }
  }
  return merged;
}

/**
 * Stage 1's view of the pages the note readers use: page kinds from analysis.json, and for native
 * pages their `pdftotext -layout` text from source.pdf (analysis.json keeps only 200 characters).
 */
async function replayAnalysis(dir: string): Promise<DocumentAnalysis> {
  const saved = await readJson<{ pageCount: number; ms: number; pages: Array<Omit<PageAnalysis, 'text' | 'overlay'> & { head?: string }> }>(path.join(dir, 'analysis.json'));
  if (!saved) return { pageCount: 0, ms: 0, pages: [] };
  let texts: string[] = [];
  try {
    texts = (await runCommand('pdftotext', ['-layout', path.join(dir, 'source.pdf'), '-'])).stdout.split('\f');
  } catch {
    texts = [];
  }
  const pages = saved.pages.map(({ head, ...page }) => ({
    ...page,
    text: page.kind === 'native' ? texts[page.pageNumber - 1] ?? head ?? '' : '',
    overlay: '',
  }));
  return { pageCount: saved.pageCount, ms: saved.ms, pages };
}

export interface Replayed {
  values: ReportedValue[];
  notes: ReportedValue[];
  summaries: StatementSummary[];
  drops: Drop[];
  periods: PeriodFigures[];
  tables: StatementTable[];
  corrections: Correction[];
  unresolved: Array<{ constraint: string; reason: string }>;
}

export interface ReplayOptions {
  /** Build the statement tables again from the saved grids (stage 5), instead of reading statements.json. */
  rebuild?: boolean;
  /** The filing's period ("2025", "2026-03-31"), from its payload; needed to rebuild. */
  periodEnded?: string | null;
}

/** Stage 6 onward for one saved filing, as extractFilingFinancials runs it (stage 5 onward with `rebuild`). */
export async function replayFiling(dir: string, options: ReplayOptions = {}): Promise<Replayed | null> {
  const analysis = await replayAnalysis(dir);
  const classification = await readJson<Classification>(path.join(dir, 'classification.json'));
  const grids = await readJson<TableExtraction>(path.join(dir, 'tables.json'));
  const pages = grids?.pages ?? [];
  let tables: StatementTable[];
  if (options.rebuild) {
    if (!classification || !grids || !options.periodEnded) return null;
    tables = buildStatements(classification.statements, pages, { periodEnded: options.periodEnded }, analysis);
  } else {
    const saved = await readJson<{ tables: StatementTable[] }>(path.join(dir, 'statements.json'));
    if (!saved || !Array.isArray(saved.tables)) return null;
    tables = saved.tables.map(uniqueRowIds);
  }
  const drops: Drop[] = [];
  // The second reading offline: the text layer of native pages. Scanned pages would need
  // tesseract, which the replay does not run, so they get no second reading here.
  const reread: Rereader = async (suspect, cells) => {
    const native = cells.filter((cell) => analysis.pages[(suspect[cell.table]?.rows.find((row) => row.id === cell.row)?.page ?? 0) - 1]?.kind === 'native');
    return native.length ? rereadCells(path.join(dir, 'source.pdf'), analysis, suspect, native, dir, { maxOcrPages: 0 }) : new Map();
  };
  const verified = await verifyStatements(tables, drops, reread);
  const { values, summaries, corrections, unresolved } = verified;
  const notes = classification ? readNotes(classification.notes, pages, analysis, verified.tables, values, drops) : [];
  const periods = buildPeriods([...values, ...notes], () => null, droppedItemKeys(drops));
  return { values, notes, summaries, drops, periods, tables: verified.tables, corrections, unresolved };
}

/**
 * Tables saved before row ids were made unique within a statement (normalize.ts: the second table
 * on a page numbers its rows `p{page}.t{n}.r{row}`) repeat ids across a side-by-side page's
 * halves. The same renaming is applied here, so old artifacts replay as today's code builds them.
 */
export function uniqueRowIds(table: StatementTable): StatementTable {
  const seen = new Map<string, number>();
  const rows = table.rows.map((row) => {
    const count = seen.get(row.id) ?? 0;
    seen.set(row.id, count + 1);
    return count === 0 ? row : { ...row, id: row.id.replace(/^p(\d+)\./u, `p$1.t${count}.`) };
  });
  return { ...table, rows };
}

async function filingMeta(filing: FilingDir): Promise<FilingMeta> {
  const payload = await readJson<{ filing?: { url?: string; sourceUrl?: string; symbol?: string; reportType?: string; periodEnded?: string } }>(`${filing.dir}.json`);
  const [symbol = filing.id, number = ''] = filing.id.split('-');
  return {
    id: filing.id,
    symbol: payload?.filing?.symbol ?? symbol,
    url: payload?.filing?.url ?? payload?.filing?.sourceUrl ?? `https://financials.psx.com.pk/lib/DownloadPDF.php?id=${number}`,
    reportType: payload?.filing?.reportType ?? null,
    periodEnded: payload?.filing?.periodEnded ?? null,
  };
}

export async function measureFiling(filing: FilingDir, answers: AnswerKey, options: { rebuild?: boolean } = {}): Promise<FilingMetrics | null> {
  const meta = await filingMeta(filing);
  const replayed = await replayFiling(filing.dir, { rebuild: options.rebuild, periodEnded: meta.periodEnded });
  if (!replayed) return null;
  const { values, notes, summaries, drops, periods, tables } = replayed;
  const ocrPages = new Set(tables.flatMap((table) => table.rows.filter((row) => row.ocr).map((row) => row.page)));
  const byCheck: Record<string, number> = {};
  for (const value of values) {
    for (const family of new Set((value.checks ?? []).map((check) => check.split(/\s/u)[0]!))) byCheck[family] = (byCheck[family] ?? 0) + 1;
  }
  const dropsByRule: Record<string, number> = {};
  for (const drop of drops) dropsByRule[dropRule(drop)] = (dropsByRule[dropRule(drop)] ?? 0) + 1;

  let runs = 0;
  let unconfirmed = 0;
  let mirrorMismatches = 0;
  const failures: CrossColumnFailure[] = [];
  for (const [index, table] of tables.entries()) {
    const found = a1Runs(table, index);
    runs += found.length;
    mirrorMismatches += mirrorMismatch(table, found);
    failures.push(...crossColumnFailures(table, found, index));
    unconfirmed += unconfirmedTotals(table).length;
  }

  let derived = 0;
  let ratios = 0;
  let runtime = 0;
  for (const period of periods) {
    for (const figure of [period.income, period.balance, period.cashFlow].flatMap((section) => Object.values(section))) {
      if (figure?.source === 'derived') derived++;
      if (figure?.source === 'runtime') runtime++;
    }
    for (const figure of Object.values(period.ratios)) {
      if (figure?.source === 'derived') ratios++;
      if (figure?.source === 'runtime') runtime++;
    }
  }
  const counts = countFigures(periods);
  const recordedValidation = await readJson<{ drops: Drop[]; values: ReportedValue[] }>(path.join(filing.dir, 'validation.json'));
  const recordedPayload = await readJson<{ periods?: PeriodFigures[] }>(`${filing.dir}.json`);
  const checked = values.filter((value) => value.checks?.length).length;
  return {
    ...meta,
    run: filing.run,
    dir: filing.dir,
    tables: tables.length,
    ocrTables: tables.filter((table) => table.rows.some((row) => row.ocr)).length,
    delivered: values.length,
    checked,
    unchecked: values.length - checked,
    uncheckedOcr: values.filter((value) => !value.checks?.length && value.page !== null && ocrPages.has(value.page)).length,
    byCheck,
    notes: notes.length,
    drops: drops.length,
    dropsByRule,
    unmatchedRows: summaries.reduce((sum, summary) => sum + summary.unmatched.length, 0),
    periods: periods.length,
    reported: counts.reported,
    derived,
    ratios,
    runtime,
    empty: counts.empty,
    a1: { runs, unconfirmedTotals: unconfirmed, crossColumnFailures: failures.filter((failure) => !failure.confirmedOtherwise).length, mirrorMismatches },
    score: answers[meta.url] ? scorePeriods(periods, answers[meta.url]!) : null,
    recorded: {
      values: recordedValidation?.values.length ?? null,
      drops: recordedValidation?.drops.length ?? null,
      reported: recordedPayload?.periods ? countFigures(recordedPayload.periods).reported : null,
    },
    failures,
    dropList: drops,
    corrections: replayed.corrections,
    unresolved: replayed.unresolved,
  };
}

/** Cells the recorded runs confirm that confirmTotals does not, or the reverse. */
function mirrorMismatch(table: StatementTable, runs: A1Run[]): number {
  const mine = new Set(runs.flatMap((run) => [run.total, ...run.parts].map((row) => `${row}:${run.column}`)));
  const theirs = new Set([...confirmTotals(table)].flatMap(([row, columns]) => [...columns.keys()].map((column) => `${row}:${column}`)));
  return [...mine].filter((cell) => !theirs.has(cell)).length + [...theirs].filter((cell) => !mine.has(cell)).length;
}

const RULES = ['A1', 'I1', 'I2', 'B4', 'B5', 'F4', 'F5', 'X1', 'X2', 'E1', 'V5', 'V6', 'R5', 'negative', 'other'];

function report(metrics: FilingMetrics[]): string {
  const sum = (pick: (item: FilingMetrics) => number) => metrics.reduce((total, item) => total + pick(item), 0);
  const lines: string[] = [];
  const head = ['filing', 'tbl', 'ocr', 'deliv', 'chk', 'nochk', 'notes', 'drops', 'V6', 'R7', 'unmat', 'deriv', 'ratio', 'A1runs', 'A1unconf', 'A1hidden', 'vs.run', 'score'];
  const drift = (item: FilingMetrics) => (item.recorded.values === null ? 0 : item.delivered + item.notes - item.recorded.values);
  const rows = metrics.map((item) => [
    item.id, item.tables, item.ocrTables, item.delivered, item.checked, item.unchecked, item.notes, item.drops, item.dropsByRule.V6 ?? 0, item.corrections.length, item.unmatchedRows, item.derived, item.ratios,
    item.a1.runs, item.a1.unconfirmedTotals, item.a1.crossColumnFailures, item.recorded.values === null ? '-' : signed(drift(item)),
    item.score ? `${item.score.correct}/${item.score.expected} w${item.score.wrong.length} m${item.score.missing.length}` : '-',
  ].map(String));
  const scored = metrics.filter((item) => item.score);
  rows.push([
    `TOTAL (${metrics.length})`, sum((item) => item.tables), sum((item) => item.ocrTables), sum((item) => item.delivered), sum((item) => item.checked), sum((item) => item.unchecked),
    sum((item) => item.notes), sum((item) => item.drops), sum((item) => item.dropsByRule.V6 ?? 0), sum((item) => item.corrections.length), sum((item) => item.unmatchedRows), sum((item) => item.derived), sum((item) => item.ratios),
    sum((item) => item.a1.runs), sum((item) => item.a1.unconfirmedTotals), sum((item) => item.a1.crossColumnFailures), signed(sum(drift)),
    scored.length ? `${scored.reduce((total, item) => total + item.score!.correct, 0)}/${scored.reduce((total, item) => total + item.score!.expected, 0)} w${scored.reduce((total, item) => total + item.score!.wrong.length, 0)} m${scored.reduce((total, item) => total + item.score!.missing.length, 0)}` : '-',
  ].map(String));
  const widths = head.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
  const line = (cells: string[]) => cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!))).join('  ');
  lines.push(line(head), ...rows.slice(0, -1).map(line), '-'.repeat(widths.reduce((total, width) => total + width + 2, 0)), line(rows.at(-1)!));
  const drops = Object.fromEntries(RULES.map((rule) => [rule, sum((item) => item.dropsByRule[rule] ?? 0)]).filter(([, count]) => count));
  const checks: Record<string, number> = {};
  for (const item of metrics) for (const [family, count] of Object.entries(item.byCheck)) checks[family] = (checks[family] ?? 0) + count;
  lines.push('', 'vs.run: figures delivered now (statements and notes) less those the run itself recorded in validation.json.');
  lines.push(`drops by rule: ${Object.entries(drops).map(([rule, count]) => `${rule} ${count}`).join(', ') || 'none'}`);
  lines.push(`delivered figures carrying each check: ${Object.entries(checks).sort().map(([family, count]) => `${family} ${count}`).join(', ')}`);
  lines.push(`unchecked on OCR pages (V5 should make this 0): ${sum((item) => item.uncheckedOcr)}; A1 mirror mismatches (must be 0): ${sum((item) => item.a1.mirrorMismatches)}`);
  for (const item of scored) {
    for (const wrong of item.score!.wrong) lines.push(`  WRONG ${item.id} ${wrong}`);
    for (const missing of item.score!.missing) lines.push(`  missing ${item.id} ${missing}`);
  }
  return lines.join('\n');
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rebuild = args.includes('--rebuild');
  const [corpusDir, outJson, ...keys] = args.filter((arg) => arg !== '--rebuild');
  if (!corpusDir) {
    console.error('usage: node dist/replay.js [--rebuild] <corpusDir> [outJson] [answerKey.json ...]');
    process.exit(2);
  }
  const answers = await readAnswerKeys(keys.length ? keys : [path.join(ROOT, 'samples', 'hpl-answers.json')]);
  const filings = await findFilings(corpusDir);
  const measured: Array<FilingMetrics | null> = new Array(filings.length).fill(null);
  // A few filings at a time: most of the time is pdftotext over each source.pdf (for notes).
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, filings.length) }, async () => {
      for (let index = next++; index < filings.length; index = next++) {
        measured[index] = await measureFiling(filings[index]!, answers, { rebuild });
        if (!measured[index]) console.error(`skipped ${filings[index]!.id}: ${rebuild ? 'grids, classification or period missing' : 'statements.json unreadable'}`);
      }
    }),
  );
  const metrics = measured.filter((item): item is FilingMetrics => item !== null);
  console.log(report(metrics));
  if (outJson) await writeFile(outJson, JSON.stringify({ corpus: path.resolve(corpusDir), rebuild, filings: metrics }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : 'replay failed');
    process.exit(1);
  });
}
