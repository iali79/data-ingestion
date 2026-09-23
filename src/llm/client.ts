import { request } from 'node:http';

/**
 * Minimal client for a local llama.cpp server (`llama-server`) started by the workflow on the
 * runner itself. Nothing leaves the machine: the model, the page text and the answers all stay on
 * the runner. Output is constrained to a JSON schema by the server's grammar sampler, so the reply
 * always parses; whether its *content* is right is `statements/verify.ts`'s job.
 */
export interface LlmOptions {
  baseUrl: string;
  /** Per request. A CPU runner reads a statement page in well under this. */
  timeoutMs?: number;
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: LlmOptions) {
    const url = new URL(options.baseUrl);
    // The model server is always local; refusing anything else keeps page text on the runner.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LLM server must be local');
    this.baseUrl = url.toString().replace(/\/$/u, '');
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  static fromEnv(): LlmClient | null {
    const baseUrl = process.env.LLM_URL?.trim();
    return baseUrl ? new LlmClient({ baseUrl }) : null;
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async waitUntilReady(timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error('LLM server did not become ready');
  }

  /** One chat completion whose reply must match `schema`. Returns the parsed object. */
  async json<T>(system: string, user: string, schema: object, maxTokens: number): Promise<{ value: T; promptTokens: number; completionTokens: number }> {
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0,
      seed: 7,
      max_tokens: maxTokens,
      cache_prompt: true,
      response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema } },
    });
    // Plain http rather than fetch: a CPU model can take longer than fetch's fixed five-minute
    // wait for response headers, and this server is always local.
    const { status, text } = await post(`${this.baseUrl}/v1/chat/completions`, body, this.timeoutMs);
    if (status !== 200) throw new Error(`LLM request failed with HTTP ${status}`);
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('LLM reply was cut off');
    const content = choice?.message?.content;
    if (!content) throw new Error('LLM returned no content');
    return {
      value: JSON.parse(content) as T,
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    };
  }
}

function post(url: string, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('LLM request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
