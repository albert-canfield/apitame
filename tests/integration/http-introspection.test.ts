import { existsSync, readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config, ConfigInput } from '../../src/config/schema.js';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createOAuthVerifiers } from '../../src/server/introspection.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { serveHttp, type HttpOptions } from '../../src/server/transport.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { petstore, petstoreConfig, tempDir, textOf } from '../helpers.js';
import { FakeAuthServer, INTROSPECTION_CLIENT } from '../oauth-fixtures.js';

// The public URL of the endpoint, as a reverse proxy in front of apitame would serve it.
const RESOURCE = 'https://mcp.example.com/mcp';
const METADATA_URL = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const ENV = { INTROSPECTION_SECRET: INTROSPECTION_CLIENT.secret };

const tmp = tempDir('apitame-introspection-');
let as: FakeAuthServer;
let mock: MockServer;
let audits = 0;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  mock = await startMockServer(extractOperations((await petstore()).doc));
});
afterAll(async () => {
  await mock.close();
  await as.close();
  tmp.cleanup();
});
beforeEach(() => {
  as.overrides.clear();
  as.answers.clear();
  as.introspections.length = 0;
});

/**
 * The Petstore, read-write with two writes allowed, behind OAuth with token introspection.
 * Every caller reads pets; the mcp:write scope and the ci-bot client add writes.
 */
