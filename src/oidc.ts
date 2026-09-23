/**
 * Short-lived GitHub OIDC identity token for this workflow run. The ingest API verifies it
 * against GitHub's public keys and checks which repository, branch and workflow it was issued
 * to, so the repository needs no stored credential at all.
 *
 * GitHub's tokens live about five minutes; one is cached for four and then refreshed.
 */
const REFRESH_AFTER_MS = 4 * 60_000;

let cached: { value: string; fetchedAt: number } | null = null;

export async function identityToken(audience: string): Promise<string> {
  if (cached && Date.now() - cached.fetchedAt < REFRESH_AFTER_MS) return cached.value;

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error('No OIDC token available: the job needs `permissions: id-token: write`.');
  }

  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { authorization: `bearer ${requestToken}` } });
  if (!response.ok) throw new Error(`OIDC token request failed with HTTP ${response.status}`);
  const body = (await response.json()) as { value?: unknown };
  if (typeof body.value !== 'string' || body.value.length < 20) throw new Error('OIDC token response was malformed');

  mask(body.value);
  cached = { value: body.value, fetchedAt: Date.now() };
  return body.value;
}

/** Hide a value from the public Actions log for the rest of the job. */
export function mask(value: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${value}\n`);
}
