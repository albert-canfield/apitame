/**
 * Pagination styles recognised in a spec. Detection runs once per operation when the spec is
 * loaded, from its query parameters, its first 2xx JSON response schema and the headers that
 * response declares. Only GET operations classified as reads are considered.
 */
import type { Access } from '../../types.js';
import { isObject } from './schema.js';

/** A query parameter as the tool sees it (`key`) and as the request sends it (`name`). */
export interface PagingParam {
  name: string;
  key: string;
  type: 'integer' | 'number' | 'string';
}

interface Base {
  /** The top-level property that holds the item list, `''` when the body is the list. */
  items: string;
}

/**
 * - `cursor`: Stripe style. `starting_after` takes the id of the last item, `has_more` says
 *   whether more follow. `ending_before` pages the other way.
 * - `token`: a response field holds the value for a request parameter (`next_page` for `page`,
 *   `nextPageToken` for `pageToken`, `next_cursor` for `cursor`).
 * - `link`: a next page URL, from a `Link: <...>; rel="next"` header or a response field
 *   (`next`, `nextLink`, `links.next`). Only its paging parameters are used.
 * - `offset`: `offset` advances by the number of items read, `limit` sets the page size.
 * - `page`: `page` advances by one, `per_page` (or `limit`, `page_size`) sets the page size.
 */
export type Paging =
  | (Base & { kind: 'cursor'; param: PagingParam; before?: PagingParam; more: string })
  | (Base & { kind: 'token'; param: PagingParam; field: string })
  | (Base & { kind: 'link'; params: PagingParam[]; field?: string })
  | (Base & {
      kind: 'offset';
      param: PagingParam;
      first: number;
      size: PagingParam;
      sizeDefault?: number;
    })
  | (Base & {
      kind: 'page';
      param: PagingParam;
      first: number;
      size: PagingParam;
      sizeDefault?: number;
    });

export type PagingKind = Paging['kind'];

/** Names of the item list in common response envelopes, best first. */
const LIST_NAMES = [
  'data',
  'items',
  'results',
  'records',
  'entries',
  'values',
  'value',
  'elements',
  'list',
];

/** Query parameters that say where a page starts, for next links. */
const POSITION = [
  'page',
  'cursor',
  'after',
  'before',
  'starting_after',
  'ending_before',
  'page_token',
  'pageToken',
  'next_token',
  'nextToken',
  'offset',
  'skip',
  'start',
  'marker',
  'continuation_token',
  'continuationToken',
  '$skip',
  '$skiptoken',
];
const PAGE = ['page', 'page_number', 'pageNumber'];
const OFFSET = ['offset', 'skip', 'start', '$skip'];
const SIZE = [
  'per_page',
  'perPage',
  'page_size',
  'pageSize',
  'limit',
  'size',
  'max_results',
  'maxResults',
  'count',
  '$top',
];
/** Response fields that hold the next page's value, with the parameters that take it. */
const TOKENS: Array<[field: string, params: string[]]> = [
  ['nextPageToken', ['pageToken', 'page_token']],
  ['next_page_token', ['page_token', 'pageToken']],
  ['next_page', ['page']],
  ['next_cursor', ['cursor']],
  ['nextCursor', ['cursor']],
  ['next_token', ['next_token', 'nextToken', 'token']],
  ['nextToken', ['nextToken', 'next_token', 'token']],
  ['continuation_token', ['continuation_token', 'continuationToken']],
  ['continuationToken', ['continuationToken', 'continuation_token']],
];
/** Wrappers a token or next link may sit in (`response_metadata.next_cursor`, `links.next`). */
const WRAPPERS = ['meta', 'pagination', 'paging', 'response_metadata', 'links', '_links'];
const LINK_FIELDS = ['next', 'next_url', 'nextUrl', 'next_link', 'nextLink', '@odata.nextLink'];

export interface PagingInput {
  method: string;
  access: Access;
  params: Array<{ name: string; key: string; in: string; schema: Record<string, unknown> }>;
  /** Raw (dereferenced) schema of the first 2xx JSON response. */
  response?: unknown;
  /** Header names that response declares. */
  headers?: string[];
}

function types(schema: unknown): Set<string> {
  if (!isObject(schema)) return new Set();
  const t = schema.type;
  return new Set(Array.isArray(t) ? t.map(String) : typeof t === 'string' ? [t] : []);
}

/** Shallow merge of `allOf` parts, so wrapped envelopes still show their properties. */
function flat(schema: unknown, depth = 0): Record<string, unknown> {
  if (!isObject(schema)) return {};
  if (!Array.isArray(schema.allOf) || depth > 3) return schema;
  const props: Record<string, unknown> = {
    ...(isObject(schema.properties) ? schema.properties : {}),
  };
  let out: Record<string, unknown> = { ...schema };
  for (const part of schema.allOf) {
    const f = flat(part, depth + 1);
    if (isObject(f.properties)) Object.assign(props, f.properties);
    if (f.type !== undefined && out.type === undefined) out = { ...out, type: f.type };
    if (f.items !== undefined && out.items === undefined) out = { ...out, items: f.items };
  }
  return { ...out, properties: props };
}

function isArraySchema(schema: unknown): boolean {
  const s = flat(schema);
  if (types(s).has('array') || (s.type === undefined && s.items !== undefined)) return true;
  // A list of one kind or another (GitHub's stargazers with or without timestamps).
  const variants = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : [];
  return variants.length > 0 && variants.every((v) => types(flat(v)).has('array'));
}

