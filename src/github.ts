import { backoffMs, sleep } from './http.js';

/**
 * The few GitHub release endpoints the document corpus needs, over plain `fetch`. Error messages
 * carry only a method, a path and a status -- never a token or a response body.
 */
const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
}

export interface Release {
  id: number;
  tag_name: string;
  upload_url: string;
}

export class GithubReleases {
  constructor(
    private readonly repo: string,
    private readonly token: string | null,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw new Error('invalid repository name');
  }

  async releaseByTag(tag: string): Promise<Release | null> {
    const response = await this.request('GET', `${API}/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (response.status === 404) return null;
    return (await expectOk(response, 'GET release')).json() as Promise<Release>;
  }

  async ensureRelease(tag: string, title: string, notes: string): Promise<Release> {
    const existing = await this.releaseByTag(tag);
    if (existing) return existing;
    const response = await this.request('POST', `${API}/repos/${this.repo}/releases`, {
      body: JSON.stringify({ tag_name: tag, name: title, body: notes, make_latest: 'false' }),
      contentType: 'application/json',
    });
    // 422: created by a concurrent publish between our read and write.
    if (response.status === 422) {
      const raced = await this.releaseByTag(tag);
      if (raced) return raced;
    }
    return (await expectOk(response, 'POST release')).json() as Promise<Release>;
  }

  async listAssets(releaseId: number): Promise<ReleaseAsset[]> {
    const assets: ReleaseAsset[] = [];
    for (let page = 1; ; page++) {
      const response = await this.request('GET', `${API}/repos/${this.repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
      const batch = (await (await expectOk(response, 'GET assets')).json()) as ReleaseAsset[];
      assets.push(...batch.map(({ id, name, size }) => ({ id, name, size })));
      if (batch.length < 100) return assets;
    }
  }

  async uploadAsset(release: Release, name: string, data: Buffer, contentType: string): Promise<ReleaseAsset> {
    const base = release.upload_url.replace(/\{.*\}$/u, '');
    const response = await this.request('POST', `${base}?name=${encodeURIComponent(name)}`, { body: data, contentType });
    const { id, size } = (await (await expectOk(response, 'POST asset')).json()) as ReleaseAsset;
    return { id, name, size };
  }

  async deleteAsset(id: number): Promise<void> {
    const response = await this.request('DELETE', `${API}/repos/${this.repo}/releases/assets/${id}`);
    if (response.status !== 404) await expectOk(response, 'DELETE asset');
  }

  async renameAsset(id: number, name: string): Promise<void> {
    const response = await this.request('PATCH', `${API}/repos/${this.repo}/releases/assets/${id}`, {
      body: JSON.stringify({ name }),
      contentType: 'application/json',
    });
    await expectOk(response, 'PATCH asset');
  }

  /**
   * Opens an asset's bytes. The API answers with a redirect to a signed download URL; it is
   * followed by hand so the token is never sent to the storage host.
   */
  async openAsset(id: number): Promise<Response> {
    const response = await this.request('GET', `${API}/repos/${this.repo}/releases/assets/${id}`, {
      accept: 'application/octet-stream',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || new URL(location).protocol !== 'https:') throw new Error('GET asset: bad redirect');
      return expectOk(await fetch(location, { redirect: 'follow' }), 'GET asset download');
    }
    return expectOk(response, 'GET asset');
  }

  private async request(
    method: string,
    url: string,
    options: { body?: string | Buffer; contentType?: string; accept?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      'user-agent': 'data-ingestion-corpus',
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.contentType) headers['content-type'] = options.contentType;
    let lastStatus = 'no response';
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: options.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!(response.status === 429 || response.status >= 500) || attempt === RETRIES) return response;
        await response.body?.cancel();
        lastStatus = `HTTP ${response.status}`;
      } catch (error) {
        lastStatus = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
        if (attempt === RETRIES) break;
      }
      await sleep(backoffMs(attempt));
    }
    throw new Error(`${method} ${new URL(url).pathname} failed: ${lastStatus}`);
  }
}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  await response.body?.cancel();
  throw new Error(`${what} failed with HTTP ${response.status}`);
}
