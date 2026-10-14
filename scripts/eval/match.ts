import type { RecordedRequest } from '../../src/mock/server.js';
import type { Operation } from '../../src/sources/openapi/operations.js';
import type { ArgMatcher } from './tasks.js';

export type ArgValue = string | string[];

/** Path parameters, query parameters and top-level JSON body fields of a recorded request. */
export function requestArgs(
  op: Operation | undefined,
  req: RecordedRequest,
): Record<string, ArgValue> {
  const args: Record<string, ArgValue> = {};
  if (req.body) {
    try {
      const body: unknown = JSON.parse(req.body);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) args[k] = toArgValue(v);
      }
    } catch {
      // Not JSON: nothing to match on.
    }
  }
  for (const [k, v] of Object.entries(req.query)) args[k] = v;
  if (op) Object.assign(args, pathParams(op.path, req.path));
  return args;
}

function toArgValue(v: unknown): ArgValue {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function pathParams(template: string, path: string): Record<string, string> {
  const names: string[] = [];
  const pattern = template
    .split(/(\{[^}]+\})/)
    .map((part) => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (m) {
        names.push(m[1]!);
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  const found = new RegExp(`^${pattern}/?$`).exec(path);
  const out: Record<string, string> = {};
  if (!found) return out;
  names.forEach((name, i) => {
    const raw = found[i + 1] ?? '';
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  });
  return out;
}

/** All values of an argument: repeated query parameters, or comma-separated lists. */
function valuesOf(actual: ArgValue): string[] {
  const list = Array.isArray(actual) ? actual : [actual];
  return list.flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase());
}

function joined(actual: ArgValue): string {
  return (Array.isArray(actual) ? actual.join(',') : actual).toLowerCase();
}

export function matchArg(actual: ArgValue | undefined, expected: ArgMatcher): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(expected)) {
    const have = valuesOf(actual);
    return expected.every((e) => have.includes(String(e).toLowerCase()));
  }
  if (typeof expected === 'object') {
    if ('contains' in expected) return joined(actual).includes(expected.contains.toLowerCase());
    return new RegExp(expected.regex, 'i').test(joined(actual));
  }
  const want = String(expected).toLowerCase();
  if (Array.isArray(actual)) return actual.some((v) => v.toLowerCase() === want);
  return actual.toLowerCase() === want;
}

export function describeArgs(args: Record<string, ArgMatcher>): string {
  return Object.entries(args)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : String(v)}`,
    )
    .join(', ');
}
