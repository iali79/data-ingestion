import { describe, expect, it } from 'vitest';
import { parseOffMarket, parseReportDate } from '../../src/market/psx-omts.js';

/**
 * A made-up report in the layout PSX prints (members, companies and figures are invented: the real
 * document is PSX's and is not redistributed). Group totals and section turnovers add up.
 */
const REPORT = `
                 Pakistan Stock Exchange Limited
                                                   Off Market Transactions
PSX/N-000                                                                             Report For: November 16, 2026

BROKERS HAVE SUBSEQUENTLY REPORTED THE FOLLOWING TRANSACTIONS

BROKER TO BROKER
    Member Code                             Company                      Turnover of Shares               Rate
       Nos.
    (+) 011 (-) 022      Alpha Mills                                           200,000                   15.500
    (+) 011 (-) 022      Beta Cement Limited                                   135,881                   47.000
         Total                                                                 335,881                      -

    (+) 033 (-) 044      Alpha Mills                                           300,000                   12.500
         Total                                                                 300,000                      -

              Total Turnover                                               635,881


CROSS TRANSACTIONS BETWEEN CLIENT TO CLIENT & FINANCIAL INSTITUTIONS
  Member Code Nos.                          Company                       Turnover of Shares               Rate


         006            Gamma Textile Mills                                    900,000                    26.500

         006            Delta Oil                                               10,000                    77.500
         Total                                                                  910,000                     -

         022            Epsilon Bank                                            3,000                    29.110
         Total                                                                    3,000                     -

              Pakistan Stock Exchange Limited
                                                   Off Market Transactions
PSX/N-000                                                                          Report For: November 16, 2026

  Member Code Nos.                        Company                      Turnover of Shares               Rate

         984            Zeta Exchange                                         727,055                    51.820
         Total                                                                727,055                      -

              Total Turnover                                               1,640,055
`;

describe('parseReportDate', () => {
  it('reads the report date', () => expect(parseReportDate('Report For: November 16, 2026')).toBe('2026-11-16'));
  it('does not guess', () => expect(parseReportDate('Report For: Smarch 4, 2026')).toBeNull());
});

describe('a well-formed report', () => {
  const out = parseOffMarket(REPORT);

  it('passes every group and section total', () => {
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.tradeDate).toBe('2026-11-16');
  });

  it('reads broker-to-broker rows with both member codes', () => {
    const m2m = out.rows.filter((r) => r.section === 'm2m');
    expect(m2m).toHaveLength(3);
    expect(m2m[0]).toMatchObject({ rowNo: 1, buyerCode: '011', sellerCode: '022', company: 'Alpha Mills', shares: 200000, rate: 15.5, value: 3100000 });
    expect(m2m[1]!.company).toBe('Beta Cement Limited');
  });

  it('reads client rows with their member, across a repeated page header', () => {
    const c2c = out.rows.filter((r) => r.section === 'c2c');
    expect(c2c).toHaveLength(4);
    expect(c2c[0]).toMatchObject({ rowNo: 1, memberCode: '006', buyerCode: null, company: 'Gamma Textile Mills', shares: 900000 });
    expect(c2c.at(-1)).toMatchObject({ memberCode: '984', company: 'Zeta Exchange', value: 37675990.1 });
  });

  it('numbers rows within their section and never takes a total or a header for a row', () => {
    expect(out.rows.map((r) => `${r.section}${r.rowNo}`)).toEqual(['m2m1', 'm2m2', 'm2m3', 'c2c1', 'c2c2', 'c2c3', 'c2c4']);
  });
});

describe('a rate of a thousand rupees or more', () => {
  // PSX prints such a rate with a separator. Before this was read, the row was skipped and its
  // group failed its total (21 of 43 real reports from Aug-Sep 2026).
  const withRate = REPORT
    .replace(/(\s+006\s+Delta Oil\s+10,000\s+)77\.500/u, '$11,164.000')
    .replace(/(\(\+\) 033 \(-\) 044\s+Alpha Mills\s+300,000\s+)12\.500/u, '$12,012.250');
  const out = parseOffMarket(withRate);

  it('reads the row in both sections, and every total still adds up', () => {
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.rows.find((r) => r.company === 'Delta Oil')).toMatchObject({ shares: 10000, rate: 1164, value: 11640000 });
    expect(out.rows.find((r) => r.section === 'm2m' && r.buyerCode === '033')).toMatchObject({ rate: 2012.25, value: 603675000 });
  });
});

describe('a report that does not add up', () => {
  it('delivers nothing when a share count is altered', () => {
    const out = parseOffMarket(REPORT.replace('135,881', '136,881'));
    expect(out.rows).toEqual([]);
    expect(out.checks.find((c) => c.id.startsWith('group:m2m'))).toMatchObject({ ok: false });
  });

  it('delivers nothing when a row is missing from its group', () => {
    const out = parseOffMarket(REPORT.replace(/\n\s+006\s+Delta Oil[^\n]*\n/u, '\n'));
    expect(out.rows).toEqual([]);
    expect(out.checks.some((c) => !c.ok)).toBe(true);
  });

  it('delivers nothing from a different document', () => {
    const out = parseOffMarket('PETROL (MS) Price Effective November 17,2026, 00:00 hours');
    expect(out.rows).toEqual([]);
    expect(out.checks.some((c) => c.id === 'document' && !c.ok)).toBe(true);
  });

  it('accepts a quiet day: both sections empty and no totals printed', () => {
    const out = parseOffMarket('Off Market Transactions\nReport For: November 17, 2026\nBROKER TO BROKER\nCROSS TRANSACTIONS BETWEEN CLIENT TO CLIENT & FINANCIAL INSTITUTIONS\n');
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.rows).toEqual([]);
  });
});
