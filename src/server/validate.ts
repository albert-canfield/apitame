import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { JsonSchema } from '../types.js';

/**
 * Argument validation for tool calls. Types are coerced where unambiguous
 * ("42" to 42), because agents often stringify numbers.
 */
export class ArgValidator {
  private readonly ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    coerceTypes: true,
  });
  private readonly cache = new Map<string, ValidateFunction | null>();

  /** Returns a list of readable problems, or an empty list when valid. Mutates `data` when coercing. */
  check(key: string, schema: JsonSchema, data: unknown): string[] {
    let fn = this.cache.get(key);
    if (fn === undefined) {
      try {
        fn = this.ajv.compile(schema);
      } catch {
        // Some real-world specs carry schemas Ajv cannot compile (exotic regexes). Skip validation then.
        fn = null;
      }
      this.cache.set(key, fn);
    }
    if (fn === null || fn(data)) return [];
    return (fn.errors ?? []).slice(0, 8).map(formatError);
  }
}

function formatError(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'params';
  if (e.keyword === 'additionalProperties') {
    return `${where}: unknown property "${String((e.params as { additionalProperty: string }).additionalProperty)}"`;
  }
  if (e.keyword === 'required') {
    return `${where}: missing required property "${String((e.params as { missingProperty: string }).missingProperty)}"`;
  }
  if (e.keyword === 'enum') {
    return `${where}: must be one of ${JSON.stringify((e.params as { allowedValues: unknown[] }).allowedValues)}`;
  }
  return `${where}: ${e.message ?? 'is invalid'}`;
}
