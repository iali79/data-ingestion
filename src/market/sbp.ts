/**
 * State Bank of Pakistan: "Credit/Loans classified by borrowers", month-end outstanding in million
 * rupees. The archive workbook (https://www.sbp.org.pk/assets/document/CreditLoans-arch.xls) holds
 * every month: `WEB COPY-Archive` from 2006-05 to 2019-06 and `Archive ISIC 4` from 2019-05 on, with
 * the same rows worded slightly differently (and the newer sheet wins where they overlap).
 *
 * The rows are matched by what they say and by their parent block: "For house building" appears
 * under both Bank Employees and Consumer Financing, and only the second is stored.
 *
 * Delivery is gated on the sheet's own arithmetic for the latest month: consumer financing is the
 * sum of its five purposes, personal is bank employees plus consumer plus other, and private-sector
 * loans are business plus trusts plus personal plus other.
 */
export const SBP_SERIES = [
  'private',
  'business',
  'trusts',
  'personal',
  'bankemp',
  'consumer',
  'house',
  'auto',
  'cards',
  'durables',
  'personalloans',
  'personalother',
  'other',
] as const;
export type SbpSeries = (typeof SBP_SERIES)[number];

export interface SbpRow {
  series: SbpSeries;
  /** First day of the month the figure is the end of, `YYYY-MM-01`. */
  period: string;
  /** Million rupees. */
  value: number;
}

export interface SbpCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface SbpCredit {
  /** The latest month in the workbook, `YYYY-MM-01`. */
  asOf: string;
  rows: SbpRow[];
  checks: SbpCheck[];
}

export interface SbpSheet {
  name: string;
  rows: unknown[][];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SHEETS = ['WEB COPY-Archive', 'Archive ISIC 4'] as const;
/** The workbook is whole numbers of rupees millions summed from rounded cells; allow a million of drift. */
const TOLERANCE = 1.5;

/** An Excel serial date (days since 1899-12-30) as `YYYY-MM-01`. */
export function serialToPeriod(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20_000 || serial > 80_000) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** `Jul-26`, `June-19`, `Sep-2026`, or a spreadsheet serial; the month's first day, or null. */
export function headerToPeriod(cell: unknown): string | null {
  if (typeof cell === 'number') return serialToPeriod(cell);
  if (cell instanceof Date) return `${cell.getUTCFullYear()}-${String(cell.getUTCMonth() + 1).padStart(2, '0')}-01`;
  if (typeof cell !== 'string') return null;
  const match = /^\s*([A-Za-z]+)[-\s'](\d{2}|\d{4})\s*$/u.exec(cell);
  if (!match) return null;
  const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/** Lower case, single spaces, no leading "A." / "3." / "1)" numbering. */
export function normaliseLabel(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]\)|[a-z]\.|\d\)|\d\.)\s*/u, '');
}

interface Located {
  series: SbpSeries;
  row: number;
}

/** Finds each stored series' row in one sheet, using the parent block to tell repeated labels apart. */
export function locateSeries(rows: unknown[][], headerRow: number): Located[] {
  const found: Located[] = [];
  let block: 'personal' | 'bankemp' | 'consumer' | null = null;
  let personalSeen = false;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const raw = String(rows[r]?.[0] ?? '').replace(/\s+/gu, ' ').trim();
    if (!raw) continue;
    const label = normaliseLabel(raw);
    const topNumber = /^(\d)\./u.exec(raw)?.[1];
    const push = (series: SbpSeries) => found.push({ series, row: r });

    if (/^loans to private sector\s*\(1-4\)$/u.test(label)) { push('private'); continue; }
    if (/^(private sector \(business\)|loans to private sector business)$/u.test(label)) { push('business'); continue; }
    if (topNumber === '2' && /(trust|non-?profit|npo)/u.test(label)) { push('trusts'); continue; }
    if (topNumber === '3' && label === 'personal') { push('personal'); block = 'personal'; personalSeen = true; continue; }
    if (topNumber === '4' && label === 'other') { push('other'); block = null; continue; }
    if (!personalSeen) continue;
    if (/^total credit/u.test(label)) break;
    if (/^bank\s*employees$/u.test(label)) { push('bankemp'); block = 'bankemp'; continue; }
    if (/^consumer financing$/u.test(label)) { push('consumer'); block = 'consumer'; continue; }
    if (block === 'consumer') {
      if (/^for house building$/u.test(label)) push('house');
      else if (/^for transport/u.test(label)) push('auto');
      else if (/^credit cards$/u.test(label)) push('cards');
      else if (/^consumers? durables?$/u.test(label)) push('durables');
      else if (/^personal loans$/u.test(label)) push('personalloans');
      // "C) Other" follows the five consumer purposes and belongs to Personal, not to Consumer Financing.
      else if (/^other$/u.test(label)) {
        push('personalother');
        block = null;
      }
    }
  }
  return found;
}

