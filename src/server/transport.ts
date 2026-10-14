import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import type { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Logger } from '../log.js';

export async function serveStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer token required on every request. Mandatory for non-loopback hosts. */
  token?: string;
  logger: Logger;
  /**
   * Keep one MCP session per client (`Mcp-Session-Id`) instead of a fresh
   * server per request. Needed for elicitation: the server can ask the human
   * in the middle of a tool call and receive the answer.
   */
  sessions?: boolean;
  /** Close sessions without requests or open streams for this long. Default 30 minutes. */
  sessionIdleMs?: number;
  /** Most sessions kept at once; the oldest idle one is closed to make room. Default 100. */
  maxSessions?: number;
  /** Called whenever a server built by `makeServer` is closed. */
  onServerClosed?: (server: Server) => void;
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

interface Session {
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
  lastSeen: number;
  /** Requests and streams still open. A busy session is never closed for being idle. */
  open: number;
}

/**
 * Streamable HTTP transport. Stateless by default: a fresh MCP server per
 * request, all sharing one runtime (so confirmation tokens survive across
 * requests). With `sessions`, each client keeps its own server between
 * requests, which elicitation needs.
 *
 * Safe defaults: loopback only, Host and Origin checks against DNS rebinding,
 * and a bearer token required as soon as the server listens beyond loopback.
 */
export async function serveHttp(makeServer: () => Server, opts: HttpOptions): Promise<HttpServer> {
  const loopback = isLoopback(opts.host);
  if (!loopback && !opts.token) {
    throw new Error(
      `Refusing to listen on ${opts.host} without authentication. Set APITAME_HTTP_TOKEN (clients then send "Authorization: Bearer <token>"), or use --host 127.0.0.1.`,
    );
  }
  const validateHost = loopback ? localhostHostValidation() : undefined;
  const validateOrigin = loopback ? localhostOriginValidation() : undefined;
  const closeServer = (server: Server, transport: NodeStreamableHTTPServerTransport) => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
    opts.onServerClosed?.(server);
  };

  const sessions = new Map<string, Session>();
  const idleMs = opts.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = opts.maxSessions ?? 100;
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

  const handleSession = async (req: IncomingMessage, res: ServerResponse) => {
    const header = req.headers['mcp-session-id'];
    const id = Array.isArray(header) ? header[0] : header;
    if (id) {
      const s = sessions.get(id);
      if (!s) return rpcError(res, 404, 'Session not found. Send initialize to start a new one.');
      s.open++;
      s.lastSeen = Date.now();
      res.on('close', () => {
        s.open--;
        s.lastSeen = Date.now();
      });
      await s.transport.handleRequest(req, res);
      return;
    }

    // Only an initialize request starts a session; the transport answers anything else with 400.
    if (sessions.size >= maxSessions) {
      const idle = [...sessions].filter(([, s]) => s.open === 0);
      const oldest = idle.sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (!oldest) return rpcError(res, 503, 'Too many active sessions. Try again later.');
      endSession(oldest[0]);
    }
    const server = makeServer();
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport, lastSeen: Date.now(), open: 1 });
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
    await transport.handleRequest(req, res);
  };

  const handleStateless = async (req: IncomingMessage, res: ServerResponse) => {
    const server = makeServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => closeServer(server, transport));
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname !== '/mcp')
      return send(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
    if (validateHost && !validateHost(req, res)) return;
    if (validateOrigin && !validateOrigin(req, res)) return;
    if (opts.token && !tokenMatches(req.headers.authorization, opts.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return send(res, 401, { error: 'Missing or invalid bearer token.' });
    }

    try {
      await (opts.sessions ? handleSession(req, res) : handleStateless(req, res));
    } catch (err) {
      opts.logger.error(`HTTP request failed: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const http = createServer((req, res) => void handler(req, res));
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
