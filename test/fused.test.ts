import { describe, expect, it } from 'vitest';
import { rebuildFromText } from '../src/pipeline/fused.js';
import { buildStatementTable, parseFigure, type StatementRow } from '../src/pipeline/normalize.js';
import type { PageTables, TableCell } from '../src/pipeline/tables.js';

// Real rows and `pdftotext -layout` lines from the Evaluate corpus (stage 5 before rule R4c).

function row(id: string, label: string, cells: string[], headings: string[] = [], page = 1): StatementRow {
  return { id, page, label, cells, values: cells.map(parseFigure), note: null, headings, ocr: false };
}

const text = (lines: string[]) => (page: number) => (page === 1 ? lines.join('\n') : null);
const view = (rows: StatementRow[]) => rows.map((item) => `${item.id} ${item.label} | ${item.cells.join(' | ')}`);

describe('rule R4c: fused rows rebuilt from the text layer', () => {
  it('splits a two-line fusion (ABOT-281852 p.8)', () => {
    const rows = [
      row('p8.r5', 'Export', ['875,685', '1,493,944', '343,890', '1,003,981']),
      row('p8.r6', '', ['38,026,551', '36,407,789', '20,321,829', '19,061,338']),
      row('p8.r7', 'Cost of sales', ['(23,576,445)', '(23,792,889)', '(12,569,531)', '(12,288,344)']),
      row('p8.r8', 'Gross Profit', ['14,450,106', '12,614,900', '7,752,298', '6,772,994']),
      row('p8.r9', 'Selling and distribution expenses', ['(6,145,400)', '(5,527,267)', '(3,227,285)', '(2,805,964)']),
      row('p8.r10', 'Administrative expenses Other charges', ['(776,092) (887,408)', '(638,195) (826,334)', '(395,770) (567,280)', '(335,172) (504,514)']),
      row('p8.r11', 'Other income', ['593,980', '416,745', '364,514', '156,646']),
      row('p8.r12', '', ['(7,214,920)', '(6,575,051)', '(3,825,821)', '(3,489,004)']),
    ];
    const page = [
      '                    Export                                       875,685           1,493,944              343,890            1,003,981',
      '',
      '                                                              38,026,551          36,407,789           20,321,829           19,061,338',
      '',
      '    Cost of sales                                             (23,576,445)        (23,792,889)         (12,569,531)        (12,288,344)',
      '',
      '    Gross Profit                                              14,450,106          12,614,900             7,752,298           6,772,994',
      '',
      '    Selling and distribution expenses                          (6,145,400)         (5,527,267)          (3,227,285)          (2,805,964)',
      '    Administrative expenses                                      (776,092)           (638,195)            (395,770)            (335,172)',
      '    Other charges                                    16          (887,408)           (826,334)            (567,280)            (504,514)',
      '    Other income                                     17           593,980             416,745              364,514              156,646',
      '                                                               (7,214,920)         (6,575,051)          (3,825,821)          (3,489,004)',
    ];
    const result = rebuildFromText(rows, text(page));
    expect(view(result.rows).slice(4, 8)).toEqual([
      'p8.r9 Selling and distribution expenses | (6,145,400) | (5,527,267) | (3,227,285) | (2,805,964)',
      'p8.r10a Administrative expenses | (776,092) | (638,195) | (395,770) | (335,172)',
      'p8.r10b Other charges | (887,408) | (826,334) | (567,280) | (504,514)',
      'p8.r11 Other income | 593,980 | 416,745 | 364,514 | 156,646',
    ]);
    expect(result.rows[6]!.values).toEqual([-887_408, -826_334, -567_280, -504_514]);
    expect(result.rows[6]!.note).toBe('16');
    expect(result.rebuilt.size).toBe(2);
    expect(result.problems).toEqual(['p.1: 1 block(s) of fused or shifted rows re-read from the text layer as 2 rows (R4c)']);
  });

  it('splits a three-line fusion and the shift it leaves below (HASCOL-273630 p.187)', () => {
    const rows = [
      row('p187.r9', 'Distribution and marketing expenses', ['(4,182,326)', '(3,552,176)']),
      row('p187.r10', 'Administrative expenses', ['(957,698)', '(910,619)']),
      row('p187.r11', 'Operating expenses', ['(5,140,024)', '(4,462,795)']),
      row('p187.r12', 'Reversal / (allowance) for expected credit loss on trade debts Other expenses', ['239,634 (73,595) 2,585,341', '(67,111) (2,614,130)']),
      row('p187.r13', 'Other income', ['', '3,246,407']),
      row('p187.r15', '', ['1,195,032', '(553,473)'], ['Operating proft / (loss)']),
      row('p187.r16', 'Finance cost', ['(6,781,482)', '(10,539,875)']),
    ];
    const page = [
      '',
      'Distribution and marketing expenses                                                    34         (4,182,326)         (3,552,176)',
      'Administrative expenses                                                                35           (957,698)           (910,619)',
      'Operating expenses                                                                                (5,140,024)         (4,462,795)',
      '',
      'Reversal / (allowance) for expected credit loss on trade debts                         36            239,634              (67,111)',
      'Other expenses                                                                         37            (73,595)         (2,614,130)',
      'Other income                                                                           38          2,585,341            3,246,407',
      '',
      'Operating proft / (loss)                                                                           1,195,032           (553,473)',
      '',
      'Finance cost                                                                           39         (6,781,482)        (10,539,875)',
    ];
    const result = rebuildFromText(rows, text(page));
    expect(view(result.rows).slice(3)).toEqual([
      'p187.r12a Reversal / (allowance) for expected credit loss on trade debts | 239,634 | (67,111)',
      'p187.r12b Other expenses | (73,595) | (2,614,130)',
      'p187.r12c Other income | 2,585,341 | 3,246,407',
      'p187.r12d Operating proft / (loss) | 1,195,032 | (553,473)',
      'p187.r16 Finance cost | (6,781,482) | (10,539,875)',
    ]);
  });

  it('leaves a fusion alone when the fused cell does not read the lines in their printed order (NAGC-261252 p.45)', () => {
    // The table model read "Deferred tax recognised" (2,005,732) before the FVTOCI line's 5,472,000,
    // though the page prints them the other way round: no run of lines gives those figures in that
    // order, so nothing is rebuilt and the cells stay unreadable.
    const rows = [
      row('p45.r15', 'Profit for the year', ['50,416,692', '77,024,988']),
      row('p45.r18', 'Remeasurement gain / (loss) on defined benefit liability', ['6,916,317', '(12,139,615)'], ['Other comprehensive income', 'Items that will not be reclassified subsequently to profit or loss']),
      row('p45.r19', 'Deferred tax recognised', ['(1,586,880)', '-']),
      row('p45.r20', 'Deferred tax recognised Fair value gain on investment in equity instruments designated at FVTOCI', ['(2,005,732) 5,472,000', '- 108,644,099']),
      row('p45.r21', '', ['8,795,705', '96,504,484']),
      row('p45.r22', 'Total comprehensive income for the year', ['59,212,397', '173,529,472']),
    ];
    const page = [
      'Profit for the year                                                                           50,416,692         77,024,988',
      '',
      'Other comprehensive income',
      '',
      'Items that will not be reclassified subsequently to profit or loss',
      '',
      'Remeasurement gain / (loss) on defined benefit liability                       9.4              6,916,317        (12,139,615)',
      'Deferred tax recognised                                                         8              (1,586,880)               -',
      '',
      'Fair value gain on investment in equity instruments',
      'designated at FVTOCI                                                          25.5              5,472,000       108,644,099',
      'Deferred tax recognised                                                        8               (2,005,732)              -',
      '',
      '                                                                                               8,795,705         96,504,484',
      '',
      'Total comprehensive income for the year                                                       59,212,397        173,529,472',
    ];
    const result = rebuildFromText(rows, text(page));
    expect(result.rows).toEqual(rows);
    expect(result.rebuilt.size).toBe(0);
    expect(result.rows[3]!.values).toEqual([null, null]);
  });

  it('realigns a column shifted by one row, keeping the row ids (AGIC-281903 p.17)', () => {
    const rows = [
      row('p17.r33', 'Equity transactions cost paid', ['(1,489)', '-']),
      row('p17.r34', 'Total cash used in financing activities', ['(279,109)', '(334,866)']),
      row('p17.r35', 'Net cash (used in)/generated from all activities', ['(207,633)', '2,465']),
      row('p17.r36', 'Cash and cash equivalents at beginning of the period', ['824,247', '430,664 433,129']),
      row('p17.r37', 'Cash and cash equivalents at end of the period', ['616,614', '']),
    ];
    const page = [
      '       Equity transactions cost paid                                                                           (1,489)                              -',
      ' Total cash used in financing activities                                                                   (279,109)                       (334,866)',
      ' Net cash (used in)/generated from all activities                                                            (207,633)                         2,465',
      ' Cash and cash equivalents at beginning of the period                                                        824,247                         430,664',
      ' Cash and cash equivalents at end of the period                                                              616,614                         433,129',
      ' The annexed notes 1 to 26 form an integral part of these unconsolidated financial statements.',
    ];
    const result = rebuildFromText(rows, text(page));
    expect(view(result.rows).slice(3)).toEqual([
      'p17.r36 Cash and cash equivalents at beginning of the period | 824,247 | 430,664',
      'p17.r37 Cash and cash equivalents at end of the period | 616,614 | 433,129',
    ]);
  });

  it('rebuilds a fused row and the shifted rows after it (HPL-236018 p.13)', () => {
    const rows = [
      row('p13.r31', 'Cash generated from operations', ['1,009,904', '3,407,616']),
      row('p13.r32', 'Finance costs paid', ['(62,075)', '(126,456)']),
      row('p13.r33', 'Interest received', ['2,094', '9,644']),
      row('p13.r34', 'Minimum tax differential paid Final tax paid', ['(177,076) (19,904)', '(212,781) (2,904)']),
      row('p13.r35', 'Income tax paid', ['(263,920)', '(155,690)']),
      row('p13.r37', 'Retirement benefits paid Long-term loans', ['(3,713)', '- (904)']),
      row('p13.r38', 'Long-term deposits', ['283 (11,463)', '-']),
      row('p13.r39', 'Net cash generated from operating activities', ['474,130', '2,918,525']),
    ];
    const page = [
      '  Cash generated from operations                                                                              1,009,904               3,407,616',
      '   Finance costs paid                                                                                            (62,075)              (126,456)',
      '   Interest received                                                                                               2,094                  9,644',
      '   Minimum tax differential paid                                                                                (177,076)              (212,781)',
      '   Final tax paid                                                                                                (19,904)                (2,904)',
      '   Income tax paid                                                                                              (263,920)              (155,690)',
      '   Retirement benefits paid                                                                                       (3,713)                   -',
      '   Long-term loans                                                                                                   283                   (904)',
      '   Long-term deposits                                                                                            (11,463)                   -',
      '  Net cash generated from operating activities                                                                   474,130              2,918,525',
    ];
    const result = rebuildFromText(rows, text(page));
    expect(view(result.rows).slice(3)).toEqual([
      'p13.r34a Minimum tax differential paid | (177,076) | (212,781)',
      'p13.r34b Final tax paid | (19,904) | (2,904)',
      'p13.r35 Income tax paid | (263,920) | (155,690)',
      'p13.r37a Retirement benefits paid | (3,713) | -',
      'p13.r37b Long-term loans | 283 | (904)',
      'p13.r37c Long-term deposits | (11,463) | -',
      'p13.r39 Net cash generated from operating activities | 474,130 | 2,918,525',
    ]);
  });

  it('reads nothing from a page without a text layer', () => {
    const rows = [row('p8.r10', 'Administrative expenses Other charges', ['(776,092) (887,408)', '(638,195) (826,334)'])];
    expect(rebuildFromText(rows, () => null).rows).toEqual(rows);
  });
});

