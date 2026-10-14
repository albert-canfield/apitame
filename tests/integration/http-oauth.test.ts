import { readFileSync } from 'node:fs';
import { request, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { JwtVerifier, type OAuthOptions } from '../../src/server/oauth.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { serveHttp, type HttpOptions } from '../../src/server/transport.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { petstore, petstoreConfig, tempDir } from '../helpers.js';
import {
  claimsFor,
  FakeAuthServer,
  makeKey,
  signers,
  signJwt,
  type TestKey,
} from '../oauth-fixtures.js';

// The public URL of the endpoint, as a reverse proxy in front of apitame would serve it.
const RESOURCE = 'https://mcp.example.com/mcp';
const METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

const logger = new Logger(new Redactor(), 'silent');
const tmp = tempDir('apitame-oauth-');
const auditFile = join(tmp.dir, 'audit.jsonl');
let as: FakeAuthServer;
let key: TestKey;
let mock: MockServer;
let rt: OpenApiRuntime;
let options: OAuthOptions;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  key = makeKey('rsa', 'rsa-1');
  const spec = await petstore();
  mock = await startMockServer(extractOperations(spec.doc));
  const config = await petstoreConfig({ audit: { file: auditFile, include: 'all' } });
  rt = await createOpenApiRuntime({
    config,
    configDir: tmp.dir,
    spec,
    baseUrlOverride: mock.url,
    env: {},
  });
  options = { issuer: as.issuer, resource: RESOURCE, scopes: ['mcp:tools'], audiences: [] };
});
afterAll(async () => {
  await mock.close();
  await as.close();
  tmp.cleanup();
});
beforeEach(() => as.publish(key));

const token = (extra: Record<string, unknown> = {}) =>
  signJwt(
    { alg: 'RS256', kid: 'rsa-1', typ: 'at+jwt' },
    claimsFor(as.issuer, RESOURCE, extra),
    signers.rs(key.privateKey),
  );

async function start(extra: Partial<HttpOptions> = {}): Promise<{ http: HttpServer; url: string }> {
  const http = await serveHttp(() => createMcpServer(rt), {
    host: '127.0.0.1',
    port: 0,
    logger,
    oauth: { verifier: new JwtVerifier(options), options, name: 'petstore' },
    ...extra,
  });
  const { port } = http.address() as AddressInfo;
  return { http, url: `http://127.0.0.1:${port}` };
}

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': '2025-11-25',
};
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

const rpc = (url: string, headers: Record<string, string> = {}, body = LIST) =>
  fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, ...headers }, body });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
});

/** Start a session with raw HTTP. Returns the status and the session id, if any. */
async function initSession(
  url: string,
  t: string,
): Promise<{ status: number; id?: string; body?: string }> {
  const res = await rpc(url, bearer(t), INIT);
  const body = await res.text();
  const id = res.headers.get('mcp-session-id') ?? undefined;
  if (id) {
    const ack = await rpc(
      url,
      { ...bearer(t), 'Mcp-Session-Id': id },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    await ack.text();
  }
  return { status: res.status, ...(id ? { id } : { body }) };
}

/** Open a session's notification stream, as a connected client does. */
async function openStream(url: string, t: string, id: string) {
  const ac = new AbortController();
  const res = await fetch(`${url}/mcp`, {
    method: 'GET',
    headers: {
      ...bearer(t),
      Accept: 'text/event-stream',
      'Mcp-Session-Id': id,
      'MCP-Protocol-Version': '2025-11-25',
    },
    signal: ac.signal,
  });
  expect(res.status).toBe(200);
  return { res, close: () => ac.abort() };
}

async function connect(
  url: string,
  t: string,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: bearer(t) },
  });
  await client.connect(transport);
  return { client, transport };
}

