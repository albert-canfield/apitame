import type { Usage } from './types.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Public list prices in USD per million tokens (input, output, cache hit as a fraction of
 * input), from https://platform.claude.com/docs/en/about-claude/pricing in October 2026.
 * Used only for the cost estimate in the summary. Check the page before publishing, or
 * pass --price-input and --price-output.
 */
const LIST_PRICES: Record<string, [number, number, number]> = {
  'claude-fable-5-1': [10, 50, 0.025],
  'claude-opus-5-5': [4, 20, 0.05],
  'claude-sonnet-5': [2, 10, 0.1],
  'claude-haiku-4-5': [1, 5, 0.1],
};

/** Five-minute cache writes cost 1.25x the input price on every listed model. */
const CACHE_WRITE = 1.25;

function withCache(input: number, output: number, cacheHit = 0.1): Price {
  return { input, output, cacheRead: input * cacheHit, cacheWrite: input * CACHE_WRITE };
}

/** The price for a model id. Dated ids (`claude-haiku-4-5-20251001`) use their alias. */
export function priceFor(
  model: string,
  override: { input?: number; output?: number } = {},
): Price | undefined {
  const known = LIST_PRICES[model] ?? LIST_PRICES[model.replace(/-\d{8}$/, '')];
  const input = override.input ?? known?.[0];
  const output = override.output ?? known?.[1];
  if (input === undefined || output === undefined) return undefined;
  return withCache(input, output, known?.[2]);
}

export function costOf(usage: Usage, price: Price | undefined): number | null {
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
