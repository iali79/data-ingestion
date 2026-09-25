import { describe, expect, it } from 'vitest';
import type { StatementType } from '../src/parser.js';
import { cellKey, type CellRef, type Constraint, type Reading } from '../src/pipeline/constraint-types.js';
import { parseFigure, type StatementTable } from '../src/pipeline/normalize.js';
import { applyCorrections, misreadCandidates, repairCells } from '../src/pipeline/repair.js';

/** A one-column statement table from [row id, label, printed cell] triples, parsed as normalize does. */
function table(statementType: StatementType, rows: Array<[string, string, string]>, unitScale = 1000): StatementTable {
  return {
    statementType,
    basis: 'unconsolidated',
    pages: [1],
    method: 'docling-ocr',
    title: statementType,
    unitScale,
    unitPrinted: true,
    columns: [{ index: 0, header: '2025', periodEnd: '2025-06-30', months: 12, kept: true }],
    rows: rows.map(([id, label, cell]) => ({ id, page: 1, label, cells: [cell], values: [parseFigure(cell)], note: null, headings: [], ocr: true })),
    problems: [],
  };
}

const at = (tableIndex: number, row: string): CellRef => ({ table: tableIndex, row, column: 0 });

/** parts - total = 0, tolerance one printed unit (1,000 rupees). */
function sum(id: string, parts: CellRef[], total: CellRef, options: { tolerance?: number; advisory?: boolean; rule?: string } = {}): Constraint {
  return {
    rule: options.rule ?? id.split(' ')[0]!,
    id,
    terms: [...parts.map((cell) => ({ cell, sign: 1 as const, scale: 1000 })), { cell: total, sign: -1 as const, scale: 1000 }],
    tolerance: options.tolerance ?? 1000,
    text: id,
    ...(options.advisory ? { advisory: true } : {}),
  };
}

/**
 * Balance sheet (table 0) and its note (table 1). Printed truth: 1,250,000 + 420,113 + 85,337 =
 * 1,755,450 = equity 900,000 + liabilities 855,450; the note's stock in trade is 420,113.
 */
function balance(cells: Partial<Record<'ppe' | 'stock' | 'cash' | 'total' | 'noteStock', string>> = {}): StatementTable[] {
  return [
    table('balance_sheet', [
      ['ppe', 'Property, plant and equipment', cells.ppe ?? '1,250,000'],
      ['stock', 'Stock in trade', cells.stock ?? '420,113'],
      ['cash', 'Cash and bank balances', cells.cash ?? '85,337'],
      ['total', 'Total assets', cells.total ?? '1,755,450'],
      ['equity', 'Total equity', '900,000'],
      ['liabilities', 'Total liabilities', '855,450'],
    ]),
    table('balance_sheet', [['noteStock', 'Stock in trade (note 9)', cells.noteStock ?? '420,113']]),
  ];
}

const A1 = sum('A1 t0 total', [at(0, 'ppe'), at(0, 'stock'), at(0, 'cash')], at(0, 'total'));
const I1 = sum('I1 assets = equity + liabilities', [at(0, 'equity'), at(0, 'liabilities')], at(0, 'total'));
const TIE = sum('X9 stock = note 9', [at(1, 'noteStock')], at(0, 'stock'));
const none = new Map<string, Reading[]>();

