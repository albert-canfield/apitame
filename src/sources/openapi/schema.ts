import type { JsonSchema } from '../../types.js';

export interface CompactOptions {
  /** Request schemas drop readOnly properties, response schemas drop writeOnly ones. */
  direction: 'request' | 'response';
  /** Nesting depth after which schemas collapse to `{}` (any). */
  maxDepth?: number;
  /** Keep descriptions (truncated). */
  descriptions?: boolean;
  /** Max characters per description. */
  maxDescription?: number;
}

const COPY_KEYS = [
  'enum',
  'const',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'multipleOf',
  'uniqueItems',
] as const;

/** Formats worth the tokens: they change what a valid value looks like. */
const USEFUL_FORMATS = new Set([
  'date',
  'date-time',
  'time',
  'email',
  'uri',
  'url',
  'uuid',
  'ipv4',
  'ipv6',
  'hostname',
  'binary',
  'byte',
]);

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : cut.length)}…`;
}

/**
 * Convert an OpenAPI 3.0/3.1 schema (already dereferenced, possibly
 * circular) into a compact JSON Schema that MCP clients and Ajv accept.
 *
 * - `nullable: true` becomes a type union with "null"
 * - `oneOf` is relaxed to `anyOf` (agents rarely satisfy exclusivity reliably)
 * - simple `allOf` object compositions are merged
 * - cycles and deep nesting collapse instead of exploding the token count
 * - OpenAPI-only keywords (discriminator, xml, example, externalDocs) are dropped
 */
export function compactSchema(schema: unknown, opts: CompactOptions): JsonSchema {
  const options = {
    maxDepth: opts.maxDepth ?? 6,
    descriptions: opts.descriptions ?? true,
    maxDescription: opts.maxDescription ?? 160,
    direction: opts.direction,
  };
  return walk(schema, 0, new Set(), options);
}

type Resolved = Required<CompactOptions>;

function walk(input: unknown, depth: number, stack: Set<object>, o: Resolved): JsonSchema {
  if (input === true || input === undefined) return {};
  if (!isObject(input)) return {};
  if (stack.has(input)) return { type: 'object', description: '(recursive, same shape as parent)' };
  if (depth >= o.maxDepth) {
    const t = input.type;
    return typeof t === 'string' && t !== 'object' && t !== 'array' ? { type: t } : {};
  }
  stack.add(input);
  try {
    const out: JsonSchema = {};

    let type = input.type;
    if (input.nullable === true) {
      if (typeof type === 'string') type = [type, 'null'];
      else if (Array.isArray(type) && !type.includes('null')) type = [...type, 'null'];
    }
    if (type !== undefined) out.type = type;

    for (const k of COPY_KEYS) {
      if (input[k] !== undefined) out[k] = input[k];
    }
    // OpenAPI 3.0 boolean exclusive bounds to JSON Schema numeric form.
    if (input.exclusiveMinimum === true && typeof input.minimum === 'number') {
      out.exclusiveMinimum = input.minimum;
      delete out.minimum;
    } else if (typeof input.exclusiveMinimum === 'number')
      out.exclusiveMinimum = input.exclusiveMinimum;
    if (input.exclusiveMaximum === true && typeof input.maximum === 'number') {
      out.exclusiveMaximum = input.maximum;
      delete out.maximum;
    } else if (typeof input.exclusiveMaximum === 'number')
      out.exclusiveMaximum = input.exclusiveMaximum;

    if (typeof input.format === 'string' && USEFUL_FORMATS.has(input.format))
      out.format = input.format;

    if (o.descriptions) {
      const d =
        typeof input.description === 'string'
          ? input.description
          : typeof input.title === 'string'
            ? input.title
            : '';
      if (d.trim()) out.description = truncate(d, o.maxDescription);
    }

    if (isObject(input.properties)) {
      const props: Record<string, JsonSchema> = {};
      const required = new Set(Array.isArray(input.required) ? (input.required as string[]) : []);
      for (const [name, sub] of Object.entries(input.properties)) {
        if (isObject(sub)) {
          if (o.direction === 'request' && sub.readOnly === true) {
            required.delete(name);
            continue;
          }
          if (o.direction === 'response' && sub.writeOnly === true) {
            required.delete(name);
            continue;
          }
        }
        props[name] = walk(sub, depth + 1, stack, o);
      }
      out.properties = props;
      const req = [...required].filter((r) => r in props);
      if (req.length > 0) out.required = req;
      if (out.type === undefined) out.type = 'object';
    }

    if (input.items !== undefined) out.items = walk(input.items, depth + 1, stack, o);
    if (input.additionalProperties === false) out.additionalProperties = false;
    else if (isObject(input.additionalProperties)) {
      out.additionalProperties = walk(input.additionalProperties, depth + 1, stack, o);
    }

    const alternatives = [
      ...(Array.isArray(input.oneOf) ? input.oneOf : []),
      ...(Array.isArray(input.anyOf) ? input.anyOf : []),
    ];
    if (alternatives.length > 0) {
      out.anyOf = alternatives.map((s) => walk(s, depth + 1, stack, o));
    }

    if (Array.isArray(input.allOf)) {
      const parts = input.allOf.map((s) => walk(s, depth, stack, o));
      mergeAllOf(out, parts);
    }

    return out;
  } finally {
    stack.delete(input);
  }
}

/** Merge object-shaped allOf parts into `target`; keep allOf for anything else. */
function mergeAllOf(target: JsonSchema, parts: JsonSchema[]): void {
  const simple = parts.every(
    (p) =>
      (p.type === undefined || p.type === 'object') &&
      p.anyOf === undefined &&
      p.allOf === undefined,
  );
  if (!simple) {
    target.allOf = parts;
    return;
  }
  const props: Record<string, JsonSchema> = {
    ...((target.properties as Record<string, JsonSchema>) ?? {}),
  };
  const required = new Set<string>((target.required as string[] | undefined) ?? []);
  for (const p of parts) {
    Object.assign(props, (p.properties as Record<string, JsonSchema> | undefined) ?? {});
    for (const r of (p.required as string[] | undefined) ?? []) required.add(r);
    if (p.description && !target.description) target.description = p.description;
    if (p.additionalProperties === false) target.additionalProperties = false;
  }
  target.type = 'object';
  target.properties = props;
  if (required.size > 0) target.required = [...required];
}

/** A short, human readable type label used in tool descriptions and skills. */
export function typeLabel(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema || Object.keys(schema).length === 0) return 'any';
  if (Array.isArray(schema.enum)) {
    const vals = schema.enum.slice(0, 5).map((v) => JSON.stringify(v));
    return vals.join('|') + (schema.enum.length > 5 ? '|…' : '');
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf)) {
    return [...new Set((schema.anyOf as JsonSchema[]).map((s) => typeLabel(s, depth + 1)))]
      .slice(0, 3)
      .join('|');
  }
  const t = Array.isArray(schema.type) ? schema.type.filter((x) => x !== 'null')[0] : schema.type;
  if (t === 'array') return `${typeLabel(schema.items as JsonSchema | undefined, depth + 1)}[]`;
  if (t === 'object' || (t === undefined && schema.properties)) {
    const props = Object.entries(
      (schema.properties as Record<string, JsonSchema> | undefined) ?? {},
    );
    if (props.length === 0 || depth > 0) return 'object';
    const req = new Set((schema.required as string[] | undefined) ?? []);
    const shown = props
      .slice(0, 6)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${typeLabel(v, depth + 1)}`);
    return `{${shown.join(', ')}${props.length > 6 ? ', …' : ''}}`;
  }
  if (typeof t === 'string')
    return schema.format && t === 'string' ? `string(${String(schema.format)})` : t;
  return 'any';
}
