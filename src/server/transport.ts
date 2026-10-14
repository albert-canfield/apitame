import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
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
  return serveStdioEntry(
    ({ era }) => {
      const instance = server({ era });
      if (era === 'modern') logger?.debug('stdio: the client uses protocol 2026-07-28');
      else {
        instance.oninitialized = () =>
          logger?.debug(
            `stdio: the client negotiated protocol ${instance.getNegotiatedProtocolVersion() ?? 'unknown'} (2025 era)`,
          );
      }
      return instance;
    },
    {
      ...(opts.transport ? { transport: opts.transport } : {}),
      onerror: (err) => logger?.debug(`stdio: ${err.message}`),
    },
  );
}

/** OAuth 2.1 access tokens from an external authorization server (`http.oauth`). */
export interface HttpOAuth {
  /**
   * Checks each token. Sessions and the audit log read who the token speaks for from
   * `AuthInfo.extra.client` and `extra.subject`, as `JwtVerifier` reports them.
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

/**
 * A copy of a request whose body was already read, which a handler can read again. Everything
 * else (method, URL, headers, socket, the OAuth result) is the original request's.
 */
function replay(req: IncomingMessage, body: Buffer): IncomingMessage {
  const copy = Readable.from(body.length > 0 ? [body] : [], { objectMode: false });
  return Object.assign(copy, {
    method: req.method,
    url: req.url,
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    httpVersion: req.httpVersion,
    socket: req.socket,
    auth: (req as IncomingMessage & { auth?: AuthInfo }).auth,
  }) as unknown as IncomingMessage;
}

/**
 * Whether a request is 2025-era traffic, decided by the SDK's own classification (the one its
 * dual-era handler uses), so this routing never disagrees with the SDK.
 */
async function isLegacy(req: IncomingMessage, body: Buffer | undefined): Promise<boolean> {
  let parsed: unknown;
  if (body !== undefined && body.length > 0) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // Not JSON: the SDK sends it to 2025-era serving too.
      return true;
    }
    // JSON that is not a JSON-RPC message belongs to neither era: the 2025-era wiring refuses it
    // as it always has (and, with sessions, before it can touch the session table).
    const rpc =
      Array.isArray(parsed) ||
      isJSONRPCRequest(parsed) ||
      isJSONRPCNotification(parsed) ||
      isJSONRPCResponse(parsed);
    if (!rpc) return true;
  }
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
  return isLegacyRequest(probe, parsed, { maxRequestBodySize: MAX_BODY_BYTES });
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

  const handleSession = async (req: IncomingMessage, res: ServerResponse, auth?: AuthInfo) => {
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
      await s.transport.handleRequest(req, res);
      return;
    }

    // Only an initialize request starts a session. Anything else is answered here, before it can
    // count against, or close, any session.
    const noSession = 'Bad Request: no valid Mcp-Session-Id. Send initialize to start a session.';
    if (req.method !== 'POST') return rpcError(res, 400, noSession);
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, MAX_INIT_BODY_BYTES)).toString('utf8'));
    } catch (err) {
      if (err instanceof BodyTooLarge) return rpcError(res, 413, 'Request body too large.');
      return send(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
    }
    if (!isInitializeRequest(body)) return rpcError(res, 400, noSession);
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
    const server = makeServer({ era: 'legacy' });
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
    await transport.handleRequest(req, res, body);
  };

  const handleStateless = async (req: IncomingMessage, res: ServerResponse) => {
    const server = makeServer({ era: 'legacy' });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => closeServer(server, transport));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  // Protocol 2026-07-28: every request carries what it needs (client capabilities, protocol
  // version) and is served by a fresh server, sessions or not. 2025-era requests never reach
  // this handler ('reject'); they keep the wiring above. The SDK handler checks no Host, Origin
  // or token: everything in `handler` below runs first.
  const modern = createMcpHandler(() => makeServer({ era: 'modern' }), {
    legacy: 'reject',
    maxRequestBodySize: MAX_BODY_BYTES,
    ...(opts.events ? { bus: opts.events } : {}),
    onerror: (err) => opts.logger.debug(`HTTP (protocol 2026-07-28): ${err.message}`),
  });
  const serveModern = toNodeHandler(modern, {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (err) => opts.logger.error(`HTTP request failed: ${err.message}`),
  });

  /** Send each request to the wiring for its protocol era. */
  const route = async (req: IncomingMessage, res: ServerResponse, auth?: AuthInfo) => {
    let body: Buffer | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof BodyTooLarge)) throw err;
        return rpcError(
          res,
          413,
          `Payload Too Large: Request body must not exceed ${MAX_BODY_BYTES} bytes`,
        );
      }
    }
    // Handlers read the body again from a copy, exactly as they would have from the socket.
    const fresh = () => (body === undefined ? req : replay(req, body));
    const legacy = await isLegacy(req, body);
    const version = req.headers['mcp-protocol-version'];
    opts.logger.debug(
      `HTTP ${req.method ?? 'GET'}: ${legacy ? '2025-era' : 'protocol 2026-07-28'} request${typeof version === 'string' ? ` (MCP-Protocol-Version: ${version})` : ''}`,
    );
    if (!legacy) return serveModern(fresh(), res);
    return opts.sessions ? handleSession(fresh(), res, auth) : handleStateless(fresh(), res);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { ok: true });
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
        if (err instanceof OAuthError) opts.logger.debug(`OAuth: refused a request: ${message}`);
        else opts.logger.error(`OAuth: token check failed: ${message}`);
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
