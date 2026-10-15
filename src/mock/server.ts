import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Operation } from '../sources/openapi/operations.js';
import { sampleFromSchema } from './sample.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  operationId?: string;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface Route {
  op: Operation;
  method: string;
  re: RegExp;
}

function compile(path: string): RegExp {
  const pattern = path
    .split(/(\{[^}]+\})/)
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${pattern}/?$`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * A local HTTP server that answers every operation with a sample built from
 * its response schema. Used by `apitame test` and by the test suite.
 * `basePath` is the path part of the API base URL (for example /api/v3).
 */
export async function startMockServer(
  ops: Operation[],
  opts: {
    basePath?: string;
    /** Answer a request yourself (for example with `Link` headers to test paging). */
    handler?: (
      req: RecordedRequest,
    ) => { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  } = {},
): Promise<MockServer> {
  const basePath = (opts.basePath ?? '').replace(/\/+$/, '');
  // Literal segments beat templated ones: /pet/findByStatus before /pet/{petId}.
  const routes: Route[] = ops
    .map((op) => ({ op, method: op.method.toUpperCase(), re: compile(op.path) }))
    .sort((a, b) => (a.op.path.match(/\{/g)?.length ?? 0) - (b.op.path.match(/\{/g)?.length ?? 0));
  const requests: RecordedRequest[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const body = await readBody(req);
    const path =
      basePath && url.pathname.startsWith(basePath)
        ? url.pathname.slice(basePath.length) || '/'
        : url.pathname;
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of url.searchParams) {
      const prev = query[k];
      query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const route = routes.find((r) => r.method === req.method && r.re.test(path));
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path,
      query,
      headers: req.headers,
      body,
      ...(route ? { operationId: route.op.id } : {}),
    };
    requests.push(recorded);

    const custom = opts.handler?.(recorded);
    if (custom) {
      res
        .writeHead(custom.status, { 'Content-Type': 'application/json', ...custom.headers })
        .end(JSON.stringify(custom.body));
      return;
    }
    if (!route) {
      res
        .writeHead(404, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'no such route in the spec' }));
      return;
    }
    const resp = route.op.response;
    const status = resp && /^\d{3}$/.test(resp.status) ? Number(resp.status) : 200;
    const payload = resp ? sampleFromSchema(resp.rawSchema) : { ok: true };
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
