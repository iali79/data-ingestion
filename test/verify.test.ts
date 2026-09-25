import { describe, expect, it } from 'vitest';
import { verifyStatements } from '../src/pipeline/filing.js';
import { parseFigure, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
import type { Drop } from '../src/pipeline/validate.js';

function row(id: string, label: string, cells: string[]): StatementRow {
  return { id, page: 5, label, cells, values: cells.map(parseFigure), note: null, headings: [], ocr: true };
}

function income(rows: StatementRow[]): StatementTable {
  return {
    statementType: 'income_statement',
    basis: 'unknown',
    pages: [5],
    method: 'docling-ocr',
    title: 'Statement of profit or loss for the year ended June 30, 2025',
    unitScale: 1000,
    unitPrinted: true,
    columns: [
      { index: 0, header: '2025', periodEnd: '2025-06-30', months: 12, kept: true },
      { index: 1, header: '2024', periodEnd: '2024-06-30', months: 12, kept: true },
    ],
    rows,
    problems: [],
  };
}

describe('verify and repair (stage 6b)', () => {
  // Gross profit 4,000 read by OCR as 9,000 in the current column: the gross profit sum and the
  // operating profit sum both fail there, and 4 is the one reading of the 9 that closes both.
  const misread = () => income([
    row('p5.r1', 'Revenue', ['10,000', '9,000']),
    row('p5.r2', 'Cost of sales', ['(6,000)', '(5,500)']),
    row('p5.r3', 'Gross profit', ['9,000', '3,500']),
    row('p5.r4', 'Distribution cost', ['(1,000)', '(900)']),
    row('p5.r5', 'Operating profit', ['3,000', '2,600']),
  ]);

  it('corrects a misread the arithmetic proves, and says so in the checks (R7)', async () => {
    const drops: Drop[] = [];
    const tables = [misread()];
    const verified = await verifyStatements(tables, drops, null);
    expect(verified.corrections).toEqual([expect.objectContaining({ from: 9000, to: 4000, cell: { table: 0, row: 'p5.r3', column: 0 } })]);
    const gross = verified.values.find((value) => value.key === 'gross_profit' && value.periodEnd === '2025-06-30');
    expect(gross?.value).toBe(4_000_000);
    expect(gross?.checks?.at(-1)).toMatch(/^R7 corrected from 9000: digit 9->4/u);
    // Every figure of the current column is now confirmed and delivered.
    expect(verified.values.filter((value) => value.periodEnd === '2025-06-30').map((value) => value.key).sort()).toEqual(['cost_of_sales', 'distribution_cost', 'gross_profit', 'operating_profit', 'revenue']);
    // The input tables are left as read.
    expect(tables[0]!.rows[2]!.values[0]).toBe(9000);
  });

  it('withholds what it cannot prove instead of guessing', async () => {
    // Operating profit misread too (3,000 as 8,000): gross profit 4,000 closes its own sum but not
    // the operating one, and no single or paired plausible reading closes both.
    const table = misread();
    table.rows[4] = row('p5.r5', 'Operating profit', ['8,500', '2,600']);
    const drops: Drop[] = [];
    const verified = await verifyStatements([table], drops, null);
    expect(verified.corrections).toEqual([]);
    // The current column fails I1 and its sums, so none of it is delivered; the comparative column is.
    expect(verified.values.filter((value) => value.periodEnd === '2025-06-30')).toEqual([]);
    expect(verified.values.filter((value) => value.periodEnd === '2024-06-30')).toHaveLength(5);
    expect(verified.unresolved.map((item) => item.constraint)).toContain('A1 t0 p5.r5 c0');
    expect(drops.some((drop) => drop.reason.startsWith('I1'))).toBe(true);
  });

  it('asks for a second reading of the suspect cells only', async () => {
    const asked: string[] = [];
    await verifyStatements([misread()], [], async (_tables, cells) => {
      asked.push(...cells.map((cell) => `${cell.row}:${cell.column}`));
      return new Map();
    });
    expect(asked.every((cell) => cell.endsWith(':0'))).toBe(true);
    expect(asked).toContain('p5.r3:0');
  });
});
