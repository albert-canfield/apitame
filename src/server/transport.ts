import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  isInitializeRequest,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type AuthInfo,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type OAuthTokenVerifier,
  type ProtocolEra,
  type Server,
  type ServerEventBus,
  type Transport,
} from '@modelcontextprotocol/server';
import {
  serveStdio as serveStdioEntry,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import type { Logger } from '../log.js';
import { markServedWithoutAuth } from './mcp.js';
import {
  identityOf,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  type OAuthOptions,
} from './oauth.js';

/**
 * Builds a server for one connection or request. `era` is the protocol era it will serve:
 * `legacy` for 2025-era clients (`initialize`), `modern` for protocol 2026-07-28.
 */
export type ServerFactory = (ctx: { era: ProtocolEra }) => Server;

export interface StdioOptions {
  logger?: Logger;
  /** Serve over this transport instead of the process's stdin and stdout (used by tests). */
  transport?: Transport;
}

/**
 * Serve MCP over stdio.
 *
 * Given a factory, both protocol eras are served: the client's first message selects the era,
 * and one server from the factory serves the whole connection. A 2025-era client is served
 * exactly as by a server connected to the transport directly. Given a server, it is connected
 * as is, which serves 2025-era clients only.
 */
export async function serveStdio(
  server: Server | ServerFactory,
  opts: StdioOptions = {},
): Promise<{ close: () => Promise<void> }> {
  if (typeof server !== 'function') {
    await server.connect(opts.transport ?? new StdioServerTransport());
    return { close: () => server.close() };
  }
  const { logger } = opts;
  // A client may open with a server/discover probe and then fall back to `initialize`, which
  // throws the probe's server away. So the 2026-07-28 era is logged on the first other request,
  // once the connection is pinned to it.
  let era: ProtocolEra | undefined;
  let called = false;
  let logged = false;
  const logModern = () => {
    if (logged || !called || era !== 'modern') return;
    logged = true;
    logger?.debug('stdio: the client uses protocol 2026-07-28');
  };
  const wire = observe(opts.transport ?? new StdioServerTransport(), (message) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'server/discover' || message.method === 'initialize') return;
    called = true;
    logModern();
  });
  return serveStdioEntry(
    (ctx) => {
      era = ctx.era;
      const instance = server({ era: ctx.era });
      if (ctx.era === 'modern') logModern();
      else {
        instance.oninitialized = () =>
          logger?.debug(
            `stdio: the client negotiated protocol ${instance.getNegotiatedProtocolVersion() ?? 'unknown'} (2025 era)`,
          );
      }
      return instance;
    },
    { transport: wire, onerror: (err) => logger?.debug(`stdio: ${err.message}`) },
  );
}

/** The same transport, showing each incoming message to `seen` before the SDK handles it. */
function observe(wire: Transport, seen: (message: JSONRPCMessage) => void): Transport {
  return {
    start: () => wire.start(),
    send: (message, options) => wire.send(message, options),
    close: () => wire.close(),
    get onclose() {
      return wire.onclose;
    },
    set onclose(handler) {
      wire.onclose = handler;
    },
    get onerror() {
      return wire.onerror;
    },
    set onerror(handler) {
      wire.onerror = handler;
    },
    get onmessage() {
      return wire.onmessage;
    },
    set onmessage(handler) {
      wire.onmessage =
        handler &&
        (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => {
          seen(message);
          handler(message, extra);
        });
    },
    setProtocolVersion: (version) => wire.setProtocolVersion?.(version),
  };
}