describe('rule R4b on a scanned page: a fused row split from its own cells (ASHT-261320 p.27)', () => {
  const cell = (r: number, c: number, text: string, extra: Partial<TableCell> = {}): TableCell => ({ row: r, col: c, rowSpan: 1, colSpan: 1, text, columnHeader: false, rowHeader: false, rowSection: false, ...extra });
  const grid = (method: PageTables['method']): PageTables => ({
    pageNumber: 27,
    method,
    width: 612,
    height: 792,
    texts: [{ label: 'section_header', text: 'STATEMENT OF FINANCIAL POSITION AS AT JUNE 30, 2025', bbox: [60, 40, 400, 60] }],
    tables: [
      {
        bbox: [50, 80, 560, 400],
        rows: 8,
        cols: 3,
        cells: [
          cell(0, 1, '2025 Rupees', { columnHeader: true }),
          cell(0, 2, '2024 Rupees', { columnHeader: true }),
          cell(1, 0, 'Property, plant and equipment Long term security deposits'),
          cell(1, 1, '999,451,152 4,509,782 1,003,960,934'),
          cell(1, 2, '1,016,484,388 4,509,782 1,020,994,170'),
          cell(2, 0, 'Trade debts'),
          cell(2, 1, '124,711,116'),
          cell(2, 2, '5,318,913'),
          cell(3, 0, 'Stores, spares and loose tools Contract costs'),
          cell(3, 1, '31,827,426 8,698,157'),
          cell(3, 2, '38,608,254 98,116,586'),
          cell(4, 0, 'Other receivables Tax refunds due from Government'),
          cell(4, 1, '517,912 47,316,533'),
          cell(4, 2, '47,383'),
          cell(5, 0, 'Loans and advances'),
          cell(5, 1, '30,940,593'),
          cell(5, 2, '32,006,723'),
          cell(6, 0, 'Prepayments'),
          cell(6, 1, '6,279,529'),
          cell(6, 2, '5,881,753'),
          cell(7, 0, 'Cash and bank balances'),
          cell(7, 1, '21,719,190'),
          cell(7, 2, '17,988,034'),
        ],
      },
    ],
  });
  const build = (method: PageTables['method']) =>
    buildStatementTable({ statementType: 'balance_sheet', basis: 'unknown', pages: [27] }, [grid(method)], { periodEnded: '2025-06-30', yearEndMonthDay: '-06-30' }, () => null).rows;

  it('splits a row whose cells hold two figures each and whose caption has exactly one place a caption can start', () => {
    const rows = build('docling-ocr');
    expect(view(rows)).toEqual([
      // Three figures, two captions: the third line is an uncaptioned total, so the split is not known.
      'p27.r1 Property, plant and equipment Long term security deposits | 999,451,152 4,509,782 1,003,960,934 | 1,016,484,388 4,509,782 1,020,994,170',
      'p27.r2 Trade debts | 124,711,116 | 5,318,913',
      'p27.r3 Stores, spares and loose tools | 31,827,426 | 38,608,254',
      'p27.r3b Contract costs | 8,698,157 | 98,116,586',
      // One column holds a single figure: which line it belongs to is not known.
      'p27.r4 Other receivables Tax refunds due from Government | 517,912 47,316,533 | 47,383',
      'p27.r5 Loans and advances | 30,940,593 | 32,006,723',
      'p27.r6 Prepayments | 6,279,529 | 5,881,753',
      'p27.r7 Cash and bank balances | 21,719,190 | 17,988,034',
    ]);
    expect(rows[3]!.values).toEqual([8_698_157, 98_116_586]);
  });

  it('never splits from the cells alone on a page read from its text layer', () => {
    expect(build('docling-pdf').map((item) => item.id)).toEqual(['p27.r1', 'p27.r2', 'p27.r3', 'p27.r4', 'p27.r5', 'p27.r6', 'p27.r7']);
  });
});
