import { isObject } from '../sources/openapi/schema.js';

const BY_NAME: Array<[RegExp, unknown]> = [
  [/^(e-?mail)$/i, 'user@example.com'],
  [/(^|_)(user_?name|login|owner)$/i, 'octocat'],
  [/(^|_)repo$/i, 'hello-world'],
  [/^(ref|branch|base|head)$/i, 'main'],
  [/^(sha|commit_sha)$/i, '6dcb09b5b57875f334f61aebed695e2e4193db5e'],
  [/(^|_)name$/i, 'example'],
  [/(^|_)(status|state)$/i, 'open'],
  [/(^|_)(q|query|search|term)$/i, 'example'],
  [/(^|_)(per_?page|page_?size|limit)$/i, 5],
  [/(^|_)page$/i, 1],
  [/(^|_)offset$/i, 0],
  [/(^|_)(url|uri|link)$/i, 'https://example.com'],
];

const FORMATS: Record<string, unknown> = {
  'date-time': '2026-01-15T09:30:00Z',
  date: '2026-01-15',
  time: '09:30:00',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  hostname: 'example.com',
};

/**
 * Build a plausible value for a schema: examples and defaults first, then
 * enums, formats, property-name hints, then the type. Deterministic, cycle
 * safe and depth limited, so generated docs and tests are stable.
 */
export function sampleFromSchema(
  schema: unknown,
  name = '',
  depth = 0,
  stack = new Set<object>(),
): unknown {
  if (!isObject(schema)) return name ? (sampleByName(name) ?? 'example') : null;
  if (stack.has(schema) || depth > 6)
    return schema.type === 'array' ? [] : schema.type === 'object' ? {} : null;

  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return schema.enum.find((v) => v !== null) ?? schema.enum[0];

  stack.add(schema);
  try {
    for (const key of ['oneOf', 'anyOf'] as const) {
      const alts = schema[key];
      if (Array.isArray(alts) && alts.length > 0) {
        const pick = alts.find((a) => isObject(a) && a.type !== 'null') ?? alts[0];
        return sampleFromSchema(pick, name, depth + 1, stack);
      }
    }
    if (Array.isArray(schema.allOf)) {
      const merged: Record<string, unknown> = {};
      for (const part of schema.allOf) {
        const v = sampleFromSchema(part, name, depth + 1, stack);
        if (isObject(v)) Object.assign(merged, v);
        else if (schema.allOf.length === 1) return v;
      }
      return merged;
    }

    const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
    const format = typeof schema.format === 'string' ? schema.format : '';

    if (type === 'object' || (type === undefined && isObject(schema.properties))) {
      const out: Record<string, unknown> = {};
      const props = isObject(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const keys = Object.keys(props);
      // All properties of small objects (realistic responses), only required ones of large objects.
      const chosen = keys.length <= 8 ? keys : keys.filter((k) => required.has(k));
      for (const k of chosen) {
        const p = props[k];
        if (isObject(p) && p.readOnly === true && depth === 0 && name === 'body') continue;
        out[k] = sampleFromSchema(p, k, depth + 1, stack);
      }
      if (keys.length === 0 && isObject(schema.additionalProperties)) {
        out.key = sampleFromSchema(schema.additionalProperties, 'key', depth + 1, stack);
      }
      return out;
    }
    if (type === 'array') {
      const min = typeof schema.minItems === 'number' ? Math.max(1, schema.minItems) : 1;
      return Array.from({ length: Math.min(min, 3) }, () =>
        sampleFromSchema(schema.items, singular(name), depth + 1, stack),
      );
    }
    if (type === 'integer' || type === 'number') {
      const byName = sampleByName(name);
      if (typeof byName === 'number') return clamp(byName, schema);
      const base = typeof schema.minimum === 'number' ? schema.minimum : 1;
      return clamp(type === 'integer' ? Math.ceil(base) : base, schema);
    }
    if (type === 'boolean') return true;
    if (type === 'string' || type === undefined) {
      if (FORMATS[format] !== undefined) return FORMATS[format];
      if (format === 'binary' || format === 'byte') return '';
      const byName = sampleByName(name);
      if (typeof byName === 'string') return byName;
      return 'example';
    }
    return null;
  } finally {
    stack.delete(schema);
  }
}

function sampleByName(name: string): unknown {
  for (const [re, v] of BY_NAME) if (re.test(name)) return v;
  return undefined;
}

function singular(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name;
}

function clamp(n: number, schema: Record<string, unknown>): number {
  let v = n;
  if (typeof schema.minimum === 'number' && v < schema.minimum) v = schema.minimum;
  if (typeof schema.maximum === 'number' && v > schema.maximum) v = schema.maximum;
  return v;
}
