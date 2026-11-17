/**
 * The Pakistan Cotton Ginners' Association's fortnightly "Consolidated Statement of Cotton
 * Arrivals in Factories of Pakistan" (https://www.pcga.org/arrival-reports/), one page per report,
 * published on the 3rd and 18th.
 *
 * Read from the PDF's text layer. Each district row carries the district's name and 14 columns
 * (arrivals, pressing, bales sold to TCP / exporters-traders / textiles, total sold, unsold,
 * unginned stock, last year's arrivals on the same date, the difference with its INCREASE/SHORT
 * word and percentage, the fortnight's flow and the number of factories operating).
 *
 * The Sindh block also lists Balochistan, as the association does; its total is "TOTAL OF SINDH".
 *
 * The district rows of a province must add up to its printed total, and the two provinces to the
 * printed Pakistan total. If they do not, nothing is delivered.
 */

export type CottonRegion = 'punjab' | 'sindh' | 'pakistan';

export interface CottonRow {
  region: CottonRegion;
  /** The district as printed, upper case; `TOTAL` for a region's own total row. */
  district: string;
  arrivals: number;
  pressed: number;
  soldTcp: number;
  soldExporters: number;
  soldTextiles: number;
  soldTotal: number;
  unsold: number;
  unginned: number;
  lastYearArrivals: number;
  flow: number;
  factories: number;
}

export interface CottonCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface CottonReport {
  /** The date the arrivals are counted to ("AS ON"), `YYYY-MM-DD`. */
  asOf: string;
  /** The cotton season of the circular, e.g. `2026-27`, or null when it is not printed. */
  season: string | null;
  rows: CottonRow[];
  checks: CottonCheck[];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const FIELDS = ['arrivals', 'pressed', 'soldTcp', 'soldExporters', 'soldTextiles', 'soldTotal', 'unsold', 'unginned', 'lastYearArrivals'] as const;
type Field = (typeof FIELDS)[number];
/** Columns after the name: the nine above, the difference, its word, its percentage, the flow, the factories. */
const TOKENS_PER_ROW = 14;

/** `1,234` -> 1234, `(33,694)` -> -33694, `-` -> null. */
export function parseCount(token: string): number | null {
  const t = token.trim();
  if (t === '-' || t === '') return null;
  const negative = /^\(.*\)$/u.test(t) || t.startsWith('-');
  const digits = t.replace(/[(),\s-]/gu, '');
  if (!/^\d+$/u.test(digits)) return null;
  return negative ? -Number(digits) : Number(digits);
}

export function parseAsOf(text: string): string | null {
  const match = /AS ON:?\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/iu.exec(text);
  if (!match) return null;
  const month = MONTHS[match[2]!.toLowerCase()];
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}` : null;
}

function rowFrom(region: CottonRegion, district: string, tokens: string[]): CottonRow | null {
  if (tokens.length !== TOKENS_PER_ROW) return null;
  const counts: Partial<Record<Field, number>> = {};
  for (const [index, field] of FIELDS.entries()) {
    const value = parseCount(tokens[index]!);
    if (value === null) {
      // A dash in a count column never occurs in the printed table; refuse the row rather than call it 0.
      if (tokens[index] !== '-') return null;
      counts[field] = 0;
    } else {
      counts[field] = value;
    }
  }
  const flow = parseCount(tokens[12]!);
  const factories = parseCount(tokens[13]!);
  if (flow === null || factories === null) return null;
  const c = counts as Record<Field, number>;
  return { region, district, ...c, flow, factories };
}

const TOTAL_LABEL = /^\s*TOTAL OF (PUNJAB|SINDH|PAKISTAN):?\s+(.*)$/iu;
const DISTRICT = /^\s*(\d{1,2})\s+([A-Z][A-Z .()'&-]*?)\s{2,}(.*)$/u;

export function parseCottonArrivals(text: string): CottonReport {
  const rows: CottonRow[] = [];
  const checks: CottonCheck[] = [];
  const asOf = parseAsOf(text);
  const season = /Cir\.[^\n]*?(\d{4}-\d{2})/u.exec(text)?.[1] ?? null;

  let current: CottonRegion = 'punjab';
  const pending: CottonRow[] = [];
  const closed: Record<'punjab' | 'sindh', CottonRow[]> = { punjab: [], sindh: [] };

  for (const line of text.split(/\r?\n/u)) {
    const total = TOTAL_LABEL.exec(line);
    if (total) {
      const region = total[1]!.toLowerCase() as CottonRegion;
      const row = rowFrom(region, 'TOTAL', total[2]!.trim().split(/\s+/u));
      if (!row) {
        checks.push({ id: `${region}:total-readable`, ok: false, detail: 'the total row has an unexpected number of columns' });
        continue;
      }
      rows.push(row);
      if (region !== 'pakistan') {
        closed[region] = pending.splice(0);
        // Punjab is printed first, then Sindh (with Balochistan); the district rows that follow a
        // province's total belong to the next block.
        current = 'sindh';
      }
      continue;
    }
    const district = DISTRICT.exec(line);
    if (!district || /LAST YEAR/iu.test(line)) continue;
    const name = district[2]!.trim();
    const row = rowFrom(current, name, district[3]!.trim().split(/\s+/u));
    if (!row) {
      checks.push({ id: `${current}:${name}`, ok: false, detail: 'the district row has an unexpected number of columns' });
      continue;
    }
    pending.push(row);
    rows.push(row);
  }

  const totalOf = (region: CottonRegion) => rows.find((r) => r.region === region && r.district === 'TOTAL');
  for (const region of ['punjab', 'sindh'] as const) {
    const total = totalOf(region);
    if (!total) {
      checks.push({ id: `${region}:total-printed`, ok: false });
      continue;
    }
    for (const field of ['arrivals', 'pressed', 'soldTotal', 'unsold', 'unginned'] as const) {
      const added = closed[region].reduce((acc, r) => acc + r[field], 0);
      checks.push({ id: `${region}:${field}`, ok: added === total[field], ...(added === total[field] ? {} : { detail: `districts add to ${added}, total prints ${total[field]}` }) });
    }
  }
  const pk = totalOf('pakistan');
  const pj = totalOf('punjab');
  const sd = totalOf('sindh');
  if (!pk || !pj || !sd) {
    checks.push({ id: 'pakistan:total-printed', ok: false });
  } else {
    const added = pj.arrivals + sd.arrivals;
    checks.push({ id: 'pakistan:arrivals', ok: added === pk.arrivals, ...(added === pk.arrivals ? {} : { detail: `provinces add to ${added}, total prints ${pk.arrivals}` }) });
  }
  if (!asOf) checks.push({ id: 'as-on-date', ok: false, detail: 'no "AS ON" date printed' });
  if (closed.punjab.length === 0 || closed.sindh.length === 0) checks.push({ id: 'districts-found', ok: false, detail: 'a province has no district rows' });

  const ok = checks.every((c) => c.ok);
  return { asOf: asOf ?? '', season, rows: ok ? rows : [], checks };
}
