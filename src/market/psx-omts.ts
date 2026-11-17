/**
 * PSX's daily "Off Market Transactions" report (https://dps.psx.com.pk/download/omts/<date>.pdf):
 * trades the brokers reported after the session, in two sections.
 *
 *  - BROKER TO BROKER: `(+) <buyer code> (-) <seller code>  <company>  <shares>  <rate>`
 *  - CROSS TRANSACTIONS BETWEEN CLIENT TO CLIENT & FINANCIAL INSTITUTIONS: `<member code>  <company>  <shares>  <rate>`
 *
 * Members appear by their three-digit code and companies by the short name the report prints; the
 * report carries no member names or symbols, and none is invented here.
 *
 * Each group of rows ends in a printed "Total", and each section in "Total Turnover". Rows must add
 * up to both, or nothing is delivered.
 */

export type OffMarketSection = 'm2m' | 'c2c';

export interface OffMarketRow {
  section: OffMarketSection;
  /** Position within its section, from 1. */
  rowNo: number;
  buyerCode: string | null;
  sellerCode: string | null;
  /** The member the row is listed under (client-to-client only). */
  memberCode: string | null;
  company: string;
  shares: number;
  rate: number;
  /** `shares x rate`, rupees. */
  value: number;
}

export interface OffMarketCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface OffMarketReport {
  /** `Report For:` date, `YYYY-MM-DD`. */
  tradeDate: string;
  rows: OffMarketRow[];
  checks: OffMarketCheck[];
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const M2M = /^\s*\(\+\)\s*(\d{3})\s*\(-\)\s*(\d{3})\s{2,}(.+?)\s{2,}([\d,]+)\s+(\d+(?:\.\d+)?)\s*$/u;
const C2C = /^\s{2,}(\d{3})\s{2,}(.+?)\s{2,}([\d,]+)\s+(\d+(?:\.\d+)?)\s*$/u;
const GROUP_TOTAL = /^\s*Total\s+([\d,]+)\s+-\s*$/u;
const SECTION_TOTAL = /^\s*Total Turnover\s+([\d,]+)\s*$/u;

export function parseReportDate(text: string): string | null {
  const match = /Report For:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/u.exec(text);
  const month = match ? MONTHS[match[1]!.toLowerCase()] : undefined;
  if (!match || !month) return null;
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
}

const toInt = (token: string): number => Number(token.replace(/,/gu, ''));

export function parseOffMarket(text: string): OffMarketReport {
  const tradeDate = parseReportDate(text);
  const rows: OffMarketRow[] = [];
  const checks: OffMarketCheck[] = [];
  let section: OffMarketSection | null = null;
  let group: OffMarketRow[] = [];
  const rowsOfSection = (s: OffMarketSection) => rows.filter((r) => r.section === s);
  const turnover: Partial<Record<OffMarketSection, number>> = {};

  const closeGroup = (printed: number) => {
    const added = group.reduce((acc, r) => acc + r.shares, 0);
    const where = group[0] ? `${group[0].company}` : 'an empty group';
    checks.push({ id: `group:${section}:${rows.length}`, ok: added === printed, ...(added === printed ? {} : { detail: `${where}: rows add to ${added}, total prints ${printed}` }) });
    group = [];
  };

  for (const line of text.split(/\r?\n/u)) {
    if (/BROKER TO BROKER/u.test(line)) { section = 'm2m'; group = []; continue; }
    if (/CROSS TRANSACTIONS BETWEEN CLIENT TO CLIENT/u.test(line)) { section = 'c2c'; group = []; continue; }
    if (!section) continue;

    const sectionTotal = SECTION_TOTAL.exec(line);
    if (sectionTotal) { turnover[section] = toInt(sectionTotal[1]!); continue; }
    const groupTotal = GROUP_TOTAL.exec(line);
    if (groupTotal) { closeGroup(toInt(groupTotal[1]!)); continue; }

    let row: OffMarketRow | null = null;
    const m = section === 'm2m' ? M2M.exec(line) : null;
    const c = section === 'c2c' ? C2C.exec(line) : null;
    const rowNo = rowsOfSection(section).length + 1;
    if (m) {
      row = { section, rowNo, buyerCode: m[1]!, sellerCode: m[2]!, memberCode: null, company: m[3]!.trim(), shares: toInt(m[4]!), rate: Number(m[5]), value: 0 };
    } else if (c && !/Member Code/u.test(line)) {
      row = { section, rowNo, buyerCode: null, sellerCode: null, memberCode: c[1]!, company: c[2]!.trim(), shares: toInt(c[3]!), rate: Number(c[4]), value: 0 };
    }
    if (row) {
      row.value = Math.round(row.shares * row.rate * 100) / 100;
      rows.push(row);
      group.push(row);
    }
  }

  for (const s of ['m2m', 'c2c'] as const) {
    const printed = turnover[s];
    const added = rowsOfSection(s).reduce((acc, r) => acc + r.shares, 0);
    if (printed === undefined) {
      // A day with no trades in a section prints no total; that is fine only if it also lists no rows.
      checks.push({ id: `turnover:${s}`, ok: added === 0, ...(added === 0 ? {} : { detail: 'rows without a printed Total Turnover' }) });
    } else {
      checks.push({ id: `turnover:${s}`, ok: added === printed, ...(added === printed ? {} : { detail: `rows add to ${added}, Total Turnover prints ${printed}` }) });
    }
  }
  if (group.length > 0) checks.push({ id: 'unclosed-group', ok: false, detail: `${group.length} row(s) after the last printed Total` });
  if (!tradeDate) checks.push({ id: 'report-date', ok: false, detail: 'no "Report For" date printed' });
  if (!/Off Market Transactions/iu.test(text)) checks.push({ id: 'document', ok: false, detail: 'not an Off Market Transactions report' });

  return { tradeDate: tradeDate ?? '', rows: checks.every((c) => c.ok) ? rows : [], checks };
}
