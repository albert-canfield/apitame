/**
 * Following pages of list operations: where the next page starts, read from a response, and
 * how the item lists of several pages are merged. The fetching itself happens in the runtime,
 * which owns rate limits, the deadline and the audit log.
 */
import type { Paging, PagingParam } from '../sources/openapi/pagination.js';

/**
 * The longest position (cursor, token, item id, link parameter) apitame passes on, in
 * characters. A longer one is not treated as a position: it would be sent back to the agent
 * in `next` and could be made as large as the API likes.
 */
export const MAX_POSITION = 2048;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The value at a path of object keys (`''` is the value itself). A key that contains dots,
 * such as `@odata.nextLink`, is found as it is before the path is split at a dot.
 */
export function valueAt(value: unknown, path: string): unknown {
  if (path === '') return value;
  if (!isPlainObject(value)) return undefined;
  if (path in value) return value[path];
  const dot = path.indexOf('.');
  if (dot < 0) return undefined;
  const head = path.slice(0, dot);
  return head in value ? valueAt(value[head], path.slice(dot + 1)) : undefined;
}

/** The item list of a page: the body itself (`''`) or one of its top-level properties. */
export function listAt(value: unknown, key: string): unknown[] | undefined {
  const v = key === '' ? value : isPlainObject(value) ? value[key] : undefined;
  return Array.isArray(v) ? v : undefined;
}

/** A copy of `value` with its list replaced. */
export function withList(value: unknown, key: string, list: unknown[]): unknown {
  if (key === '') return list;
  return isPlainObject(value) ? { ...value, [key]: list } : value;
}

export interface LinkValue {
  url: string;
  rels: string[];
}

const SPACE = new Set([' ', '\t', '\r', '\n']);

/**
 * Parse a Link header (RFC 8288) in one pass: `<url>; rel="next"; title="...", <url>; ...`.
 * Quoted parameter values are read as a whole, so a comma, `<` or `rel=` inside quotes is
 * never mistaken for another link or relation.
 */
export function parseLinks(header: string): LinkValue[] {
  const out: LinkValue[] = [];
  const n = header.length;
  let i = 0;
  const skipSpace = () => {
    while (i < n && SPACE.has(header[i]!)) i++;
  };
  /** Skip to the next `,` that is not inside quotes. */
  const skipValue = () => {
    while (i < n && header[i] !== ',') {
      if (header[i] === '"') readQuoted();
      else i++;
    }
  };
  const readQuoted = (): string => {
    let value = '';
    i++; // opening quote
    while (i < n && header[i] !== '"') {
      if (header[i] === '\\' && i + 1 < n) i++;
      value += header[i];
      i++;
    }
    i++; // closing quote
    return value;
  };
  const readToken = (stop: string): string => {
    const start = i;
    while (i < n && !stop.includes(header[i]!) && !SPACE.has(header[i]!)) i++;
    return header.slice(start, i);
  };

  while (i < n) {
    skipSpace();
    if (header[i] === ',') {
      i++;
      continue;
    }
    if (header[i] !== '<') {
      skipValue();
      continue;
    }
    const end = header.indexOf('>', i + 1);
    if (end < 0) break;
    const link: LinkValue = { url: header.slice(i + 1, end), rels: [] };
    i = end + 1;
    for (;;) {
      skipSpace();
      if (header[i] !== ';') break;
      i++;
      skipSpace();
      const name = readToken('=;,').toLowerCase();
      skipSpace();
      let value = '';
      if (header[i] === '=') {
        i++;
        skipSpace();
        value = header[i] === '"' ? readQuoted() : readToken(';,');
      }
      if (name === 'rel' && link.rels.length === 0) {
        link.rels = value.toLowerCase().split(/\s+/).filter(Boolean);
      }
    }
    out.push(link);
    skipValue();
  }
  return out;
}

/** The URL of the first `rel="next"` link in a Link header, if there is one. */
export function nextLink(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return parseLinks(header).find((l) => l.rels.includes('next'))?.url;
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

/** Cursors that point in opposite directions: setting one drops the other. */
const PAIRS: Array<[string, string]> = [
  ['after', 'before'],
  ['starting_after', 'ending_before'],
];

/**
 * The arguments for another page: the same ones, with the position replaced. For next links,
 * only the parameters the link sets are replaced (plus the other half of a cursor pair), so an
 * argument the agent set and the link leaves out, a filter for example, is kept.
 */
export function applyPosition(
  p: Paging,
  args: Record<string, unknown>,
  position: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...args };
  if (p.kind === 'link') {
    for (const param of p.params) {
      if (!(param.key in position)) continue;
      for (const pair of PAIRS) {
        const other = pair[0] === param.name ? pair[1] : pair[1] === param.name ? pair[0] : '';
        const partner = p.params.find((x) => x.name === other);
        if (partner && !(partner.key in position)) delete out[partner.key];
      }
    }
  } else {
    for (const k of positionKeys(p)) delete out[k];
  }
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
  /** A next link apitame refused, as origin and path, for the audit log. */
  refused?: string;
  /** The position goes backwards (`ending_before`): it is given but never followed. */
  backwards?: boolean;
}

const TOO_LONG = `The API's position for the next page is longer than ${MAX_POSITION} characters, so apitame does not pass it on.`;

function asInt(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
}

/** A value short enough to be a position. */
function fits(v: string | number): boolean {
  return String(v).length <= MAX_POSITION;
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
      if (!fits(id)) return { more, problem: TOO_LONG };
      const param = backwards ? p.before! : p.param;
      return { more, position: { [param.key]: id }, ...(backwards ? { backwards } : {}) };
    }
    case 'token': {
      const value = valueAt(body, p.field);
      if ((typeof value !== 'string' && typeof value !== 'number') || value === '') {
        return { more: false };
      }
      if (!fits(value)) return { more: true, problem: TOO_LONG };
      return { more: true, position: { [p.param.key]: value } };
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
      return {
        more,
        position: { [p.param.key]: p.kind === 'page' ? at + 1 : at + items.length },
      };
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
      refused: `${url.protocol}//${url.host}${url.pathname}`.slice(0, 200),
    };
  }
  const position: Record<string, unknown> = {};
  for (const param of p.params) {
    const v = url.searchParams.get(param.name);
    if (v === null) continue;
    if (!fits(v)) return { more: true, problem: TOO_LONG };
    position[param.key] = typed(param, v);
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
    return id === undefined || !fits(id) ? undefined : { [p.param.key]: id };
  }
  return undefined;
}

/** UTF-8 size of a value as JSON, the way `limits.maxResponseBytes` counts it. */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}
