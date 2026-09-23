import { DocumentExtractionError } from './errors.js';

/**
 * The only hosts a document may be downloaded from. The ingest API applies the same allowlist
 * before handing a task out; this is the second, independent check, so a bad task row can never
 * turn the runner into a fetcher of arbitrary URLs.
 */
export const ALLOWED_DOCUMENT_HOSTS: ReadonlySet<string> = new Set(['financials.psx.com.pk', 'dps.psx.com.pk']);

const MAX_REDIRECTS = 3;
const HEADER_TIMEOUT_MS = 30_000;
const RETRIES = 3;

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'application/pdf,text/html,text/plain,*/*',
};

export function assertAllowedDocumentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DocumentExtractionError('host_not_allowed', 'document URL is not a valid URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !ALLOWED_DOCUMENT_HOSTS.has(url.hostname)) {
    throw new DocumentExtractionError('host_not_allowed', `document host is not on the allowlist`);
  }
  return url;
}

/**
 * GET a document, following redirects by hand so every hop is re-checked against the allowlist
 * (`redirect: 'follow'` would let an allowed URL bounce anywhere). Retries only transport errors
 * and 408/429/5xx -- any other 4xx means the request itself is wrong.
 */
export async function fetchDocument(raw: string): Promise<Response> {
  let url = assertAllowedDocumentUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchWithRetry(url);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new DocumentExtractionError('download_failed', `redirect without a location`);
      url = assertAllowedDocumentUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DocumentExtractionError('download_failed', `download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new DocumentExtractionError('download_failed', `more than ${MAX_REDIRECTS} redirects`);
}

async function fetchWithRetry(url: URL): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    try {
      const response = await fetch(url, { headers: HEADERS, redirect: 'manual', signal: controller.signal });
      if (!isRetryable(response.status) || attempt === RETRIES) return response;
      await response.body?.cancel();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES) break;
    } finally {
      clearTimeout(timer);
    }
    await sleep(backoffMs(attempt));
  }
  throw new DocumentExtractionError('download_failed', `download failed: ${describe(lastError)}`);
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'timed out' : error.message.slice(0, 200);
  return 'unknown error';
}
