import type { Usage } from './types.js';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Public list prices (input, output) in USD per million tokens, as of October 2026.
 * Used only for the cost estimate in the summary. Check the provider's pricing page
 * before publishing, or pass --price-input and --price-output.
 */
const LIST_PRICES: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

/** Prompt caching: reads cost 0.1x the input price, 5-minute writes 1.25x. */
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

function withCache(input: number, output: number): Price {
  return { input, output, cacheRead: input * CACHE_READ, cacheWrite: input * CACHE_WRITE };
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
  return withCache(input, output);
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
