import { describe, expect, it } from 'vitest';
import type { Classification } from '../src/pipeline/classify.js';
import { applyPageHints, applyUnitHint, readHints } from '../src/pipeline/hints.js';
import type { StatementTable } from '../src/pipeline/normalize.js';

function classification(): Classification {
  return {
    pages: [81, 82, 83, 84].map((pageNumber) => ({ pageNumber, class: 'ignore' as const, basis: 'unconsolidated' as const, selected: false, reasons: [] })),
    statements: [
      { statementType: 'balance_sheet', basis: 'unconsolidated', pages: [81] },
      { statementType: 'balance_sheet', basis: 'consolidated', pages: [90] },
      { statementType: 'income_statement', basis: 'unconsolidated', pages: [83] },
    ],
    notes: [{ topic: 'share_capital', basis: 'unconsolidated', pages: [99], number: '16' }],
    selectedPages: [81, 83, 90, 99],
  };
}

function table(unitScale: number, unitPrinted: boolean): StatementTable {
  return { statementType: 'income_statement', basis: 'unknown', pages: [1], method: 'docling-pdf', title: '', unitScale, unitPrinted, columns: [], rows: [], problems: [] };
}

describe('reviewer hints', () => {
  it('reads well-formed hints and ignores malformed ones whole (H0)', () => {
    expect(readHints({ unitScale: 1000, statements: [{ type: 'balance_sheet', pages: [82] }] }, 100)).toEqual({ unitScale: 1000, statements: [{ type: 'balance_sheet', pages: [82] }] });
    expect(readHints(undefined, 100)).toBeNull();
    expect(readHints({ unitScale: 10 }, 100)).toBeNull();
    expect(readHints({ unitScale: 1000, note: 'x' }, 100)).toBeNull();
    expect(readHints({ statements: [{ type: 'balance_sheet', pages: [120] }] }, 100)).toBeNull(); // beyond the document
    expect(readHints({ statements: [{ type: 'balance_sheet', pages: [83, 82] }] }, 100)).toBeNull(); // not ascending
    expect(readHints({ statements: [{ type: 'equity_changes', pages: [82] }] }, 100)).toBeNull();
  });

  it('replaces the classifier pages for the hinted statement and basis only (H2)', () => {
    const hinted = applyPageHints(classification(), { statements: [{ type: 'balance_sheet', pages: [82], basis: 'unconsolidated' }] });
    const balance = hinted.statements.filter((statement) => statement.statementType === 'balance_sheet');
    expect(balance).toEqual([
      { statementType: 'balance_sheet', basis: 'consolidated', pages: [90] },
      { statementType: 'balance_sheet', basis: 'unconsolidated', pages: [82], hinted: true },
    ]);
    expect(hinted.statements.find((statement) => statement.statementType === 'income_statement')?.pages).toEqual([83]);
    expect(hinted.selectedPages).toEqual([82, 83, 90, 99]);
    expect(hinted.pages.find((page) => page.pageNumber === 82)).toMatchObject({ class: 'balance_sheet', selected: true, reasons: ['admin hint: balance sheet'] });
  });

  it('without a basis, replaces the statement type for every basis', () => {
    const hinted = applyPageHints(classification(), { statements: [{ type: 'balance_sheet', pages: [82, 83] }] });
    expect(hinted.statements.filter((statement) => statement.statementType === 'balance_sheet')).toEqual([
      { statementType: 'balance_sheet', basis: 'unconsolidated', pages: [82, 83], hinted: true },
    ]);
  });

  it('leaves the classification alone with no page hints', () => {
    const original = classification();
    expect(applyPageHints(original, { unitScale: 1000 })).toBe(original);
    expect(applyPageHints(original, null)).toBe(original);
  });

  it('puts every statement in the hinted unit and says so (H3)', () => {
    const tables = [table(1, false), table(1000, true), table(1000000, true)];
    applyUnitHint(tables, { unitScale: 1000 });
    expect(tables.map((item) => item.unitScale)).toEqual([1000, 1000, 1000]);
    expect(tables[0]!.problems).toEqual(['unit x1000 from an admin hint (read no printed unit)']);
    expect(tables[1]!.problems).toEqual([]);
    expect(tables[2]!.problems).toEqual(['unit x1000 from an admin hint (read x1000000 as printed)']);
  });
});