function propsOf(schema: unknown): Record<string, unknown> {
  const s = flat(schema);
  return isObject(s.properties) ? s.properties : {};
}

/**
 * The schema at a path of object properties, if every step is declared. A property whose name
 * contains dots (`@odata.nextLink`) is found as it is before the path is split at a dot.
 */
function at(schema: unknown, path: string): unknown {
  const props = propsOf(schema);
  if (path in props) return props[path];
  const dot = path.indexOf('.');
  if (dot < 0) return undefined;
  const head = path.slice(0, dot);
  return head in props ? at(props[head], path.slice(dot + 1)) : undefined;
}

/** A string (or untyped) field: tokens and URLs. */
function stringish(schema: unknown): boolean {
  if (!isObject(schema)) return false;
  const t = types(flat(schema));
  return t.size === 0 ? !isObject(schema.properties) : t.has('string');
}

/** Where the item list is: `''` for a list body, a property name for an envelope. */
export function listPath(schema: unknown): string | undefined {
  if (schema === undefined) return undefined;
  if (isArraySchema(schema)) return '';
  const props = propsOf(schema);
  const arrays = Object.keys(props).filter((k) => isArraySchema(props[k]));
  return (
    LIST_NAMES.find((n) => arrays.includes(n)) ?? (arrays.length === 1 ? arrays[0] : undefined)
  );
}

/** A field at the top level or in one of the usual wrappers. */
function findField(
  schema: unknown,
  names: string[],
  ok: (s: unknown) => boolean,
): string | undefined {
  for (const name of names) if (ok(at(schema, name))) return name;
  for (const w of WRAPPERS)
    for (const name of names) if (ok(at(schema, `${w}.${name}`))) return `${w}.${name}`;
  return undefined;
}

/** Detect how an operation pages, or undefined when it does not (or not in a way apitame knows). */
export function detectPaging(op: PagingInput): Paging | undefined {
  if (op.method.toLowerCase() !== 'get' || op.access !== 'read' || op.response === undefined)
    return undefined;
  const items = listPath(op.response);
  if (items === undefined) return undefined;

  const query = new Map<string, PagingParam>();
  for (const p of op.params) {
    if (p.in !== 'query') continue;
    // Dates and times are filters (GitHub's `before` and `since` on notifications), never
    // positions: treating them as positions would drop or replace the agent's filter.
    if (p.schema.format === 'date' || p.schema.format === 'date-time') continue;
    const t = types(p.schema);
    const type = t.has('integer') ? 'integer' : t.has('number') ? 'number' : 'string';
    // A parameter whose schema allows neither strings nor numbers cannot carry a position.
    if (t.size > 0 && !t.has('string') && !t.has('integer') && !t.has('number')) continue;
    query.set(p.name, { name: p.name, key: p.key, type });
  }
  const numeric = (names: string[]) =>
    names.map((n) => query.get(n)).find((p) => p !== undefined && p.type !== 'string');
  const textual = (names: string[]) =>
    names.map((n) => query.get(n)).find((p) => p !== undefined && p.type === 'string');
  const defaultOf = (p: PagingParam | undefined, key: 'default' | 'minimum') => {
    const s = op.params.find((x) => x.key === p?.key)?.schema;
    const v = s?.[key];
    return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
  };
  const schema = op.response;
  const fieldIs = (path: string, type: string) => types(flat(at(schema, path))).has(type);

  // Stripe: starting_after (and ending_before) with has_more next to the list.
  const after = textual(['starting_after']);
  if (after && items !== '' && fieldIs('has_more', 'boolean')) {
    const before = textual(['ending_before']);
    return { kind: 'cursor', items, param: after, ...(before ? { before } : {}), more: 'has_more' };
  }

  // A response field with the value for a request parameter.
  if (items !== '') {
    for (const [field, params] of TOKENS) {
      const path = findField(schema, [field], stringish);
      if (!path) continue;
      const param = textual(params);
      if (param) return { kind: 'token', items, param, field: path };
    }
  }

  // Next links, in a Link header or the body, carry the position in their query string.
  const positions = POSITION.map((n) => query.get(n)).filter((p): p is PagingParam => !!p);
  // GitHub's /users and /repositories page with `since` alone; elsewhere it is a filter.
  if (positions.length === 0 && query.has('since')) positions.push(query.get('since')!);
  if (positions.length > 0) {
    if ((op.headers ?? []).some((h) => h.toLowerCase() === 'link')) {
      return { kind: 'link', items, params: positions };
    }
    const field = items !== '' ? findField(schema, LINK_FIELDS, stringish) : undefined;
    if (field) return { kind: 'link', items, params: positions, field };
  }

  const size = numeric(SIZE);
  const sizeDefault = defaultOf(size, 'default');
  const offset = numeric(OFFSET);
  if (offset && size) {
    return {
      kind: 'offset',
      items,
      param: offset,
      first: defaultOf(offset, 'default') ?? 0,
      size,
      ...(sizeDefault !== undefined ? { sizeDefault } : {}),
    };
  }
  const page = numeric(PAGE);
  if (page && size) {
    return {
      kind: 'page',
      items,
      param: page,
      first: defaultOf(page, 'default') ?? defaultOf(page, 'minimum') ?? 1,
      size,
      ...(sizeDefault !== undefined ? { sizeDefault } : {}),
    };
  }
  return undefined;
}
