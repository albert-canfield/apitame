import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { serveHttp } from '../../src/server/transport.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { petstore, petstoreConfig } from '../helpers.js';

const logger = new Logger(new Redactor(), 'silent');
let mock: MockServer;
let rt: OpenApiRuntime;

beforeAll(async () => {
  const spec = await petstore();
  mock = await startMockServer(extractOperations(spec.doc));
  const config = await petstoreConfig({ mode: 'read-write', writes: { allow: ['deletePet'] } });
  rt = await createOpenApiRuntime({
    config,
    configDir: '.',
    spec,
    baseUrlOverride: mock.url,
    env: {},
  });
});
afterAll(() => mock.close());

async function start(
  token?: string,
  extra: Partial<Parameters<typeof serveHttp>[1]> = {},
): Promise<{ http: HttpServer; url: string }> {
  const http = await serveHttp(() => createMcpServer(rt), {
    host: '127.0.0.1',
    port: 0,
    logger,
    ...(token ? { token } : {}),
    ...extra,
  });
  const { port } = http.address() as AddressInfo;
  return { http, url: `http://127.0.0.1:${port}` };
}

/** A tools/list request on an existing session id. */
const post = (url: string, sessionId: string) =>
  fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

describe('streamable HTTP transport', () => {
  it('refuses to listen beyond loopback without a token', async () => {
    await expect(
      serveHttp(() => createMcpServer(rt), { host: '0.0.0.0', port: 0, logger }),
    ).rejects.toThrow(/APITAME_HTTP_TOKEN/);
  });

  it('serves MCP on /mcp, health on /health, and 404 elsewhere', async () => {
    const { http, url } = await start();
    try {
      expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true });
      expect((await fetch(`${url}/other`)).status).toBe(404);
      const client = new Client({ name: 'http-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('pet');
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'getPetById', params: { petId: 1 } },
      });
      expect(res.isError).toBeFalsy();
      await client.close();
    } finally {
      await stop(http);
    }
  });

  it('rejects requests with a foreign Host or Origin header (DNS rebinding)', async () => {
    const { http, url } = await start();
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      const badOrigin = await fetch(`${url}/mcp`, {
        method: 'POST',
        body,
        headers: { ...headers, Origin: 'https://evil.example' },
      });
      expect(badOrigin.status).toBe(403);
      // fetch does not allow overriding Host, so use a raw request.
      const { request } = await import('node:http');
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          `${url}/mcp`,
          { method: 'POST', headers: { ...headers, Host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(403);
    } finally {
      await stop(http);
    }
  });

  it('requires the bearer token when one is set', async () => {
    const { http, url } = await start('s3cret-http-token');
    try {
      const anonymous = new Client({ name: 'anon', version: '1.0.0' });
      await expect(
        anonymous.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`))),
      ).rejects.toThrow();
      const wrong = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get('www-authenticate')).toBe('Bearer');

      const client = new Client({ name: 'authed', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { Authorization: 'Bearer s3cret-http-token' } },
        }),
      );
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();
    } finally {
      await stop(http);
    }
  });

  it('confirms destructive calls over HTTP (elicitation, or the token fallback)', async () => {
    const { http, url } = await start();
    try {
      const client = new Client(
        { name: 'elicit', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } },
      );
      let asked = false;
      client.setRequestHandler('elicitation/create', async () => {
        asked = true;
        return { action: 'decline' };
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'deletePet', params: { petId: 4 } },
      });
      const text = JSON.stringify(res.content);
      // Without --sessions the transport is stateless, so the server falls back to a confirmation
      // token. If the SDK starts delivering elicitation over stateless HTTP, the human is asked instead.
      expect(asked ? res.isError : text.includes('CONFIRMATION REQUIRED')).toBe(true);
      expect(mock.requests.filter((r) => r.operationId === 'deletePet').length).toBe(before);
      await client.close();
    } finally {
      await stop(http);
    }
  });

  it('with sessions, asks the human through elicitation and respects the answer', async () => {
    const { http, url } = await start(undefined, { sessions: true });
    try {
      for (const approve of [false, true]) {
        const client = new Client(
          { name: 'elicit', version: '1.0.0' },
          { capabilities: { elicitation: { form: {} } } },
        );
        const asked: string[] = [];
        client.setRequestHandler('elicitation/create', async (req) => {
          asked.push(String(req.params.message));
          return { action: 'accept', content: { approve } };
        });
        const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
        await client.connect(transport);
        expect(transport.sessionId).toBeTruthy();
        const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
        const res = await client.callTool({
          name: 'pet',
          arguments: { operation: 'deletePet', params: { petId: 4 } },
        });
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain('DELETE');
        expect(JSON.stringify(res.content)).not.toContain('CONFIRMATION REQUIRED');
        const after = mock.requests.filter((r) => r.operationId === 'deletePet').length;
        expect(after - before).toBe(approve ? 1 : 0);
        expect(Boolean(res.isError)).toBe(!approve);
        await client.close();
      }
    } finally {
      await stop(http);
    }
  });

  it('with sessions, refuses unknown sessions and requests that do not start one', async () => {
    const { http, url } = await start(undefined, { sessions: true });
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const unknown = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'Mcp-Session-Id': 'not-a-session' },
        body: list,
      });
      expect(unknown.status).toBe(404);
      const noSession = await fetch(`${url}/mcp`, { method: 'POST', headers, body: list });
      expect(noSession.status).toBe(400);
    } finally {
      await stop(http);
    }
  });

  it('with sessions, ends a session on DELETE and closes idle ones', async () => {
    const closed: unknown[] = [];
    const { http, url } = await start(undefined, {
      sessions: true,
      sessionIdleMs: 150,
      onServerClosed: (s) => closed.push(s),
    });
    try {
      const connect = async () => {
        const client = new Client({ name: 't', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
        await client.connect(transport);
        return { client, transport };
      };
      const a = await connect();
      const aId = a.transport.sessionId!;
      await a.transport.terminateSession();
      expect((await post(url, aId)).status).toBe(404);
      expect(closed.length).toBeGreaterThanOrEqual(1);

      // A client that went away without DELETE: its streams close, then the session idles out.
      // A connected client keeps a stream open and is never closed for being idle.
      const b = await connect();
      await b.client.listTools();
      const id = b.transport.sessionId!;
      const count = closed.length;
      await new Promise((r) => setTimeout(r, 400));
      expect(closed.length).toBe(count);
      await b.transport.close();
      await new Promise((r) => setTimeout(r, 600));
      expect(closed.length).toBeGreaterThan(count);
      expect((await post(url, id)).status).toBe(404);
    } finally {
      await stop(http);
    }
  });

  it('with sessions, makes room by closing the oldest idle session', async () => {
    const { http, url } = await start(undefined, { sessions: true, maxSessions: 1 });
    try {
      const first = new Client({ name: 'a', version: '1.0.0' });
      const firstTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
      await first.connect(firstTransport);
      const id = firstTransport.sessionId!;
      // Still connected: no room for another session.
      const busy = new Client({ name: 'b', version: '1.0.0' });
      await expect(
        busy.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`))),
      ).rejects.toThrow(/Too many active sessions/);
      // Gone (streams closed, no DELETE): its session makes room for a new one.
      await firstTransport.close();
      await new Promise((r) => setTimeout(r, 50));
      const second = new Client({ name: 'c', version: '1.0.0' });
      await second.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      await expect(second.listTools()).resolves.toBeTruthy();
      expect((await post(url, id)).status).toBe(404);
      await second.close();
    } finally {
      await stop(http);
    }
  });

  it('with sessions, sends the elicitation on the tool call stream, not the standalone one', async () => {
    // A raw client that never opens the GET stream: before the fix the server sent the
    // prompt there, where it was dropped, and the call hung (seen in CI under load).
    const { http, url } = await start(undefined, { sessions: true });
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
      };
      const rpc = (body: unknown, extra: Record<string, string> = {}) =>
        fetch(`${url}/mcp`, {
          method: 'POST',
          headers: { ...headers, ...extra },
          body: JSON.stringify(body),
        });
      const init = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: { elicitation: { form: {} } },
          clientInfo: { name: 'raw', version: '1' },
        },
      });
      const session = init.headers.get('mcp-session-id')!;
      await init.text();
      const s = { 'Mcp-Session-Id': session };
      await (await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, s)).text();

      const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
      const call = await rpc(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'pet', arguments: { operation: 'deletePet', params: { petId: 4 } } },
        },
        s,
      );
      const reader = call.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const next = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const m = /^data: (.+)$/m.exec(buffer);
          if (m) {
            buffer = buffer.slice((m.index ?? 0) + m[0].length);
            return JSON.parse(m[1] as string) as Record<string, unknown>;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buffer += decoder.decode(value, { stream: true });
        }
      };
      const prompt = await Promise.race([
        next(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no elicitation')), 3_000)),
      ]);
      expect(prompt.method).toBe('elicitation/create');
      await (await rpc({ jsonrpc: '2.0', id: prompt.id, result: { action: 'decline' } }, s)).text();
      const result = (await next()) as { id: number; result: { isError?: boolean } };
      expect(result.id).toBe(2);
      expect(result.result.isError).toBe(true);
      expect(mock.requests.filter((r) => r.operationId === 'deletePet').length).toBe(before);
      await reader.cancel();
    } finally {
      await stop(http);
    }
  });

  it('with sessions, a prompt that fails stops the call instead of falling back to a token', async () => {
    const { http, url } = await start(undefined, { sessions: true });
    try {
      const client = new Client(
        { name: 'broken', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } },
      );
      client.setRequestHandler('elicitation/create', async () => {
        throw new Error('the prompt could not be shown');
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const before = mock.requests.filter((r) => r.operationId === 'deletePet').length;
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'deletePet', params: { petId: 4 } },
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).not.toContain('CONFIRMATION REQUIRED');
      expect(mock.requests.filter((r) => r.operationId === 'deletePet').length).toBe(before);
      await client.close();
    } finally {
      await stop(http);
    }
  });
});
