import { fetchDocument } from '../http.js';
import type { PriceLookup } from './derive.js';

/**
 * Closing prices from PSX's own end-of-day series (dps.psx.com.pk, on the download allowlist).
 * The series is back-adjusted for bonus issues and splits but not for dividends, so a multiple
 * computed from it matches the per-share figures of the latest filings; each derived value names
 * the close it used.
 */
const MAX_GAP_DAYS = 10;

export async function psxPriceLookup(symbol: string): Promise<PriceLookup> {
  if (!/^[A-Z0-9-]{1,12}$/u.test(symbol)) return () => null;
  let series: Array<[number, number]> = [];
  try {
    const response = await fetchDocument(`https://dps.psx.com.pk/timeseries/eod/${encodeURIComponent(symbol)}`);
    const body = (await response.json()) as { data?: unknown };
    if (Array.isArray(body.data)) {
      series = body.data
        .filter((row): row is [number, number] => Array.isArray(row) && typeof row[0] === 'number' && typeof row[1] === 'number' && row[1] > 0)
        .map((row) => [row[0] * 1000, row[1]] as [number, number])
        .sort((a, b) => a[0] - b[0]);
    }
  } catch {
    series = [];
  }
  return (date: string) => {
    const end = Date.parse(`${date}T23:59:59Z`);
    let best: [number, number] | null = null;
    for (const point of series) {
      if (point[0] > end) break;
      best = point;
    }
    if (!best || end - best[0] > MAX_GAP_DAYS * 86_400_000) return null;
    return { close: best[1], date: new Date(best[0]).toISOString().slice(0, 10), source: 'PSX end-of-day close' };
  };
}
