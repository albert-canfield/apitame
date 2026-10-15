import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { inspectCommand } from '../../src/cli/commands/inspect.js';
import { parseConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { JwtVerifier, type OAuthOptions } from '../../src/server/oauth.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import { serveHttp, serveStdio } from '../../src/server/transport.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { DuckdbDriver } from '../../src/sources/sql/duckdb.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import type { CallContext } from '../../src/types.js';
import {
  createDuckdbShop,
  createSqliteShop,
  duckdbForTests,
  fakeApi,
  jsonOf,
  PETSTORE,
  petstore,
  petstoreConfig,
  tempDir,
  textOf,
} from '../helpers.js';
import {
  claimsFor,
  FakeAuthServer,
  makeKey,
  signers,
  signJwt,
  type TestKey,
} from '../oauth-fixtures.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const MODERN = '2026-07-28';
const silent = new Logger(new Redactor(), 'silent');
const tmp = tempDir('apitame-permissions-');
let as: FakeAuthServer;
let key: TestKey;
let mock: MockServer;
let audits = 0;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  key = makeKey('rsa', 'rsa-1');
  mock = await startMockServer(extractOperations((await petstore()).doc));
});
afterAll(async () => {
  await mock.close();
  await as.close();
  tmp.cleanup();
});
beforeEach(() => as.publish(key));

/**
 * The Petstore, read-write, with four writes allowed by the server config, and permissions that
 * give each scope or client a different part of it.
 */
const PERMISSIONS = {
  byScope: {
    'mcp:read': { mode: 'read-only' as const },
    'mcp:write': { writes: ['addPet', 'deletePet'] },
  },
  byClient: { 'ci-bot': { tools: ['pet', 'search_operations'], writes: ['updatePet'] } },
};