function readSheet(sheet: SbpSheet): { rows: SbpRow[]; problems: string[] } {
  const problems: string[] = [];
  const headerRow = sheet.rows.findIndex((r) => String(r?.[0] ?? '').trim().toLowerCase() === 'description');
  if (headerRow < 0) return { rows: [], problems: [`${sheet.name}: no "Description" header row`] };
  const header = sheet.rows[headerRow]!;
  const periods = header.map((cell, index) => (index === 0 ? null : headerToPeriod(cell)));

  const located = locateSeries(sheet.rows, headerRow);
  const have = new Set(located.map((l) => l.series));
  for (const needed of ['private', 'business', 'personal', 'consumer', 'house', 'auto', 'cards', 'personalloans'] as const) {
    if (!have.has(needed)) problems.push(`${sheet.name}: row for ${needed} not found`);
  }
  const seen = new Set<SbpSeries>();
  const rows: SbpRow[] = [];
  for (const { series, row } of located) {
    if (seen.has(series)) {
      problems.push(`${sheet.name}: ${series} is printed twice`);
      continue;
    }
    seen.add(series);
    for (const [column, period] of periods.entries()) {
      const cell = sheet.rows[row]?.[column];
      if (!period || typeof cell !== 'number' || !Number.isFinite(cell)) continue;
      rows.push({ series, period, value: Math.round(cell * 1000) / 1000 });
    }
  }
  return { rows, problems };
}

export function parseSbpCredit(sheets: SbpSheet[]): SbpCredit {
  const checks: SbpCheck[] = [];
  const byKey = new Map<string, SbpRow>();
  let readAny = false;
  // The older sheet first, so the newer one overwrites the months they share.
  for (const name of SHEETS) {
    const sheet = sheets.find((s) => s.name === name);
    if (!sheet) {
      if (name === 'Archive ISIC 4') checks.push({ id: 'sheet:Archive ISIC 4', ok: false, detail: 'the current sheet is missing' });
      continue;
    }
    const { rows, problems } = readSheet(sheet);
    for (const p of problems) checks.push({ id: 'rows', ok: false, detail: p });
    for (const row of rows) byKey.set(`${row.series}|${row.period}`, row);
    readAny = readAny || rows.length > 0;
  }
  const rows = [...byKey.values()].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.series < b.series ? -1 : 1));
  if (!readAny) {
    checks.push({ id: 'rows', ok: false, detail: 'no rows read' });
    return { asOf: '', rows: [], checks };
  }

  const asOf = rows.reduce((latest, r) => (r.period > latest ? r.period : latest), '');
  const at = (series: SbpSeries) => byKey.get(`${series}|${asOf}`)?.value;
  const sum = (parts: SbpSeries[]) => (parts.every((p) => at(p) !== undefined) ? parts.reduce((a, p) => a + at(p)!, 0) : null);
  const near = (id: string, actual: number | undefined, expected: number | null) => {
    if (actual === undefined || expected === null) {
      checks.push({ id, ok: false, detail: 'a figure the check needs is not printed for the latest month' });
      return;
    }
    const ok = Math.abs(actual - expected) <= TOLERANCE;
    checks.push({ id, ok, ...(ok ? {} : { detail: `${asOf}: printed ${actual}, parts add to ${expected.toFixed(1)}` }) });
  };
  near('consumer', at('consumer'), sum(['house', 'auto', 'cards', 'durables', 'personalloans']));
  near('personal', at('personal'), (sum(['bankemp', 'consumer']) ?? NaN) + (at('personalother') ?? 0));
  near('private', at('private'), (sum(['business', 'personal']) ?? NaN) + (at('trusts') ?? 0) + (at('other') ?? 0));
  return { asOf, rows: checks.every((c) => c.ok) ? rows : [], checks };
}

/** The workbook's two data sheets as plain rows. Dates are read as serials so the runner's time zone cannot move a month. */
export async function readSbpWorkbook(buffer: Buffer): Promise<SbpSheet[]> {
  const XLSX = await import('@e965/xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return SHEETS.filter((name) => workbook.Sheets[name]).map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, { header: 1, raw: true, defval: null }),
  }));
}
