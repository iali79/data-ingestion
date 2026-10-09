import { readTables, type HtmlRow } from './html-table.js';

/**
 * MUFAP's public industry pages and what each one carries. Every row is keyed by MUFAP's own
 * fund id, read from the row's profile link (or, on the monthly AUM page, from its allocation
 * handler) -- never from the fund name, which 28 pension schemes share across their sub-funds.
 */
export const MUFAP_ORIGIN = 'https://www.mufap.com.pk';

export const PAGES = {
  performanceAnnualised: `${MUFAP_ORIGIN}/Industry/IndustryStatDaily?tab=1`,
  performanceAbsolute: `${MUFAP_ORIGIN}/Industry/IndustryStatDaily?tab=2`,
  prices: `${MUFAP_ORIGIN}/Industry/IndustryStatDaily?tab=3`,
  payouts: `${MUFAP_ORIGIN}/Industry/IndustryStatDaily?tab=4`,
  expenses: `${MUFAP_ORIGIN}/Industry/IndustryStatDaily?tab=5`,
  monthlyAum: `${MUFAP_ORIGIN}/Industry/IndustryStatMonthly?tab=1`,
} as const;

export type PageName = keyof typeof PAGES;

/** Raised when a page is not the table we expect: a challenge page, an error page or a redesign. */
export class PageShapeError extends Error {}

export const RETURN_PERIODS = {
  ytd: 'ytd',
  mtd: 'mtd',
  '1 day': 'd1',
  '15 days': 'd15',
  '30 days': 'd30',
  '90 days': 'd90',
  '180 days': 'd180',
  '270 days': 'd270',
  '365 days': 'd365',
  '2 years': 'y2',
  '3 years': 'y3',
} as const;

export type ReturnPeriod = (typeof RETURN_PERIODS)[keyof typeof RETURN_PERIODS];
export type Returns = Partial<Record<ReturnPeriod, number | null>>;

export interface PerformanceRow {
  fundId: number;
  name: string;
  sector: string;
  category: string;
  /** What MUFAP says the figures are, e.g. "Annualized Return", taken from its category label. */
  returnBasis: string | null;
  rating: string | null;
  benchmark: string | null;
  validityDate: string | null;
  nav: number | null;
  returns: Returns;
}

export interface PriceRow {
  fundId: number;
  name: string;
  sector: string;
  amc: string;
  category: string;
  inceptionDate: string | null;
  offer: number | null;
  repurchase: number | null;
  nav: number | null;
  validityDate: string | null;
  /** As published. Whether these are percentages or codes is not settled (offer vs NAV disagrees). */
  frontEndLoad: string | null;
  backEndLoad: string | null;
  contingentLoad: string | null;
  marketLoad: string | null;
  trustee: string | null;
}

export interface PayoutRow {
  fundId: number;
  name: string;
  payoutPerUnit: number | null;
  exNav: number | null;
  payoutDate: string | null;
}

export interface ExpenseRow {
  fundId: number;
  name: string;
  nav: number | null;
  validityDate: string | null;
  terMtdPct: number | null;
  terYtdPct: number | null;
  managementFeePct: number | null;
  sellingMarketingPct: number | null;
}

export interface AumRow {
  fundId: number;
  name: string;
  amc: string;
  category: string;
  inceptionDate: string | null;
  aumPkrMillions: number | null;
}

export interface MonthlyAum {
  /** `YYYY-MM`, read from the AUM column heading ("September-2026 ( Rupees in million )"). */
  month: string;
  rows: AumRow[];
}

export function parsePerformance(html: string): PerformanceRow[] {
  const table = keyedTable(html, ['category', 'rating', 'validity date', 'nav', 'ytd'], 'performance');
  return table.rows.map(({ entry, fundId }) => {
    const { category, basis } = splitCategory(entry.category ?? '');
    const returns: Returns = {};
    for (const [label, key] of Object.entries(RETURN_PERIODS)) {
      if (label in entry) returns[key] = toNumber(entry[label]);
    }
    return {
      fundId,
      name: fundName(entry),
      sector: entry.sector ?? '',
      category,
      returnBasis: basis,
      rating: toText(entry.rating),
      benchmark: toText(entry.benchmark),
      validityDate: toDate(entry['validity date']),
      nav: toNumber(entry.nav),
      returns,
    };
  });
}

export function parsePrices(html: string): PriceRow[] {
  const table = keyedTable(html, ['offer', 'repurchase', 'nav', 'validity date'], 'prices');
  return table.rows.map(({ entry, fundId }) => ({
    fundId,
    name: fundName(entry),
    sector: entry.sector ?? '',
    amc: entry.amc ?? '',
    category: entry.category ?? '',
    inceptionDate: toDate(entry['inception date']),
    offer: toNumber(entry.offer),
    repurchase: toNumber(entry.repurchase),
    nav: toNumber(entry.nav),
    validityDate: toDate(entry['validity date']),
    frontEndLoad: toText(entry['front-end']),
    backEndLoad: toText(entry['back-end']),
    contingentLoad: toText(entry.contingent),
    marketLoad: toText(entry.market),
    trustee: toText(entry.trustee),
  }));
}