async function petServer(permissions: unknown = PERMISSIONS, extra: Partial<ConfigInput> = {}) {
  const auditFile = join(tmp.dir, `audit-${audits++}.jsonl`);
  const config = await petstoreConfig({
    mode: 'read-write',
    writes: { allow: ['addPet', 'updatePet', 'deletePet', 'placeOrder'] },
    audit: { file: auditFile, include: 'all' },
    http: {
      oauth: {
        issuer: as.issuer,
        resource: RESOURCE,
        scopes: ['mcp:tools'],
        permissions: permissions as never,
      },
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

const token = (claims: Record<string, unknown>) =>
  signJwt(
    { alg: 'RS256', kid: 'rsa-1', typ: 'at+jwt' },
    claimsFor(as.issuer, RESOURCE, claims),
    signers.rs(key.privateKey),
  );

/** Tokens for four callers: by scope, by client, and one that no entry matches. */
const callers = () => ({
  reader: token({ sub: 'rita', scope: 'mcp:tools mcp:read' }),
  writer: token({ sub: 'walt', scope: 'mcp:tools mcp:write' }),
  bot: token({ sub: 'svc', client_id: 'ci-bot', scope: 'mcp:tools' }),
  nobody: token({ sub: 'nora', scope: 'mcp:tools' }),
});

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

type Kind = 'http' | 'http --sessions' | `http (${typeof MODERN})`;

/** Serve a runtime over HTTP with OAuth, as `apitame serve --transport http` does. */
async function serve(rt: OpenApiRuntime, oauth: OAuthOptions, sessions = false) {
  const http = await serveHttp(() => createMcpServer(rt), {
    host: '127.0.0.1',
    port: 0,
    logger: silent,
    sessions,
    oauth: { verifier: new JwtVerifier(oauth), options: oauth, name: 'petstore' },
  });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  const clients: Client[] = [];
  return {
    async connect(
      t: string,
      opts: { modern?: boolean; onPrompt?: (message: string) => void } = {},
    ): Promise<Client> {
      const client = new Client(
        { name: 'permissions-test', version: '1.0.0' },
        {
          capabilities: { elicitation: { form: {} } },
          ...(opts.modern ? { versionNegotiation: { mode: { pin: MODERN } } } : {}),
        },
      );
      client.setRequestHandler('elicitation/create', async (req) => {
        opts.onPrompt?.(String(req.params.message));
        return { action: 'accept', content: { approve: true } };
      });
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${t}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await stop(http);
    },
  };
}

/** Tool names, each with the operations it offers (an operation enum, or itself). */
function surface(tools: Array<{ name: string; inputSchema: unknown }>): Record<string, string[]> {
  return Object.fromEntries(
    tools.map((t) => {
      const props = (t.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
      return [t.name, props?.operation?.enum ?? []];
    }),
  );
}

const writesIn = (ops: string[]) =>
  ops.filter((o) => ['addPet', 'updatePet', 'deletePet', 'placeOrder', 'uploadFile'].includes(o));

const sentTo = (operationId: string) =>
  mock.requests.filter((r) => r.operationId === operationId).length;

describe.each<Kind>(['http', 'http --sessions', `http (${MODERN})`])(
  'per-caller tools/list over %s',
  (kind) => {
    it('shows each caller only the tools and writes it may use', async () => {
      const { rt, config } = await petServer();
      const s = await serve(rt, config.http.oauth!, kind === 'http --sessions');
      try {
        const t = callers();
        const modern = kind.includes(MODERN);
        const listed = async (tok: string) => {
          const client = await s.connect(tok, { modern });
          if (modern) expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
          return surface((await client.listTools()).tools);
        };

        // The server config alone: every allowlisted write.
        const all = surface(rt.listTools());
        expect(writesIn(all.pet!)).toEqual(['addPet', 'updatePet', 'deletePet']);

        const reader = await listed(t.reader);
        expect(Object.keys(reader)).toEqual(Object.keys(all));
        expect(writesIn(reader.pet!)).toEqual([]);
        expect(writesIn(reader.store!)).toEqual([]);
        expect(reader.pet).toContain('getPetById');

        // writes [addPet, deletePet] meets writes.allow: updatePet and placeOrder stay hidden.
        const writer = await listed(t.writer);
        expect(writesIn(writer.pet!)).toEqual(['addPet', 'deletePet']);
        expect(writesIn(writer.store!)).toEqual([]);

        // tools [pet, search_operations]: no call_operation, user or store tool at all.
        const bot = await listed(t.bot);
        expect(Object.keys(bot).sort()).toEqual(['pet', 'search_operations']);
        expect(writesIn(bot.pet!)).toEqual(['updatePet']);

        // No entry matches: read-only by default.
        const nobody = await listed(t.nobody);
        expect(nobody).toEqual(reader);
      } finally {
        await s.close();
      }
    });
  },
);

describe('a read-only caller and an allowlisted write', () => {
  it('is refused with the reason, nothing is sent and nobody is asked', async () => {
    const { rt, config, audit } = await petServer();
    const s = await serve(rt, config.http.oauth!, true);
    try {
      const prompts: string[] = [];
      const reader = await s.connect(callers().reader, { onPrompt: (m) => prompts.push(m) });
      const before = { add: sentTo('addPet'), del: sentTo('deletePet') };

      for (const [operationId, params] of [
        ['deletePet', { petId: 3 }],
        ['addPet', { body: { name: 'Rex', photoUrls: [] } }],
      ] as const) {
        const res = await reader.callTool({
          name: 'call_operation',
          arguments: { operationId, params },
        });
        expect(res.isError).toBe(true);
        const text = textOf(res as never);
        expect(text).toContain('your access token allows read-only access');
        expect(text).toContain('scope mcp:read');
        // Other callers' permissions are never named.
        expect(text).not.toMatch(/mcp:write|ci-bot|byScope|byClient/);
        expect(text).not.toContain('CONFIRMATION REQUIRED');
      }
      // Through the grouped tool, the operation does not exist for this caller.
      const grouped = await reader.callTool({
        name: 'pet',
        arguments: { operation: 'deletePet', params: { petId: 3 } },
      });
      expect(textOf(grouped as never)).toContain('Unknown operation "deletePet"');

      expect(prompts).toEqual([]);
      expect({ add: sentTo('addPet'), del: sentTo('deletePet') }).toEqual(before);
      const blocked = audit().filter((e) => e.outcome === 'blocked');
      expect(blocked.map((e) => e.operation)).toEqual(['deletePet', 'addPet']);
      for (const e of blocked) {
        expect(e).toMatchObject({ subject: 'rita', permissions: ['byScope.mcp:read'] });
      }

      // The control: the writer is asked, and the delete is sent once approved.
      const writer = await s.connect(callers().writer, { onPrompt: (m) => prompts.push(m) });
      const res = await writer.callTool({
        name: 'call_operation',
        arguments: { operationId: 'deletePet', params: { petId: 3 } },
      });
      expect(res.isError).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(sentTo('deletePet')).toBe(before.del + 1);
      expect(audit().at(-1)).toMatchObject({
        operation: 'deletePet',
        outcome: 'sent',
        subject: 'walt',
        permissions: ['byScope.mcp:write'],
      });
    } finally {
      await s.close();
    }
  });

  it('search_operations reports writes as blocked for that caller only', async () => {
    const { rt } = await petServer();
    const ctx = (scope: string): CallContext => ({ caller: { subject: 'u' }, scopes: [scope] });
    const status = async (c: CallContext | undefined) =>
      jsonOf<{ results: Array<{ operationId: string; status: string }> }>(
        await rt.callTool('search_operations', { query: 'delete pet' }, c),
      ).results.find((r) => r.operationId === 'deletePet')!.status;
    expect(await status(ctx('mcp:read'))).toMatch(/^blocked: .*read-only access/);
    expect(await status(ctx('mcp:write'))).toBe('available');
    expect(await status(undefined)).toBe('available');
  });
});

/** An in-memory API with three writes, for runtime-level checks. */
const PETS = {
  '/pets': {
    get: { operationId: 'listPets', responses: { '200': { description: 'ok' } } },
    post: {
      operationId: 'createPet',
      parameters: [{ name: 'name', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: 'ok' } },
    },
  },
  '/pets/{id}': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    put: { operationId: 'updatePet', responses: { '200': { description: 'ok' } } },
    delete: { operationId: 'deletePet', responses: { '200': { description: 'ok' } } },
  },
};

function api(permissions: unknown, config: Record<string, unknown> = {}) {
  return fakeApi({
    paths: PETS,
    config: {
      mode: 'read-write',
      writes: { allow: ['createPet', 'deletePet'] },
      confirmation: { method: 'token' },
      http: {
        oauth: {
          issuer: 'https://login.example.com',
          resource: RESOURCE,
          permissions,
        },
      },
      ...config,
    },
  });
}

const withScopes = (
  scopes: string[],
  caller: CallContext['caller'] = { subject: 'u' },
): CallContext => ({
  caller,
  scopes,
});

const call = (rt: OpenApiRuntime, operationId: string, ctx?: CallContext) =>
  rt.callTool(
    'call_operation',
    {
      operationId,
      params: operationId === 'createPet' || operationId === 'listPets' ? {} : { id: '1' },
    },
    ctx,
  );

/** The writes call_operation would run for this caller, read from search results. */
function writableIn(rt: OpenApiRuntime, ctx?: CallContext): Promise<string[]> {
  return rt.callTool('search_operations', { query: 'pet', limit: 25 }, ctx).then((r) =>
    jsonOf<{ results: Array<{ operationId: string; access: string; status: string }> }>(r)
      .results.filter((x) => x.access !== 'read' && x.status === 'available')
      .map((x) => x.operationId)
      .sort(),
  );
}

describe('permissions only narrow the server config', () => {
  it('intersects a caller write list with writes.allow and never widens it', async () => {
    const { rt, sent } = api({
      byScope: {
        everything: { writes: ['*'] },
        some: { writes: ['createPet', 'updatePet'] },
      },
    });
    // "*" means every write the server allows, and no more: updatePet is not in writes.allow.
    expect(await writableIn(rt, withScopes(['everything']))).toEqual(['createPet', 'deletePet']);
    expect(await writableIn(rt, withScopes(['some']))).toEqual(['createPet']);

    const update = await call(rt, 'updatePet', withScopes(['some']));
    expect(textOf(update)).toContain('not in writes.allow');
    const del = await call(rt, 'deletePet', withScopes(['some']));
    expect(textOf(del)).toContain(
      '"deletePet" is a destructive operation that your access token does not allow',
    );
    expect(textOf(del)).not.toContain('CONFIRMATION REQUIRED');
    expect(sent).toHaveLength(0);
    const create = await call(rt, 'createPet', withScopes(['some']));
    expect(create.isError).toBeFalsy();
    expect(sent.map((s) => s.method)).toEqual(['POST']);
  });

  it('cannot make a read-only server writable', async () => {
    const { rt, sent } = api(
      { byScope: { admin: { mode: 'read-write', writes: ['*'] } } },
      {
        mode: 'read-only',
      },
    );
    expect(await writableIn(rt, withScopes(['admin']))).toEqual([]);
    const res = await call(rt, 'createPet', withScopes(['admin']));
    expect(textOf(res)).toContain('the server runs in read-only mode');
    expect(sent).toHaveLength(0);
  });

  it('gives the union of every entry that matches the token scopes and client', async () => {
    const { rt } = api({
      byScope: { a: { writes: ['createPet'] }, ro: { mode: 'read-only' } },
      byClient: { app: { writes: ['deletePet'] } },
    });
    expect(await writableIn(rt, withScopes(['ro']))).toEqual([]);
    expect(await writableIn(rt, withScopes(['a', 'ro']))).toEqual(['createPet']);
    expect(await writableIn(rt, withScopes(['a'], { client: 'app', subject: 'u' }))).toEqual([
      'createPet',
      'deletePet',
    ]);
    // A subject that happens to equal a client id is not that client.
    expect(await writableIn(rt, withScopes([], { subject: 'app' }))).toEqual([]);
  });

  it('gives callers that no entry matches read-only access, or the default entry', async () => {
    const readOnly = api({ byScope: { a: { writes: ['createPet'] } } });
    expect(await writableIn(readOnly.rt, withScopes(['other']))).toEqual([]);
    const res = await call(readOnly.rt, 'createPet', withScopes(['other']));
    expect(textOf(res)).toContain('allows read-only access');
    expect(textOf(res)).toContain('no entry in http.oauth.permissions matches');
    expect(readOnly.sent).toHaveLength(0);
    // Object members are not entries.
    expect(await writableIn(readOnly.rt, withScopes(['constructor', 'toString']))).toEqual([]);

    const withDefault = api({
      byScope: { a: { writes: ['createPet'] } },
      default: { writes: ['deletePet'], tools: ['call_operation'] },
    });
    const ctx = withScopes(['other']);
    expect(withDefault.rt.listTools(ctx).map((t) => t.name)).toEqual(['call_operation']);
    expect(textOf(await call(withDefault.rt, 'deletePet', ctx))).toContain('CONFIRMATION REQUIRED');
    // A caller that matches an entry does not also get the default.
    expect(textOf(await call(withDefault.rt, 'deletePet', withScopes(['a'])))).toContain(
      'does not allow',
    );
  });

  it('are decided before argument rules, which still apply to the callers they permit', async () => {
    const { rt, sent } = api(
      { byScope: { ro: { mode: 'read-only' }, rw: {} } },
      {
        writes: {
          allow: ['createPet', 'deletePet'],
          rules: { createPet: { name: { in: ['Rex'] } } },
        },
      },
    );
    const create = (name: string, ctx: CallContext) =>
      rt.callTool('call_operation', { operationId: 'createPet', params: { name } }, ctx);
    // Not permitted: refused as such, whatever the arguments, and the rule is never mentioned.
    for (const name of ['Rex', 'Bad']) {
      const res = await create(name, withScopes(['ro']));
      expect(textOf(res)).toContain('your access token allows read-only access');
      expect(textOf(res)).not.toContain('writes.rules');
    }
    // Permitted: the rule still applies.
    expect(textOf(await create('Bad', withScopes(['rw'])))).toContain(
      'Refused by writes.rules for "createPet"',
    );
    expect(sent).toHaveLength(0);
    expect((await create('Rex', withScopes(['rw']))).isError).toBeFalsy();
    expect(sent).toHaveLength(1);
  });

  it('describes call_operation by what the caller can run: hints and control arguments', async () => {
    const { rt } = api({ byScope: { ro: { mode: 'read-only' } } });
    const callOperation = (ctx?: CallContext) =>
      rt.listTools(ctx).find((t) => t.name === 'call_operation')!;
    const readOnly = callOperation(withScopes(['ro']));
    expect(readOnly.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(readOnly.description).toContain('Read-only mode: only read operations run.');
    expect(Object.keys(readOnly.inputSchema.properties ?? {})).not.toContain('dryRun');
    expect(Object.keys(readOnly.inputSchema.properties ?? {})).not.toContain('confirm');
    // Without a caller, the server config: deletePet makes it destructive and asks first.
    const full = callOperation();
    expect(full.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(full.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['dryRun', 'confirm']),
    );
  });

  it('hides tools a caller may not use, and treats them as unknown', async () => {
    const { rt, sent } = api({ byScope: { narrow: { tools: ['search_*'] } } });
    const ctx = withScopes(['narrow']);
    expect(rt.listTools(ctx).map((t) => t.name)).toEqual(['search_operations']);
    const res = await call(rt, 'createPet', ctx);
    expect(textOf(res)).toBe('Unknown tool "call_operation".');
    expect(sent).toHaveLength(0);
    // Its search does not offer operations it cannot reach.
    const found = jsonOf<{ results: Array<{ operationId: string; status: string }> }>(
      await rt.callTool('search_operations', { query: 'list pets' }, ctx),
    ).results.find((r) => r.operationId === 'listPets');
    expect(found?.status).toMatch(/^blocked: it is in no tool/);
  });

  it('keeps a bounded number of per-caller tool lists, and rebuilds evicted ones the same', async () => {
    // 40 scopes with different tool patterns: 40 permission sets that all see the same tools.
    const byScope = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `s${i}`,
        { tools: ['call_operation', `search${'*'.repeat(i + 1)}`] },
      ]),
    );
    const { rt } = api({ byScope });
    const first = rt.listTools(withScopes(['s0']));
    expect(first.map((t) => t.name)).toEqual(['search_operations', 'call_operation']);
    for (let i = 1; i < 40; i++) expect(rt.listTools(withScopes([`s${i}`]))).toEqual(first);
    const views = (rt as unknown as { views: Map<string, unknown> }).views;
    expect(views.size).toBe(32);
    expect(rt.listTools(withScopes(['s0']))).toEqual(first);
  });

  it('applies nothing without an OAuth caller: stdio and other transports keep the server config', async () => {
    const { rt, sent } = api({ byScope: { a: { mode: 'read-only' } } });
    // No caller: the scopes alone change nothing.
    expect(await writableIn(rt, undefined)).toEqual(['createPet', 'deletePet']);
    expect(await writableIn(rt, { scopes: ['a'] })).toEqual(['createPet', 'deletePet']);
    expect((await call(rt, 'createPet')).isError).toBeFalsy();
    expect(sent).toHaveLength(1);
  });
});

describe('stdio', () => {
  it('serves the server config unchanged when permissions are configured', async () => {
    const { rt } = await petServer({ byScope: {}, default: { mode: 'read-only', tools: ['pet'] } });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveStdio(() => createMcpServer(rt), {
      transport: serverSide,
      logger: silent,
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(clientSide);
      const tools = surface((await client.listTools()).tools);
      expect(Object.keys(tools)).toEqual(Object.keys(surface(rt.listTools())));
      expect(writesIn(tools.pet!)).toEqual(['addPet', 'updatePet', 'deletePet']);
      const before = sentTo('addPet');
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'addPet', params: { body: { name: 'Rex', photoUrls: [] } } },
      });
      expect(res.isError).toBeFalsy();
      expect(sentTo('addPet')).toBe(before + 1);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});

describe('per-caller rate limits', () => {
  it('give each user a budget of their own, without using up the shared one', async () => {
    const { rt } = api(undefined, {
      limits: { maxCallsPerMinute: 3, perCaller: { maxCallsPerMinute: 2 } },
    });
    const alice: CallContext = { caller: { client: 'app', subject: 'alice' } };
    const bob: CallContext = { caller: { client: 'app', subject: 'bob' } };
    const list = (ctx?: CallContext) => call(rt, 'listPets', ctx);
    expect((await list(alice)).isError).toBeFalsy();
    expect((await list(alice)).isError).toBeFalsy();
    for (let i = 0; i < 5; i++) {
      expect(textOf(await list(alice))).toMatch(/more than 2 calls per minute for this user/);
    }
    // Alice's refused calls did not count against the server: Bob gets the one call left.
    expect((await list(bob)).isError).toBeFalsy();
    expect(textOf(await list(bob))).toMatch(/more than 3 calls per minute\./);
  });

  it('limit writes per user, checked before anyone is asked', async () => {
    const { rt, sent } = api(undefined, {
      limits: { perCaller: { maxWritesPerMinute: 1 } },
    });
    const alice: CallContext = { caller: { subject: 'alice' } };
    const bob: CallContext = { caller: { subject: 'bob' } };
    expect((await call(rt, 'createPet', alice)).isError).toBeFalsy();
    const again = await call(rt, 'createPet', alice);
    expect(textOf(again)).toMatch(/more than 1 writes per minute for this user/);
    // Refused before a confirmation token is issued.
    expect(textOf(await call(rt, 'deletePet', alice))).toMatch(/for this user/);
    expect((await call(rt, 'createPet', bob)).isError).toBeFalsy();
    expect(sent).toHaveLength(2);
    // Without an OAuth caller there is no per-caller budget.
    expect((await call(rt, 'createPet')).isError).toBeFalsy();
    expect((await call(rt, 'createPet')).isError).toBeFalsy();
  });

  it('keep the client and the subject apart', async () => {
    const { rt } = api(undefined, { limits: { perCaller: { maxCallsPerMinute: 1 } } });
    expect((await call(rt, 'listPets', { caller: { client: 'x' } })).isError).toBeFalsy();
    expect((await call(rt, 'listPets', { caller: { subject: 'x' } })).isError).toBeFalsy();
    expect(textOf(await call(rt, 'listPets', { caller: { subject: 'x' } }))).toMatch(
      /for this user/,
    );
  });
});

describe('SQL named queries', () => {
  const t = tempDir('apitame-permissions-sql-');
  const db = join(t.dir, 'shop.db');
  const auditFile = join(t.dir, 'audit.jsonl');
  beforeAll(() => createSqliteShop(db));
  afterAll(() => t.cleanup());

  const sqlRuntime = () =>
    new SqlRuntime(
      parseConfig({
        name: 'shop',
        mode: 'read-write',
        source: { type: 'sqlite', path: db },
        writes: {
          allow: ['archive_order', 'touch_order'],
          rules: { touch_order: { id: { max: 100 } } },
        },
        confirmation: { method: 'token' },
        audit: { file: auditFile },
        sql: {
          queries: [
            {
              name: 'archive_order',
              description: 'Archive one order',
              write: true,
              sql: 'DELETE FROM order_items WHERE order_id = :id AND 1 = 0',
              params: { id: { type: 'integer' } },
            },
            {
              name: 'touch_order',
              description: 'Touch one order',
              write: true,
              sql: 'UPDATE orders SET status = status WHERE id = :id',
              params: { id: { type: 'integer' } },
            },
            {
              name: 'order_count',
              description: 'Number of orders',
              sql: 'SELECT count(*) AS n FROM orders',
            },
          ],
        },
        http: {
          oauth: {
            issuer: 'https://login.example.com',
            resource: RESOURCE,
            permissions: {
              byScope: {
                'db:read': { mode: 'read-only' },
                'db:touch': { writes: ['touch_order'] },
                'db:curated': { tools: ['order_count', 'touch_order'] },
              },
            },
          },
        },
      }),
      new SqliteDriver(db),
      new Redactor(),
    );
  const names = (rt: SqlRuntime, ctx?: CallContext) => rt.listTools(ctx).map((x) => x.name);
  const scope = (s: string): CallContext => ({ caller: { subject: s }, scopes: [s] });

  it('list and run only what the caller may use', async () => {
    const rt = sqlRuntime();
    try {
      const builtIn = ['list_tables', 'describe_table', 'query'];
      expect(names(rt)).toEqual([...builtIn, 'archive_order', 'touch_order', 'order_count']);
      expect(names(rt, scope('db:read'))).toEqual([...builtIn, 'order_count']);
      expect(names(rt, scope('db:touch'))).toEqual([...builtIn, 'touch_order', 'order_count']);
      expect(names(rt, scope('db:curated'))).toEqual(['touch_order', 'order_count']);

      // Refused before a confirmation token is issued or anything runs.
      const archived = await rt.callTool('archive_order', { id: 1 }, scope('db:read'));
      expect(archived.isError).toBe(true);
      expect(textOf(archived)).toContain('your access token allows read-only access');
      expect(textOf(await rt.callTool('touch_order', { id: 1 }, scope('db:read')))).toContain(
        'read-only access',
      );
      const other = await rt.callTool('archive_order', { id: 1 }, scope('db:touch'));
      expect(textOf(other)).toContain('that your access token does not allow');
      expect(textOf(other)).not.toContain('CONFIRMATION REQUIRED');
      const touched = jsonOf(await rt.callTool('touch_order', { id: 1 }, scope('db:touch')));
      expect(touched).toMatchObject({ affectedRows: 1 });
      // Permissions come before argument rules; rules still apply to permitted callers.
      expect(textOf(await rt.callTool('touch_order', { id: 999 }, scope('db:read')))).toContain(
        'read-only access',
      );
      expect(textOf(await rt.callTool('touch_order', { id: 999 }, scope('db:touch')))).toContain(
        'Refused by writes.rules for "touch_order"',
      );

      // Tools outside `tools` do not exist for that caller, the free-form query included.
      for (const name of ['query', 'archive_order']) {
        expect(textOf(await rt.callTool(name, { sql: 'SELECT 1' }, scope('db:curated')))).toBe(
          `Unknown tool "${name}".`,
        );
      }
      // Without a caller, the server config applies: the destructive query asks first.
      expect(textOf(await rt.callTool('archive_order', { id: 1 }))).toContain(
        'CONFIRMATION REQUIRED',
      );

      const entries = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries.slice(0, 6)).toMatchObject([
        { tool: 'archive_order', outcome: 'blocked', permissions: ['byScope.db:read'] },
        { tool: 'touch_order', outcome: 'blocked', permissions: ['byScope.db:read'] },
        { tool: 'archive_order', outcome: 'blocked', permissions: ['byScope.db:touch'] },
        { tool: 'touch_order', outcome: 'sent', permissions: ['byScope.db:touch'] },
        { tool: 'touch_order', outcome: 'blocked', permissions: ['byScope.db:read'] },
        { tool: 'touch_order', outcome: 'blocked', permissions: ['byScope.db:touch'] },
      ]);
      expect(entries[4]!.reason).toContain('read-only access');
      expect(entries.at(-1)).not.toHaveProperty('permissions');
    } finally {
      await rt.close();
    }
  });
});

describe('config validation', () => {
  const oauth = (permissions: unknown) => ({
    http: { oauth: { issuer: 'https://login.example.com', resource: RESOURCE, permissions } },
  });
  const minimal = { name: 'demo', source: { type: 'openapi', spec: './openapi.yaml' } };

  it('refuses entries that cannot mean what they say', () => {
    expect(() =>
      parseConfig({ ...minimal, ...oauth({ 'mcp:read': { mode: 'read-only' } }) }),
    ).toThrow(/Unknown key "mcp:read" \(put scopes under byScope and client ids under byClient\)/);
    expect(() => parseConfig({ ...minimal, ...oauth({ scopes: {} }) })).toThrow(
      /did you mean byScope\?/,
    );
    expect(() =>
      parseConfig({ ...minimal, ...oauth({ byScope: { a: { allow: ['x'] } } }) }),
    ).toThrow(/Unknown key "allow" \(did you mean writes\?\)/);
    expect(() =>
      parseConfig({
        ...minimal,
        ...oauth({ byScope: { a: { mode: 'read-only', writes: ['x'] } } }),
      }),
    ).toThrow(/writes has no effect with mode: read-only/);
    expect(() => parseConfig({ ...minimal, limits: { perCaller: { maxCalls: 5 } } })).toThrow(
      /Unknown key "maxCalls"/,
    );
    // An entry naming no field at all is valid: it narrows nothing.
    expect(
      parseConfig({ ...minimal, ...oauth({ byClient: { app: {} } }) }).http.oauth?.permissions,
    ).toEqual({ byScope: {}, byClient: { app: {} } });
  });

  it('warns about tools and operations that do not exist, and keeps serving, for OpenAPI', async () => {
    const { rt, sent } = api({
      byScope: { 'mcp:read': { tools: ['pets'] } },
      byClient: { app: { writes: ['createPett'] } },
      default: { tools: ['call_*'], writes: ['*Pet'] },
    });
    expect(rt.warnings).toEqual([
      'http.oauth.permissions.byScope.mcp:read.tools: no tool matches "pets" (typo?), so it shows nothing. Tools: search_operations, call_operation.',
      'http.oauth.permissions.byClient.app.writes: no operation matches "createPett" (typo?), so it grants nothing.',
    ]);
    // A name that matches nothing only fails to grant: these callers get less, never more.
    expect(rt.listTools(withScopes(['mcp:read']))).toEqual([]);
    const app = withScopes([], { client: 'app', subject: 'u' });
    expect(textOf(await call(rt, 'createPet', app))).toContain(
      'that your access token does not allow',
    );
    expect(sent).toHaveLength(0);
  });

  it('warns about writes that the server never allows, since permissions cannot widen', () => {
    const { rt } = api({ byScope: { a: { writes: ['updatePet', 'listPets', 'create*'] } } });
    expect(rt.warnings).toEqual([
      'http.oauth.permissions.byScope.a.writes: "updatePet" grants nothing, because no write it matches is in writes.allow (permissions only narrow writes.allow).',
      'http.oauth.permissions.byScope.a.writes: "listPets" grants nothing, because no write it matches is in writes.allow (permissions only narrow writes.allow).',
    ]);
    // A read-only server grants no writes to anyone: no warning for each entry.
    expect(
      api({ byScope: { a: { writes: ['updatePet'] } } }, { mode: 'read-only' }).rt.warnings,
    ).toEqual([]);
  });

  it('warns about tools and named queries that do not exist, for SQL', () => {
    const t = tempDir('apitame-permissions-check-');
    const db = join(t.dir, 'shop.db');
    try {
      createSqliteShop(db);
      const build = (permissions: unknown) =>
        new SqlRuntime(
          parseConfig({
            name: 'shop',
            source: { type: 'sqlite', path: db },
            sql: { queries: [{ name: 'order_count', description: 'n', sql: 'SELECT 1' }] },
            ...oauth(permissions),
          }),
          new SqliteDriver(db),
          new Redactor(),
        );
      const rt = build({ byScope: { a: { tools: ['run_sql'], writes: ['archive'] } } });
      expect(rt.warnings).toEqual([
        'http.oauth.permissions.byScope.a.tools: no tool matches "run_sql" (typo?), so it shows nothing. Tools: list_tables, describe_table, query, order_count.',
        'http.oauth.permissions.byScope.a.writes: no named query matches "archive" (typo?), so it grants nothing.',
      ]);
      expect(rt.listTools({ caller: { subject: 'u' }, scopes: ['a'] })).toEqual([]);
      expect(build({ byScope: { a: { tools: ['query', 'order_count'] } } }).warnings).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  it('reports them in inspect, as writes.rules does', async () => {
    const t = tempDir('apitame-permissions-inspect-');
    try {
      copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
      const config = join(t.dir, 'apitame.config.yaml');
      writeFileSync(
        config,
        stringify({
          name: 'petstore',
          source: { type: 'openapi', spec: './openapi.yaml' },
          ...oauth({ byScope: { 'mcp:read': { tools: ['pets'] } } }),
        }),
      );
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
      });
      try {
        await inspectCommand({ config, json: true });
        const json = JSON.parse(lines.join('\n')) as { warnings: string[] };
        expect(json.warnings).toContain(
          'http.oauth.permissions.byScope.mcp:read.tools: no tool matches "pets" (typo?), so it shows nothing. Tools: search_operations, call_operation.',
        );
        lines.length = 0;
        await inspectCommand({ config });
        expect(lines.join('\n')).toContain('byScope.mcp:read.tools: no tool matches "pets"');
      } finally {
        spy.mockRestore();
      }
    } finally {
      t.cleanup();
    }
  });
});

const { duck } = await duckdbForTests();

describe.skipIf(!duck)('DuckDB sources', () => {
  const t = tempDir('apitame-permissions-duckdb-');
  const file = join(t.dir, 'shop.duckdb');
  beforeAll(async () => {
    if (duck) await createDuckdbShop(file, duck);
  }, 60_000);
  afterAll(() => t.cleanup());

  it('list and run only the read tools a caller may use', async () => {
    const config = parseConfig({
      name: 'shop',
      source: { type: 'duckdb', path: file },
      sql: {
        queries: [
          {
            name: 'order_count',
            description: 'Number of orders',
            sql: 'SELECT count(*) AS n FROM orders',
          },
        ],
      },
      http: {
        oauth: {
          issuer: 'https://login.example.com',
          resource: RESOURCE,
          permissions: { byScope: { analyst: { tools: ['order_count'] } }, default: {} },
        },
      },
    });
    const rt = new SqlRuntime(config, new DuckdbDriver(file), new Redactor());
    try {
      const analyst: CallContext = { caller: { subject: 'a' }, scopes: ['analyst'] };
      expect(rt.listTools(analyst).map((x) => x.name)).toEqual(['order_count']);
      expect(textOf(await rt.callTool('query', { sql: 'SELECT 1' }, analyst))).toBe(
        'Unknown tool "query".',
      );
      expect(
        jsonOf<{ rows: unknown[][] }>(await rt.callTool('order_count', {}, analyst)).rows,
      ).toHaveLength(1);
      // The default entry, {}, narrows nothing: every read tool, as without a caller.
      const other: CallContext = { caller: { subject: 'b' }, scopes: [] };
      expect(rt.listTools(other).map((x) => x.name)).toEqual(rt.listTools().map((x) => x.name));
      expect((await rt.callTool('query', { sql: 'SELECT 1 AS one' }, other)).isError).toBeFalsy();
    } finally {
      await rt.close();
    }
  });
});
