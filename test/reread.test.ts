import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/extraction.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/extraction.js')>()), runCommand: vi.fn() }));

import { DocumentExtractionError } from '../src/errors.js';
import { runCommand } from '../src/extraction.js';
import type { DocumentAnalysis, PageAnalysis } from '../src/pipeline/analyse.js';
import { parseFigure, type StatementRow, type StatementTable } from '../src/pipeline/normalize.js';
import { readRowsFromOcr, readRowsFromText, rereadCells } from '../src/pipeline/reread.js';

const mockedRun = vi.mocked(runCommand);

function row(id: string, label: string, cells: string[], ocr = false): StatementRow {
  return { id, page: Number(/^p(\d+)/u.exec(id)![1]), label, cells, values: cells.map(parseFigure), note: null, headings: [], ocr };
}

function table(rows: StatementRow[]): StatementTable {
  return {
    statementType: 'balance_sheet',
    basis: 'unconsolidated',
    pages: [...new Set(rows.map((item) => item.page))],
    method: rows.some((item) => item.ocr) ? 'docling-ocr' : 'docling-pdf',
    title: '',
    unitScale: 1,
    unitPrinted: false,
    columns: rows[0]!.cells.map((_, index) => ({ index, header: '', periodEnd: null, months: null, kept: true })),
    rows,
    problems: [],
  };
}

function page(pageNumber: number, text: string, kind: PageAnalysis['kind']): PageAnalysis {
  return { pageNumber, kind, text, overlay: '', textSource: kind === 'native' ? 'pdftotext' : 'ocr-strip', chars: text.length, imageCoverage: kind === 'scanned' ? 1 : 0, width: 612, height: 792 };
}

/** Readings per row id, as printed, for comparison. */
function read(text: string, rows: StatementRow[]): Record<string, Array<string | null>> {
  return Object.fromEntries(readRowsFromText(text, rows));
}

// Real `pdftotext -layout` text from filings in the evaluation corpus (trimmed; tabs as spaces).

const ABOT_P106 = [
  "                                                  Note    2025              2024",
  "                                                         …….… (Rupees '000) ……….",
  "EQUITY AND LIABILITIES",
  "",
  "SHARE CAPITAL AND RESERVES",
  "",
  "Authorised capital                                 3      2,000,000     2,000,000",
  "",
  "Issued, subscribed and paid-up capital             4       979,003       979,003",
  "Reserves - capital                                        2,073,901     1,750,481",
  "            - revenue                                    28,572,553    20,995,152",
  "Total equity                                             31,625,457    23,724,636",
  "",
  "NON-CURRENT LIABILITIES",
  "",
  "Deferred taxation - net                            5       989,965      1,052,587",
  "Staff retirement benefits                          6       494,943      1,184,179",
  "Lease liabilities                                  7       329,677         29,545",
  "Total Non-Current Liabilities                             1,814,585     2,266,311",
  "",
  "CURRENT LIABILITIES",
  "",
  "Trade and other payables                           8     12,198,722    10,951,662",
  "Unclaimed dividends                                          71,155        63,715",
  "Taxation - net                                             246,958              -",
  "Current portion of lease liabilities               7       158,301        22,683",
  "Provisions                                         9       701,018       622,151",
  "",
  "Total Current Liabilities                                13,376,154    11,660,211",
  "",
  "CONTINGENCIES AND COMMITMENTS                     10",
].join('\n');

const HPL_P49_TOP = [
  "                                                                          Note    2023              2022",
  "                                                                                    (Rupees in thousand)",
  "",
  "CASH FLOWS FROM OPERATING ACTIVITIES",
  "   Profit before taxation                                                          916,099           724,067",
  "   Adjustment for non-cash items:",
  "     Depreciation and amortization                                   315,247         285,935",
  "     Allowance for expected credit loss               10.1,12.1 & 13.3 47,005        197,516",
  "     Unrealised foreign exchange differences                         203,507         237,134",
  "     Gain on disposal of operating fixed assets - net       3.1.4       (6,118)         (9,944)",
  "     Amortization of deferred liabilities                   19.1        (9,000)       (15,274)",
  "     Expense related to share-based payments                25.1         8,506         16,737",
  "     Charge for defined benefit plans                       25.1       57,431        167,266",
  "     Provision against defined contribution plan                       46,808                 -",
  "     Interest income                                         27       (80,876)          (1,379)",
  "     Dividend income on mutual funds                         27       (27,390)                -",
  "     Income from investment properties                       5.2      (74,640)        (67,347)",
  "     Finance costs                                           28      174,773           49,825",
  "                                                                   1,571,352       1,584,536",
].join('\n');

