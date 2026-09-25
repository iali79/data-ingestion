import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ReportedValue } from '../src/financials/derive.js';
import { validateStatements } from '../src/pipeline/filing.js';
import { matchRows } from '../src/pipeline/labels.js';
import { parseFigure, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
import { applyChecks, confirmTotals, valuesFromMatches, type Drop } from '../src/pipeline/validate.js';
import { a1Runs, crossColumnFailures, dropRule, findFilings, readAnswerKeys, replayFiling, unconfirmedTotals } from '../src/replay.js';
import { scorePeriods } from '../src/score.js';

function row(id: string, label: string, cells: string[], ocr = false, page = 1): StatementRow {
  return { id, page, label, cells, values: cells.map(parseFigure), note: null, headings: [], ocr };
}

function table(rows: StatementRow[], statementType: StatementTable['statementType'] = 'income_statement', columns = 2): StatementTable {
  const months = statementType === 'balance_sheet' ? 0 : 12;
  return {
    statementType,
    basis: 'unknown',
    pages: [...new Set(rows.map((item) => item.page))],
    method: rows.some((item) => item.ocr) ? 'docling-ocr' : 'docling-pdf',
    title: '',
    unitScale: 1000,
    unitPrinted: true,
    columns: Array.from({ length: columns }, (_, index) => ({ index, header: String(2025 - index), periodEnd: `${2025 - index}-12-31`, months, kept: true })),
    rows,
    problems: [],
  };
}

const income = () =>
  table([
    row('p1.r1', 'Revenue', ['1,000', '900']),
    row('p1.r2', 'Cost of sales', ['(600)', '(500)']),
    row('p1.r3', 'Gross profit', ['400', '400']),
    row('p1.r4', 'Administrative expenses', ['(100)', '(90)']),
    row('p1.r5', 'Profit before taxation', ['300', '310']),
    row('p1.r6', 'Taxation', ['(90)', '(93)']),
    row('p1.r7', 'Profit for the year', ['210', '217']),
    row('p1.r8', 'Some caption no rule knows', ['5', '6']),
  ]);

const balance = () =>
  table(
    [
      row('p2.r1', 'Total current assets', ['700', '650'], false, 2),
      row('p2.r2', 'Total non-current assets', ['300', '250'], false, 2),
      row('p2.r3', 'Total assets', ['1,000', '900'], false, 2),
    ],
    'balance_sheet',
  );

describe('validateStatements (the pure stage 6 production and replay share)', () => {
  it('equals the stage run by hand: rules, arithmetic, values with their cells, then checks on deduplicated values', () => {
    const tables = [balance(), income(), income()];
    const drops: Drop[] = [];
    const { values, summaries } = validateStatements(tables, drops);

    const byHand: ReportedValue[] = [];
    const handDrops: Drop[] = [];
    for (const [index, item] of tables.entries()) {
      const kind = item.statementType === 'balance_sheet' ? 'balance' : 'income';
      byHand.push(...valuesFromMatches(kind, item, matchRows(kind, item.rows).matches, confirmTotals(item), handDrops, index));
    }
    const seen = new Set<string>();
    const deduped = byHand.filter((value) => {
      const key = `${value.statement}|${value.key}|${value.periodEnd}|${value.months}|${value.basis}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
    expect(values).toEqual(applyChecks(deduped, tables, handDrops));
    expect(drops).toEqual(handDrops);

    // The repeated income statement is read once: its figures point at the first copy (table 1).
    expect(values.filter((value) => value.key === 'revenue').map((value) => value.cell)).toEqual([
      { table: 1, row: 'p1.r1', column: 0 },
      { table: 1, row: 'p1.r1', column: 1 },
    ]);
    expect(values.find((value) => value.key === 'total_assets')?.checks).toContain('B4');
    expect(values.find((value) => value.key === 'profit_after_tax' && value.periodEnd === '2025-12-31')?.checks).toEqual(expect.arrayContaining(['I2']));
    expect(summaries.map((summary) => [summary.statementType, summary.matched, summary.unmatched])).toEqual([
      ['balance_sheet', 3, []],
      ['income_statement', 7, ['some caption no rule knows']],
      ['income_statement', 7, ['some caption no rule knows']],
    ]);
  });

  it('drops an OCR figure no check confirms (V6) and records why', () => {
    const drops: Drop[] = [];
    const ocr = table([row('p3.r1', 'Administrative expenses', ['(100)', '(90)'], true, 3)]);
    const { values } = validateStatements([ocr], drops);
    expect(values).toEqual([]);
    expect(drops.map(dropRule)).toEqual(['V6', 'V6']);
  });
});

describe('A1 structure the replay measures', () => {
  it('records the same runs confirmTotals confirms', () => {
    const item = income();
    const runs = a1Runs(item);
    const cells = new Set(runs.flatMap((run) => [run.total, ...run.parts].map((id) => `${id}:${run.column}`)));
    const confirmed = new Set([...confirmTotals(item)].flatMap(([id, columns]) => [...columns.keys()].map((column) => `${id}:${column}`)));
    expect(cells).toEqual(confirmed);
    expect(runs.find((run) => run.total === 'p1.r3' && run.column === 0)?.parts).toEqual(['p1.r1', 'p1.r2']);
  });

  it('finds a run that adds up in one column and not in the other: a hidden misread', () => {
    const item = table([
      row('p1.r1', 'Revenue', ['1,000', '900']),
      row('p1.r2', 'Cost of sales', ['(600)', '(800)']), // printed (500): 5 read as 8
      row('p1.r3', 'Gross profit', ['400', '400']),
    ]);
    const failures = crossColumnFailures(item, a1Runs(item));
    expect(failures).toEqual([{ table: 0, foundIn: 0, column: 1, total: 'p1.r3', parts: ['p1.r1', 'p1.r2'], residual: -300, confirmedOtherwise: false }]);
    expect(unconfirmedTotals(item)).toEqual([{ row: 'p1.r3', column: 1 }]);
  });

  it('does not carry a run whose column leaves the structure open (a nil part, a row empty in that column)', () => {
    const nilPart = table(
      [
        row('p1.r1', 'Loan obtained', ['-', '500']),
        row('p1.r2', 'Dividend paid', ['(100)', '(50)']),
        row('p1.r3', 'Lease paid', ['(20)', '(30)']),
        row('p1.r4', 'Net cash used in financing activities', ['(120)', '420']),
      ],
      'cash_flow',
    );
    // Column 0 closes with the nil loan row inside the run; column 1 needs it: no failure either way.
    expect(crossColumnFailures(nilPart, a1Runs(nilPart))).toEqual([]);
    const emptyInside = table(
      [
        row('p1.r1', 'Dividend paid', ['(100)', '(50)']),
        row('p1.r2', 'Loan obtained', ['', '500']),
        row('p1.r3', 'Lease paid', ['(20)', '(30)']),
        row('p1.r4', 'Net cash used in financing activities', ['(120)', '420']),
      ],
      'cash_flow',
    );
    expect(crossColumnFailures(emptyInside, a1Runs(emptyInside))).toEqual([]);
  });

  it('leaves out columns production does not deliver (the other half of a side-by-side sheet)', () => {
    const item = table([row('p1.r1', 'Revenue', ['1,000', '7']), row('p1.r2', 'Cost of sales', ['(600)', '8']), row('p1.r3', 'Gross profit', ['400', '9'])]);
    item.columns[1]!.kept = false;
    expect(crossColumnFailures(item, a1Runs(item))).toEqual([]);
    expect(unconfirmedTotals(item)).toEqual([]);
  });

  it('counts a total whose own rows do not add up even when a later total takes it as a component', () => {
    const item = table(
      [
        row('p1.r1', 'Revenue', ['1,000']),
        row('p1.r2', 'Cost of sales', ['(600)']),
        row('p1.r3', 'Administrative expenses', ['(150)']), // printed (100)
        row('p1.r4', 'Operating profit', ['300']),
        row('p1.r5', 'Finance cost', ['(50)']),
        row('p1.r6', 'Profit before taxation', ['250']),
      ],
      'income_statement',
      1,
    );
    expect(confirmTotals(item).get('p1.r4')?.get(0)).toBe('A1 sum to p1.r6');
    expect(unconfirmedTotals(item)).toEqual([{ row: 'p1.r4', column: 0 }]);
  });
});

describe('drops, answer keys and scoring', () => {
  it('names the rule of each drop', () => {
    expect(dropRule({ item: 'x', reason: 'I2: profit before tax - taxation = profit after tax does not hold (2025-12-31 12 unknown)' })).toBe('I2');
    expect(dropRule({ item: 'x', reason: 'negative for 2025-12-31' })).toBe('negative');
    expect(dropRule({ item: 'x', reason: 'something else' })).toBe('other');
  });

  const dir = mkdtemp(path.join(tmpdir(), 'replay-test-'));
  afterAll(async () => rm(await dir, { recursive: true, force: true }));

  it('reads both answer key formats and merges them by URL and period', async () => {
    const base = await dir;
    const url = 'https://financials.psx.com.pk/lib/DownloadPDF.php?id=1';
    await writeFile(path.join(base, 'key.json'), JSON.stringify({ _about: 'hand typed', [url]: { 'income|2025-12-31|12': { revenue: 1_000_000 } } }));
    await writeFile(path.join(base, 'export.json'), JSON.stringify({ samples: [], answers: { _about: 'panel', [url]: { 'income|2025-12-31|12': { taxation: 90_000 } } } }));
    const key = await readAnswerKeys([path.join(base, 'key.json'), path.join(base, 'export.json'), path.join(base, 'missing.json')]);
    expect(key).toEqual({ [url]: { 'income|2025-12-31|12': { revenue: 1_000_000, taxation: 90_000 } } });
  });

  it('replays a saved filing from its statements.json and scores it', async () => {
    const base = await dir;
    const filing = path.join(base, 'run-2', 'evaluation-1', 'ABC-1');
    const older = path.join(base, 'run-1', 'evaluation-1', 'ABC-1');
    for (const target of [filing, older]) {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'statements.json'), JSON.stringify({ statements: [], tables: [income()] }));
    }
    const found = await findFilings(base);
    expect(found.map((item) => [item.id, item.run])).toEqual([['ABC-1', 'run-2']]);

    const replayed = await replayFiling(filing);
    expect(replayed?.values.length).toBeGreaterThan(0);
    const score = scorePeriods(replayed!.periods, { 'income|2025-12-31|12': { revenue: 1_000_000, taxation: 90_000, gross_profit: 1 } });
    expect(score.correct).toBe(2);
    expect(score.wrong).toHaveLength(1);
  });
});
