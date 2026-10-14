import type { AuthProvider } from '../auth/index.js';
import type { Redactor } from '../safety/redact.js';
import { VERSION } from '../version.js';
import { projectFields } from './fields.js';
import type { Operation, ParamSpec } from '../sources/openapi/operations.js';

const USER_AGENT = `apitame/${VERSION} (+https://github.com/albert-canfield/apitame)`;

/** Content types returned to the agent as a short description instead of bytes. */
const BINARY =
  /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z-compressed|vnd\.|msword|x-protobuf|wasm)/i;
/** Structured syntax suffixes: `application/vnd.api+json` and `application/vnd.github+json` are JSON. */
const TEXT_SUFFIX = /\+(json|xml)\b/i;

function isBinary(contentType: string): boolean {
  return BINARY.test(contentType) && !TEXT_SUFFIX.test(contentType);
}

const MAX_REDIRECTS = 5;

export interface BuiltRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | FormData | Uint8Array;
  /** What the body looks like, for dry runs and confirmations (files are summarized, never inlined). */
  bodyPreview?: unknown;
}

export interface BuildOptions {
  /** Maximum total size of uploaded file content. */
  maxUploadBytes?: number;
}

interface FileValue {
  data: Buffer;
  filename?: string;
  contentType?: string;
}

/** A file argument: {base64} or {text}, with optional filename and contentType. */
function asFile(v: unknown): FileValue | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const data =
    typeof o.base64 === 'string'
      ? Buffer.from(o.base64, 'base64')
      : typeof o.text === 'string'
        ? Buffer.from(o.text, 'utf8')
        : undefined;
  if (!data) return undefined;
  return {
    data,
    ...(typeof o.filename === 'string' ? { filename: o.filename } : {}),
    ...(typeof o.contentType === 'string' ? { contentType: o.contentType } : {}),
  };
}

const fileSummary = (f: FileValue) => ({
  file: f.filename ?? '(unnamed)',
  ...(f.contentType ? { contentType: f.contentType } : {}),
  bytes: f.data.length,
});

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
      // Each key becomes a query parameter of its own. When the schema lists its keys and does
      // not allow others, nothing else may be added: an agent must not be able to slip in
      // parameters such as _method=DELETE, which some frameworks honor.
      const props = p.schema.properties as Record<string, unknown> | undefined;
      const extra = p.schema.additionalProperties;
      if (props && (extra === undefined || extra === false)) {
        const unknown = entries.map(([k]) => k).filter((k) => !(k in props));
        if (unknown.length > 0) {
          throw new RequestBuildError(
            `Query parameter "${p.key}" does not accept ${unknown.map((k) => `"${k}"`).join(', ')}. Allowed keys: ${Object.keys(props).join(', ')}.`,
          );
        }
      }
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
  opts: BuildOptions = {},
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

  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin + basePath + path);
  // A query string on the base URL (?api-version=2024-01-01) is kept as query parameters.
  for (const [k, v] of base.searchParams) url.searchParams.append(k, v);
  // Defense in depth: the request must stay under the base path, exactly as built.
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

  let body: BuiltRequest['body'];
  let bodyPreview: unknown;
  const maxUpload = opts.maxUploadBytes ?? 10_000_000;
  let uploaded = 0;
  const countUpload = (f: FileValue) => {
    uploaded += f.data.length;
    if (uploaded > maxUpload) {
      throw new RequestBuildError(
        `Upload is larger than ${maxUpload} bytes (limits.maxUploadBytes in apitame.config.yaml).`,
      );
    }
    return f;
  };

  if (op.body && args.body !== undefined) {
    const ct = op.body.contentType;
    const value = args.body;
    switch (op.body.kind) {
      case 'form': {
        headers['Content-Type'] = ct;
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries((value as Record<string, unknown>) ?? {})) {
          if (Array.isArray(v)) for (const item of v) form.append(k, scalar(item));
          else if (v !== undefined) form.append(k, scalar(v));
        }
        body = form.toString();
        bodyPreview = value;
        break;
      }
      case 'multipart': {
        // fetch sets the multipart Content-Type with its boundary.
        const form = new FormData();
        const preview: Record<string, unknown> = {};
        for (const [k, v] of Object.entries((value as Record<string, unknown>) ?? {})) {
          if (v === undefined) continue;
          const items = Array.isArray(v) && v.some((x) => asFile(x)) ? v : [v];
          const shown: unknown[] = [];
          for (const item of items) {
            const file = asFile(item);
            if (file) {
              countUpload(file);
              form.append(
                k,
                new Blob([file.data], { type: file.contentType ?? 'application/octet-stream' }),
                file.filename ?? k,
              );
              shown.push(fileSummary(file));
            } else {
              form.append(k, scalar(item));
              shown.push(item);
            }
          }
          preview[k] = items === v ? shown : shown[0];
        }
        body = form;
        bodyPreview = { multipart: preview };
        break;
      }
      case 'binary': {
        const file =
          asFile(value) ?? (typeof value === 'string' ? { data: Buffer.from(value) } : undefined);
        if (!file) {
          throw new RequestBuildError(
            'This operation takes a file: pass "body": {"base64": "...", "contentType": "...", "filename": "..."} (or "text" instead of "base64").',
          );
        }
        countUpload(file);
        headers['Content-Type'] = file.contentType ?? ct;
        body = new Uint8Array(file.data);
        bodyPreview = fileSummary(file);
        break;
      }
      case 'json':
        headers['Content-Type'] = ct;
        body = JSON.stringify(value);
        bodyPreview = value;
        break;
      default:
        headers['Content-Type'] = ct;
        body = typeof value === 'string' ? value : JSON.stringify(value);
        bodyPreview = body;
    }
  }

  return {
    method: op.method.toUpperCase(),
    url,
    headers,
    ...(body !== undefined ? { body, bodyPreview } : {}),
  };
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
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value };
    return {
      value: `${value.slice(0, Math.max(0, maxBytes - 3))}...`,
      note: `Response truncated to ${maxBytes} bytes. Use filters or pagination to get a smaller result.`,
    };
  }
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
  /** Keep only these fields of a JSON response (dot paths), before size limits apply. */
  fields?: string[] | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Applied to the response before it is trimmed to size. Redacting after
   * trimming would let a cut leave part of a secret behind.
   */
  redactor?: Redactor;
  /** Path of the API base URL. A write is only resent (307, 308) to a location under it. */
  basePath?: string;
}

