import type { AuthProvider } from '../auth/index.js';
import { VERSION } from '../version.js';
import type { Operation, ParamSpec } from '../sources/openapi/operations.js';

const USER_AGENT = `apitame/${VERSION} (+https://github.com/albert-canfield/apitame)`;

/** Content types returned to the agent as a short description instead of bytes. */
const BINARY =
  /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z-compressed|vnd\.|msword|x-protobuf|wasm)/i;

const MAX_REDIRECTS = 5;

export interface BuiltRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  contentType: string;
  data: unknown;
  note?: string;
}

export class RequestBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestBuildError';
  }
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function addQuery(url: URL, p: ParamSpec, value: unknown): void {
  const explode = p.explode ?? (p.style === undefined || p.style === 'form');
  if (Array.isArray(value)) {
    if (explode) for (const v of value) url.searchParams.append(p.name, scalar(v));
    else {
      const sep = p.style === 'spaceDelimited' ? ' ' : p.style === 'pipeDelimited' ? '|' : ',';
      url.searchParams.append(p.name, value.map(scalar).join(sep));
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (p.style === 'deepObject') {
      for (const [k, v] of entries) url.searchParams.append(`${p.name}[${k}]`, scalar(v));
    } else if (explode) {
      for (const [k, v] of entries) url.searchParams.append(k, scalar(v));
    } else {
      url.searchParams.append(p.name, entries.flatMap(([k, v]) => [k, scalar(v)]).join(','));
    }
    return;
  }
  url.searchParams.append(p.name, scalar(value));
}

/** Turn validated tool arguments into an HTTP request. No credentials are added here. */
export function buildRequest(
  op: Operation,
  args: Record<string, unknown>,
  baseUrl: string,
  staticHeaders: Record<string, string> = {},
): BuiltRequest {
  let path = op.path;
  for (const p of op.params.filter((x) => x.in === 'path')) {
    const v = args[p.key];
    if (v === undefined || v === null || v === '') {
      throw new RequestBuildError(`Missing required path parameter "${p.key}".`);
    }
    const values = (Array.isArray(v) ? v : [v]).map(scalar);
    // "." and ".." survive encodeURIComponent and would be resolved by URL parsing,
    // turning /repos/{owner}/{repo} into a different endpoint.
    if (values.some((x) => /^\.{1,2}$/.test(x))) {
      throw new RequestBuildError(`Path parameter "${p.key}" cannot be "." or "..".`);
    }
    path = path.split(`{${p.name}}`).join(values.map((x) => encodeURIComponent(x)).join(','));
  }

  const base = new URL(baseUrl.replace(/\/+$/, ''));
  const url = new URL(base.toString().replace(/\/+$/, '') + path);
  // Defense in depth: the request must stay under the base path, exactly as built.
  const basePath = base.pathname.replace(/\/+$/, '');
  if (
    url.origin !== base.origin ||
    (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath)
  ) {
    throw new RequestBuildError('The request path escapes the API base URL.');
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, */*;q=0.5',
    'User-Agent': USER_AGENT,
    ...staticHeaders,
  };
  const cookies: string[] = [];

  for (const p of op.params) {
    const v = args[p.key];
    if (v === undefined) continue;
    if (p.in === 'query') addQuery(url, p, v);
    else if (p.in === 'header')
      headers[p.name] = Array.isArray(v) ? v.map(scalar).join(',') : scalar(v);
    else if (p.in === 'cookie') cookies.push(`${p.name}=${encodeURIComponent(scalar(v))}`);
  }
  if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');

  let body: string | undefined;
  if (op.body && args.body !== undefined) {
    const ct = op.body.contentType;
    headers['Content-Type'] = ct;
    if (/x-www-form-urlencoded/i.test(ct)) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries((args.body as Record<string, unknown>) ?? {})) {
        if (Array.isArray(v)) for (const item of v) form.append(k, scalar(item));
        else if (v !== undefined) form.append(k, scalar(v));
      }
      body = form.toString();
    } else if (/json/i.test(ct)) {
      body = JSON.stringify(args.body);
    } else {
      body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    }
  }

  return { method: op.method.toUpperCase(), url, headers, ...(body !== undefined ? { body } : {}) };
}

/** Read a response body, stopping after `limit` bytes. */
async function readCapped(
  res: Response,
  limit: number,
): Promise<{ text: string; complete: boolean }> {
  if (!res.body) return { text: '', complete: true };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      complete = false;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = Buffer.concat(chunks);
  return { text: buf.subarray(0, Math.min(buf.length, limit)).toString('utf8'), complete };
}

/**
 * Shrink a JSON value to fit a byte budget. Arrays are cut to the number of
 * items that fit, so the agent still gets valid, useful JSON and a note.
 */
export function fitJson(value: unknown, maxBytes: number): { value: unknown; note?: string } {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
  if (size(value) <= maxBytes) return { value };

  const trimArray = (arr: unknown[], budget: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(arr.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  if (Array.isArray(value)) {
    const n = trimArray(value, maxBytes - 64);
    if (n > 0) {
      return {
        value: value.slice(0, n),
        note: `Response truncated: showing ${n} of ${value.length} items. Use filters or pagination to see more.`,
      };
    }
  } else if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const arrays = Object.entries(obj)
      .filter(([, v]) => Array.isArray(v))
      .sort((a, b) => size(b[1]) - size(a[1]));
    if (arrays.length > 0) {
      const [key, arr] = arrays[0] as [string, unknown[]];
      const rest = size({ ...obj, [key]: [] });
      const n = trimArray(arr, maxBytes - rest - 64);
      const candidate = { ...obj, [key]: arr.slice(0, n) };
      if (size(candidate) <= maxBytes) {
        return {
          value: candidate,
          note: `Response truncated: "${key}" shows ${n} of ${arr.length} items. Use filters or pagination to see more.`,
        };
      }
    }
  }
  const text = JSON.stringify(value);
  return {
    value: `${text.slice(0, Math.max(0, maxBytes - 3))}...`,
    note: `Response truncated to ${maxBytes} bytes. Use filters or pagination to get a smaller result.`,
  };
}

export interface SendOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Send a request with auth, timeout and response size limits. */
export async function sendRequest(
  req: BuiltRequest,
  auth: AuthProvider | undefined,
  opts: SendOptions,
): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = new URL(req.url).origin;
  const signal = () =>
    AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])]);

  /**
   * One request with manual redirects. Same-origin redirects keep credentials;
   * a redirect to another origin is followed without credentials or custom
   * headers, so an API key can never be handed to a third party.
   */
  const attempt = async (forceRefresh: boolean): Promise<Response> => {
    let url = new URL(req.url);
    let method = req.method;
    let body = req.body;
    for (let hop = 0; ; hop++) {
      const sameOrigin = url.origin === origin;
      const headers: Record<string, string> = sameOrigin
        ? { ...req.headers }
        : { Accept: req.headers.Accept ?? '*/*', 'User-Agent': USER_AGENT };
      if (!sameOrigin && body !== undefined && req.headers['Content-Type']) {
        headers['Content-Type'] = req.headers['Content-Type'];
      }
      if (auth && sameOrigin) await auth.apply({ url, headers }, { forceRefresh });
      const res = await doFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: signal(),
        redirect: 'manual',
      });
      const location = res.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      await res.body?.cancel().catch(() => {});
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new Error(`Refusing to follow a redirect to ${next.protocol} URL.`);
      }
      // 303, and 301/302 after a non-GET, become a GET without body (as browsers do).
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')
      ) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  };

  let res: Response;
  try {
    res = await attempt(false);
    if (res.status === 401 && auth?.canRefresh) {
      await res.body?.cancel().catch(() => {});
      res = await attempt(true);
    }
  } catch (err) {
    const e = err as Error;
    // Original errors are not attached as `cause`: they may hold URLs with credentials.
    // eslint-disable-next-line preserve-caught-error
    if (e.name === 'TimeoutError') throw new Error(`Request timed out after ${opts.timeoutMs} ms.`);
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Request failed: ${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (BINARY.test(contentType)) {
    await res.body?.cancel().catch(() => {});
    const length = Number(res.headers.get('content-length') ?? NaN);
    return {
      status: res.status,
      ok: res.ok,
      contentType,
      data: { binary: true, contentType, ...(Number.isFinite(length) ? { bytes: length } : {}) },
      note: 'Binary content is not returned to the agent.',
    };
  }
  // Read more than the budget so JSON can still be parsed and trimmed cleanly.
  const hardCap = Math.max(opts.maxResponseBytes * 20, 5_000_000);
  const { text, complete } = await readCapped(res, hardCap);

  let data: unknown = text;
  let note: string | undefined;
  if (!complete) {
    const fitted = fitJson(text, opts.maxResponseBytes);
    data = fitted.value;
    note = `Response was larger than ${hardCap} bytes and was cut. Use filters or pagination.`;
  } else if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      const fitted = fitJson(JSON.parse(text), opts.maxResponseBytes);
      data = fitted.value;
      note = fitted.note;
    } catch {
      const fitted = fitJson(text, opts.maxResponseBytes);
      data = fitted.value;
      note = fitted.note;
    }
  } else if (text.length > opts.maxResponseBytes) {
    data = `${text.slice(0, opts.maxResponseBytes)}...`;
    note = `Response truncated to ${opts.maxResponseBytes} bytes.`;
  }
  if (res.status === 204 || text === '') data = null;

  return { status: res.status, ok: res.ok, contentType, data, ...(note ? { note } : {}) };
}
