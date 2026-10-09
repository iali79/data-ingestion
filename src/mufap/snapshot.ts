import type { ExpenseRow, PayoutRow, PerformanceRow, PriceRow, Returns } from './pages.js';

/**
 * What one daily run sends to the ingest API: every fund MUFAP lists, merged across its
 * performance (tab 1), prices and loads (tab 3) and expenses (tab 5) pages by MUFAP's fund id,
 * plus the payouts page (tab 4). Tab 2 is not fetched: it served the same figures as tab 1 for
 * every fund when this was written (2026-10-09).
 *
 * The API only stages this; our own workers validate it again and decide what to write.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Fewer funds than this means a broken or partial page, not a quiet day. */
export const MIN_FUNDS = 300;

export interface MufapFund {
  fundId: number;
  name: string;
  sector: string;
  amc: string | null;
  category: string;
  /** "Annualized Return" or "Absolute Return": how MUFAP states this fund's returns. */
  returnBasis: string | null;
  rating: string | null;
  benchmark: string | null;
  trustee: string | null;
  inceptionDate: string | null;
  /** NAV and its date from the performance page. */
  nav: number | null;
  validityDate: string | null;
  /** Offer and repurchase from the prices page, with that page's own date. */
  offer: number | null;
  repurchase: number | null;
  pricesValidityDate: string | null;
  loads: { frontEnd: string | null; backEnd: string | null; contingent: string | null; market: string | null } | null;
  returns: Returns;
  expenses: {
    terMtdPct: number | null;
    terYtdPct: number | null;
    managementFeePct: number | null;
    sellingMarketingPct: number | null;
  } | null;
}

export interface MufapPayout {
  fundId: number;
  payoutPerUnit: number | null;
  exNav: number | null;
  payoutDate: string | null;
}

export interface DailySnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  kind: 'daily';
  fetchedAt: string;
  runId: string;
  runAttempt: number;
  funds: MufapFund[];
  payouts: MufapPayout[];
}

export interface DailyPages {
  performance: PerformanceRow[];
  prices: PriceRow[];
  expenses: ExpenseRow[];
  payouts: PayoutRow[];
}

export function buildDailySnapshot(
  pages: DailyPages,
  run: { fetchedAt: string; runId: string; runAttempt: number },
  minFunds = MIN_FUNDS,
): DailySnapshot {
  const prices = new Map(pages.prices.map((row) => [row.fundId, row]));
  const expenses = new Map(pages.expenses.map((row) => [row.fundId, row]));
  const performance = new Map(pages.performance.map((row) => [row.fundId, row]));
  const ids = new Set([...performance.keys(), ...prices.keys()]);

  const funds: MufapFund[] = [];
  for (const fundId of [...ids].sort((a, b) => a - b)) {
    const perf = performance.get(fundId);
    const price = prices.get(fundId);
    const expense = expenses.get(fundId);
    funds.push({
      fundId,
      name: perf?.name || price?.name || '',
      sector: perf?.sector || price?.sector || '',
      amc: price?.amc || null,
      category: perf?.category || price?.category || '',
      returnBasis: perf?.returnBasis ?? null,
      rating: perf?.rating ?? null,
      benchmark: perf?.benchmark ?? null,
      trustee: price?.trustee ?? null,
      inceptionDate: price?.inceptionDate ?? null,
      nav: perf ? perf.nav : (price?.nav ?? null),
      validityDate: perf ? perf.validityDate : (price?.validityDate ?? null),
      offer: price?.offer ?? null,
      repurchase: price?.repurchase ?? null,
      pricesValidityDate: price?.validityDate ?? null,
      loads: price
        ? {
            frontEnd: price.frontEndLoad,
            backEnd: price.backEndLoad,
            contingent: price.contingentLoad,
            market: price.marketLoad,
          }
        : null,
      returns: perf?.returns ?? {},
      expenses: expense
        ? {
            terMtdPct: expense.terMtdPct,
            terYtdPct: expense.terYtdPct,
            managementFeePct: expense.managementFeePct,
            sellingMarketingPct: expense.sellingMarketingPct,
          }
        : null,
    });
  }

  const missingNames = funds.filter((fund) => !fund.name).length;
  if (funds.length < minFunds) throw new Error(`only ${funds.length} funds parsed (expected at least ${minFunds})`);
  if (missingNames > 0) throw new Error(`${missingNames} funds have no name`);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: 'daily',
    fetchedAt: run.fetchedAt,
    runId: run.runId,
    runAttempt: run.runAttempt,
    funds,
    payouts: pages.payouts.map(({ fundId, payoutPerUnit, exNav, payoutDate }) => ({
      fundId,
      payoutPerUnit,
      exNav,
      payoutDate,
    })),
  };
}
