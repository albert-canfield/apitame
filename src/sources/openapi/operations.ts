import type { Access, JsonSchema } from '../../types.js';
import type { OpenApiDocument } from './load.js';
import { compactSchema, isObject, truncate, typeLabel } from './schema.js';

export const HTTP_METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ParamLocation = 'path' | 'query' | 'header' | 'cookie';

export interface ParamSpec {
  /** Name in the HTTP request. */
  name: string;
  /** Property name in the tool input (differs only on collisions). */
  key: string;
  in: ParamLocation;
  required: boolean;
  schema: JsonSchema;
  /** Raw (uncompacted) schema, used for examples. */
  rawSchema: unknown;
  description: string;
  style?: string;
  explode?: boolean;
}

export interface BodySpec {
  contentType: string;
  required: boolean;
  schema: JsonSchema;
  rawSchema: unknown;
}

export interface Operation {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: ParamSpec[];
  body?: BodySpec;
  /** First 2xx JSON response. */
  response?: { status: string; contentType: string; schema: JsonSchema; rawSchema: unknown };
  /** `security: []` on the operation: send no credentials. */
  noAuth: boolean;
  access: Access;
  /** Compact JSON Schema for the tool input. */
  inputSchema: JsonSchema & { type: 'object' };
  /** Reason the operation cannot be called (unsupported content type), if any. */
  unsupported?: string;
}

export interface ClassifyOptions {
  treatAsRead?: string[];
  destructive?: string[];
  /** Header names handled by auth; never exposed as tool parameters. */
  authHeaders?: string[];
}

const READ_METHODS = new Set<HttpMethod>(['get', 'head', 'options']);
const DESTRUCTIVE_WORDS =
  /(^|[^a-z])(delete|remove|destroy|purge|drop|truncate|wipe|erase|reset|revoke|terminate|cancel|bulk|batch|overwrite)/i;
const IGNORED_HEADERS = new Set([
  'authorization',
  'content-type',
  'accept',
  'content-length',
  'cookie',
  'user-agent',
]);
const JSON_TYPES = /^application\/(.+\+)?json/i;

/** Decide read / write / destructive for an operation. */
export function classifyAccess(
  op: { id: string; method: HttpMethod; path: string; summary: string; extension?: unknown },
  opts: ClassifyOptions = {},
): Access {
  if (opts.destructive?.includes(op.id)) return 'destructive';
  if (opts.treatAsRead?.includes(op.id)) return 'read';
  if (op.extension === 'read' || op.extension === 'write' || op.extension === 'destructive') {
    return op.extension;
  }
  if (READ_METHODS.has(op.method)) return 'read';
  if (op.method === 'delete') return 'destructive';
  const words = `${op.id} ${op.summary} ${op.path}`.replace(/([a-z])([A-Z])/g, '$1 $2');
  return DESTRUCTIVE_WORDS.test(words) ? 'destructive' : 'write';
}

/** Generate a readable id for operations without operationId: GET /pets/{id} -> getPetsById. */
export function generateOperationId(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const param = /^\{(.+)\}$/.exec(seg);
      const word = param ? `by_${param[1]}` : seg;
      return word
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join('');
    });
  return `${method.toLowerCase()}${parts.join('')}` || method.toLowerCase();
}

function pickContent(content: unknown): { contentType: string; schema: unknown } | undefined {
  if (!isObject(content)) return undefined;
  const types = Object.keys(content);
  const preferred =
    types.find((t) => JSON_TYPES.test(t)) ??
    types.find((t) => t === 'application/x-www-form-urlencoded') ??
    types.find((t) => t.startsWith('text/')) ??
    types[0];
  if (!preferred) return undefined;
  const media = content[preferred];
  return { contentType: preferred, schema: isObject(media) ? media.schema : undefined };
}

function collectParams(raw: unknown[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const p of raw) {
    if (isObject(p) && typeof p.name === 'string' && typeof p.in === 'string')
      out.set(`${p.in}:${p.name}`, p);
  }
  return out;
}