const HPL_P49_BOTTOM = [
  "",
  "",
  "     Net cash used in financing activities                                          (41,123)        (448,180)",
  "NET INCREASE / (DECREASE) IN CASH AND CASH EQUIVALENTS",
  "",
  "                                                                                 1,476,089        (2,153,480)",
  "NET FOREIGN EXCHANGE DIFFERENCES",
  "",
  "                                                                                       (257)           10,726",
  "CASH AND CASH EQUIVALENTS AT THE BEGINNING OF THE YEAR",
  "",
  "                                                                                 (1,358,459)         784,295",
].join('\n');

const EFERT_P160 = [
  "      (Amounts in thousand)                       Note     2025 .......Rupees....... 2024             (Amounts in thousand)                                             Note           2025 .......Rupees....... 2024",
  "",
  "      ASSETS                                                                                          EQUITY & LIABILITIES",
  "",
  "      Non-current assets                                                                              Equity",
  "",
  "      Property, plant and equipment                4      92,391,260             83,137,431           Share capital                                                        15         13,352,993             13,352,993",
  "",
  "      Intangible assets                            5       4,779,969               5,007,551          Reserves",
  "",
  "      Long-term investments                        6       4,348,915               4,268,249          Share premium                                                        16          3,384,904              3,384,904",
  "                                                                                                      Remeasurement of post employment benefits                            16           (38,205)               (69,543)",
  "      Deferred taxation                           19       1,534,786                          -       Unappropriated profit                                                16         28,047,546             30,790,190",
  "                                                                                                                                                                                      31,394,245             34,105,551",
  "      Long-term loans, advances and deposits       7          26,738                197,921",
  "                                                         103,081,668             92,611,152           TOTAL EQUITY                                                                    44,747,238             47,458,544",
  "      Current assets",
  "                                                                                                      Liabilities",
  "      Stores, spares and loose tools               8       9,151,070               8,239,527",
  "                                                                                                      Non-current liabilities",
  "      Stock-in-trade                               9      25,691,512             26,729,059",
  "                                                                                                      Borrowings                                                           17         29,445,959             18,701,703",
  "      Trade debts                                 10      16,845,896               8,253,231          Government grant                                                     18            342,634                514,355",
  "                                                                                                      Deferred taxation                                                    19                   -               672,844",
  "      Other receivables                           11       7,834,671             11,995,667           Deferred liabilities                                                 20             34,464                247,520",
  "                                                                                                                                                                                      29,823,057             20,136,422",
  "      Loans, advances, deposits and prepayments   12       3,669,419               4,594,998          Current liabilities",
].join('\n');

const ABL_P127 = [
  "          613,237        523,942      Cash and balances with treasury banks                   5          171,781,831       146,768,168       1,061,061         1,344,981",
  "           46,690         35,571      Balances with other banks                               6           13,079,040         9,964,224         686,225           933,651",
  "                -        869,407      Lendings to financial institutions                      7                    -       243,541,081         374,836           411,330",
  "        7,629,101      4,033,492      Investments                                             8        2,137,087,228     1,129,873,956",
  "        2,819,034      3,753,042      Advances                                                9          789,676,548     1,051,313,893",
].join('\n');

