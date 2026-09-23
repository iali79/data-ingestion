import { appendFile } from 'node:fs/promises';
import { IngestAuthError, IngestClient } from './client.js';
import { envelope, type ClaimedTask, type ResultPayload, type TaskKind } from './contract.js';
import { assertToolchain } from './extraction.js';
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

  const stats = { processed: 0, accepted: 0, failed: 0, leaseLost: 0, rejected: 0 };
  while (Date.now() < deadline) {
    const task = await client.claim(kinds);
    if (!task) break;

    const started = Date.now();
    const payload = await withTimeout(processTask(task), TASK_TIMEOUT_MS, task);
    const outcome = await client.submit(payload);
    stats.processed += 1;
    if (payload.outcome === 'failed') stats.failed += 1;
    if (outcome === 'accepted') stats.accepted += 1;
    if (outcome === 'lease_lost') stats.leaseLost += 1;
    if (outcome === 'rejected') stats.rejected += 1;

    console.log(
      `task ${task.id} ${task.kind} ${task.context.symbol} -> ${describe(payload)} [${outcome}] ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }

  const summary = `processed=${stats.processed} accepted=${stats.accepted} failed=${stats.failed} lease_lost=${stats.leaseLost} rejected=${stats.rejected}`;
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
