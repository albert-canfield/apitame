import {
  FatalProviderError,
  type Message,
  type ModelRequest,
  type ModelSession,
  type ModelTurn,
  type Provider,
  type ToolCall,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
/** Overloaded, rate limited or temporarily unavailable: worth another try. */
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface AnthropicOptions {
  /** Read from ANTHROPIC_API_KEY by the caller. Never logged or written to results. */
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  /** output_config.effort, for models that support it. Omitted means the model default. */
  effort?: string;
  /** Prompt caching (on by default, as in most agent clients). */
  cache?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

function toApiMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
      // The provider's own blocks go back unchanged (thinking blocks must not be edited).
      const content = m.providerContent ?? [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      ];
      return { role: 'assistant', content };
    }
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content || '(empty result)',
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

/**
 * Claude through the Messages API with client-side tool use, over plain fetch.
 * Usage comes from the API's `usage` field: uncached input, output, cache reads
 * and cache writes are kept apart.
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly estimatedUsage = false;
  // A private field, so the key cannot end up in JSON.stringify(provider) or a log of this object.
  readonly #apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly effort: string | undefined;
  private readonly cache: boolean;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly model: string,
    opts: AnthropicOptions,
  ) {
    if (!opts.apiKey) throw new FatalProviderError('ANTHROPIC_API_KEY is not set.');
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.effort = opts.effort;
    this.cache = opts.cache ?? true;
    this.maxRetries = opts.maxRetries ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  session(): ModelSession {
    return { next: (req) => this.complete(req) };
  }

  /** The request body, without credentials. Exposed for tests. */
  requestBody(req: ModelRequest): Record<string, unknown> {
    const breakpoint = this.cache ? { cache_control: { type: 'ephemeral' } } : {};
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      // A breakpoint after the system prompt caches tools plus system; the top-level
      // automatic breakpoint caches the growing conversation.
      system: [{ type: 'text', text: req.system, ...breakpoint }],
      tools: req.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        input_schema: t.inputSchema,
      })),
      messages: toApiMessages(req.messages),
      ...breakpoint,
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
    };
  }

  private scrub(text: string): string {
    return text.split(this.#apiKey).join('[REDACTED]');
  }

  private async complete(req: ModelRequest): Promise<ModelTurn> {
    const body = JSON.stringify(this.requestBody(req));
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': API_VERSION,
            'x-api-key': this.#apiKey,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          const delay = backoff(attempt);
          waitedMs += delay;
          await this.sleep(delay);
          continue;
        }
        // The original error is not attached as `cause`, so nothing unscrubbed reaches the output.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Could not reach the Anthropic API: ${this.scrub((err as Error).message)}`);
      }
      if (res.ok) return this.parse((await res.json()) as MessagesResponse, waitedMs);

      const detail = this.scrub(await errorDetail(res));
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new FatalProviderError(
          `Anthropic API refused the request (HTTP ${res.status}: ${detail}). Check ANTHROPIC_API_KEY and the model id "${this.model}".`,
        );
      }
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoff(attempt);
        waitedMs += delay;
        await this.sleep(delay);
        continue;
      }
      throw new Error(`Anthropic API error (HTTP ${res.status}: ${detail})`);
    }
  }

  private parse(data: MessagesResponse, waitedMs: number): ModelTurn {
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const toolCalls: ToolCall[] = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: String(b.id),
        name: String(b.name),
        input:
          b.input && typeof b.input === 'object' && !Array.isArray(b.input)
            ? (b.input as Record<string, unknown>)
            : {},
      }));
    const u = data.usage ?? {};
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
      stopReason: data.stop_reason ?? 'unknown',
      providerContent: content,
      waitedMs,
    };
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

function retryAfterMs(res: Response): number | undefined {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? Math.min(60_000, value * 1_000) : undefined;
}

async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
    if (parsed.error)
      return `${parsed.error.type ?? 'error'}: ${parsed.error.message ?? ''}`.trim();
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300) || res.statusText;
}