describe('rereading a native page from its layout text', () => {
  it('reads every row of a plain statement, skipping notes, and nothing for a line not on the page', () => {
    const rows = [
      row('p106.r3', 'Authorised capital', ['2,000,000', '2,000,000']),
      row('p106.r4', 'Issued, subscribed and paid-up capital', ['979,003', '979,003']),
      row('p106.r5', 'Reserves - capital', ['2,073,901', '1,750,481']),
      row('p106.r6', '- revenue', ['28,572,553', '20,995,152']),
      row('p106.r7', 'Total equity', ['31,625,457', '23,724,636']),
      row('p106.r9', 'Deferred taxation - net', ['989,965', '1,052,587']),
      row('p106.r10', 'Staff retirement benefits', ['494,943', '1,184,179']),
      row('p106.r11', 'Lease liabilities', ['329,677', '29,545']),
      row('p106.r12', 'Total Non-Current Liabilities', ['1,814,585', '2,266,311']),
      row('p106.r14', 'Trade and other payables', ['12,198,722', '10,951,662']),
      row('p106.r15', 'Unclaimed dividends', ['71,155', '63,715']),
      row('p106.r16', 'Taxation - net', ['246,958', '-']),
      row('p106.r17', 'Current portion of lease liabilities', ['158,301', '22,683']),
      row('p106.r18', 'Provisions', ['701,018', '622,151']),
      row('p106.r19', 'Total Current Liabilities', ['13,376,154', '11,660,211']),
      // Its line is cut from the fixture: no reading, and "CONTINGENCIES AND COMMITMENTS  10" is not taken for it.
      row('p106.r21', 'TOTAL EQUITY AND LIABILITIES', ['46,816,196', '37,651,158']),
    ];
    const found = read(ABOT_P106, rows);
    for (const item of rows.slice(0, -1)) expect(found[item.id], item.label).toEqual(item.cells);
    expect(found['p106.r21']).toBeUndefined();
  });

  it('reads the printed lines where the table model shifted and fused cells', () => {
    const rows = [
      row('p49.r3', 'Profit before taxation', ['916,099', '724,067']),
      row('p49.r5', 'Depreciation and amortization', ['315,247', '285,935']),
      row('p49.r6', 'Allowance for expected credit loss', ['47,005', '197,516']),
      row('p49.r7', 'Unrealised foreign exchange differences', ['203,507', '237,134']),
      row('p49.r8', 'Gain on disposal of operating fixed assets - net', ['(6,118)', '(9,944)']),
      row('p49.r9', 'Amortization of deferred liabilities', ['(9,000)', '(15,274)']),
      row('p49.r10', '', ['', '16,737']),
      row('p49.r11', 'Expense related to share-based payments', ['8,506', '']),
      row('p49.r12', 'Charge for defined benefit plans', ['57,431 46,808', '167,266']),
      row('p49.r13', 'Provision against defined contribution plan', ['(80,876)', '-']),
      row('p49.r14', 'Interest income', ['', '(1,379)']),
      row('p49.r15', 'Dividend income on mutual funds', ['(27,390)', '-']),
      row('p49.r16', 'Income from investment properties', ['(74,640)', '(67,347)']),
      row('p49.r17', 'Finance costs', ['174,773', '49,825']),
      row('p49.r18', '', ['1,571,352', '1,584,536']),
    ];
    expect(read(HPL_P49_TOP, rows)).toEqual({
      // A subtotal printed in an outer column, read by count.
      'p49.r3': ['916,099', '724,067'],
      'p49.r5': ['315,247', '285,935'],
      // "10.1,12.1 & 13.3 47,005" prints the note against the figure: that figure is not separable.
      'p49.r6': [null, '197,516'],
      'p49.r7': ['203,507', '237,134'],
      'p49.r8': ['(6,118)', '(9,944)'],
      'p49.r9': ['(9,000)', '(15,274)'],
      // The table model's rows 10 to 14 drift by a line in one column; the page does not.
      'p49.r11': ['8,506', '16,737'],
      'p49.r12': ['57,431', '167,266'],
      'p49.r13': ['46,808', '-'],
      'p49.r14': ['(80,876)', '(1,379)'],
      'p49.r15': ['(27,390)', '-'],
      'p49.r16': ['(74,640)', '(67,347)'],
      'p49.r17': ['174,773', '49,825'],
      'p49.r18': ['1,571,352', '1,584,536'],
    });
  });

  it('takes a caption printed above its figures, not the next row\'s caption below them', () => {
    const rows = [
      row('p49.r51', 'Net cash used in financing activities', ['(41,123)', '(448,180)']),
      row('p49.r52', 'NET INCREASE / (DECREASE) IN CASH AND CASH EQUIVALENTS', ['1,476,089', '(2,153,480)']),
      row('p49.r53', 'NET FOREIGN EXCHANGE DIFFERENCES', ['(257)', '10,726']),
      row('p49.r55', 'CASH AND CASH EQUIVALENTS AT THE BEGINNING OF THE YEAR', ['(1,358,459)', '784,295']),
    ];
    const found = read(HPL_P49_BOTTOM, rows);
    for (const item of rows) expect(found[item.id], item.label).toEqual(item.cells);
  });

  it('reads each half of a side-by-side balance sheet from its own columns', () => {
    const left = [
      row('p160.r3', 'Property, plant and equipment', ['92,391,260', '83,137,431']),
      row('p160.r4', 'Intangible assets', ['4,779,969', '5,007,551']),
      row('p160.r5', 'Long-term investments', ['4,348,915', '4,268,249']),
      row('p160.r6', 'Deferred taxation', ['1,534,786', '-']),
      row('p160.r7', 'Long-term loans, advances and deposits', ['26,738', '197,921']),
      row('p160.r9', 'Stores, spares and loose tools', ['9,151,070', '8,239,527']),
      row('p160.r10', 'Stock-in-trade', ['25,691,512', '26,729,059']),
      row('p160.r11', 'Trade debts', ['16,845,896', '8,253,231']),
      row('p160.r12', 'Other receivables', ['7,834,671', '11,995,667']),
    ];
    const right = [
      row('p160.r3', 'Share capital', ['13,352,993', '13,352,993']),
      row('p160.r5', 'Share premium', ['3,384,904', '3,384,904']),
      row('p160.r6', 'Remeasurement of post employment benefits', ['(38,205)', '(69,543)']),
      row('p160.r7', 'Unappropriated profit', ['28,047,546', '30,790,190']),
      row('p160.r12', 'Borrowings', ['29,445,959', '18,701,703']),
      row('p160.r14', 'Deferred taxation', ['-', '672,844']),
    ];
    // As the pipeline numbers them, both halves' rows restart at r3: an id printed twice names no
    // single row, so those get nothing; the rest are read from their own half.
    expect(read(EFERT_P160, [...left, ...right])).toEqual({
      'p160.r4': ['4,779,969', '5,007,551'],
      'p160.r9': ['9,151,070', '8,239,527'],
      'p160.r10': ['25,691,512', '26,729,059'],
      'p160.r11': ['16,845,896', '8,253,231'],
      'p160.r14': ['-', '672,844'],
    });
    const renamed = right.map((item) => ({ ...item, id: item.id.replace('p160.', 'p160.b.') }));
    const found = read(EFERT_P160, [...left, ...renamed]);
    for (const item of [...left, ...renamed]) expect(found[item.id], item.label).toEqual(item.cells);
  });

  it('reads nothing where figures sit on both sides of the captions', () => {
    // US dollar columns left of the caption, rupee columns right of it, and the next statement's
    // figures running on after them: the run after a caption does not show where the table ends.
    const rows = [
      row('p127.r3', 'Cash and balances with treasury banks', ['613,237', '523,942', '171,781,831', '146,768,168']),
      row('p127.r4', 'Balances with other banks', ['46,690', '35,571', '13,079,040', '9,964,224']),
      row('p127.r5', 'Lendings to financial institutions', ['-', '869,407', '-', '243,541,081']),
      row('p127.r6', 'Investments', ['7,629,101', '4,033,492', '2,137,087,228', '1,129,873,956']),
      row('p127.r7', 'Advances', ['2,819,034', '3,753,042', '789,676,548', '1,051,313,893']),
    ];
    expect(read(ABL_P127, rows)).toEqual({});
  });
});

