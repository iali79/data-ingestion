import { backoffMs, sleep } from '../http.js';
import { identityToken } from '../oidc.js';

/**
 * Hands a MUFAP snapshot to the ingest API. The API only stages it (our own workers validate it
 * again before anything is written), authenticates this run by its GitHub OIDC token, and accepts
 * tokens for this workflow file only -- not the extraction workflow's.
 */
export type SubmitOutcome = 'accepted' | 'duplicate' | 'rejected';

export class SnapshotAuthError extends Error {}

const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const PATH = 'internal/mufap/snapshots';

export async function submitSnapshot(baseUrl: string, audience: string, snapshot: unknown): Promise<SubmitOutcome> {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !(local && process.env.INGEST_ALLOW_INSECURE_LOCALHOST === '1')) {
    throw new Error('INGEST_API_URL must use https');
  }
  const url = new URL(PATH, base);
  const body = JSON.stringify(snapshot);

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await bearer(audience)}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new SnapshotAuthError(`ingest API refused this run's identity (HTTP ${response.status})`);
      }
      if (response.status === 202) return 'accepted';
      if (response.status === 409) return 'duplicate';
      if (response.status === 400 || response.status === 413 || response.status === 422) return 'rejected';
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof SnapshotAuthError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < RETRIES) await sleep(backoffMs(attempt));
  }
  throw new Error(`ingest API unreachable: ${lastError instanceof Error ? lastError.message.slice(0, 120) : 'unknown error'}`);
}

/** Same rule as the extraction client: a dev token only outside Actions, for a local API. */
async function bearer(audience: string): Promise<string> {
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.INGEST_DEV_TOKEN) return process.env.INGEST_DEV_TOKEN;
  return identityToken(audience);
}
