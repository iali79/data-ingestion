import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../http.js';
import { SnapshotAuthError, submitSnapshot } from './ingest.js';
import {
  PAGES,
  PageShapeError,
  parseExpenses,
  parseMonthlyAum,
  parsePayouts,
  parsePerformance,
  parsePrices,
  type PageName,
} from './pages.js';
import { buildDailySnapshot } from './snapshot.js';
import { MufapRefusedError, mufapRequest } from './transport.js';

/**
 * MUFAP fund data, fetched on GitHub's runners so our servers carry none of it.
 *
 *   MUFAP_MODE=probe  fetch the pages, save them to MUFAP_OUT_DIR and report row counts. Sends
 *                     nothing anywhere; used to prove the runner can reach MUFAP at all.
 *   MUFAP_MODE=daily  fetch the daily pages, build one snapshot, submit it for staging.
 *
 * Public logs: page names, HTTP statuses, row counts and timings only.
 */
const PAGE_GAP_MS = 3_000;
const DAILY_PAGES: PageName[] = ['performanceAnnualised', 'prices', 'expenses', 'payouts'];
const PROBE_PAGES: PageName[] = [...DAILY_PAGES, 'monthlyAum'];

async function main(): Promise<void> {
  const mode = process.env.MUFAP_MODE ?? 'probe';
  const outDir = process.env.MUFAP_OUT_DIR;
  if (outDir) await mkdir(outDir, { recursive: true });

  if (mode === 'probe') {
    const lines: string[] = [];
    let failed = 0;
    for (const page of PROBE_PAGES) {
      const result = await fetchPage(page, outDir);
      lines.push(`${page}: ${result}`);
      if (!/^\d+ rows/.test(result)) failed += 1;
      await sleep(PAGE_GAP_MS);
    }
    await report('MUFAP probe', lines);
    if (failed > 0) process.exit(1);
    return;
  }

  if (mode === 'daily') {
    const html: Partial<Record<PageName, string>> = {};
    for (const page of DAILY_PAGES) {
      const started = Date.now();
      html[page] = (await mufapRequest(PAGES[page])).body;
      if (outDir) await writeFile(join(outDir, `${page}.html`), html[page]!);
      console.log(`${page}: fetched in ${Math.round((Date.now() - started) / 100) / 10}s`);
      await sleep(PAGE_GAP_MS);
    }
    const snapshot = buildDailySnapshot(
      {
        performance: parsePerformance(html.performanceAnnualised!),
        prices: parsePrices(html.prices!),
        expenses: parseExpenses(html.expenses!),
        payouts: parsePayouts(html.payouts!),
      },
      {
        fetchedAt: new Date().toISOString(),
        runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? '1'),
      },
    );
    const today = snapshot.funds.filter((fund) => fund.validityDate === snapshot.fetchedAt.slice(0, 10)).length;
    const outcome = await submitSnapshot(requireEnv('INGEST_API_URL'), requireEnv('MUFAP_OIDC_AUDIENCE'), snapshot);
    await report('MUFAP daily', [
      `funds=${snapshot.funds.length} dated_today_utc=${today} payouts=${snapshot.payouts.length}`,
      `submit=${outcome}`,
    ]);
    if (outcome === 'rejected') process.exit(1);
    return;
  }

  throw new Error(`unknown MUFAP_MODE ${mode}`);
}

async function fetchPage(page: PageName, outDir: string | undefined): Promise<string> {
  const started = Date.now();
  try {
    const { body } = await mufapRequest(PAGES[page]);
    if (outDir) await writeFile(join(outDir, `${page}.html`), body);
    const rows = page === 'monthlyAum' ? parseMonthlyAum(body).rows.length : rowsOf(page, body);
    return `${rows} rows in ${Math.round((Date.now() - started) / 100) / 10}s`;
  } catch (error) {
    if (error instanceof MufapRefusedError) return `refused (HTTP ${error.status})`;
    if (error instanceof PageShapeError) return `unreadable (${error.message})`;
    return `failed (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'})`;
  }
}

function rowsOf(page: PageName, body: string): number {
  switch (page) {
    case 'performanceAnnualised':
    case 'performanceAbsolute':
      return parsePerformance(body).length;
    case 'prices':
      return parsePrices(body).length;
    case 'expenses':
      return parseExpenses(body).length;
    case 'payouts':
      return parsePayouts(body).length;
    case 'monthlyAum':
      return parseMonthlyAum(body).rows.length;
  }
}

async function report(title: string, lines: string[]): Promise<void> {
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof SnapshotAuthError || error instanceof Error ? error.message : 'run failed');
  process.exit(1);
});