/** OAuth 2.1 access tokens from an external authorization server (`http.oauth`). */
export interface HttpOAuth {
  /**
   * Checks each token. Sessions and the audit log read who the token speaks for from
   * `AuthInfo.extra.client` and `extra.subject`, as `JwtVerifier` and `IntrospectionVerifier`
   * report them. A verifier that cannot reach a verdict (the introspection endpoint is down)
   * throws something other than an `invalid_token` error: the request gets a 500, never access.
   */
  verifier: OAuthTokenVerifier;
  options: OAuthOptions;
  /** Shown as `resource_name` in the protected resource metadata. */
  name: string;
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Static bearer token required on every request (`APITAME_HTTP_TOKEN`). */
  token?: string;
  /** Require OAuth access tokens instead. Cannot be combined with `token`. */
  oauth?: HttpOAuth;
  logger: Logger;
  /**
   * Keep one MCP session per 2025-era client (`Mcp-Session-Id`) instead of a
   * fresh server per request. Needed for elicitation on that protocol: the
   * server asks the human in the middle of a tool call and receives the answer.
   * Protocol 2026-07-28 requests are stateless either way.
   */
  sessions?: boolean;
  /** Close sessions without requests or open streams for this long. Default 30 minutes. */
  sessionIdleMs?: number;
  /** Most sessions kept at once; the oldest idle one is closed to make room. Default 100. */
  maxSessions?: number;
  /**
   * With OAuth, most sessions one client and subject may hold. A user only ever makes room
   * among their own idle sessions, never by closing someone else's. Default 10.
   */
  maxSessionsPerOwner?: number;
  /**
   * Called whenever a 2025-era server built by `makeServer` is closed. Servers for protocol
   * 2026-07-28 live for one request and are not reported.
   */
  onServerClosed?: (server: Server) => void;
  /**
   * Where `serve --watch` publishes list changes for protocol 2026-07-28 clients, which receive
   * them on `subscriptions/listen` streams. 2025-era clients are notified by their own server.
   */
  events?: ServerEventBus;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1] as string);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  send(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/** Copy a web `Response` (the SDK's bearer challenge) onto a Node response. */
async function sendWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers).end(await response.text());
}

/**
 * `GET /health`: liveness for container health checks, load balancers and probes. It needs no
 * authentication and says nothing about the server (no version, no config, no tools).
 */
function sendHealth(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
}

/** The RFC 9728 document is public, and browser-based clients read it cross-origin. */
function sendMetadata(req: IncomingMessage, res: ServerResponse, body: string): void {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    res
      .writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      .end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
    return;
  }
  res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(body);
}

/** Who a session belongs to: a session id alone must not let another user into it. */
function ownerOf(auth: AuthInfo | undefined): string | undefined {
  if (!auth) return undefined;
  const { client, subject } = identityOf(auth);
  return JSON.stringify([client ?? null, subject ?? null]);
}

/** Largest body read before the transport sees a request that wants to start a session. */
const MAX_INIT_BODY_BYTES = 1_000_000;
/** Largest request body. The same limit the SDK transports apply, with the same answer. */
const MAX_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_SIZE;
/** setTimeout cannot wait longer than this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

class BodyTooLarge extends Error {}

/**
 * Read a request body up to `limit` bytes. Past the limit the rest is read and dropped rather
 * than left unread, so the client can finish sending and receive the 413.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = () => {
      req.removeAllListeners('data');
      req.resume();
      reject(new BodyTooLarge());
    };
    if (Number(req.headers['content-length']) > limit) return tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) return tooLarge();
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A request body as `route` read it: its JSON value, unless it was empty or not JSON. */
type Body = { ok: true; value: unknown } | { ok: false };

function parseBody(raw: Buffer | undefined): Body {
  if (raw === undefined || raw.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(raw)) };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether a request is 2025-era traffic, decided by the SDK's own classification (the one its
 * dual-era handler uses), so this routing never disagrees with the SDK.
 */
async function isLegacy(req: IncomingMessage, body: Body): Promise<boolean> {
  // No body, an empty one or one that is not JSON: the SDK sends these to 2025-era serving too.
  if (!body.ok) return true;
  // JSON that is not a JSON-RPC message belongs to neither era: the 2025-era wiring refuses it
  // as it always has (and, with sessions, before it can touch the session table).
  const rpc =
    Array.isArray(body.value) ||
    isJSONRPCRequest(body.value) ||
    isJSONRPCNotification(body.value) ||
    isJSONRPCResponse(body.value);
  if (!rpc) return true;
  let probe: Request;
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    // Only the method, headers and body matter, so the URL is not taken from the request.
    probe = new Request(new URL('/mcp', 'http://localhost'), {
      method: req.method ?? 'GET',
      headers,
    });
  } catch {
    // A request the Fetch API cannot represent (a TRACE, say) is not 2026-07-28 traffic.
    return true;
  }
  return isLegacyRequest(probe, body.value, { maxRequestBodySize: MAX_BODY_BYTES });
}

