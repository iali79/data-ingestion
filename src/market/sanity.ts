/**
 * Checks that need only the document, run after a parser has read it. Each parser already checks the
 * document's printed totals; these add what a total cannot catch: a misread digit that still adds up
 * across a column breaks the identity on its own row.
 *
 * Every hard check here held on every real document the parsers accepted when it was added (80 OGRA
 * publications, 94 PCGA reports and 3,384 cotton rows, 42 PSX off-market reports, 2016 to 2026). A
 * check that a genuine document could fail is `advisory`: it is reported but delivers the rows.
 *
 * The ingest API runs the same hard checks again; it does not rely on these having run.
 */
import type { MarketCheck, MarketDataset, MarketRow } from './index.js';

/** No dataset here has documents before this; an earlier date is a misread year. */
const EARLIEST = '2010-01-01';
/** OGRA publishes the evening before a price takes effect, so an as-of date may be a day ahead. */
const DAYS_AHEAD = 2;
/** Pump prices in rupees per litre: 50 is below any price since 2010, 1,000 is far above any to date. */
const RETAIL_RANGE = [50, 1_000] as const;

const num = (row: MarketRow, field: string): number => Number(row[field]);

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function check(id: string, failures: string[], extra: { advisory?: boolean } = {}): MarketCheck {
  return { id, ok: failures.length === 0, ...extra, ...(failures.length ? { detail: failures.slice(0, 5).join('; ') } : {}) };
}

function dateWindow(asOf: string, today: string): MarketCheck {
  const latest = addDays(today, DAYS_AHEAD);
  const bad = asOf < EARLIEST || asOf > latest ? [`${asOf} is outside ${EARLIEST} to ${latest}`] : [];
  return check('sanity:date-window', bad);
}

function ogra(rows: MarketRow[]): MarketCheck[] {
  const products = new Set(rows.map((r) => String(r.product)));
  const missing = ['MS', 'HSD'].filter((p) => !products.has(p)).map((p) => `${p} has no rows`);
  const prices = rows
    .filter((r) => r.component === 'retail')
    .filter((r) => !(num(r, 'value') >= RETAIL_RANGE[0] && num(r, 'value') <= RETAIL_RANGE[1]))
    .map((r) => `${String(r.product)} retail ${String(r.value)} is outside ${RETAIL_RANGE[0]} to ${RETAIL_RANGE[1]}`);
  return [check('sanity:both-products', missing), check('sanity:retail-range', prices)];
}

function pcga(asOf: string, rows: MarketRow[]): MarketCheck[] {
  const where = (r: MarketRow) => `${String(r.region)}/${String(r.district)}`;
  const sold: string[] = [];
  const unsold: string[] = [];
  const unginned: string[] = [];
  const pressed: string[] = [];
  for (const r of rows) {
    const [arrivals, press, total] = [num(r, 'arrivals'), num(r, 'pressed'), num(r, 'soldTotal')];
    const parts = num(r, 'soldTcp') + num(r, 'soldExporters') + num(r, 'soldTextiles');
    if (parts !== total) sold.push(`${where(r)}: sold ${parts}, total prints ${total}`);
    if (press - total !== num(r, 'unsold')) unsold.push(`${where(r)}: pressed less sold is ${press - total}, unsold prints ${num(r, 'unsold')}`);
    if (arrivals - press !== num(r, 'unginned')) unginned.push(`${where(r)}: arrivals less pressed is ${arrivals - press}, unginned prints ${num(r, 'unginned')}`);
    if (press > arrivals) pressed.push(`${where(r)}: pressed ${press} is more than arrivals ${arrivals}`);
  }
  const checks = [
    check('sanity:sold-adds-up', sold),
    check('sanity:unsold', unsold),
    check('sanity:unginned', unginned),
    check('sanity:pressed-within-arrivals', pressed),
  ];
  // The season (June to May) is printed on reports from 2022 on; older ones carry none.
  const season = rows.find((r) => typeof r.season === 'string')?.season;
  if (typeof season === 'string') {
    const start = Number(season.slice(0, 4));
    const ok = asOf >= `${start}-06-01` && asOf <= `${start + 1}-05-31`;
    checks.push(check('sanity:season', ok ? [] : [`${asOf} is not in season ${season}`]));
  }
  return checks;
}

function offMarket(asOf: string): MarketCheck[] {
  // Advisory: PSX has held special sessions on a Saturday; such a report would be genuine.
  const day = new Date(`${asOf}T00:00:00Z`).getUTCDay();
  return [check('sanity:weekday', day === 0 || day === 6 ? [`${asOf} is a weekend`] : [], { advisory: true })];
}

/** The checks for a document whose own totals already held. `today` is `YYYY-MM-DD`. */
export function sanityChecks(dataset: MarketDataset, asOf: string, rows: MarketRow[], today: string): MarketCheck[] {
  if (rows.length === 0) return [];
  const checks = [dateWindow(asOf, today)];
  if (dataset === 'ogra-prices') checks.push(...ogra(rows));
  if (dataset === 'pcga-cotton') checks.push(...pcga(asOf, rows));
  if (dataset === 'psx-off-market') checks.push(...offMarket(asOf));
  return checks;
}