export function parsePayouts(html: string): PayoutRow[] {
  const table = keyedTable(html, ['payout (per unit)', 'ex-nav', 'payout date'], 'payouts');
  return table.rows.map(({ entry, fundId }) => ({
    fundId,
    name: fundName(entry),
    payoutPerUnit: toNumber(entry['payout (per unit)']),
    exNav: toNumber(entry['ex-nav']),
    payoutDate: toDate(entry['payout date']),
  }));
}

export function parseExpenses(html: string): ExpenseRow[] {
  const table = keyedTable(html, ['ter mtd %', 'ter ytd %', 'mf %', 's&m %'], 'expenses');
  return table.rows.map(({ entry, fundId }) => ({
    fundId,
    name: fundName(entry),
    nav: toNumber(entry.nav),
    validityDate: toDate(entry['validity date']),
    terMtdPct: toNumber(entry['ter mtd %']),
    terYtdPct: toNumber(entry['ter ytd %']),
    managementFeePct: toNumber(entry['mf %']),
    sellingMarketingPct: toNumber(entry['s&m %']),
  }));
}

export function parseMonthlyAum(html: string): MonthlyAum {
  const table = keyedTable(html, ['fund name', 'category', 'inception date'], 'monthly AUM');
  const aumLabel = table.header.find((label) => /rupees in million/.test(label));
  const month = aumLabel ? monthFromHeading(aumLabel) : null;
  if (!aumLabel || !month) throw new PageShapeError('monthly AUM: no "<Month>-<Year> ( Rupees in million )" column');
  return {
    month,
    rows: table.rows.map(({ entry, fundId }) => ({
      fundId,
      name: fundName(entry),
      amc: entry['amc name'] ?? entry.amc ?? '',
      category: entry.category ?? '',
      inceptionDate: toDate(entry['inception date']),
      aumPkrMillions: toNumber(entry[aumLabel]),
    })),
  };
}

/**
 * A challenge page has no fund table; say so plainly instead of "0 rows". Only the title counts:
 * Cloudflare also injects its `challenge-platform` script into ordinary pages.
 */
export function looksLikeChallenge(html: string): boolean {
  return /<title>\s*Just a moment/i.test(html);
}

interface KeyedTable {
  header: string[];
  rows: Array<{ entry: Record<string, string>; fundId: number }>;
}

function keyedTable(html: string, required: string[], page: string): KeyedTable {
  if (looksLikeChallenge(html)) throw new PageShapeError(`${page}: got a Cloudflare challenge page, not data`);
  for (const table of readTables(html)) {
    const headerIndex = table.findIndex((row) => {
      const labels = row.cells.map(normalizeLabel);
      return required.every((label) => labels.includes(label));
    });
    if (headerIndex < 0) continue;
    const header = table[headerIndex]!.cells.map(normalizeLabel);
    const rows: KeyedTable['rows'] = [];
    for (const row of table.slice(headerIndex + 1)) {
      if (row.cells.length !== header.length) continue;
      const fundId = fundIdOf(row);
      if (fundId === null) continue;
      const entry: Record<string, string> = {};
      header.forEach((label, i) => (entry[label] = row.cells[i] ?? ''));
      rows.push({ entry, fundId });
    }
    return { header, rows };
  }
  throw new PageShapeError(`${page}: no table with columns ${required.join(', ')}`);
}

function fundIdOf(row: HtmlRow): number | null {
  for (const href of row.links) {
    const match = /FundDetail\?FundID=(\d+)/i.exec(href);
    if (match) return Number(match[1]);
  }
  for (const handler of row.handlers) {
    const match = /getAssetAllocation\(\s*(\d+)\s*,/.exec(handler);
    if (match) return Number(match[1]);
  }
  return null;
}

export function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function fundName(entry: Record<string, string>): string {
  return (entry['fund name'] ?? entry.fund ?? '').trim();
}

/** "Money Market (Annualized Return )" -> category "Money Market", basis "Annualized Return". */
export function splitCategory(raw: string): { category: string; basis: string | null } {
  const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(raw);
  if (!match) return { category: raw.trim(), basis: null };
  return { category: match[1]!.trim(), basis: match[2]!.replace(/\s+/g, ' ').trim() || null };
}

export function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function toText(raw: string | undefined): string | null {
  const text = raw?.trim() ?? '';
  return text === '' || /^(n\/a|-+)$/i.test(text) ? null : text;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Oct 09, 2026" -> "2026-10-09"; anything else -> null. */
export function toDate(raw: string | undefined): string | null {
  const match = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/.exec(raw?.trim() ?? '');
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : null;
}

function monthFromHeading(label: string): string | null {
  const match = /([a-z]+)-(\d{4})/.exec(label);
  const month = match ? MONTHS[match[1]!.slice(0, 3)] : undefined;
  return match && month ? `${match[2]}-${String(month).padStart(2, '0')}` : null;
}
