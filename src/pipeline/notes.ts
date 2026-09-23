import type { ReportedValue } from '../financials/derive.js';
import type { DocumentAnalysis } from './analyse.js';
import type { SelectedNote } from './classify.js';
import { normalizeLabel } from './labels.js';
import { columnLayout, parseFigure, toGrid, type StatementTable } from './normalize.js';
import type { Drop } from './validate.js';
import type { PageTables } from './tables.js';

/**
 * Note readers: items the face of the statements does not print, read from the notes the
 * classifier kept, and delivered only when they reconcile with the statements.
 *
 * - Inventory split (stock-in-trade note): raw and packing material, work-in-process, finished
 *   goods -- each the net figure of its group. Delivered only when the note's top-level lines add
 *   up to the note total (A1) and that total equals the balance sheet's stock-in-trade (X2).
 * - Par value (share capital note text: "ordinary shares of Rs. 10 each"). The share count is then
 *   derived as share capital / par value, with its formula.
 */
interface NoteRow {
  label: string;
  values: Array<number | null>;
}

const INVENTORY_PARTS: Array<[string, RegExp]> = [
  ['inventory_raw_materials', /^raw(?: and packing)? materials?\b|^packing materials?\b|^raw materials? and (?:packing|components)/u],
  ['inventory_work_in_progress', /^work[- ]in[- ](?:process|progress)\b/u],
  ['inventory_finished_goods', /^finished goods\b/u],
];
const STOCK_HEADING = /^(?:\d{1,2}(?:\.\d{1,2})?\.?\s+)?(?:stock[- ]in[- ]trade|inventor(?:y|ies))\b/u;
const NEXT_NOTE = /^\d{1,2}(?:\.\d{1,2})?\.?\s+[a-z]/u;

export function readNotes(
  notes: SelectedNote[],
  pages: PageTables[],
  analysis: DocumentAnalysis,
  statements: StatementTable[],
  values: ReportedValue[],
  drops: Drop[],
): ReportedValue[] {
  const out: ReportedValue[] = [];
  for (const note of notes.filter((item) => item.topic === 'stock_in_trade')) {
    const balance = statements.find((table) => table.statementType === 'balance_sheet' && table.basis === note.basis);
    if (!balance) continue;
    out.push(...readInventory(note, pages, balance, values, drops));
  }
  out.push(...parValue(analysis, values));
  return out;
}

function readInventory(note: SelectedNote, pages: PageTables[], balance: StatementTable, values: ReportedValue[], drops: Drop[]): ReportedValue[] {
  for (const pageNumber of note.pages) {
    const page = pages.find((item) => item.pageNumber === pageNumber);
    if (!page) continue;
    for (const table of page.tables) {
      const grid = toGrid(table);
      const layout = columnLayout(grid);
      if (layout.values.length === 0) continue;
      const rows: NoteRow[] = [];
      for (let r = 0; r < grid.rows; r++) {
        // The note number may sit in its own column; the heading text in the label column.
        const label = normalizeLabel([...Array(grid.cols).keys()].filter((col) => !layout.values.includes(col)).map((col) => grid.cell(r, col)).join(' '));
        rows.push({ label, values: layout.values.map((col) => parseFigure(grid.cell(r, col).trim())) });
      }
      const start = rows.findIndex((row) => STOCK_HEADING.test(row.label) && row.values.every((value) => value === null));
      if (start < 0) continue;
      const end = rows.findIndex((row, index) => index > start && NEXT_NOTE.test(row.label));
      const section = rows.slice(start + 1, end < 0 ? rows.length : end);
      // Years over the value columns: in the header, or in the first rows ("2023  2022").
      const headerYears = layout.values.map((col) => {
        const texts = [grid.header(col), ...Array.from({ length: Math.min(grid.rows, 3) }, (_, r) => grid.cell(r, col))];
        return texts.map((text) => /\b((?:19|20)\d{2})\b/u.exec(text)?.[1]).find(Boolean) ?? null;
      });
      return reconcile(section, headerYears, note, balance, values, drops, pageNumber);
    }
  }
  return [];
}

