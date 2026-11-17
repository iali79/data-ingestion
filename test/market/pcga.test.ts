import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAsOf, parseCottonArrivals, parseCount } from '../../src/market/pcga.js';

const sample = readFileSync(new URL('../../samples/market/pcga/arrivals-2026-11-03.txt', import.meta.url), 'utf8');

describe('parseCount', () => {
  it.each([
    ['1,998,944', 1998944],
    ['(33,694)', -33694],
    ['0', 0],
  ])('reads %s', (token, n) => expect(parseCount(token)).toBe(n));
  it('reads a dash as nothing', () => expect(parseCount('-')).toBeNull());
});

describe('parseAsOf', () => {
  it('reads the date arrivals are counted to, not the date of the circular', () => {
    expect(parseAsOf('ARRIVALS IN FACTORIES OF PAKISTAN AS ON: 31 Oct 2026.')).toBe('2026-10-31');
  });
});

describe('the 3 Nov 2026 report', () => {
  const out = parseCottonArrivals(sample);
  const row = (region: string, district: string) => out.rows.find((r) => r.region === region && r.district === district);

  it('passes every check: districts add to the printed totals', () => {
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.asOf).toBe('2026-10-31');
    expect(out.season).toBe('2026-27');
  });

  it('delivers 21 Punjab and 12 Sindh districts plus the three totals', () => {
    expect(out.rows.filter((r) => r.region === 'punjab' && r.district !== 'TOTAL')).toHaveLength(21);
    expect(out.rows.filter((r) => r.region === 'sindh' && r.district !== 'TOTAL')).toHaveLength(12);
    expect(out.rows.filter((r) => r.district === 'TOTAL')).toHaveLength(3);
  });

  it('matches the figures AHL republishes (Punjab 1,999k, Sindh 2,744k, Pakistan 4,743k bales)', () => {
    expect(row('punjab', 'TOTAL')?.arrivals).toBe(1998944);
    expect(row('sindh', 'TOTAL')?.arrivals).toBe(2743686);
    expect(row('pakistan', 'TOTAL')?.arrivals).toBe(4742630);
    expect(row('pakistan', 'TOTAL')?.unsold).toBe(338240);
  });

  it('reads a full district row, including names with spaces and brackets', () => {
    expect(row('punjab', 'MULTAN')).toMatchObject({ arrivals: 28242, pressed: 27442, soldTextiles: 24409, unsold: 3033, unginned: 800, lastYearArrivals: 24637, flow: 4265, factories: 5 });
    expect(row('punjab', 'DERA GHAZI KHAN')?.soldExporters).toBe(600);
    expect(row('sindh', 'MIRPUR KHAS (THARPARKAR)')?.arrivals).toBe(60350);
    expect(row('sindh', 'BALUCHISTAN')?.arrivals).toBe(204132);
  });

  it('reads a district with nothing reported (dashes for the difference)', () => {
    expect(row('punjab', 'PAKPATTAN')).toMatchObject({ arrivals: 0, lastYearArrivals: 0, factories: 0 });
  });

  it('does not take "last year" total rows for districts', () => {
    expect(out.rows.filter((r) => r.region === 'pakistan')).toHaveLength(1);
  });
});

describe('a report that does not add up', () => {
  it('delivers nothing when a district figure is altered', () => {
    const tampered = sample.replace('28,242', '38,242');
    expect(tampered).not.toBe(sample);
    const out = parseCottonArrivals(tampered);
    expect(out.rows).toEqual([]);
    expect(out.checks.find((c) => c.id === 'punjab:arrivals')).toMatchObject({ ok: false });
  });

  it('delivers nothing from a different document', () => {
    const out = parseCottonArrivals('Off Market Transactions\nBROKER TO BROKER\n');
    expect(out.rows).toEqual([]);
    expect(out.checks.some((c) => !c.ok)).toBe(true);
  });
});
