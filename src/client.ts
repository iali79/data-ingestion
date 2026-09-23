import type { ClaimedTask, ResultPayload, TaskKind } from './contract.js';
import type { FinancialsResult } from './financials/task.js';
import { EXTRACTOR_VERSION } from './contract.js';
import { backoffMs, sleep } from './http.js';
import { identityToken, mask } from './oidc.js';

export type SubmitOutcome = 'accepted' | 'lease_lost' | 'rejected';

/** Auth failures stop the whole run: retrying with the same identity cannot succeed. */
export class IngestAuthError extends Error {}

const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;

export class IngestClient {
  private readonly base: URL;

  constructor(
    baseUrl: string,
    private readonly audience: string,
  ) {
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    const local = this.base.hostname === 'localhost' || this.base.hostname === '127.0.0.1';
    if (this.base.protocol !== 'https:' && !(local && process.env.INGEST_ALLOW_INSECURE_LOCALHOST === '1')) {
      throw new Error('INGEST_API_URL must use https');
    }
  }

  async claim(kinds: TaskKind[]): Promise<ClaimedTask | null> {
    const response = await this.post('internal/extraction/claim', { kinds, extractorVersion: EXTRACTOR_VERSION });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`claim failed with HTTP ${response.status}`);
    }
    // The API wraps every response as `{ data: ... }`. Anything else is treated as an error, not
    // as an empty queue -- a silently misread response would leave the task leased and idle.
    const body = (await response.json()) as { data?: { task?: ClaimedTask | null } };
    const task = body.data?.task;
    if (task === undefined) throw new Error('claim response had an unexpected shape');
    if (task) mask(task.leaseToken);
    return task;
  }

  async submit(payload: ResultPayload | FinancialsResult): Promise<SubmitOutcome> {
    const response = await this.post('internal/extraction/results', payload);
    await response.body?.cancel();
    if (response.status === 202) return 'accepted';
    if (response.status === 409) return 'lease_lost';
    if (response.status === 400 || response.status === 422) return 'rejected';
    throw new Error(`submit failed with HTTP ${response.status}`);
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const url = new URL(path, this.base);
    const encoded = JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await this.bearer()}`,
            'content-type': 'application/json',
          },
          body: encoded,
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new IngestAuthError(`ingest API refused this run's identity (HTTP ${response.status})`);
        }
        if (response.status !== 429 && response.status < 500) return response;
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (error instanceof IngestAuthError) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < RETRIES) await sleep(backoffMs(attempt));
    }
    throw new Error(`ingest API unreachable: ${lastError instanceof Error ? lastError.message.slice(0, 120) : 'unknown error'}`);
  }

  /**
   * The workflow's OIDC token. `INGEST_DEV_TOKEN` exists only for running against a local API
   * outside Actions; the API refuses to start in production with its counterpart configured.
   */
  private async bearer(): Promise<string> {
    if (process.env.GITHUB_ACTIONS !== 'true' && process.env.INGEST_DEV_TOKEN) return process.env.INGEST_DEV_TOKEN;
    return identityToken(this.audience);
  }
}
