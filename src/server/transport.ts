import { timingSafeEqual } from 'node:crypto';
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

/**
 * Streamable HTTP transport, stateless: a fresh MCP server per request, all
 * sharing one runtime (so confirmation tokens survive across requests).
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

    const server = makeServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      opts.logger.error(`HTTP request failed: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const http = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  return http;
}