// Tesseract `--psm 6` output for a scanned balance sheet, and the digits-only pass over the same image.
const OCR_LAYOUT = [
  'ADAM SUGAR MILLS LIMITED',
  'STATEMENT OF FINANCIAL POSITION',
  'AS AT SEPTEMBER 30, 2018',
  '2018 2017',
  'Note Rupees Rupees',
  'NON-CURRENT ASSETS',
  'Property, plant and equipment 6 1,814,627,166 1,702,418,553',
  'Long term deposits 2,456,000 2,456,000',
  '| 1,817,083,166 1,704,874,553',
  'CURRENT ASSETS',
  'Stores and spares 8 45,118,220 39,442,101',
  'Stock-in-trade 9 12,345 —',
  'Trade debts - unsecured 10 118,882,5I1 97,555,210',
  'Cash and bank balances 11 (4,512) 8,774,300',
  'CONTINGENCIES AND COMMITMENTS 12',
].join('\n');
const OCR_DIGITS = [
  '..0.. 0.0..',
  '...0..0. 0. .0.0.0.. 0.0.0.0',
  '.. .. ..0...0.. 30, 2018',
  '2018 2017',
  '.0.. ...... ......',
  '.0.-........ .....',
  '.......,. 1..0 ... ...1..... 6 1,814,627,166 1,702,418,553',
  '1... ..... ....0.. 2,456,000 2,456,000',
  '1 1,817,083,166 1,704,874,553',
  '....... .....',
  '..0... ... ...... 8 45,118,220 39,442,101',
  '.0..-1.-...0. 9 12,345 .',
  '...0. .0... - .....0..0 10 118,882,511 97,555,210',
  '0... ... 0... 0...... 11 (4,512) 8,774,300',
  '...........0 .... ...........0 12',
].join('\n');
const OCR_ROWS = [
  row('p3.r6', 'Property, plant and equipment', ['1,814,627,166', '1,702,418,553'], true),
  row('p3.r7', 'Long term deposits', ['2,456,000', '2,456,000'], true),
  row('p3.r8', '', ['1,817,083,166', '1,704,874,553'], true),
  row('p3.r10', 'Stores and spares', ['45,118,220', '39,442,101'], true),
  row('p3.r11', 'Stock-in-trade', ['12,345', '-'], true),
  row('p3.r12', 'Trade debts - unsecured', ['118,882,811', '97,555,210'], true),
  row('p3.r13', 'Cash and bank balances', ['(4,512)', '8,774,300'], true),
];

