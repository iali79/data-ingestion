import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffMs, sleep } from '../http.js';

/**
 * HTTP for mufap.com.pk. The site sits behind a Cloudflare challenge that every ordinary client
 * gets (Node's fetch, curl, headless Chromium alike); a client presenting Chrome's TLS and HTTP/2
 * fingerprint is served normally. That client is curl-impersonate's Chrome wrapper, installed by
 * the workflow at a pinned version and checksum, and found through MUFAP_CURL.
 *
 * Only MUFAP's own host is reachable through here.
 */
export const MUFAP_HOST = 'www.mufap.com.pk';

const RETRIES = 3;
const MAX_TIME_SECONDS = 90;

export interface MufapResponse {
  status: number;
  body: string;
}

export interface MufapRequest {
  method?: 'GET' | 'POST';
  /** JSON request body; sent with `content-type: application/json`. */
  json?: unknown;
  referer?: string;
}

/** Thrown for answers no retry can fix: a challenge page or a 4xx. */
export class MufapRefusedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function assertMufapUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.hostname !== MUFAP_HOST || url.username || url.password) {
    throw new Error('only https://www.mufap.com.pk may be fetched');
  }
  return url;
}

export async function mufapRequest(raw: string, request: MufapRequest = {}): Promise<MufapResponse> {
  const url = assertMufapUrl(raw);
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await curl(url, request);
      if (response.status === 200) return response;
      if (response.status === 403 || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
        throw new MufapRefusedError(`${url.pathname} answered HTTP ${response.status}`, response.status);
      }
      lastError = new Error(`${url.pathname} answered HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof MufapRefusedError) throw error;
      lastError = error;
    }
    if (attempt < RETRIES) await sleep(backoffMs(attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`${url.pathname} failed`);
}

async function curl(url: URL, request: MufapRequest): Promise<MufapResponse> {
  const binary = process.env.MUFAP_CURL;
  if (!binary) throw new Error('MUFAP_CURL is not set: the workflow installs curl-impersonate and points it here');

  const dir = await mkdtemp(join(tmpdir(), 'mufap-'));
  const out = join(dir, 'body');
  const args = ['--silent', '--show-error', '--compressed', '--max-time', String(MAX_TIME_SECONDS), '--output', out, '--write-out', '%{http_code}'];
  if (request.referer) args.push('--header', `referer: ${request.referer}`);
  if (request.method === 'POST') {
    args.push('--request', 'POST', '--header', 'content-type: application/json;charset=utf-8', '--data-binary', '@-');
  }
  args.push(url.toString());

  try {
    const status = await run(binary, args, request.method === 'POST' ? JSON.stringify(request.json ?? {}) : undefined);
    const body = await readFile(out, 'utf8').catch(() => '');
    return { status, body };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(binary: string, args: string[], stdin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const status = Number(stdout.trim());
      if (code === 0 && Number.isInteger(status) && status > 0) resolve(status);
      else reject(new Error(`curl exited ${code}: ${stderr.trim().slice(0, 200) || 'no output'}`));
    });
    child.stdin.end(stdin ?? '');
  });
}
