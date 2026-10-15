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
 * The Petstore, read-write, with four writes allowed by the server config. Every OAuth caller
 * reads pets and the store (not users); scopes and clients add writes on top.
 */
const PERMISSIONS = {
  default: {
    mode: 'read-only' as const,
    tools: ['pet', 'store', 'search_operations', 'call_operation'],
  },
  byScope: { 'mcp:write': { tools: ['pet'], writes: ['addPet', 'deletePet'] } },
  byClient: { 'ci-bot': { tools: ['pet'], writes: ['updatePet'] } },
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

/** Tokens for four callers: by scope, by client, and two that no entry matches. */
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

        expect(Object.keys(all)).toEqual([
          'pet',
          'user',
          'store',
          'search_operations',
          'call_operation',
        ]);

        // mcp:read has no entry: only the default, read-only and without the user tool.
        const reader = await listed(t.reader);
        expect(Object.keys(reader)).toEqual([
          'pet',
          'store',
          'search_operations',
          'call_operation',
        ]);
        expect(writesIn(reader.pet!)).toEqual([]);
        expect(writesIn(reader.store!)).toEqual([]);
        expect(reader.pet).toContain('getPetById');

        // writes [addPet, deletePet] meets writes.allow: updatePet and placeOrder stay hidden.
        const writer = await listed(t.writer);
        expect(Object.keys(writer)).toEqual(Object.keys(reader));
        expect(writesIn(writer.pet!)).toEqual(['addPet', 'deletePet']);
        expect(writesIn(writer.store!)).toEqual([]);

        const bot = await listed(t.bot);
        expect(Object.keys(bot)).toEqual(Object.keys(reader));
        expect(writesIn(bot.pet!)).toEqual(['updatePet']);

        // No scope beyond the required one: the default, like the reader.
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
        expect(text).toContain('only the default: no entry in http.oauth.permissions matches');
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
        expect(e).toMatchObject({ subject: 'rita', permissions: ['default'] });
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
        permissions: ['default', 'byScope.mcp:write'],
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

  it('adds every entry that matches the token scopes and client to the default', async () => {
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

  it('gives every caller the default, read-only when unset, and entries only add to it', async () => {
    const readOnly = api({ byScope: { a: { writes: ['createPet'] } } });
    expect(await writableIn(readOnly.rt, withScopes(['other']))).toEqual([]);
    const res = await call(readOnly.rt, 'createPet', withScopes(['other']));
    expect(textOf(res)).toContain('allows read-only access');
    expect(textOf(res)).toContain('only the default: no entry in http.oauth.permissions matches');
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
    // A caller that matches an entry keeps the default and gets the entry on top.
    expect(await writableIn(withDefault.rt, withScopes(['a']))).toEqual(['createPet', 'deletePet']);
  });

  it('never gives a token more access for leaving a scope out', async () => {
    // A contractor entry narrower than the default cannot restrict anything: it is reported.
    const { rt, sent } = api({ byScope: { contractor: { mode: 'read-only' } }, default: {} });
    expect(rt.warnings).toEqual([
      'http.oauth.permissions.byScope.contractor: adds nothing to permissions.default, so it has no effect. Every caller gets default, and entries can only add to it: to restrict callers, narrow default and grant more in entries.',
    ]);
    expect(await writableIn(rt, withScopes(['contractor']))).toEqual(
      await writableIn(rt, withScopes([])),
    );
    // Configured the right way round, the token without the scope gets less, never more.
    const right = api({ byScope: { staff: { writes: ['createPet'] } } });
    expect(right.rt.warnings).toEqual([]);
    expect(await writableIn(right.rt, withScopes(['staff']))).toEqual(['createPet']);
    expect(await writableIn(right.rt, withScopes([]))).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('grants a write only through one entry that both allows it and reaches it with its own tools', async () => {
    const ok = { '200': { description: 'ok' } };
    const { rt, sent } = fakeApi({
      paths: {
        '/orders': {
          get: { operationId: 'listOrders', responses: ok },
          post: { operationId: 'createOrder', responses: ok },
        },
        '/pets/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { operationId: 'getPet', responses: ok },
          put: { operationId: 'updatePet', responses: ok },
        },
      },
      config: {
        mode: 'read-write',
        writes: { allow: ['createOrder', 'updatePet'] },
        tools: [
          { name: 'orders', operations: ['listOrders', 'createOrder'] },
          { name: 'pets', operations: ['getPet', 'updatePet'] },
        ],
        http: {
          oauth: {
            issuer: 'https://login.example.com',
            resource: RESOURCE,
            permissions: {
              byScope: {
                // All tools, no writes; and the orders tool with every write it holds.
                'mcp:read': { mode: 'read-only' },
                'orders-admin': { tools: ['orders'], writes: ['*'] },
                pets: { tools: ['orders'], writes: ['updatePet'] },
              },
            },
          },
        },
      },
    });
    const both = withScopes(['mcp:read', 'orders-admin']);
    // Seeing the pets tool (default) and holding writes: ['*'] (orders-admin) do not add up.
    const updated = await rt.callTool(
      'pets',
      { operation: 'updatePet', params: { id: '1' } },
      both,
    );
    expect(textOf(updated)).toContain('Unknown operation "updatePet"');
    const viaCall = await rt.callTool(
      'call_operation',
      { operationId: 'updatePet', params: { id: '1' } },
      both,
    );
    expect(textOf(viaCall)).toContain('that your access token does not allow');
    expect(sent).toHaveLength(0);
    const created = await rt.callTool('orders', { operation: 'createOrder', params: {} }, both);
    expect(created.isError).toBeFalsy();
    expect(sent.map((x) => x.method)).toEqual(['POST']);
    // An entry whose writes are out of reach of its own tools is reported.
    expect(rt.warnings).toContain(
      'http.oauth.permissions.byScope.pets.writes: "updatePet" grants nothing, because no write it matches is in a tool this entry shows (orders).',
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
    const { rt, sent } = api({ default: { tools: ['search_*'] } });
    const ctx = withScopes(['narrow']);
    expect(rt.listTools(ctx).map((t) => t.name)).toEqual(['search_operations']);
    const res = await call(rt, 'createPet', ctx);
    expect(textOf(res)).toBe('Unknown tool "call_operation".');
    expect(sent).toHaveLength(0);
    // Its search does not list operations it cannot reach at all.
    const found = jsonOf<{ results: Array<{ operationId: string }> }>(
      await rt.callTool('search_operations', { query: 'list pets' }, ctx),
    ).results;
    expect(found).toEqual([]);
  });

  it('keeps the operations of hidden groups out of call_operation and search_operations', async () => {
    const ok = { '200': { description: 'ok' } };
    const { rt, sent } = fakeApi({
      paths: {
        '/pets': { get: { operationId: 'listPets', responses: ok } },
        '/admin/salaries': {
          get: {
            operationId: 'listSalaries',
            parameters: [{ name: 'department', in: 'query', schema: { type: 'string' } }],
            responses: ok,
          },
        },
        '/status': { get: { operationId: 'getStatus', responses: ok } },
      },
      config: {
        tools: [
          { name: 'pets', operations: ['listPets'] },
          { name: 'hr', operations: ['listSalaries'] },
        ],
        http: {
          oauth: {
            issuer: 'https://login.example.com',
            resource: RESOURCE,
            permissions: { default: { tools: ['pets', 'search_operations', 'call_operation'] } },
          },
        },
      },
    });
    const staff = withScopes([]);
    for (const id of ['listSalaries', 'listsalaries']) {
      const res = await rt.callTool('call_operation', { operationId: id, params: {} }, staff);
      expect(textOf(res)).toBe(
        `Unknown operationId "${id}". Use search_operations to find valid ids.`,
      );
    }
    const search = async (query: string, ctx?: CallContext) =>
      jsonOf<{ results: Array<{ operationId: string; status: string }> }>(
        await rt.callTool('search_operations', { query }, ctx),
      );
    expect((await search('salaries', staff)).results).toEqual([]);
    // Operations in no group stay reachable through call_operation, and so do visible groups.
    expect(
      (await rt.callTool('call_operation', { operationId: 'getStatus' }, staff)).isError,
    ).toBeFalsy();
    expect(
      (await rt.callTool('call_operation', { operationId: 'listPets' }, staff)).isError,
    ).toBeFalsy();
    expect(sent.map((x) => new URL(x.url).pathname)).toEqual(['/v1/status', '/v1/pets']);
    // Without a caller, everything as before.
    expect((await search('salaries')).results.map((r) => r.operationId)).toEqual(['listSalaries']);
  });

  it('keeps a configured group grouped for a caller that may use only one of its operations', () => {
    const { rt } = api(
      {},
      {
        tools: [{ name: 'pets', operations: ['listPets', 'createPet'] }],
      },
    );
    const shape = (ctx?: CallContext) =>
      Object.keys(rt.listTools(ctx).find((t) => t.name === 'pets')!.inputSchema.properties ?? {});
    expect(shape()).toEqual(['operation', 'params', 'dryRun']);
    // Read-only by default: only listPets is left, and the tool keeps its shape.
    expect(shape(withScopes([]))).toEqual(['operation', 'params']);
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
              // Every caller: the order count. Scopes add free-form reads, or one write.
              default: { mode: 'read-only', tools: ['order_count'] },
              byScope: {
                'db:read': { mode: 'read-only', tools: ['list_tables', 'describe_table', 'query'] },
                'db:touch': { tools: ['touch_order'], writes: ['touch_order'] },
                // Shows the archive query, but grants no write: it stays hidden.
                'db:look': { mode: 'read-only', tools: ['archive_order'] },
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
      expect(names(rt, scope('nothing'))).toEqual(['order_count']);
      expect(names(rt, scope('db:read'))).toEqual([...builtIn, 'order_count']);
      expect(names(rt, scope('db:touch'))).toEqual(['touch_order', 'order_count']);
      expect(names(rt, scope('db:look'))).toEqual(['order_count']);

      // A hidden named query answers exactly like a tool that does not exist, whatever the
      // arguments: nothing about its parameters or the caller's entries.
      for (const args of [{}, { id: 'x' }, { id: 1 }, { id: 999 }]) {
        for (const [name, who] of [
          ['archive_order', 'db:read'],
          ['touch_order', 'db:read'],
          ['archive_order', 'db:touch'],
          ['archive_order', 'db:look'],
          ['query', 'db:touch'],
        ] as const) {
          expect(textOf(await rt.callTool(name, args, scope(who)))).toBe(`Unknown tool "${name}".`);
        }
        expect(textOf(await rt.callTool('no_such_tool', args, scope('db:read')))).toBe(
          'Unknown tool "no_such_tool".',
        );
      }
      const touched = jsonOf(await rt.callTool('touch_order', { id: 1 }, scope('db:touch')));
      expect(touched).toMatchObject({ affectedRows: 1 });
      // Argument rules still apply to the callers who may use the query.
      expect(textOf(await rt.callTool('touch_order', { id: 999 }, scope('db:touch')))).toContain(
        'Refused by writes.rules for "touch_order"',
      );
      // Without a caller, the server config applies: the destructive query asks first.
      expect(textOf(await rt.callTool('archive_order', { id: 1 }))).toContain(
        'CONFIRMATION REQUIRED',
      );

      const entries = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries).toMatchObject([
        { tool: 'touch_order', outcome: 'sent', permissions: ['default', 'byScope.db:touch'] },
        { tool: 'touch_order', outcome: 'blocked', permissions: ['default', 'byScope.db:touch'] },
        { tool: 'archive_order', outcome: 'confirmation-requested' },
      ]);
      expect(entries.at(-1)).not.toHaveProperty('permissions');
    } finally {
      await rt.close();
    }
  });

  it('decide named writes with the caller even past the visibility check', async () => {
    const rt = sqlRuntime();
    try {
      // runNamed is reached only for visible tools; its own decision is a second line.
      const named = (rt as unknown as { named: Map<string, unknown> }).named.get('touch_order');
      const runNamed = (
        rt as unknown as {
          runNamed: (n: unknown, a: object, c: CallContext) => Promise<{ content: [] }>;
        }
      ).runNamed.bind(rt);
      expect(textOf(await runNamed(named, { id: 1 }, scope('db:read')))).toContain(
        'your access token allows read-only access',
      );
    } finally {
      await rt.close();
    }
  });

  it('refuse unknown tool names before anything else, the rate limit included', async () => {
    const rt = new SqlRuntime(
      parseConfig({
        name: 'shop',
        source: { type: 'sqlite', path: db },
        limits: { maxCallsPerMinute: 1 },
        sql: { queries: [{ name: 'order_count', description: 'n', sql: 'SELECT 1 AS n' }] },
      }),
      new SqliteDriver(db),
      new Redactor(),
    );
    try {
      for (let i = 0; i < 3; i++) {
        expect(textOf(await rt.callTool(`nope_${i}`, {}))).toBe(`Unknown tool "nope_${i}".`);
      }
      expect((await rt.callTool('order_count', {})).isError).toBeFalsy();
    } finally {
      await rt.close();
    }
  });

  it('refuse a huge unknown tool name at once, whatever the patterns', async () => {
    const rt = new SqlRuntime(
      parseConfig({
        name: 'shop',
        source: { type: 'sqlite', path: db },
        sql: { queries: [{ name: 'sales_report', description: 'Sales', sql: 'SELECT 1' }] },
        http: {
          oauth: {
            issuer: 'https://login.example.com',
            resource: RESOURCE,
            permissions: { default: { tools: ['*report*', '*e*e*e*x'] } },
          },
        },
      }),
      new SqliteDriver(db),
      new Redactor(),
    );
    try {
      const name = `${'report'.repeat(700_000)}\n`; // about 4 MB
      const started = performance.now();
      expect(textOf(await rt.callTool(name, {}, scope('analyst')))).toMatch(/^Unknown tool/);
      expect(performance.now() - started).toBeLessThan(1_000);
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
      default: { mode: 'read-only', tools: ['call_*'] },
    });
    const noEffect = (path: string) =>
      `http.oauth.permissions.${path}: adds nothing to permissions.default, so it has no effect. Every caller gets default, and entries can only add to it: to restrict callers, narrow default and grant more in entries.`;
    expect(rt.warnings).toEqual([
      'http.oauth.permissions.byScope.mcp:read.tools: no tool matches "pets" (typo?), so it shows nothing. Tools: search_operations, call_operation.',
      noEffect('byScope.mcp:read'),
      'http.oauth.permissions.byClient.app.writes: no operation matches "createPett" (typo?), so it grants nothing.',
      // byClient.app still adds something: without `tools`, it shows search_operations.
    ]);
    // A name that matches nothing only fails to grant: these callers get less, never more.
    expect(rt.listTools(withScopes(['mcp:read'])).map((t) => t.name)).toEqual(['call_operation']);
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
      const rt = build({
        default: { mode: 'read-only', tools: ['order_count'] },
        byScope: { a: { tools: ['run_sql'], writes: ['archive'] } },
      });
      expect(rt.warnings).toEqual([
        'http.oauth.permissions.byScope.a.tools: no tool matches "run_sql" (typo?), so it shows nothing. Tools: list_tables, describe_table, query, order_count.',
        'http.oauth.permissions.byScope.a.writes: no named query matches "archive" (typo?), so it grants nothing.',
        'http.oauth.permissions.byScope.a: adds nothing to permissions.default, so it has no effect. Every caller gets default, and entries can only add to it: to restrict callers, narrow default and grant more in entries.',
      ]);
      expect(rt.listTools({ caller: { subject: 'u' }, scopes: ['a'] }).map((t) => t.name)).toEqual([
        'order_count',
      ]);
      expect(
        build({
          default: { mode: 'read-only', tools: ['list_tables'] },
          byScope: { a: { tools: ['query', 'order_count'] } },
        }).warnings,
      ).toEqual([]);
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
          permissions: {
            default: { tools: ['order_count'] },
            byScope: { analyst: { tools: ['list_tables', 'describe_table', 'query'] } },
          },
        },
      },
    });
    const rt = new SqlRuntime(config, new DuckdbDriver(file), new Redactor());
    try {
      const other: CallContext = { caller: { subject: 'b' }, scopes: [] };
      expect(rt.listTools(other).map((x) => x.name)).toEqual(['order_count']);
      expect(textOf(await rt.callTool('query', { sql: 'SELECT 1' }, other))).toBe(
        'Unknown tool "query".',
      );
      expect(
        jsonOf<{ rows: unknown[][] }>(await rt.callTool('order_count', {}, other)).rows,
      ).toHaveLength(1);
      // The analyst scope adds the free-form reads: every read tool, as without a caller.
      const analyst: CallContext = { caller: { subject: 'a' }, scopes: ['analyst'] };
      expect(rt.listTools(analyst).map((x) => x.name)).toEqual(rt.listTools().map((x) => x.name));
      expect((await rt.callTool('query', { sql: 'SELECT 1 AS one' }, analyst)).isError).toBeFalsy();
    } finally {
      await rt.close();
    }
  });
});