/** Extract and normalize every operation in a dereferenced document. */
export function extractOperations(doc: OpenApiDocument, opts: ClassifyOptions = {}): Operation[] {
  const ops: Operation[] = [];
  const usedIds = new Set<string>();
  const authHeaders = new Set((opts.authHeaders ?? []).map((h) => h.toLowerCase()));

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!isObject(item)) continue;
    const pathParams = collectParams(Array.isArray(item.parameters) ? item.parameters : []);

    for (const method of HTTP_METHODS) {
      const raw = item[method];
      if (!isObject(raw)) continue;

      let id =
        typeof raw.operationId === 'string' && raw.operationId.trim()
          ? raw.operationId.trim()
          : generateOperationId(method, path);
      if (usedIds.has(id)) {
        let n = 2;
        while (usedIds.has(`${id}_${n}`)) n++;
        id = `${id}_${n}`;
      }
      usedIds.add(id);

      const merged = new Map(pathParams);
      for (const [k, v] of collectParams(Array.isArray(raw.parameters) ? raw.parameters : []))
        merged.set(k, v);

      const params: ParamSpec[] = [];
      const keys = new Set<string>();
      for (const p of merged.values()) {
        const loc = p.in as ParamLocation;
        if (!['path', 'query', 'header', 'cookie'].includes(loc)) continue;
        const name = p.name as string;
        if (
          loc === 'header' &&
          (IGNORED_HEADERS.has(name.toLowerCase()) || authHeaders.has(name.toLowerCase()))
        )
          continue;
        let key = name;
        if (keys.has(key) || key === 'body') key = `${name}_${loc}`;
        keys.add(key);
        const rawSchema =
          p.schema ?? (isObject(p.content) ? pickContent(p.content)?.schema : undefined);
        const description = typeof p.description === 'string' ? p.description : '';
        const schema = compactSchema(rawSchema ?? { type: 'string' }, {
          direction: 'request',
          maxDepth: 4,
        });
        if (description && !schema.description) schema.description = truncate(description, 160);
        params.push({
          name,
          key,
          in: loc,
          required: loc === 'path' || p.required === true,
          schema,
          rawSchema,
          description,
          ...(typeof p.style === 'string' ? { style: p.style } : {}),
          ...(typeof p.explode === 'boolean' ? { explode: p.explode } : {}),
        });
      }

      let body: BodySpec | undefined;
      let unsupported: string | undefined;
      if (isObject(raw.requestBody)) {
        const picked = pickContent(raw.requestBody.content);
        if (picked) {
          if (/multipart\/|octet-stream/i.test(picked.contentType)) {
            unsupported = `request body type ${picked.contentType} is not supported yet`;
          }
          body = {
            contentType: picked.contentType,
            required: raw.requestBody.required === true,
            schema: compactSchema(picked.schema ?? {}, { direction: 'request' }),
            rawSchema: picked.schema,
          };
        }
      }

      let response: Operation['response'];
      if (isObject(raw.responses)) {
        const codes = Object.keys(raw.responses).sort();
        const ok =
          codes.find((c) => /^2\d\d$/.test(c)) ??
          codes.find((c) => c === '2XX') ??
          codes.find((c) => c === 'default');
        const r = ok ? raw.responses[ok] : undefined;
        if (ok && isObject(r)) {
          const picked = pickContent(r.content);
          if (picked && JSON_TYPES.test(picked.contentType) && picked.schema) {
            response = {
              status: ok,
              contentType: picked.contentType,
              schema: compactSchema(picked.schema, {
                direction: 'response',
                descriptions: false,
                maxDepth: 8,
              }),
              rawSchema: picked.schema,
            };
          }
        }
      }

      const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      const access = classifyAccess(
        { id, method, path, summary, extension: raw['x-apitame-access'] },
        opts,
      );

      ops.push({
        id,
        method,
        path,
        summary,
        description,
        tags: Array.isArray(raw.tags)
          ? raw.tags.filter((t): t is string => typeof t === 'string')
          : [],
        deprecated: raw.deprecated === true,
        params,
        ...(body ? { body } : {}),
        ...(response ? { response } : {}),
        noAuth: Array.isArray(raw.security) && raw.security.length === 0,
        access,
        inputSchema: buildInputSchema(params, body),
        ...(unsupported ? { unsupported } : {}),
      });
    }
  }
  return ops;
}

function buildInputSchema(
  params: ParamSpec[],
  body: BodySpec | undefined,
): JsonSchema & { type: 'object' } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.key] = p.schema;
    if (p.required) required.push(p.key);
  }
  if (body) {
    properties.body = body.schema;
    if (body.required) required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** One-line signature, e.g. `getPetById(petId: integer)`. */
export function signature(op: Operation): string {
  const props = (op.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
  const req = new Set((op.inputSchema.required as string[] | undefined) ?? []);
  const args = Object.entries(props).map(
    ([k, s]) => `${k}${req.has(k) ? '' : '?'}: ${typeLabel(s)}`,
  );
  const sig = `${op.id}(${args.join(', ')})`;
  return sig.length > 220 ? `${sig.slice(0, 217)}…)` : sig;
}

/** Short text describing what an operation does. */
export function operationTitle(op: Operation): string {
  return truncate(op.summary || op.description || `${op.method.toUpperCase()} ${op.path}`, 100);
}