describe('rereading a scanned page from two tesseract passes', () => {
  it('reads the layout pass by caption and count, and the digits pass through it', () => {
    const found = Object.fromEntries(readRowsFromOcr(OCR_LAYOUT, OCR_DIGITS, OCR_ROWS));
    expect(found['p3.r6']).toEqual({ layout: ['1,814,627,166', '1,702,418,553'], digits: ['1,814,627,166', '1,702,418,553'] });
    expect(found['p3.r7']).toEqual({ layout: ['2,456,000', '2,456,000'], digits: ['2,456,000', '2,456,000'] });
    expect(found['p3.r8']).toEqual({ layout: ['1,817,083,166', '1,704,874,553'], digits: ['1,817,083,166', '1,704,874,553'] });
    // The em dash has no digits-pass counterpart ('.' is not a figure): only the layout pass reads the row.
    expect(found['p3.r11']).toEqual({ layout: ['12,345', '—'], digits: null });
    // "5I1": the layout pass cannot read the figure, so its line has one figure for two columns; the
    // digits pass reads both.
    expect(found['p3.r12']).toEqual({ layout: null, digits: ['118,882,511', '97,555,210'] });
    expect(found['p3.r13']).toEqual({ layout: ['(4,512)', '8,774,300'], digits: ['(4,512)', '8,774,300'] });
  });

  it('never takes a lone note reference for a value when only the count can place figures', () => {
    const rows = [row('p3.r20', 'CONTINGENCIES AND COMMITMENTS', ['8,671,871'], true)];
    expect(readRowsFromText('CONTINGENCIES AND COMMITMENTS 12', rows, 'ocr').size).toBe(0);
    expect(readRowsFromText('Trade debts 12 1,234', [row('p3.r21', 'Trade debts', ['1,234', '5,678'], true)], 'ocr').size).toBe(0);
  });
});

