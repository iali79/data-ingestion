import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTables } from '../src/mufap/html-table.js';
import {
  PageShapeError,
  parseExpenses,
  parseMonthlyAum,
  parsePayouts,
  parsePerformance,
  parsePrices,
  splitCategory,
  toDate,
  toNumber,
} from '../src/mufap/pages.js';
import { buildDailySnapshot } from '../src/mufap/snapshot.js';
import { assertMufapUrl, classifyRefusal } from '../src/mufap/transport.js';

// Real MUFAP pages from 2026-10-09, cut down to ten funds (see test/fixtures/mufap).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/mufap/${name}.html`, import.meta.url), 'utf8');

describe('MUFAP performance page', () => {
  const rows = parsePerformance(fixture('performance'));
  const byId = new Map(rows.map((row) => [row.fundId, row]));

  it('keys every row by MUFAP fund id', () => {
    expect(rows).toHaveLength(10);
    expect(byId.size).toBe(10);
  });

  it('reads NAV, date, rating and returns, and splits the basis out of the category', () => {
    expect(byId.get(12768)).toMatchObject({
      name: 'ABL Cash Fund',
      sector: 'Open-End Funds',
      category: 'Money Market',
      returnBasis: 'Annualized Return',
      rating: 'AA+(f)',
      benchmark: null,
      validityDate: '2026-10-09',
      nav: 10.5664,
    });
    expect(byId.get(12768)!.returns).toMatchObject({ ytd: 10.83, mtd: 11.12, d1: 10.69, d365: 10.67, y3: 17.02 });
  });

  it('keeps pension sub-funds apart: same name, different ids and categories', () => {
    const subFunds = [12798, 12799, 12800].map((id) => byId.get(id)!);
    expect(new Set(subFunds.map((row) => row.name))).toEqual(new Set(['ABL Pension Fund']));
    expect(subFunds.map((row) => row.category)).toEqual(['VPS-Debt', 'VPS-Equity', 'VPS-Money Market']);
  });

  it('reads a published zero NAV as zero, for the consumer to reject', () => {
    expect(byId.get(12913)?.nav).toBe(0);
  });

  it('says plainly when it got a Cloudflare challenge instead of data', () => {
    expect(() => parsePerformance(fixture('challenge'))).toThrow(PageShapeError);
  });
});

describe('MUFAP prices, payouts, expenses and AUM pages', () => {
  it('reads offer, repurchase, loads as published, trustee and inception date', () => {
    const row = parsePrices(fixture('prices')).find((r) => r.fundId === 12768);
    expect(row).toMatchObject({
      amc: 'ABL Asset Management Company Limited',
      category: 'Money Market',
      inceptionDate: '2010-07-31',
      offer: 10.6583,
      repurchase: 10.5664,
      nav: 10.5664,
      frontEndLoad: '1',
      backEndLoad: '2',
      contingentLoad: '1',
      trustee: 'CDC',
    });
  });

  it('reads payouts', () => {
    const rows = parsePayouts(fixture('payouts'));
    expect(rows.find((r) => r.fundId === 12768)).toEqual({
      fundId: 12768,
      name: 'ABL Cash Fund',
      payoutPerUnit: 1.0559,
      exNav: 10.2552,
      payoutDate: '2026-06-29',
    });
  });

  it('reads expense ratios, management fee and selling and marketing', () => {
    expect(parseExpenses(fixture('expenses')).find((r) => r.fundId === 12768)).toMatchObject({
      terMtdPct: 0.96,
      terYtdPct: 1.15,
      managementFeePct: 0.7,
      sellingMarketingPct: 0,
    });
  });

  it('reads monthly AUM keyed by the id in each row allocation handler, with the month from the heading', () => {
    const aum = parseMonthlyAum(fixture('monthly-aum'));
    expect(aum.month).toBe('2026-09');
    expect(aum.rows.find((r) => r.fundId === 12768)).toMatchObject({ name: 'ABL Cash Fund', aumPkrMillions: 63394.05 });
  });
});

describe('daily snapshot', () => {
  const pages = {
    performance: parsePerformance(fixture('performance')),
    prices: parsePrices(fixture('prices')),
    expenses: parseExpenses(fixture('expenses')),
    payouts: parsePayouts(fixture('payouts')),
  };
  const run = { fetchedAt: '2026-10-09T14:00:00.000Z', runId: '1', runAttempt: 1 };

  it('merges the pages per fund id', () => {
    const snapshot = buildDailySnapshot(pages, run, 5);
    const fund = snapshot.funds.find((f) => f.fundId === 12768)!;
    expect(snapshot).toMatchObject({ schemaVersion: 1, kind: 'daily', runId: '1', runAttempt: 1 });
    expect(snapshot.funds).toHaveLength(10);
    expect(fund).toMatchObject({
      nav: 10.5664,
      offer: 10.6583,
      amc: 'ABL Asset Management Company Limited',
      returnBasis: 'Annualized Return',
      expenses: { terYtdPct: 1.15 },
      loads: { frontEnd: '1' },
    });
    expect(snapshot.payouts).toHaveLength(3);
  });

  it('refuses a snapshot with too few funds rather than sending a partial day', () => {
    expect(() => buildDailySnapshot(pages, run)).toThrow(/only 10 funds/);
  });
});

describe('parsing helpers', () => {
  it('turns MUFAP dates into ISO dates and rejects impossible ones', () => {
    expect(toDate(' Oct 09, 2026 ')).toBe('2026-10-09');
    expect(toDate('Feb 30, 2026')).toBeNull();
    expect(toDate('N/A')).toBeNull();
  });

  it('reads numbers with thousands separators and nothing else', () => {
    expect(toNumber('63,394.05')).toBe(63394.05);
    expect(toNumber('N/A')).toBeNull();
    expect(toNumber('-')).toBeNull();
  });

  it('splits a category label into category and return basis', () => {
    expect(splitCategory('Money Market (Annualized Return )')).toEqual({ category: 'Money Market', basis: 'Annualized Return' });
    expect(splitCategory('Equity')).toEqual({ category: 'Equity', basis: null });
  });

  it('decodes entities and attributes inside table cells', () => {
    const [table] = readTables('<table><tr><td><a href="/x?a=1&amp;b=2">S&amp;P&nbsp;Fund</a></td></tr></table>');
    expect(table?.[0]).toEqual({ cells: ['S&P Fund'], links: ['/x?a=1&b=2'], handlers: [] });
  });

  it('tells a Cloudflare challenge from a block page', () => {
    expect(classifyRefusal(fixture('challenge'))).toBe('challenge');
    expect(classifyRefusal('<title>Attention Required!</title><h1>Sorry, you have been blocked</h1>')).toBe('blocked');
    expect(classifyRefusal('<html>nope</html>')).toBe('other');
  });

  it('only lets MUFAP itself be fetched', () => {
    expect(assertMufapUrl('https://www.mufap.com.pk/Industry/IndustryStatDaily?tab=1').hostname).toBe('www.mufap.com.pk');
    expect(() => assertMufapUrl('https://example.com/')).toThrow();
    expect(() => assertMufapUrl('http://www.mufap.com.pk/')).toThrow();
  });
});