/**
 * Top-level lines of the section: a heading with lines under it closed by an uncaptioned total is
 * one line (its total); a labelled line with figures is one line; the last uncaptioned total with
 * no open group is the section total.
 */
function reconcile(
  section: NoteRow[],
  headerYears: Array<string | null>,
  note: SelectedNote,
  balance: StatementTable,
  values: ReportedValue[],
  drops: Drop[],
  page: number,
): ReportedValue[] {
  const lines: Array<{ label: string; values: Array<number | null> }> = [];
  let group: string | null = null;
  let total: Array<number | null> | null = null;
  for (const row of section) {
    const empty = row.values.every((value) => value === null);
    if (row.label && empty) {
      group = row.label;
      continue;
    }
    if (!row.label && !empty) {
      if (group) {
        lines.push({ label: group, values: row.values });
        group = null;
      } else total = row.values;
      continue;
    }
    if (row.label && !empty && !group) lines.push(row);
  }
  if (!total || lines.length < 2) return [];

  const out: ReportedValue[] = [];
  for (const [position, year] of headerYears.entries()) {
    // The note's column is the balance sheet column for the same year (same order as printed).
    const column = balance.columns.filter((item) => item.kept && item.periodEnd)[position];
    if (!column?.periodEnd || !year || column.periodEnd.slice(0, 4) !== year) continue;
    const printed = total[position];
    const parts = lines.map((line) => line.values[position]);
    if (printed === null || printed === undefined || parts.some((part) => part === null || part === undefined)) continue;
    const sum = parts.reduce((acc, part) => acc! + part!, 0)!;
    const stock = values.find((value) => value.key === 'total_inventory' && value.basis === balance.basis && value.periodEnd === column.periodEnd);
    const scaled = printed * balance.unitScale;
    if (Math.abs(sum - printed) > 0.5 * parts.length + 0.5) {
      drops.push({ item: 'inventory split', reason: `A1: note ${note.number} lines do not add up to its total (${column.periodEnd})` });
      continue;
    }
    if (!stock || Math.abs(stock.value - scaled) > balance.unitScale) {
      drops.push({ item: 'inventory split', reason: `X2: note ${note.number} total does not equal the balance sheet's stock-in-trade (${column.periodEnd})` });
      continue;
    }
    for (const [item, pattern] of INVENTORY_PARTS) {
      const line = lines.find((candidate) => pattern.test(candidate.label));
      const value = line?.values[position];
      if (!line || value === null || value === undefined) continue;
      out.push({
        statement: 'balance',
        key: item,
        periodEnd: column.periodEnd,
        months: 0,
        basis: balance.basis,
        value: value * balance.unitScale,
        page,
        text: `note ${note.number}: ${line.label} | ${line.values.map((v) => (v === null ? '' : v.toLocaleString('en-US'))).join(' | ')}`,
        checks: ['A1 note total', 'X2 equals balance sheet stock-in-trade'],
      });
    }
  }
  return out;
}

/**
 * Face value of one ordinary share, from the share capital note ("Ordinary shares of Rs. 10/-
 * each"), matched deterministically with its printed line, applied to each balance-sheet date and
 * basis of the filing. A filing states one face value for all of them.
 */
function parValue(analysis: DocumentAnalysis, values: ReportedValue[]): ReportedValue[] {
  const pattern = /ordinary\s+shares\s+of\s+(?:rs\.?|pkr|rupees)\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:\/-)?\s*each/iu;
  for (const page of analysis.pages) {
    if (page.kind !== 'native') continue;
    const line = page.text.split('\n').find((text) => pattern.test(text));
    if (!line) continue;
    const par = Number(pattern.exec(line)![1]);
    if (!(par > 0)) return [];
    const dates = new Map<string, ReportedValue>();
    for (const value of values) if (value.statement === 'balance') dates.set(`${value.periodEnd}|${value.basis}`, value);
    return [...dates.values()].map((value) => ({
      statement: 'balance' as const,
      key: 'par_value_per_share',
      periodEnd: value.periodEnd,
      months: 0,
      basis: value.basis,
      value: par,
      page: page.pageNumber,
      text: line.replace(/\s+/gu, ' ').trim().slice(0, 300),
    }));
  }
  return [];
}
