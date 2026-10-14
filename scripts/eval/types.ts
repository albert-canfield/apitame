import type { Task } from './tasks.js';

/** The three tool surfaces under test. They differ only in the `tools` and `longTail` config. */
export const SURFACES = ['curated', 'per-endpoint', 'search-only'] as const;
export type SurfaceId = (typeof SURFACES)[number];

export const SURFACE_LABELS: Record<SurfaceId, string> = {
  curated: 'Curated (example config)',
  'per-endpoint': 'One tool per endpoint',
  'search-only': 'Search and call only',
};

/** A tool as returned by `tools/list`. */
export interface ToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * Provider-neutral conversation. `providerContent` keeps the provider's own
 * assistant blocks (for example thinking blocks) so they can be sent back unchanged.
 */
export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; providerContent?: unknown }
  | { role: 'tool'; results: ToolOutcome[] };

export interface Usage {
  /** Prompt tokens billed at the full input price (not read from or written to the cache). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelRequest {
  system: string;
  tools: ToolSpec[];
  messages: Message[];
}

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Provider stop reason, for example `tool_use` or `end_turn`. */
  stopReason: string;
  providerContent?: unknown;
  /** Time spent waiting before retries, excluded from wall time. */
  waitedMs?: number;
}

export interface ModelSession {
  next(req: ModelRequest): Promise<ModelTurn>;
}

export interface Provider {
  /** `anthropic` or `fake`. */
  readonly name: string;
  readonly model: string;
  /** True when token counts are estimated by apitame rather than reported by the provider. */
  readonly estimatedUsage: boolean;
  /** One session per run. The fake model reads its script from the task. */
  session(task: Task, surface: SurfaceId): ModelSession;
}

/** A provider error that makes every further run pointless (bad key, no access to the model). */
export class FatalProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalProviderError';
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