async function petServer(oauth: Record<string, unknown> = {}, extra: Partial<ConfigInput> = {}) {
  const auditFile = join(tmp.dir, `audit-${audits++}.jsonl`);
  const config = await petstoreConfig({
    mode: 'read-write',
    writes: { allow: ['addPet', 'deletePet'] },
    audit: { file: auditFile, include: 'all' },
    http: {
      oauth: {
        issuer: as.issuer,
        resource: RESOURCE,
        scopes: ['mcp:tools'],
        introspection: {
          url: as.introspectionUrl,
          clientId: INTROSPECTION_CLIENT.id,
          clientSecret: '${INTROSPECTION_SECRET}',
        },
        permissions: {
          default: { mode: 'read-only', tools: ['pet', 'search_operations'] },
          byScope: { 'mcp:write': { tools: ['pet'], writes: ['addPet'] } },
          byClient: { 'ci-bot': { tools: ['pet', 'store'], writes: ['deletePet'] } },
        },
        ...oauth,
      } as never,
    },
    ...extra,
  });
  const rt = await createOpenApiRuntime({
    config,
    configDir: tmp.dir,
    spec: await petstore(),
    baseUrlOverride: mock.url,
    env: {},
  });
  const audit = () =>
    existsSync(auditFile)
      ? readFileSync(auditFile, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { rt, config, audit };
}

/** Serve a runtime over HTTP as `apitame serve --transport http` does. */
async function start(
  rt: OpenApiRuntime,
  config: Config,
  extra: Partial<HttpOptions> = {},
  redactor = new Redactor(),
): Promise<{ http: HttpServer; url: string }> {
  const oauth = config.http.oauth!;
  const { verifier } = createOAuthVerifiers(oauth, { redactor, env: ENV });
  const http = await serveHttp(() => createMcpServer(rt), {
    host: '127.0.0.1',
    port: 0,
    logger: new Logger(redactor, 'silent'),
    oauth: { verifier, options: oauth, name: 'petstore' },
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
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const rpc = (url: string, headers: Record<string, string> = {}, body = LIST) =>
  fetch(`${url}/mcp`, { method: 'POST', headers: { ...HEADERS, ...headers }, body });

/** A new opaque token the fake authorization server answers for. */
const opaque = (extra: Record<string, unknown> = {}) => as.issue(RESOURCE, extra);

async function connect(url: string, t: string): Promise<Client> {
  const client = new Client({ name: 'introspection-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: bearer(t) },
    }),
  );
  return client;
}

describe('HTTP transport with token introspection', () => {
  it('serves the same protected resource metadata and challenge as with JWTs', async () => {
    const { rt, config } = await petServer();
    const { http, url } = await start(rt, config);
    try {
      const meta = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
      expect(await meta.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [as.issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:tools'],
        resource_name: 'petstore',
      });
      for (const headers of [{}, bearer('revoked-or-unknown')]) {
        const res = await rpc(url, headers);
        expect(res.status).toBe(401);
        const challenge = res.headers.get('www-authenticate') ?? '';
        expect(challenge).toMatch(/^Bearer error="invalid_token"/);
        expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
        expect(challenge).toContain('scope="mcp:tools"');
      }
      // Only the second request carried a token to ask about.
      expect(as.introspections).toHaveLength(1);
      const noScope = await rpc(url, bearer(opaque({ scope: 'profile' })));
      expect(noScope.status).toBe(403);
      expect(noScope.headers.get('www-authenticate')).toMatch(/^Bearer error="insufficient_scope"/);
    } finally {
      await stop(http);
    }
  });

  it('accepts an active opaque token: the SDK client calls tools and the audit log names the caller', async () => {
    const { rt, config, audit } = await petServer();
    const { http, url } = await start(rt, config);
    try {
      const token = opaque({ sub: 'alice', client_id: 'desktop-app' });
      const client = await connect(url, token);
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'getPetById', params: { petId: 1 } },
      });
      expect(res.isError).toBeFalsy();
      await client.close();
      expect(audit().at(-1)).toMatchObject({
        client: 'desktop-app',
        subject: 'alice',
        operation: 'getPetById',
        outcome: 'sent',
        permissions: ['default'],
      });
      // Every request of that conversation was answered from one introspection.
      expect(as.introspections).toHaveLength(1);
    } finally {
      await stop(http);
    }
  });

  it('gives each caller the permissions its introspected scopes and client grant', async () => {
    const { rt, config, audit } = await petServer();
    const { http, url } = await start(rt, config);
    try {
      const toolsOf = async (t: string) => {
        const client = await connect(url, t);
        const names = (await client.listTools()).tools.map((x) => x.name).sort();
        return { client, names };
      };
      const reader = await toolsOf(opaque({ sub: 'rita' }));
      expect(reader.names).toEqual(['pet', 'search_operations']);
      const bot = await toolsOf(opaque({ sub: 'svc', client_id: 'ci-bot' }));
      expect(bot.names).toContain('store');
      const writer = await toolsOf(opaque({ sub: 'walt', scope: 'mcp:tools mcp:write' }));

      const add = {
        name: 'pet',
        arguments: { operation: 'addPet', params: { body: { name: 'Rex', photoUrls: [] } } },
      };
      // A reader's pet tool does not even list the write.
      const refused = await reader.client.callTool(add);
      expect(refused.isError).toBe(true);
      expect(textOf(refused as never)).toMatch(/Unknown operation "addPet"/);
      const sent = await writer.client.callTool(add);
      expect(sent.isError).toBeFalsy();
      expect(audit().at(-1)).toMatchObject({
        subject: 'walt',
        operation: 'addPet',
        outcome: 'sent',
        permissions: ['default', 'byScope.mcp:write'],
      });
      for (const c of [reader, bot, writer]) await c.client.close();
    } finally {
      await stop(http);
    }
  });

  it('with sessions, binds each session to the client and subject the authorization server names', async () => {
    const { rt, config } = await petServer();
    const { http, url } = await start(rt, config, { sessions: true });
    try {
      const init = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      });
      const alice = opaque({ sub: 'alice' });
      const started = await rpc(url, bearer(alice), init);
      expect(started.status).toBe(200);
      await started.text();
      const session = { 'Mcp-Session-Id': started.headers.get('mcp-session-id') ?? '' };
      expect(session['Mcp-Session-Id']).not.toBe('');
      const mallory = await rpc(url, { ...session, ...bearer(opaque({ sub: 'mallory' })) });
      expect(mallory.status).toBe(404);
      // Another token of the same user (after a refresh, say) keeps the session.
      const again = await rpc(url, { ...session, ...bearer(opaque({ sub: 'alice' })) });
      expect(again.status).toBe(200);
      await again.text();
    } finally {
      await stop(http);
    }
  });

  it('refuses a revoked token at once with cacheSeconds 0', async () => {
    const { rt, config } = await petServer({
      introspection: {
        url: as.introspectionUrl,
        clientId: INTROSPECTION_CLIENT.id,
        clientSecret: '${INTROSPECTION_SECRET}',
        cacheSeconds: 0,
      },
    });
    const { http, url } = await start(rt, config);
    try {
      const token = opaque();
      const ok = await rpc(url, bearer(token));
      expect(ok.status).toBe(200);
      await ok.text();
      as.answers.set(token, { active: false });
      const res = await rpc(url, bearer(token));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error_description: string }).error_description).toMatch(
        /not active/,
      );
    } finally {
      await stop(http);
    }
  });

  it('fails closed with a 500 when the authorization server is down, and logs why without the token', async () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    const { rt, config } = await petServer();
    const { http, url } = await start(
      rt,
      config,
      { logger: new Logger(redactor, 'debug', (l) => lines.push(l)) },
      redactor,
    );
    try {
      as.overrides.set('/introspect', (res) => res.writeHead(503).end());
      const token = opaque();
      const res = await rpc(url, bearer(token));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: 'server_error',
        error_description: 'Internal Server Error',
      });
      expect(lines.join('')).toMatch(/error: OAuth: token check failed: .*HTTP 503/);
      // A refused token, and one that was accepted, are never written to the log either.
      as.overrides.clear();
      const inactive = 'inactive-token-value';
      expect((await rpc(url, bearer(inactive))).status).toBe(401);
      const accepted = opaque();
      const ok = await rpc(url, bearer(accepted));
      expect(ok.status).toBe(200);
      await ok.text();
      expect(lines.length).toBeGreaterThan(2);
      for (const t of [token, inactive, accepted]) expect(lines.join('')).not.toContain(t);
      expect(lines.join('')).not.toContain(INTROSPECTION_CLIENT.secret);
    } finally {
      await stop(http);
    }
  });
});
