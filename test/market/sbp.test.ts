import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headerToPeriod, normaliseLabel, parseSbpCredit, serialToPeriod, type SbpSheet } from '../../src/market/sbp.js';

const fixture = JSON.parse(readFileSync(new URL('../../samples/market/sbp/credit-rows.json', import.meta.url), 'utf8')) as Record<string, unknown[][]>;
const sheets = (): SbpSheet[] => Object.entries(fixture).map(([name, rows]) => ({ name, rows: structuredClone(rows) }));

describe('headers', () => {
  it('reads spreadsheet serials, short and long month names', () => {
    // 38869 is displayed as "Jun-06" in the workbook.
    expect(serialToPeriod(38869)).toBe('2006-06-01');
    expect(headerToPeriod('Jul-26')).toBe('2026-07-01');
    expect(headerToPeriod('June-19')).toBe('2019-06-01');
    expect(headerToPeriod('Sep-2026')).toBe('2026-09-01');
    expect(headerToPeriod(38899)).toBe('2006-07-01');
  });
  it('does not take a label for a month', () => {
    expect(headerToPeriod('Description')).toBeNull();
    expect(headerToPeriod(null)).toBeNull();
    expect(headerToPeriod(5)).toBeNull();
  });
  it('strips the numbering from a row label', () => {
    expect(normaliseLabel('  A. Bank Employees ')).toBe('bank employees');
    expect(normaliseLabel('1)   For house building')).toBe('for house building');
    expect(normaliseLabel('3. PERSONAL')).toBe('personal');
  });
});

describe('the SBP credit workbook (data to Oct-26)', () => {
  const out = parseSbpCredit(sheets());
  const at = (series: string, period: string) => out.rows.find((r) => r.series === series && r.period === period)?.value;

  it('passes the sheet\'s own sums for the latest month', () => {
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.asOf).toBe('2026-10-01');
  });

  it('matches the figures AHL republishes for Oct-26 and Sep-26 (million rupees)', () => {
    expect(Math.round(at('private', '2026-10-01')!)).toBe(11398563);
    expect(Math.round(at('business', '2026-10-01')!)).toBe(9538761);
    expect(Math.round(at('personal', '2026-10-01')!)).toBe(1850538);
    expect(Math.round(at('auto', '2026-10-01')!)).toBe(416538);
    expect(Math.round(at('house', '2026-10-01')!)).toBe(409018);
    expect(Math.round(at('cards', '2026-10-01')!)).toBe(217474);
    expect(Math.round(at('personalloans', '2026-10-01')!)).toBe(343292);
    expect(Math.round(at('consumer', '2026-09-01')!)).toBe(1293199);
    expect(Math.round(at('auto', '2026-09-01')!)).toBe(407118);
  });

  it('takes the consumer-financing house-building row, not the bank-employee one', () => {
    expect(Math.round(at('house', '2026-10-01')!)).toBe(409018);
    expect(Math.round(at('house', '2026-10-01')!)).not.toBe(348983);
  });

  it('reaches back through the older sheet (2006) and prefers the newer one where they overlap', () => {
    expect(at('personal', '2006-06-01')).toBeCloseTo(342851.614, 2);
    expect(out.rows.filter((r) => r.period === '2019-06-01' && r.series === 'private')).toHaveLength(1);
  });

  it('never repeats a (series, month)', () => {
    const keys = out.rows.map((r) => `${r.series}|${r.period}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('a workbook that does not add up', () => {
  it('delivers nothing when a consumer purpose is altered', () => {
    const tampered = sheets();
    const isic = tampered.find((s) => s.name === 'Archive ISIC 4')!;
    const row = isic.rows.findIndex((r, i) => /^\d\)\s+For transport/.test(String(r[0]).trim()) && i > 10);
    expect(row).toBeGreaterThan(0);
    isic.rows[row]![isic.rows[row]!.length - 1] = 999_999;
    const out = parseSbpCredit(tampered);
    expect(out.rows).toEqual([]);
    expect(out.checks.find((c) => c.id === 'consumer')).toMatchObject({ ok: false });
  });

  it('delivers nothing when the current sheet is missing', () => {
    const out = parseSbpCredit(sheets().filter((s) => s.name !== 'Archive ISIC 4'));
    expect(out.rows).toEqual([]);
    expect(out.checks.some((c) => !c.ok)).toBe(true);
  });
});
