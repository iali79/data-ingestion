import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyLabel, parseEffectiveDate, parsePricePublication, type OgraComponent, type OgraProduct } from '../../src/market/ogra.js';

const sample = (name: string): string => readFileSync(new URL(`../../samples/market/ogra/${name}`, import.meta.url), 'utf8');

const value = (rows: { product: OgraProduct; component: OgraComponent; value: number }[], product: OgraProduct, component: OgraComponent) =>
  rows.find((r) => r.product === product && r.component === component)?.value;

describe('parseEffectiveDate', () => {
  it.each([
    ['November 17,2026', '2026-11-17'],
    ['21 July 2026', '2026-07-21'],
    ['18 September 2026', '2026-09-18'],
    ['January 3, 2027', '2027-01-03'],
  ])('reads %s', (text, iso) => expect(parseEffectiveDate(text)).toBe(iso));

  it('refuses a month it does not know', () => expect(parseEffectiveDate('Smarch 4, 2026')).toBeNull());
});

describe('classifyLabel', () => {
  it('keeps the levy lines apart', () => {
    expect(classifyLabel('Petroleum Levy (PL)')).toBe('pl');
    expect(classifyLabel('Petroleum Levy (PL) through Refineries')).toBe('plrefineries');
    expect(classifyLabel('Petroleum Levy (PL) direct')).toBe('pldirect');
    expect(classifyLabel('Exchange Rate Adjustment')).toBe('fxadjustment');
    expect(classifyLabel('SBP Avg. Exchange Rate')).toBe('fx');
  });
  it('does not store the rounding account or the conversion factor', () => {
    expect(classifyLabel('Opening Adjustment')).toBeNull();
    expect(classifyLabel('Current Roundung-off Adjustment')).toBeNull();
    expect(classifyLabel('Conversion Factor')).toBeNull();
  });
});

describe('the 17 Nov 2026 publication (rounding line, refinery levy)', () => {
  const out = parsePricePublication(sample('price-publication-2026-11-17.txt'));

  it('reads the date and delivers both products with every check passing', () => {
    expect(out.effectiveDate).toBe('2026-11-17');
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(new Set(out.rows.map((r) => r.product))).toEqual(new Set(['MS', 'HSD']));
  });

  it('matches the pump price and the breakup AHL republishes', () => {
    expect(value(out.rows, 'MS', 'retail')).toBe(328);
    expect(value(out.rows, 'MS', 'exrefinery')).toBe(232.98);
    expect(value(out.rows, 'MS', 'pl')).toBe(80);
    expect(value(out.rows, 'MS', 'plrefineries')).toBe(-16.36);
    expect(value(out.rows, 'MS', 'csl')).toBe(5);
    expect(value(out.rows, 'MS', 'ifem')).toBe(8.13);
    expect(value(out.rows, 'MS', 'omcmargin')).toBe(7.87);
    expect(value(out.rows, 'MS', 'dealermargin')).toBe(9.98);
    expect(value(out.rows, 'MS', 'rounding')).toBe(0.4);
    expect(value(out.rows, 'HSD', 'retail')).toBe(358);
    expect(value(out.rows, 'HSD', 'exrefinery')).toBe(247.43);
    expect(value(out.rows, 'HSD', 'ifem')).toBe(8.09);
    expect(value(out.rows, 'HSD', 'rounding')).toBe(-0.37);
  });

  it('reads a label that wraps onto the next line (diesel crude, the final price)', () => {
    expect(value(out.rows, 'HSD', 'platts')).toBe(91.5);
    expect(value(out.rows, 'MS', 'calculated')).toBe(327.6);
  });

  it('does not take the rounding account for a price component', () => {
    expect(out.rows.filter((r) => r.product === 'MS' && r.component === 'rounding')).toHaveLength(1);
  });
});

describe('older layouts', () => {
  it('reads 18 Sep 2026 (no rounding line, "Price before Sales Tax" on diesel)', () => {
    const out = parsePricePublication(sample('price-publication-2026-09-18.txt'));
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.effectiveDate).toBe('2026-09-18');
    expect(value(out.rows, 'MS', 'retail')).toBe(390.79);
    expect(value(out.rows, 'HSD', 'retail')).toBe(424.92);
    expect(value(out.rows, 'HSD', 'crack')).toBe(41.89);
  });

  it('reads 21 Jul 2026, the first daily publication (refinery levy absent, diesel levy 70.82)', () => {
    const out = parsePricePublication(sample('price-publication-2026-07-21.txt'));
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.effectiveDate).toBe('2026-07-21');
    expect(value(out.rows, 'MS', 'retail')).toBe(315.8);
    expect(value(out.rows, 'HSD', 'retail')).toBe(360.06);
    expect(value(out.rows, 'HSD', 'pl')).toBe(70.82);
    expect(value(out.rows, 'MS', 'plrefineries')).toBeUndefined();
  });
});

describe('a document that does not add up', () => {
  const nov = sample('price-publication-2026-11-17.txt');

  it('delivers nothing for a product whose printed pump price is wrong, and says which check failed', () => {
    const tampered = nov.replace(/(Total Petrol Price \(excl\. Secondary\s*\n\s*RS\/LTR\s+X\s+)328\.00/u, '$1329.00');
    expect(tampered).not.toBe(nov);
    const out = parsePricePublication(tampered);
    expect(out.rows.filter((r) => r.product === 'MS')).toEqual([]);
    expect(out.checks.find((c) => c.id === 'MS:retail')).toMatchObject({ ok: false });
    // The other product is checked on its own and still delivered.
    expect(value(out.rows, 'HSD', 'retail')).toBe(358);
  });

  it('delivers nothing from a document with no price headings', () => {
    const out = parsePricePublication('Pakistan Stock Exchange\nOff Market Transactions\n');
    expect(out.rows).toEqual([]);
    expect(out.checks.some((c) => !c.ok)).toBe(true);
  });

  it('refuses two headings that disagree about the date', () => {
    const out = parsePricePublication(nov.replace('Diesel (HSD) Price Effective November 17,2026', 'Diesel (HSD) Price Effective November 18,2026'));
    expect(out.rows).toEqual([]);
    expect(out.checks.find((c) => c.id === 'effective-date')).toMatchObject({ ok: false });
  });
});
