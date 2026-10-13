import type { ToolResult } from '../types.js';

/** Compact JSON (no indentation): it is read by a model, and whitespace costs tokens. */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, jsonReplacer) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Makes database values JSON safe: bigint, Buffer and Date. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer') {
    const data = (value as { data?: number[] }).data ?? [];
    return `<binary ${data.length} bytes>`;
  }
  return value;
}
