import { appendFile } from 'node:fs/promises';
import { IngestAuthError, IngestClient } from './client.js';
import { envelope, type ClaimedTask, type ResultPayload, type TaskKind } from './contract.js';
import { DocumentCorpus } from './corpus.js';
import { assertToolchain } from './extraction.js';
import { processFinancialsTask, type FinancialsResult } from './financials/task.js';
import { processTask } from './process.js';

/**
 * One worker: claim a task, extract it, submit the result, repeat -- until the queue is empty or
 * the time budget runs out. Several of these run side by side as a matrix.
 *
 * Logging is deliberately thin because Actions logs on a public repository are public: task id,
 * kind, symbol, outcome, counts and timings only. Never payloads, document text, tokens or API
 * responses.
 */
const TASK_TIMEOUT_MS = 20 * 60_000; // well inside the API's 30-minute lease

async function main(): Promise<void> {
  const apiUrl = requireEnv('INGEST_API_URL');
  const audience = requireEnv('INGEST_OIDC_AUDIENCE');
  const budgetMinutes = Number(process.env.RUN_BUDGET_MINUTES ?? '330');
  const deadline = Date.now() + (Number.isFinite(budgetMinutes) && budgetMinutes > 0 ? budgetMinutes : 330) * 60_000;
  const kinds = parseKinds(process.env.TASK_KINDS);
  const client = new IngestClient(apiUrl, audience);
  // Before claiming anything: a runner that can't OCR would lease work and return degraded
  // results. Checked everywhere except local API testing, where OCR may legitimately be absent.
  if (process.env.INGEST_SKIP_TOOLCHAIN_CHECK !== '1') await assertToolchain();
  // Reads saved text from this repository's releases (read-only token) and saves fresh text to
  // CORPUS_OUT_DIR for the separate publish job. Both are optional; without them every document
  // is downloaded and extracted as before.
  const corpus = await DocumentCorpus.open({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.CORPUS_TOKEN,
    read: process.env.CORPUS_READ !== '0',
    outDir: process.env.CORPUS_OUT_DIR,
    log: (message) => console.log(message),
  });
  console.log(`corpus: ${corpus.size} documents indexed`);
  // Statements go through the staged pipeline (Docling tables + rules + checks); notices through
  // the text parser.
  if (!process.env.DOCSTAGE_PYTHON) throw new Error('DOCSTAGE_PYTHON is not set: the table stage needs the Docling sidecar');

  const stats = { processed: 0, accepted: 0, failed: 0, leaseLost: 0, rejected: 0 };
  while (Date.now() < deadline) {
    const task = await client.claim(kinds);
    if (!task) break;

    const started = Date.now();
    const hitsBefore = corpus.stats.hits;
    const payload = await withTimeout(
      task.kind === 'financial_statement' ? processFinancialsTask(task) : processTask(task, corpus),
      TASK_TIMEOUT_MS,
      task,
    );
    const outcome = await client.submit(payload);
    stats.processed += 1;
    if (payload.outcome === 'failed') stats.failed += 1;
    if (outcome === 'accepted') stats.accepted += 1;
    if (outcome === 'lease_lost') stats.leaseLost += 1;
    if (outcome === 'rejected') stats.rejected += 1;

    console.log(
      `task ${task.id} ${task.kind} ${task.context.symbol} -> ${describe(payload)} [${outcome}]${corpus.stats.hits > hitsBefore ? ' (corpus)' : ''} ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }

  const summary = `processed=${stats.processed} accepted=${stats.accepted} failed=${stats.failed} lease_lost=${stats.leaseLost} rejected=${stats.rejected} corpus_hits=${corpus.stats.hits} corpus_saved=${corpus.stats.saved}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Extraction\n\n${summary}\n`);
}

function describe(payload: ResultPayload | FinancialsResult): string {
  if (payload.outcome === 'failed') return `failed:${payload.error.code}`;
  if ('periods' in payload) {
    const reported = payload.periods.reduce((sum, period) => sum + [period.income, period.balance, period.cashFlow].reduce((n, figures) => n + Object.values(figures).filter((figure) => figure?.source === 'reported').length, 0), 0);
    return `periods=${payload.periods.length} reported=${reported} pages=${payload.document.pagesRead}/${payload.document.pageCount} dropped=${payload.log.drops.length}`;
  }
  if ('statement' in payload) return `${payload.statement.status} lines=${payload.statement.lines.length}`;
  return `actions=${payload.corporateActions.length}`;
}

function withTimeout(work: Promise<ResultPayload | FinancialsResult>, ms: number, task: ClaimedTask): Promise<ResultPayload | FinancialsResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ResultPayload | FinancialsResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ ...envelope(task), outcome: 'failed', error: { code: 'extract_failed', message: 'extraction timed out' } }),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function parseKinds(raw: string | undefined): TaskKind[] {
  const all: TaskKind[] = ['financial_statement', 'corporate_action_notice'];
  if (!raw) return all;
  const picked = raw.split(',').map((kind) => kind.trim()).filter((kind): kind is TaskKind => all.includes(kind as TaskKind));
  return picked.length > 0 ? picked : all;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

main().catch((error: unknown) => {
  // Auth failures and config errors fail the job loudly; the message never includes a token.
  console.error(error instanceof IngestAuthError || error instanceof Error ? error.message : 'run failed');
  process.exit(1);
});