/** Send a request with auth, timeout and response size limits. */
export async function sendRequest(
  req: BuiltRequest,
  auth: AuthProvider | undefined,
  opts: SendOptions,
): Promise<HttpResult> {
  // One deadline for the whole exchange: every redirect hop, the 401 retry and the body.
  // A timer holds the controller: on Node 20 a timeout signal reachable only through
  // AbortSignal.any() can be garbage collected and then never fires.
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    opts.timeoutMs,
  );
  try {
    const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
    return await exchange(req, auth, opts, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(
  req: BuiltRequest,
  auth: AuthProvider | undefined,
  opts: SendOptions,
  signal: AbortSignal,
): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = new URL(req.url).origin;
  const basePath = (opts.basePath ?? '').replace(/\/+$/, '');
  const underBase = (u: URL) =>
    u.origin === origin &&
    (basePath === '' || u.pathname === basePath || u.pathname.startsWith(`${basePath}/`));
  const timedOut = () => new Error(`Request timed out after ${opts.timeoutMs} ms.`);

  /**
   * One request with manual redirects. Same-origin redirects keep credentials;
   * a redirect to another origin is followed without credentials or custom
   * headers, so an API key can never be handed to a third party. Once a hop
   * has left the origin, the rest of the chain never gets credentials again,
   * even if it comes back (an open redirect must not be a way in).
   */
  const attempt = async (forceRefresh: boolean): Promise<Response> => {
    let url = new URL(req.url);
    let method = req.method;
    let body = req.body;
    let trusted = true;
    for (let hop = 0; ; hop++) {
      trusted &&= url.origin === origin;
      const headers: Record<string, string> = trusted
        ? { ...req.headers }
        : { Accept: req.headers.Accept ?? '*/*', 'User-Agent': USER_AGENT };
      if (!trusted && body !== undefined && req.headers['Content-Type']) {
        headers['Content-Type'] = req.headers['Content-Type'];
      }
      if (auth && trusted) await auth.apply({ url, headers }, { forceRefresh });
      const res = await doFetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
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
      } else if (method !== 'GET' && method !== 'HEAD' && !underBase(next)) {
        // 307 and 308 resend the method and body. A write only goes where it was previewed.
        throw new Error(
          `The API redirected this ${method} to ${next.origin}${next.pathname}. A write is not resent outside ${origin}${basePath}.`,
        );
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
    if (e.name === 'TimeoutError') throw timedOut();
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Request failed: ${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ''}`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (isBinary(contentType)) {
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
  let read: { text: string; complete: boolean };
  try {
    read = await readCapped(res, hardCap);
  } catch (err) {
    // eslint-disable-next-line preserve-caught-error
    if ((err as Error).name === 'TimeoutError') throw timedOut();
    throw err;
  }
  const { text, complete } = read;
  const redactor = opts.redactor;
  const clean = (t: string) => (redactor ? redactor.text(t) : t);

  let fitted: { value: unknown; note?: string };
  if (!complete) {
    // Only the first maxResponseBytes are kept, far from the cut at hardCap.
    fitted = {
      value: fitJson(clean(text), opts.maxResponseBytes).value,
      note: `Response was larger than ${hardCap} bytes and was cut. Use filters or pagination.`,
    };
  } else if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      const selected = opts.fields ? projectFields(parsed, opts.fields) : parsed;
      fitted = fitJson(redactor ? redactor.value(selected) : selected, opts.maxResponseBytes);
    } catch {
      fitted = fitJson(clean(text), opts.maxResponseBytes);
    }
  } else {
    fitted = fitJson(clean(text), opts.maxResponseBytes);
  }
  const data = res.status === 204 || text === '' ? null : fitted.value;
  const note = fitted.note;

  return { status: res.status, ok: res.ok, contentType, data, ...(note ? { note } : {}) };
}