describe('R7a misread candidates', () => {
  const values = (raw: string, value = parseFigure(raw)) => misreadCandidates(raw, value);

  it('offers single-digit confusions, a sign flip, transpositions and comma/period swaps, never the value as read', () => {
    const found = values('1,354');
    expect(found.find((item) => item.value === 1854)?.how).toContain('digit 3->8 at position 2');
    expect(found.find((item) => item.value === -1354)?.how).toBe('sign (lost bracket)');
    expect(found.find((item) => item.value === 1534)?.how).toContain('transposed 3,5 at positions 2-3');
    expect(found.find((item) => item.value === 1.354)?.how).toBe('period read as comma');
    expect(found.some((item) => item.value === 1354)).toBe(false);
    expect(values('(17,086)').find((item) => item.value === 17086)?.how).toBe('sign (spurious bracket)');
  });

  it('reads the corpus shapes of unreadable cells: noise, a period in a digit group, a lost digit, glyphs, fused figures', () => {
    // All five are Docling OCR cell texts from the evaluation corpus.
    expect(values('~~ 426,532', null).find((item) => item.value === 426532)?.how).toBe("noise stripped from '~~ 426,532'");
    expect(values('~"3.791,254', null).find((item) => item.value === 3791254)?.how).toContain('comma read as period');
    const lost = values('149,95;', null).filter((item) => item.how.startsWith('dropped digit')).map((item) => item.value);
    expect(lost).toEqual(expect.arrayContaining([149950, 149955, 149959, 149095, 149905]));
    expect(values('~$71,104', null).find((item) => item.value === 571104)?.how).toBe("glyph '$'->5 at position 1");
    const fused = values('~ 582,444 2444', null);
    expect(fused.find((item) => item.value === 582444)?.how).toContain("figure 1 of 2 fused in '~ 582,444 2444'");
    expect(fused.find((item) => item.value === 2444)?.how).toContain('figure 2 of 2');
  });

  it('never turns a lone letter into a number', () => {
    expect(values('z', null)).toEqual([]);
    expect(values('Sei.', null)).toEqual([]);
  });
});

