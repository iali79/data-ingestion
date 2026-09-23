import { appendFile } from 'node:fs/promises';
import { IngestAuthError, IngestClient } from './client.js';
import { envelope, type ClaimedTask, type ResultPayload, type TaskKind } from './contract.js';
import { DocumentCorpus } from './corpus.js';
import { assertToolchain } from './extraction.js';
import { LlmClient } from './llm/client.js';
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
  // The local model reads statement pages; without it the rule-based parser is used.
  const llm = LlmClient.fromEnv();
  if (llm) await llm.waitUntilReady();
  console.log(`statements: ${llm ? 'local model + verification' : 'rule-based parser'}`);

  const stats = { processed: 0, accepted: 0, failed: 0, leaseLost: 0, rejected: 0 };
  while (Date.now() < deadline) {
    const task = await client.claim(kinds);
    if (!task) break;

    const started = Date.now();
    const hitsBefore = corpus.stats.hits;
    const payload = await withTimeout(processTask(task, corpus, llm), TASK_TIMEOUT_MS, task);
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

function describe(payload: ResultPayload): string {
  if (payload.outcome === 'failed') return `failed:${payload.error.code}`;
  if ('statement' in payload) return `${payload.statement.status} lines=${payload.statement.lines.length}`;
  return `actions=${payload.corporateActions.length}`;
}

function withTimeout(work: Promise<ResultPayload>, ms: number, task: ClaimedTask): Promise<ResultPayload> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ResultPayload>((resolve) => {
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