interface Session {
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
  lastSeen: number;
  /** Requests and streams still open. A busy session is never closed for being idle. */
  open: number;
  /** The OAuth client and subject that started it, when OAuth is on. */
  owner: string | undefined;
}

/**
 * Streamable HTTP transport. Stateless by default: a fresh MCP server per
 * request, all sharing one runtime (so confirmation tokens and approvals
 * survive across requests). With `sessions`, each 2025-era client keeps its
 * own server between requests, which elicitation needs on that protocol.
 * Protocol 2026-07-28 requests are always served statelessly: the human is
 * asked between two requests, so no session is needed.
 *
 * Safe defaults: loopback only, Host and Origin checks against DNS rebinding,
 * and authentication (a static bearer token or OAuth access tokens) required
 * as soon as the server listens beyond loopback.
 */
export async function serveHttp(makeServer: ServerFactory, opts: HttpOptions): Promise<HttpServer> {
  const loopback = isLoopback(opts.host);
  if (opts.token && opts.oauth) {
    throw new Error(
      'APITAME_HTTP_TOKEN and http.oauth cannot be used together. Unset APITAME_HTTP_TOKEN to require OAuth access tokens, or remove http.oauth from the config to use the static token.',
    );
  }
  if (!loopback && !opts.token && !opts.oauth) {
    throw new Error(
      `Refusing to listen on ${opts.host} without authentication. Set APITAME_HTTP_TOKEN (clients then send "Authorization: Bearer <token>"), configure http.oauth, or use --host 127.0.0.1.`,
    );
  }
  const oauth = opts.oauth && {
    verifier: opts.oauth.verifier,
    requiredScopes: opts.oauth.options.scopes,
    resourceMetadataUrl: protectedResourceMetadataUrl(opts.oauth.options.resource),
    expectedResource: new URL(opts.oauth.options.resource),
    metadata: JSON.stringify(protectedResourceMetadata(opts.oauth.options, opts.oauth.name)),
    metadataPaths: new Set([
      protectedResourceMetadataPath(opts.oauth.options.resource),
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]),
  };
  // Behind a reverse proxy on the same machine, requests carry the public host name, and
  // browser-based clients served from it send its origin.
  const publicHost = oauth?.expectedResource.hostname;
  const validateHost = loopback
    ? publicHost
      ? hostHeaderValidation([...localhostAllowedHostnames(), publicHost])
      : localhostHostValidation()
    : undefined;
  const validateOrigin = loopback
    ? publicHost
      ? originValidation([...localhostAllowedOrigins(), publicHost])
      : localhostOriginValidation()
    : undefined;
  // Without a token or OAuth, nothing tells the MCP client apart from any other local process,
  // so approvals cannot be trusted to come from it (see `markServedWithoutAuth`).
  const build = (era: ProtocolEra): Server => {
    const server = makeServer({ era });
    return opts.token || oauth ? server : markServedWithoutAuth(server);
  };
  const closeServer = (server: Server, transport: NodeStreamableHTTPServerTransport) => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
    opts.onServerClosed?.(server);
  };

  const sessions = new Map<string, Session>();
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = opts.maxSessions ?? 100;
  const maxPerOwner = opts.maxSessionsPerOwner ?? 10;
  const endSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    closeServer(s.server, s.transport);
  };
  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.open === 0 && now - s.lastSeen > idleMs) endSession(id);
  };

  const oldestIdle = (match: (s: Session) => boolean) =>
    [...sessions]
      .filter(([, s]) => s.open === 0 && match(s))
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
  /** Close an idle session if a new one would go over a limit. Returns why not, if it cannot. */
  const makeRoom = (owner: string | undefined): string | undefined => {
    if (owner === undefined) {
      if (sessions.size < maxSessions) return undefined;
      const idle = oldestIdle(() => true);
      if (!idle) return 'Too many active sessions. Try again later.';
      endSession(idle[0]);
      return undefined;
    }
    // With OAuth, a user makes room only among their own sessions: one user opening many
    // sessions must not close, or lock out, anyone else's.
    const mine = (s: Session) => s.owner === owner;
    const count = [...sessions.values()].filter(mine).length;
    if (count < maxPerOwner && sessions.size < maxSessions) return undefined;
    const idle = oldestIdle(mine);
    if (!idle)
      return count >= maxPerOwner
        ? `Too many active sessions for this user (at most ${maxPerOwner}). Close one and try again.`
        : 'Too many active sessions. Try again later.';
    endSession(idle[0]);
    return undefined;
  };

  const handleSession = async (
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthInfo | undefined,
    body: Body,
  ) => {
    const owner = ownerOf(auth);
    const header = req.headers['mcp-session-id'];
    const id = Array.isArray(header) ? header[0] : header;
    if (id) {
      const s = sessions.get(id);
      if (!s || s.owner !== owner)
        return rpcError(res, 404, 'Session not found. Send initialize to start a new one.');
      s.open++;
      s.lastSeen = Date.now();
      res.on('close', () => {
        s.open--;
        s.lastSeen = Date.now();
      });
      await s.transport.handleRequest(req, res, body.ok ? body.value : undefined);
      return;
    }

    // Only an initialize request starts a session. Anything else is answered here, before it can
    // count against, or close, any session.
    const noSession = 'Bad Request: no valid Mcp-Session-Id. Send initialize to start a session.';
    if (req.method !== 'POST') return rpcError(res, 400, noSession);
    // `route` already refused a body over MAX_INIT_BODY_BYTES.
    if (!body.ok) {
      return send(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
    }
    if (!isInitializeRequest(body.value)) return rpcError(res, 400, noSession);
    const who = identityOf(auth);
    if (oauth && !who.client && !who.subject) {
      const err = new OAuthError(
        OAuthErrorCode.InvalidToken,
        'The token names neither a client nor a subject, so it cannot start a session.',
      );
      return await sendWeb(res, bearerAuthChallengeResponse(err, oauth));
    }
    const full = makeRoom(owner);
    if (full) return rpcError(res, 503, full);
    const server = build('legacy');
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport, lastSeen: Date.now(), open: 1, owner });
      },
      onsessionclosed: (sid) => endSession(sid),
    });
    res.on('close', () => {
      const s = transport.sessionId ? sessions.get(transport.sessionId) : undefined;
      if (!s) return closeServer(server, transport);
      s.open--;
      s.lastSeen = Date.now();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body.value);
  };

  const handleStateless = async (req: IncomingMessage, res: ServerResponse, body: Body) => {
    const server = build('legacy');
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => closeServer(server, transport));
    await server.connect(transport);
    await transport.handleRequest(req, res, body.ok ? body.value : undefined);
  };

  // Protocol 2026-07-28: every request carries what it needs (client capabilities, protocol
  // version) and is served by a fresh server, sessions or not. 2025-era requests never reach
  // this handler ('reject'); they keep the wiring above. The SDK handler checks no Host, Origin
  // or token: everything in `handler` below runs first.
  const modern = createMcpHandler(() => build('modern'), {
    legacy: 'reject',
    maxRequestBodySize: MAX_BODY_BYTES,
    // subscriptions/listen streams (`--watch`) stay open like sessions, so the same limits apply.
    maxSubscriptions: maxSessions,
    ...(opts.events ? { bus: opts.events } : {}),
    onerror: (err) => opts.logger.debug(`HTTP (protocol 2026-07-28): ${err.message}`),
  });
  const serveModern = toNodeHandler(modern, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (err) => opts.logger.error(`HTTP request failed: ${err.message}`),
  });

  // With OAuth, each user may hold at most `maxPerOwner` open subscriptions/listen streams, so one
  // user cannot use up the handler's limit and lock everyone else out of list changes.
  const listens = new Map<string, number>();
  const holdListen = (owner: string | undefined, res: ServerResponse): boolean => {
    if (owner === undefined) return true;
    const open = listens.get(owner) ?? 0;
    if (open >= maxPerOwner) return false;
    listens.set(owner, open + 1);
    res.on('close', () => {
      const left = (listens.get(owner) ?? 1) - 1;
      if (left > 0) listens.set(owner, left);
      else listens.delete(owner);
    });
    return true;
  };

  /** Send each request to the wiring for its protocol era. */
  const route = async (req: IncomingMessage, res: ServerResponse, auth?: AuthInfo) => {
    let raw: Buffer | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // With sessions, a request without a session id either starts one (2025 era) or is a
      // 2026-07-28 request: the limit for starting a session applies, checked against
      // Content-Length before anything is read.
      const sessionless = opts.sessions === true && !req.headers['mcp-session-id'];
      try {
        raw = await readBody(req, sessionless ? MAX_INIT_BODY_BYTES : MAX_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof BodyTooLarge)) throw err;
        return rpcError(
          res,
          413,
          sessionless
            ? 'Request body too large.'
            : `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`,
        );
      }
    }
    // Parsed once here. Handlers get the value; they never read the socket again.
    const body = parseBody(raw);
    const legacy = await isLegacy(req, body);
    const version = req.headers['mcp-protocol-version'];
    opts.logger.debug(
      `HTTP ${req.method ?? 'GET'}: ${legacy ? '2025-era' : 'protocol 2026-07-28'} request${typeof version === 'string' ? ` (MCP-Protocol-Version: ${version})` : ''}`,
    );
    // `isLegacy` only answers false for a body that parsed.
    if (!legacy && body.ok) {
      const { value } = body;
      if (isJSONRPCRequest(value) && value.method === 'subscriptions/listen') {
        if (!holdListen(ownerOf(auth), res)) {
          return send(res, 200, {
            jsonrpc: '2.0',
            id: value.id,
            error: {
              code: -32603,
              message: `Subscription limit reached for this user (at most ${maxPerOwner} open streams).`,
            },
          });
        }
      }
      return serveModern(req, res, value);
    }
    // A body that is empty or not JSON has no value to hand over: the SDK transport then finds
    // nothing left to read and answers with its own parse error, after its own Accept and
    // Content-Type checks, exactly as when it read the socket itself.
    return opts.sessions ? handleSession(req, res, auth, body) : handleStateless(req, res, body);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // On loopback the Host check covers /health too, so a web page cannot use DNS rebinding to
    // learn that apitame runs on this machine. Beyond loopback (a container) nothing is checked
    // before authentication, and probes send whatever Host they like.
    if (url.pathname === '/health') {
      if (validateHost && !validateHost(req, res)) return;
      return sendHealth(req, res);
    }
    if (oauth?.metadataPaths.has(url.pathname)) return sendMetadata(req, res, oauth.metadata);
    if (url.pathname !== '/mcp')
      return send(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
    if (validateHost && !validateHost(req, res)) return;
    if (validateOrigin && !validateOrigin(req, res)) return;
    if (opts.token && !tokenMatches(req.headers.authorization, opts.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return send(res, 401, { error: 'Missing or invalid bearer token.' });
    }
    let auth: AuthInfo | undefined;
    if (oauth) {
      try {
        auth = await verifyBearerToken(req.headers.authorization, oauth);
      } catch (err) {
        const message = (err as Error).message;
        // A verifier may answer with a general description and keep the reason in `cause`
        // (token introspection does, so callers cannot probe what the server knows).
        if (err instanceof OAuthError) {
          const why = err.cause instanceof Error ? ` (${err.cause.message})` : '';
          opts.logger.debug(`OAuth: refused a request: ${message}${why}`);
        } else opts.logger.error(`OAuth: token check failed: ${message}`);
        return await sendWeb(res, bearerAuthChallengeResponse(err, oauth));
      }
      // The transport hands it to request handlers as `ctx.http.authInfo`.
      (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
      // A stream outlives no token: when the one that opened it expires, it is closed, and the
      // client comes back with a fresh token (or not at all, if access was revoked).
      const ms = (auth.expiresAt ?? Number.POSITIVE_INFINITY) * 1000 - Date.now();
      if (ms < MAX_TIMER_MS) {
        const timer = setTimeout(
          () => {
            opts.logger.debug('OAuth: closed a response whose token expired.');
            res.destroy();
          },
          Math.max(0, ms),
        );
        timer.unref();
        res.on('close', () => clearTimeout(timer));
      }
    }

    try {
      await route(req, res, auth);
    } catch (err) {
      opts.logger.error(`HTTP request failed: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const http = createServer((req, res) => void handler(req, res));
  http.on('close', () => void modern.close().catch(() => {}));
  if (opts.sessions) {
    const timer = setInterval(sweep, Math.max(50, Math.min(60_000, idleMs / 4)));
    timer.unref();
    http.on('close', () => {
      clearInterval(timer);
      for (const id of [...sessions.keys()]) endSession(id);
    });
  }
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  return http;
}
