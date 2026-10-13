import type { ToolDefinition } from '../types.js';

const PIECES = /[A-Za-z]+|\d+|\n+|[ \t]+|[^\sA-Za-z\d]+/g;

/**
 * Estimate how many tokens a text costs in a model's context.
 *
 * Exact counts depend on the model's tokenizer, which differs between
 * vendors. This approximates byte-pair encoding on JSON and English and is
 * calibrated to land about 15% above OpenAI's o200k_base on real tool lists,
 * because other tokenizers tend to count more tokens for the same JSON.
 * It needs no network and no large vocabulary files.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const m of text.matchAll(PIECES)) {
    const p = m[0];
    const c = p.charCodeAt(0);
    if (c === 32 || c === 9) {
      // A single space merges into the following word; long runs of spaces cost extra.
      tokens += p.length > 1 ? Math.ceil((p.length - 1) / 4) : 0;
      continue;
    }
    if (c === 10) {
      tokens += 1;
      continue;
    }
    if (/^[A-Za-z]/.test(p)) {
      // Split camelCase: tokenizers rarely keep long identifiers whole.
      for (const part of p.split(/(?<=[a-z])(?=[A-Z])/)) {
        const len = part.length;
        tokens += len <= 8 ? 1 : len <= 12 ? 2 : Math.ceil(len / 4.5);
      }
    } else if (/^\d/.test(p)) {
      tokens += Math.ceil(p.length / 3);
    } else {
      // Punctuation runs such as `":"` or `"},{"` usually merge into one or two tokens.
      tokens += Math.ceil(p.length / 3);
    }
  }
  return tokens;
}

/** The text a client puts in context for one tool: name, description and schema. */
export function serializeTool(tool: ToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  });
}

export interface ToolCost {
  name: string;
  tokens: number;
}

export interface ToolListCost {
  tools: ToolCost[];
  instructions: number;
  total: number;
}

export function toolListCost(tools: ToolDefinition[], instructions = ''): ToolListCost {
  const per = tools.map((t) => ({ name: t.name, tokens: estimateTokens(serializeTool(t)) }));
  const instr = instructions ? estimateTokens(instructions) : 0;
  return { tools: per, instructions: instr, total: per.reduce((n, t) => n + t.tokens, 0) + instr };
}