describe('HTTP transport with OAuth', () => {
  it('serves the protected resource metadata without a token', async () => {
    const { http, url } = await start();
    try {
      for (const path of [
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-protected-resource',
      ]) {
        const res = await fetch(`${url}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(await res.json()).toEqual({
          resource: RESOURCE,
          authorization_servers: [as.issuer],
          bearer_methods_supported: ['header'],
          scopes_supported: ['mcp:tools'],
          resource_name: 'petstore',
        });
      }
      const preflight = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`, {
        method: 'OPTIONS',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await stop(http);
    }
  });

  it('refuses a request without a token with a challenge that points to the metadata', async () => {
    const { http, url } = await start();
    try {
      const res = await rpc(url);
      expect(res.status).toBe(401);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toMatch(/^Bearer error="invalid_token"/);
      expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
      expect(challenge).toContain('scope="mcp:tools"');
      expect(await res.json()).toMatchObject({ error: 'invalid_token' });

      const anonymous = new Client({ name: 'anon', version: '1.0.0' });
      await expect(
        anonymous.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`))),
      ).rejects.toThrow();
    } finally {
      await stop(http);
    }
  });

  it('accepts a valid token: the SDK client lists and calls tools, and the audit log names the caller', async () => {
    const { http, url } = await start();
    try {
      const { client } = await connect(url, token());
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('pet');
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'getPetById', params: { petId: 1 } },
      });
      expect(res.isError).toBeFalsy();
      await client.close();

      const entries = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries.at(-1)).toMatchObject({
        client: 'client-1',
        subject: 'user-1',
        operation: 'getPetById',
        outcome: 'sent',
      });

      // A token without a client claim: the subject is not reported as the client.
      const userOnly = await connect(url, token({ client_id: undefined }));
      await userOnly.client.callTool({
        name: 'pet',
        arguments: { operation: 'getPetById', params: { petId: 2 } },
      });
      await userOnly.client.close();
      const last = JSON.parse(readFileSync(auditFile, 'utf8').trim().split('\n').at(-1) ?? '{}');
      expect(last).toMatchObject({ subject: 'user-1', operation: 'getPetById' });
      expect(last).not.toHaveProperty('client');
    } finally {
      await stop(http);
    }
  });

  it('refuses tokens for another audience or issuer, expired ones and forged ones', async () => {
    const { http, url } = await start();
    try {
      const now = Math.floor(Date.now() / 1000);
      const forged = signJwt(
        { alg: 'RS256', kid: 'rsa-1' },
        claimsFor(as.issuer, RESOURCE),
        signers.rs(makeKey('rsa', 'other').privateKey),
      );
      const cases: Array<[string, RegExp]> = [
        [token({ aud: 'https://other.example.com/mcp' }), /audience/],
        [token({ iss: 'https://evil.example.com' }), /another server/],
        [token({ exp: now - 10 }), /expired/],
        [forged, /signature/],
        ['not-a-jwt', /not a signed JWT/],
      ];
      for (const [t, reason] of cases) {
        const res = await rpc(url, bearer(t));
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain(
          `resource_metadata="${METADATA_URL}"`,
        );
        expect(((await res.json()) as { error_description: string }).error_description).toMatch(
          reason,
        );
      }
      // The static token scheme does not apply: an arbitrary string is not a JWT.
      expect((await rpc(url, { Authorization: 'Basic dXNlcjpwYXNz' })).status).toBe(401);
    } finally {
      await stop(http);
    }
  });

  it('answers 403 insufficient_scope when the token lacks a required scope', async () => {
    const { http, url } = await start();
    try {
      const res = await rpc(url, bearer(token({ scope: 'profile email' })));
      expect(res.status).toBe(403);
      const challenge = res.headers.get('www-authenticate') ?? '';
      expect(challenge).toMatch(/^Bearer error="insufficient_scope"/);
      expect(challenge).toContain('scope="mcp:tools"');
      expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    } finally {
      await stop(http);
    }
  });

  it('on loopback, accepts the public host name of the resource and still rejects others', async () => {
    const { http, url } = await start();
    try {
      const status = (host: string, origin?: string) =>
        new Promise<number>((resolve, reject) => {
          const headers = {
            ...HEADERS,
            ...bearer(token()),
            Host: host,
            ...(origin ? { Origin: origin } : {}),
          };
          const req = request(`${url}/mcp`, { method: 'POST', headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end(LIST);
        });
      expect(await status('mcp.example.com')).toBe(200);
      expect(await status('evil.example.com')).toBe(403);
      // A browser-based client served from the public host sends that origin.
      expect(await status('mcp.example.com', 'https://mcp.example.com')).toBe(200);
      expect(await status('mcp.example.com', 'https://app.example.com')).toBe(403);
    } finally {
      await stop(http);
    }
  });

  it('with sessions, binds each session to the client and subject that started it', async () => {
    const { http, url } = await start({ sessions: true });
    try {
      const alice = token({ sub: 'alice' });
      const { client, transport } = await connect(url, alice);
      const session = { 'Mcp-Session-Id': transport.sessionId ?? '' };
      expect(session['Mcp-Session-Id']).not.toBe('');

      const mallory = await rpc(url, { ...session, ...bearer(token({ sub: 'mallory' })) });
      expect(mallory.status).toBe(404);
      const anonymous = await rpc(url, session);
      expect(anonymous.status).toBe(401);
      // A fresh token for the same user (say, after a refresh) keeps the session.
      const again = await rpc(url, { ...session, ...bearer(token({ sub: 'alice', jti: 'n2' })) });
      expect(again.status).toBe(200);
      await again.text();
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      await client.close();

      // The owner is the client and the subject, apart: a user token without a client is not
      // the same owner as a token whose client id happens to equal that user name.
      const userOnly = token({ sub: 'x', client_id: undefined });
      const x = await initSession(url, userOnly);
      const clientX = await rpc(url, {
        'Mcp-Session-Id': x.id ?? '',
        ...bearer(token({ sub: 'x', client_id: 'x' })),
      });
      expect(clientX.status).toBe(404);
      // A token that names neither cannot own a session.
      const nobody = await initSession(url, token({ sub: undefined, client_id: undefined }));
      expect(nobody.status).toBe(401);
      expect(nobody.body).toContain('neither a client nor a subject');
    } finally {
      await stop(http);
    }
  });

  it('with sessions, one user makes room only among their own sessions', async () => {
    const { http, url } = await start({ sessions: true, maxSessions: 3, maxSessionsPerOwner: 2 });
    const streams: Array<() => void> = [];
    try {
      const alice = token({ sub: 'alice' });
      const mallory = token({ sub: 'mallory' });
      const a = await initSession(url, alice);
      expect(a.status).toBe(200);
      // Mallory fills her quota and keeps both sessions busy.
      for (let i = 0; i < 2; i++) {
        const m = await initSession(url, mallory);
        expect(m.status).toBe(200);
        streams.push((await openStream(url, mallory, m.id ?? '')).close);
      }
      const third = await initSession(url, mallory);
      expect(third.status).toBe(503);
      expect(third.body).toContain('for this user');
      // The table is full, and Carol cannot push Alice's idle session out.
      const carol = await initSession(url, token({ sub: 'carol' }));
      expect(carol.status).toBe(503);
      const stillThere = await rpc(url, { ...bearer(alice), 'Mcp-Session-Id': a.id ?? '' });
      expect(stillThere.status).toBe(200);
      await stillThere.text();
      // Alice can replace her own idle session.
      expect((await initSession(url, alice)).status).toBe(200);
      expect((await rpc(url, { ...bearer(alice), 'Mcp-Session-Id': a.id ?? '' })).status).toBe(404);
    } finally {
      for (const close of streams) close();
      await stop(http);
    }
  });

  it('with sessions, a request that does not initialize never reaches the session table', async () => {
    const closed: unknown[] = [];
    const { http, url } = await start({
      sessions: true,
      maxSessions: 1,
      onServerClosed: (s) => closed.push(s),
    });
    try {
      const alice = token({ sub: 'alice' });
      const a = await initSession(url, alice);
      const bob = bearer(token({ sub: 'bob' }));
      expect((await rpc(url, bob)).status).toBe(400);
      expect((await rpc(url, bob, '{not json')).status).toBe(400);
      const get = await fetch(`${url}/mcp`, {
        headers: { ...bob, Accept: 'text/event-stream' },
      });
      expect(get.status).toBe(400);
      const del = await fetch(`${url}/mcp`, { method: 'DELETE', headers: bob });
      expect(del.status).toBe(400);
      const big = await rpc(url, bob, JSON.stringify({ padding: 'x'.repeat(1_100_000) }));
      expect(big.status).toBe(413);
      expect(closed).toHaveLength(0);
      const res = await rpc(url, { ...bearer(alice), 'Mcp-Session-Id': a.id ?? '' });
      expect(res.status).toBe(200);
    } finally {
      await stop(http);
    }
  });

  it('closes a stream when the token that opened it expires', async () => {
    const { http, url } = await start({ sessions: true });
    try {
      const shortLived = token({ exp: Math.floor(Date.now() / 1000) + 2 });
      const s = await initSession(url, shortLived);
      const started = Date.now();
      const { res } = await openStream(url, shortLived, s.id ?? '');
      const reader = res.body!.getReader();
      const ended = (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      })().catch(() => undefined);
      await Promise.race([
        ended,
        new Promise((_, reject) => setTimeout(() => reject(new Error('stream still open')), 5_000)),
      ]);
      expect(Date.now() - started).toBeGreaterThan(300);
    } finally {
      await stop(http);
    }
  });

  it('never writes raw token header values into the log or the challenge', async () => {
    const lines: string[] = [];
    const debug = new Logger(new Redactor(), 'debug', (l) => lines.push(l));
    const { http, url } = await start({ logger: debug });
    try {
      const forged = 'X"\r\n[apitame] error: FORGED LOG LINE';
      for (const alg of [forged, 'A'.repeat(11_000)]) {
        const header = Buffer.from(JSON.stringify({ alg })).toString('base64url');
        const res = await rpc(url, bearer(`${header}.e30.AA`));
        expect(res.status).toBe(401);
        expect((res.headers.get('www-authenticate') ?? '').length).toBeLessThan(400);
      }
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
        expect(line.length).toBeLessThan(300);
      }
    } finally {
      await stop(http);
    }
  });

  it('refuses to start with both APITAME_HTTP_TOKEN and http.oauth', async () => {
    await expect(start({ token: 'static-token' })).rejects.toThrow(
      /APITAME_HTTP_TOKEN and http\.oauth cannot be used together/,
    );
  });
});