describe('R7 repair', () => {
  it('repairs a digit confusion exposed by the column total and an identity', () => {
    const tables = balance({ total: '1,755,950' });
    const result = repairCells(tables, [A1, I1, TIE], none);
    expect(result.unresolved).toEqual([]);
    expect(result.corrections).toEqual([
      { cell: at(0, 'total'), from: 1755950, to: 1755450, how: 'digit 9->4 at position 5', proof: ['A1 t0 total', 'I1 assets = equity + liabilities'] },
    ]);
  });

  it('does not repair a misread covered by one constraint alone, unless a re-read agrees', () => {
    // 420,113 read as 420,118. Only A1 covers the stock row; 85,337 -> 85,332 (7->2) would fit A1 just as well.
    const tables = balance({ stock: '420,118' });
    const alone = repairCells(tables, [A1, I1], none);
    expect(alone.corrections).toEqual([]);
    expect(alone.unresolved).toHaveLength(1);
    expect(alone.unresolved[0]!.constraint).toBe('A1 t0 total');
    expect(alone.unresolved[0]!.reason).toMatch(/supported only by A1 t0 total/u);

    const reread = new Map([[cellKey(at(0, 'stock')), [{ value: 420113, source: 'ocr-300' as const, text: '420,113' }]]]);
    const backed = repairCells(tables, [A1, I1], reread);
    expect(backed.unresolved).toEqual([]);
    expect(backed.corrections).toHaveLength(1);
    expect(backed.corrections[0]).toMatchObject({ cell: at(0, 'stock'), from: 420118, to: 420113, proof: ['A1 t0 total'] });
    expect(backed.corrections[0]!.how).toBe("digit 8->3 at position 6; reread ocr-300 '420,113'");
  });

  it('fixes a lost bracket on a cash flow total', () => {
    const tables = [
      table('cash_flow', [
        ['op', 'Net cash generated from operating activities', '512,400'],
        ['capex', 'Fixed capital expenditure', '(300,120)'],
        ['disposal', 'Proceeds from disposal', '12,500'],
        ['inv', 'Net cash used in investing activities', '287,620'],
        ['fin', 'Net cash used in financing activities', '(100,000)'],
        ['change', 'Net increase in cash and cash equivalents', '124,780'],
      ]),
    ];
    const section = sum('A1 investing', [at(0, 'capex'), at(0, 'disposal')], at(0, 'inv'));
    const f4 = sum('F4 sections = change', [at(0, 'op'), at(0, 'inv'), at(0, 'fin')], at(0, 'change'));
    const result = repairCells(tables, [section, f4], none);
    expect(result.unresolved).toEqual([]);
    expect(result.corrections).toEqual([{ cell: at(0, 'inv'), from: 287620, to: -287620, how: 'sign (lost bracket)', proof: ['A1 investing', 'F4 sections = change'] }]);
  });

  it('reports two plausible values for one cell as ambiguous and changes nothing', () => {
    // 1,755,458 read as 1,755,453: 3->8 and 3->5 both land within three units of rounding.
    const tables = balance({ cash: '85,345', total: '1,755,453', noteStock: '420,113' });
    tables[0]!.rows.find((row) => row.id === 'liabilities')!.cells = ['855,458'];
    tables[0]!.rows.find((row) => row.id === 'liabilities')!.values = [855458];
    const loose = { tolerance: 3000 };
    const a1 = sum('A1 t0 total', [at(0, 'ppe'), at(0, 'stock'), at(0, 'cash')], at(0, 'total'), loose);
    const i1 = sum('I1 assets = equity + liabilities', [at(0, 'equity'), at(0, 'liabilities')], at(0, 'total'), loose);
    const result = repairCells(tables, [a1, i1], none);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved.map((item) => item.constraint)).toEqual(['A1 t0 total', 'I1 assets = equity + liabilities']);
    expect(result.unresolved[0]!.reason).toBe('ambiguous (R7d): 0:total:0 -> 1755455 (digit 3->5 at position 7) or 0:total:0 -> 1755458 (digit 3->8 at position 7)');
  });

  it('reports two different cells that each have an agreeing re-read as ambiguous', () => {
    const tables = balance({ stock: '420,118' });
    const readings = new Map<string, Reading[]>([
      [cellKey(at(0, 'stock')), [{ value: 420113, source: 'ocr-300', text: '420,113' }]],
      [cellKey(at(0, 'cash')), [{ value: 85332, source: 'ocr-digits', text: '85,332' }]],
    ]);
    const result = repairCells(tables, [A1, I1], readings);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved[0]!.reason).toMatch(/^ambiguous/u);
  });

  it('rejects a candidate that would break a constraint that held before', () => {
    // The total also ties to a figure elsewhere that reads 1,755,950 and holds: fixing it would break that tie.
    const tables = [...balance({ total: '1,755,950' }), table('balance_sheet', [['summary', 'Total assets (summary)', '1,755,950']])];
    const tie = sum('X9 total = summary', [at(2, 'summary')], at(0, 'total'));
    const result = repairCells(tables, [A1, I1, tie], none);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved.map((item) => item.constraint)).toEqual(['A1 t0 total', 'I1 assets = equity + liabilities']);
    expect(result.unresolved[0]!.reason).toMatch(/breaks X9 total = summary \(R7c\)/u);
  });

  it('never corrects a cell whose pdftotext re-read confirms the first reading', () => {
    const tables = balance({ total: '1,755,950' });
    const readings = new Map([[cellKey(at(0, 'total')), [{ value: 1755950, source: 'pdftotext' as const, text: '1,755,950' }]]]);
    const result = repairCells(tables, [A1, I1], readings);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved[0]!.reason).toMatch(/R7f/u);
  });

  it('fills an unreadable cell that two constraints determine', () => {
    const tables = balance({ stock: '<' });
    expect(tables[0]!.rows[1]!.values[0]).toBeNull();
    const result = repairCells(tables, [A1, I1, TIE], none);
    expect(result.unresolved).toEqual([]);
    expect(result.corrections).toEqual([
      { cell: at(0, 'stock'), from: null, to: 420113, how: "unreadable '<', solved from A1 t0 total, X9 stock = note 9", proof: ['A1 t0 total', 'X9 stock = note 9'] },
    ]);
  });

  it('reads an unreadable cell from its own text when the text holds the figure', () => {
    // "~$71,104" is 571,104 with a dollar sign for the 5.
    const tables = balance({ stock: '~$71,104', total: '1,906,441', noteStock: '571,104' });
    tables[0]!.rows.find((row) => row.id === 'liabilities')!.cells = ['1,006,441'];
    tables[0]!.rows.find((row) => row.id === 'liabilities')!.values = [1006441];
    const result = repairCells(tables, [A1, I1, TIE], none);
    expect(result.unresolved).toEqual([]);
    expect(result.corrections).toEqual([{ cell: at(0, 'stock'), from: null, to: 571104, how: "glyph '$'->5 at position 1", proof: ['A1 t0 total', 'X9 stock = note 9'] }]);
  });

  it('leaves an unreadable cell alone when only one constraint determines it', () => {
    const result = repairCells(balance({ stock: '<' }), [A1, I1], none);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved.map((item) => item.constraint)).toEqual(['A1 t0 total']);
  });

  it('never lets an advisory constraint drive or prove a repair', () => {
    const tables = balance({ stock: '420,118' });
    const advisoryTie = { ...TIE, id: 'X1 stock = note 9 (advisory)', advisory: true };
    // A failing advisory constraint on its own seeds nothing.
    expect(repairCells(tables, [advisoryTie], none)).toEqual({ corrections: [], unresolved: [] });
    // Nor does it count as the second witness beside A1.
    const result = repairCells(tables, [A1, I1, advisoryTie], none);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved.map((item) => item.constraint)).toEqual(['A1 t0 total']);
  });

  it('repairs two misread cells in one cluster when no single cell explains it', () => {
    // Stock 420,113 read as 420,118 and the total 1,755,450 read as 1,755,950.
    const tables = balance({ stock: '420,118', total: '1,755,950' });
    const result = repairCells(tables, [A1, I1, TIE], none);
    expect(result.unresolved).toEqual([]);
    expect(result.corrections).toEqual([
      { cell: at(0, 'stock'), from: 420118, to: 420113, how: 'digit 8->3 at position 6', proof: ['A1 t0 total', 'X9 stock = note 9'] },
      { cell: at(0, 'total'), from: 1755950, to: 1755450, how: 'digit 9->4 at position 5', proof: ['A1 t0 total', 'I1 assets = equity + liabilities'] },
    ]);
  });

  it('does not accept a pair solved from exactly two equations', () => {
    // Stock and total both wrong, but only A1 and the note tie see them: two unknowns, two equations.
    const tables = balance({ stock: '420,118', total: '1,755,950' });
    const result = repairCells(tables, [A1, TIE], none);
    expect(result.corrections).toEqual([]);
    expect(result.unresolved.map((item) => item.constraint)).toEqual(['A1 t0 total', 'X9 stock = note 9']);
  });

  it('is deterministic and leaves its input untouched', () => {
    const tables = balance({ stock: '420,118', total: '1,755,950' });
    const snapshot = JSON.stringify(tables);
    const readingsA = new Map<string, Reading[]>([
      [cellKey(at(0, 'cash')), [{ value: 85337, source: 'ocr-300', text: '85,337' }]],
      [cellKey(at(0, 'ppe')), [{ value: 1250000, source: 'pdftotext', text: '1,250,000' }]],
    ]);
    const readingsB = new Map([...readingsA].reverse());
    const first = repairCells(tables, [A1, I1, TIE], readingsA);
    const second = repairCells(tables, [A1, I1, TIE], readingsB);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(tables)).toBe(snapshot);

    const repaired = applyCorrections(tables, first.corrections);
    expect(JSON.stringify(tables)).toBe(snapshot);
    const stock = repaired[0]!.rows.find((row) => row.id === 'stock')!;
    expect(stock.values).toEqual([420113]);
    expect(stock.cells).toEqual(['420,118']);
    expect(stock.repaired).toEqual({ 0: { from: 420118, how: 'digit 8->3 at position 6' } });
    expect(repaired[0]!.rows.find((row) => row.id === 'cash')!.repaired).toBeUndefined();
  });
});
