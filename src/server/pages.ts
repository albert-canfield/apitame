/**
 * Following pages of list operations: where the next page starts, read from a response, and
 * how the item lists of several pages are merged. The fetching itself happens in the runtime,
 * which owns rate limits, the deadline and the audit log.
 */
import type { Paging, PagingParam } from '../sources/openapi/pagination.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The value at a dot path of object keys (`''` is the value itself). */
export function valueAt(value: unknown, path: string): unknown {
  if (path === '') return value;
  let cur = value;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** The item list of a page, if the body has one where the spec says. */
export function listAt(value: unknown, path: string): unknown[] | undefined {
  const v = valueAt(value, path);
  return Array.isArray(v) ? v : undefined;
}

/** A copy of `value` with the list at `path` replaced. */
export function withList(value: unknown, path: string, list: unknown[]): unknown {
  if (path === '') return list;
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  if (!isPlainObject(value)) return value;
  return {
    ...value,
    [head]: rest.length === 0 ? list : withList(value[head], rest.join('.'), list),
  };
}

/**
 * The URL of `rel="next"` in a Link header (RFC 8288), if there is one:
 * `<https://api.github.com/repositories/1/issues?page=2>; rel="next", <...>; rel="last"`.
 */
export function nextLink(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const m of header.matchAll(/<([^>]*)>((?:\s*;\s*[^;,]*)*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2] ?? '');
    const values = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (values.includes('next')) return m[1];
  }
  return undefined;
}

/** The parameters a strategy owns: they are replaced from one page to the next, nothing else is. */
export function positionKeys(p: Paging): string[] {
  switch (p.kind) {
    case 'cursor':
      return [p.param.key, ...(p.before ? [p.before.key] : [])];
    case 'link':
      return p.params.map((x) => x.key);
    default:
      return [p.param.key];
  }
}

/** The arguments for another page: the same ones, with the position replaced. */
export function applyPosition(
  p: Paging,
  args: Record<string, unknown>,
  position: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...args };
  for (const k of positionKeys(p)) delete out[k];
  return { ...out, ...position };
}

/** Cursor and offset positions can point inside a page, so a page can be cut between items. */
export function cutsInsidePages(p: Paging): boolean {
  return p.kind === 'cursor' || p.kind === 'offset';
}

export interface Continuation {
  /** More items follow what this page holds. */
  more: boolean;
  /** Values for the position parameters that read the next page. */
  position?: Record<string, unknown>;
  /** Why the next page cannot be read, although there is one. */
  problem?: string;
  /** The position goes backwards (`ending_before`): it is given but never followed. */
  backwards?: boolean;
}

function asInt(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

function idOf(item: unknown): string | number | undefined {
  const id = isPlainObject(item) ? item.id : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/** A value from a URL query string, typed like its parameter ("2" is 2 for an integer page). */
function typed(p: PagingParam, raw: string): unknown {
  if (p.type === 'string') return raw;
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
}

export interface PageRead {
  /** Arguments of the request that returned this page. */
  args: Record<string, unknown>;
  /** The body as received. */
  body: unknown;
  /** Its item list. */
  items: unknown[];
  /** The response's Link header. */
  link?: string | undefined;
  /** The URL the request went to, to resolve relative next links. */
  url: URL;
}

/**
 * Where the page after `page` starts, if anywhere. A next link is never followed: only its
 * paging parameters are taken, and only when it stays on the API's origin and under its base
 * path, so the next request is built from the same operation and arguments as the first one.
 */
export function continuation(p: Paging, page: PageRead, base: URL): Continuation {
  const { args, body, items } = page;
  switch (p.kind) {
    case 'cursor': {
      const more = valueAt(body, p.more) === true;
      const backwards =
        !!p.before && args[p.before.key] !== undefined && args[p.param.key] === undefined;
      const edge = backwards ? items[0] : items.at(-1);
      if (!more || edge === undefined) return { more: more && edge !== undefined };
      const id = idOf(edge);
      if (id === undefined) {
        return {
          more,
          problem: 'The last item has no id, so apitame cannot tell where the next page starts.',
        };
      }
      const param = backwards ? p.before! : p.param;
      return { more, position: { [param.key]: id }, ...(backwards ? { backwards } : {}) };
    }
    case 'token': {
      const value = valueAt(body, p.field);
      const ok = (typeof value === 'string' && value !== '') || typeof value === 'number';
      return ok ? { more: true, position: { [p.param.key]: value } } : { more: false };
    }
    case 'link': {
      const raw = p.field ? valueAt(body, p.field) : nextLink(page.link);
      if (typeof raw !== 'string' || raw === '') return { more: false };
      return fromLink(p, raw, page.url, base);
    }
    case 'offset':
    case 'page': {
      const size = asInt(args[p.size.key]) ?? p.sizeDefault;
      const header = p.kind === 'page' && page.link !== undefined;
      const more = header
        ? nextLink(page.link) !== undefined
        : items.length > 0 && (size === undefined || items.length >= size);
      if (!more) return { more: false };
      const at = asInt(args[p.param.key]) ?? p.first;
      return { more, position: { [p.param.key]: p.kind === 'page' ? at + 1 : at + items.length } };
    }
  }
}

function fromLink(
  p: Extract<Paging, { kind: 'link' }>,
  raw: string,
  from: URL,
  base: URL,
): Continuation {
  let url: URL;
  try {
    url = new URL(raw, from);
  } catch {
    return { more: true, problem: 'The API gave a next link that is not a URL.' };
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  const inside =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.origin === base.origin &&
    (basePath === '' || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
  if (!inside) {
    return {
      more: true,
      problem: `The API's next link points outside ${base.origin}${basePath}, so apitame did not follow it.`,
    };
  }
  const position: Record<string, unknown> = {};
  for (const param of p.params) {
    const v = url.searchParams.get(param.name);
    if (v !== null) position[param.key] = typed(param, v);
  }
  if (Object.keys(position).length === 0) {
    return {
      more: true,
      problem: `The API's next link sets none of ${p.params.map((x) => x.name).join(', ')}, so apitame cannot follow it.`,
    };
  }
  return { more: true, position };
}

/** The position right after the first `count` items of a page (cursor and offset only). */
export function positionAfter(
  p: Paging,
  args: Record<string, unknown>,
  items: unknown[],
  count: number,
): Record<string, unknown> | undefined {
  if (p.kind === 'offset') {
    return { [p.param.key]: (asInt(args[p.param.key]) ?? p.first) + count };
  }
  if (p.kind === 'cursor') {
    const id = idOf(items[count - 1]);
    return id === undefined ? undefined : { [p.param.key]: id };
  }
  return undefined;
}

/** UTF-8 size of a value as JSON, the way `limits.maxResponseBytes` counts it. */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}