describe('rereadCells', () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'reread-test-'));
    mockedRun.mockReset();
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const native = table([
    row('p2.r3', 'Authorised capital', ['2,000,000', '2,000,000']),
    row('p2.r4', 'Issued, subscribed and paid-up capital', ['979,003', '979,003']),
    row('p2.r5', 'Reserves - capital', ['2,073,901', '1,750,481']),
  ]);
  const scanned = table(OCR_ROWS);
  const analysis: DocumentAnalysis = {
    pageCount: 4,
    ms: 0,
    pages: [page(1, '', 'blank'), page(2, ABOT_P106, 'native'), page(3, 'ADAM SUGAR MILLS LIMITED', 'scanned'), page(4, 'NOTES', 'scanned')],
  };

  function tesseract(): void {
    mockedRun.mockImplementation(async (command, args) => {
      if (command === 'pdftoppm') return { stdout: '' };
      if (command === 'tesseract') return { stdout: args.includes('tessedit_char_whitelist=0123456789,.()-') ? OCR_DIGITS : OCR_LAYOUT };
      throw new Error(`unexpected ${command}`);
    });
  }

  it('creates its work directory before rendering: pdftoppm cannot, and a failed render is skipped silently', async () => {
    tesseract();
    const nested = path.join(workDir, 'not-yet', 'reread');
    await rereadCells('filing.pdf', analysis, [native, scanned], [{ table: 1, row: 'p3.r12', column: 0 }], nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('reads native cells from memory and renders a scanned page once for all its cells', async () => {
    tesseract();
    const readings = await rereadCells('filing.pdf', analysis, [native, scanned], [
      { table: 0, row: 'p2.r4', column: 0 },
      { table: 0, row: 'p2.r5', column: 1 },
      { table: 1, row: 'p3.r12', column: 0 },
      { table: 1, row: 'p3.r13', column: 0 },
      { table: 1, row: 'p3.r11', column: 1 },
    ], workDir);
    expect(readings.get('0:p2.r4:0')).toEqual([{ value: 979_003, source: 'pdftotext', text: '979,003' }]);
    expect(readings.get('0:p2.r5:1')).toEqual([{ value: 1_750_481, source: 'pdftotext', text: '1,750,481' }]);
    // The table model read 118,882,811; the digits pass reads the page's 118,882,511.
    expect(readings.get('1:p3.r12:0')).toEqual([{ value: 118_882_511, source: 'ocr-digits', text: '118,882,511' }]);
    expect(readings.get('1:p3.r13:0')).toEqual([
      { value: -4_512, source: 'ocr-300', text: '(4,512)' },
      { value: -4_512, source: 'ocr-digits', text: '(4,512)' },
    ]);
    expect(readings.get('1:p3.r11:1')).toEqual([{ value: 0, source: 'ocr-300', text: '—' }]);

    const calls = mockedRun.mock.calls;
    expect(calls.filter(([command]) => command === 'pdftoppm')).toEqual([
      ['pdftoppm', ['-f', '3', '-l', '3', '-r', '300', '-gray', '-singlefile', '-png', 'filing.pdf', path.join(workDir, 'reread-p3')]],
    ]);
    const passes = calls.filter(([command]) => command === 'tesseract');
    expect(passes).toHaveLength(2);
    for (const [, args, timeout, env] of passes) {
      expect(args[0]).toBe(path.join(workDir, 'reread-p3.png'));
      expect(args).toContain('6');
      expect(timeout).toBe(90_000);
      expect(env).toEqual({ OMP_THREAD_LIMIT: '1' });
    }
  });

  it('reads at most maxOcrPages scanned pages, those with the most suspect cells first', async () => {
    tesseract();
    const other = table([row('p4.r1', 'Stores and spares', ['45,118,220', '39,442,101'], true)]);
    await rereadCells('filing.pdf', analysis, [scanned, other], [
      { table: 1, row: 'p4.r1', column: 0 },
      { table: 0, row: 'p3.r12', column: 0 },
      { table: 0, row: 'p3.r13', column: 1 },
    ], workDir, { maxOcrPages: 1 });
    expect(mockedRun.mock.calls.filter(([command]) => command === 'pdftoppm').map(([, args]) => args[1])).toEqual(['3']);
  });

  it('returns no OCR readings, and does not throw, when tesseract is not installed', async () => {
    mockedRun.mockImplementation(async (command) => {
      if (command === 'tesseract') throw new DocumentExtractionError('extract_failed', 'tesseract is not installed');
      return { stdout: '' };
    });
    const other = table([row('p4.r1', 'Stores and spares', ['45,118,220', '39,442,101'], true)]);
    const readings = await rereadCells('filing.pdf', analysis, [native, scanned, other], [
      { table: 0, row: 'p2.r3', column: 1 },
      { table: 1, row: 'p3.r12', column: 0 },
      { table: 2, row: 'p4.r1', column: 0 },
    ], workDir);
    expect([...readings.keys()]).toEqual(['0:p2.r3:1']);
    // Stops at the first page: the second is not rendered.
    expect(mockedRun.mock.calls.filter(([command]) => command === 'tesseract')).toHaveLength(1);
  });
});
