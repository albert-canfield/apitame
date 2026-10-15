import { existsSync, readFileSync } from 'node:fs';
import { request, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
} from '@modelcontextprotocol/client';
import { InMemoryServerEventBus, type Server } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer, type McpServerOptions } from '../../src/server/mcp.js';
import { JwtVerifier, type OAuthOptions } from '../../src/server/oauth.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import { serveHttp, serveStdio, type HttpOptions } from '../../src/server/transport.js';
import { trackOpen } from '../../src/cli/commands/serve.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import type { Runtime } from '../../src/types.js';
import { createSqliteShop, petstore, petstoreConfig, tempDir, textOf } from '../helpers.js';
import { claimsFor, FakeAuthServer, makeKey, signers, signJwt } from '../oauth-fixtures.js';

const MODERN = '2026-07-28';
const silent = new Logger(new Redactor(), 'silent');
const tmp = tempDir('apitame-mrtr-');
let mock: MockServer;
let audits = 0;

beforeAll(async () => {
  const spec = await petstore();
  mock = await startMockServer(extractOperations(spec.doc));
});
afterAll(async () => {
  await mock.close();
  tmp.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A read-write Petstore runtime against the mock, with deletePet allowed and its own audit file. */
async function petRuntime(extra: Partial<ConfigInput> = {}) {
  const spec = await petstore();
  const auditFile = join(tmp.dir, `audit-${audits++}.jsonl`);
  const config = await petstoreConfig({
    mode: 'read-write',
    writes: { allow: ['deletePet'] },
    audit: { file: auditFile },
    ...extra,
  });
  const rt = await createOpenApiRuntime({
    config,
    configDir: tmp.dir,
    spec,
    baseUrlOverride: mock.url,
    env: {},
  });
  /** Audit outcomes for deletePet, in order. */
  const outcomes = () =>
    existsSync(auditFile)
      ? readFileSync(auditFile, 'utf8')
          .trim()
          .split('\n')
          .map(
            (l) =>
              JSON.parse(l) as {
                operation?: string;
                outcome: string;
                reason?: string;
                subject?: string;
              },
          )
          .filter((e) => e.operation === 'deletePet')
      : [];
  /** The same, as `outcome` or `outcome: reason`. */
  const outcomeList = () =>
    outcomes().map((e) => (e.reason ? `${e.outcome}: ${e.reason}` : e.outcome));
  return { rt, outcomes, outcomeList };
}

const deletes = () => mock.requests.filter((r) => r.operationId === 'deletePet').length;

type Answer =
  | { action: 'accept'; content: { approve: boolean } }
  | { action: 'decline' }
  | { action: 'cancel' };
const APPROVE: Answer = { action: 'accept', content: { approve: true } };

/** A client that negotiates protocol 2026-07-28 and answers approval prompts with `answer`. */
function modernClient(
  opts: { answer?: Answer; capabilities?: ClientCapabilities; manual?: boolean } = {},
) {
  const prompts: string[] = [];
  const capabilities = opts.capabilities ?? { elicitation: { form: {} } };
  const client = new Client(
    { name: 'modern-test', version: '1.0.0' },
    {
      capabilities,
      versionNegotiation: { mode: { pin: MODERN } },
      ...(opts.manual ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (capabilities.elicitation) {
    client.setRequestHandler('elicitation/create', async (req) => {
      prompts.push(String(req.params.message));
      return opts.answer ?? { action: 'cancel' };
    });
  }
  return { client, prompts };
}

/** A 2025-era client (the SDK default) that answers elicitation with `answer`. */
function legacyClient(answer: Answer) {
  const prompts: string[] = [];
  const client = new Client(
    { name: 'legacy-test', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler('elicitation/create', async (req) => {
    prompts.push(String(req.params.message));
    return answer;
  });
  return { client, prompts };
}

const deletePet = (petId: number, extra: Record<string, unknown> = {}) => ({
  name: 'pet',
  arguments: { operation: 'deletePet', params: { petId }, ...extra },
});

interface InputRequired {
  resultType: 'input_required';
  requestState: string;
  inputRequests: {
    approve: {
      method: string;
      params: { mode: string; message: string; requestedSchema: Record<string, unknown> };
    };
  };
}

type CallParams = Parameters<Client['callTool']>[0];

/** First round, by hand: the call comes back asking for input. */
async function firstRound(client: Client, petId = 4): Promise<InputRequired> {
  const res = (await client.callTool(deletePet(petId), {
    allowInputRequired: true,
  })) as unknown as InputRequired;
  expect(res.resultType).toBe('input_required');
  return res;
}

/** Second round, by hand: the same call with the answer and an approval id. */
function secondRound(
  client: Client,
  requestState: string | undefined,
  answer: Answer,
  petId = 4,
  extra: Record<string, unknown> = {},
) {
  return client.callTool(
    {
      ...deletePet(petId, extra),
      inputResponses: { approve: answer },
      ...(requestState !== undefined ? { requestState } : {}),
    } as CallParams,
    { allowInputRequired: true },
  ) as Promise<{ isError?: boolean; content: Array<{ text: string }>; resultType?: string }>;
}

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

type Kind = 'stdio' | 'http' | 'http --sessions';

/** Serve a runtime the way `apitame serve` does, over stdio (in-process) or HTTP. */
async function serveRuntime(
  kind: Kind,
  rt: Runtime | (() => Runtime),
  extra: Partial<HttpOptions> & {
    logger?: Logger;
    servers?: Set<Server>;
    mcp?: McpServerOptions;
  } = {},
) {
  const { logger = silent, servers, mcp, ...httpOptions } = extra;
  const closers: Array<() => Promise<void>> = [];
  const makeServer = () => {
    const server = createMcpServer(rt, { listChanged: true, ...mcp });
    servers?.add(server);
    return server;
  };
  if (kind === 'stdio') {
    return {
      // Headers only matter over HTTP.
      connect: async (client: Client, _headers: Record<string, string> = {}) => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const handle = await serveStdio(makeServer, { transport: serverSide, logger });
        closers.push(async () => {
          await client.close();
          await handle.close();
        });
        await client.connect(clientSide);
      },
      url: undefined,
      close: async () => {
        for (const c of closers.splice(0)) await c();
      },
    };
  }
  const http = await serveHttp(makeServer, {
    host: '127.0.0.1',
    port: 0,
    logger,
    sessions: kind === 'http --sessions',
    ...httpOptions,
  });
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  return {
    connect: async (client: Client, headers: Record<string, string> = {}) => {
      closers.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    },
    url,
    close: async () => {
      for (const c of closers.splice(0)) await c().catch(() => {});
      await stop(http);
    },
  };
}

describe.each<Kind>(['stdio', 'http', 'http --sessions'])(
  'protocol 2026-07-28 approvals over %s',
  (kind) => {
    it('asks the human with the same form as before, and runs the call once when approved', async () => {
      const { rt, outcomes } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        const { client, prompts } = modernClient({ answer: APPROVE });
        await s.connect(client);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        const before = deletes();
        const res = await client.callTool(deletePet(4));
        expect(res.isError).toBeFalsy();
        expect(JSON.stringify(res.content)).toContain('"status\\":200');
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('DESTRUCTIVE');
        expect(prompts[0]).toContain('/pet/4');
        expect(deletes()).toBe(before + 1);
        expect(outcomes().map((e) => e.outcome)).toEqual(['confirmation-requested', 'sent']);

        // The prompt is a form with one checkbox, in the client capabilities' form mode.
        const manual = modernClient({ manual: true });
        await s.connect(manual.client);
        const asked = await firstRound(manual.client);
        expect(asked.requestState).toMatch(/^approval_[\w-]{43}$/);
        expect(asked.inputRequests.approve.method).toBe('elicitation/create');
        expect(asked.inputRequests.approve.params.mode).toBe('form');
        expect(asked.inputRequests.approve.params.message).toMatch(/^Confirm a destructive action/);
        expect(asked.inputRequests.approve.params.requestedSchema).toMatchObject({
          properties: { approve: { type: 'boolean', default: false } },
          required: ['approve'],
        });
      } finally {
        await s.close();
      }
    });

    it('sends nothing when the human declines, cancels or leaves the box unchecked', async () => {
      const { rt, outcomes } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        const before = deletes();
        for (const answer of [
          { action: 'decline' },
          { action: 'cancel' },
          { action: 'accept', content: { approve: false } },
        ] as Answer[]) {
          const { client, prompts } = modernClient({ answer });
          await s.connect(client);
          const res = await client.callTool(deletePet(4));
          expect(prompts).toHaveLength(1);
          expect(res.isError).toBe(true);
          expect(textOf(res as never)).toContain('did not approve');
        }
        expect(deletes()).toBe(before);
        expect(outcomes().map((e) => e.outcome)).toEqual([
          'confirmation-requested',
          'declined',
          'confirmation-requested',
          'declined',
          'confirmation-requested',
          'declined',
        ]);
      } finally {
        await s.close();
      }
    });

    it('refuses a tampered or replayed approval id with nothing sent', async () => {
      const { rt, outcomeList } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        const { client } = modernClient({ manual: true });
        await s.connect(client);
        const before = deletes();

        const { requestState } = await firstRound(client);
        const tampered = `${requestState.slice(0, -2)}${requestState.endsWith('AA') ? 'BB' : 'AA'}`;
        const forged = await secondRound(client, tampered, APPROVE);
        expect(forged.isError).toBe(true);
        expect(textOf(forged)).toContain('Unknown approval');
        expect(deletes()).toBe(before);

        const approved = await secondRound(client, requestState, APPROVE);
        expect(approved.isError).toBeFalsy();
        expect(deletes()).toBe(before + 1);

        const replayed = await secondRound(client, requestState, APPROVE);
        expect(replayed.isError).toBe(true);
        expect(textOf(replayed)).toContain('This approval was already used');
        expect(deletes()).toBe(before + 1);
        // Told apart from a human decline in the audit log.
        expect(outcomeList()).toEqual([
          'confirmation-requested',
          'approval-refused: unknown',
          'sent',
          'approval-refused: used',
        ]);
      } finally {
        await s.close();
      }
    });

    it('refuses an approval sent back with other arguments, and burns it', async () => {
      const { rt, outcomeList } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        const { client } = modernClient({ manual: true });
        await s.connect(client);
        const before = deletes();
        const { requestState } = await firstRound(client, 4);
        const other = await secondRound(client, requestState, APPROVE, 5);
        expect(other.isError).toBe(true);
        expect(textOf(other)).toContain('different operation, different arguments');
        const again = await secondRound(client, requestState, APPROVE, 4);
        expect(again.isError).toBe(true);
        expect(textOf(again)).toContain('This approval was already used');
        expect(deletes()).toBe(before);
        expect(outcomeList()).toEqual([
          'confirmation-requested',
          'approval-refused: mismatch',
          'approval-refused: used',
        ]);
      } finally {
        await s.close();
      }
    });

    it('falls back to the token flow for a client without the elicitation capability', async () => {
      const { rt } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        const { client, prompts } = modernClient({ capabilities: {} });
        await s.connect(client);
        const before = deletes();
        const res = await client.callTool(deletePet(4));
        const text = textOf(res as never);
        expect(text).toContain('CONFIRMATION REQUIRED');
        const token = /"confirm": "(confirm_[^"]+)"/.exec(text)?.[1];
        expect(token).toBeTruthy();
        expect(deletes()).toBe(before);
        const confirmed = await client.callTool(deletePet(4, { confirm: token }));
        expect(confirmed.isError).toBeFalsy();
        expect(deletes()).toBe(before + 1);
        expect(prompts).toHaveLength(0);
      } finally {
        await s.close();
      }
    });
  },
);

describe('protocol 2026-07-28 approvals', () => {
  it('refuses under confirmation.method: elicitation when the client cannot show a form', async () => {
    const { rt } = await petRuntime({ confirmation: { method: 'elicitation' } });
    const s = await serveRuntime('stdio', rt);
    try {
      const { client } = modernClient({ capabilities: {} });
      await s.connect(client);
      const before = deletes();
      const res = await client.callTool(deletePet(4));
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toContain('does not support elicitation');
      expect(textOf(res as never)).not.toContain('CONFIRMATION REQUIRED');
      expect(deletes()).toBe(before);
    } finally {
      await s.close();
    }
  });

  it('treats a client that can only open URLs as one that cannot show a form', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    try {
      const { client, prompts } = modernClient({ capabilities: { elicitation: { url: {} } } });
      await s.connect(client);
      const res = await client.callTool(deletePet(4));
      expect(textOf(res as never)).toContain('CONFIRMATION REQUIRED');
      expect(prompts).toHaveLength(0);
    } finally {
      await s.close();
    }
  });

  it('never asks under confirmation.method: token', async () => {
    const { rt } = await petRuntime({ confirmation: { method: 'token' } });
    const s = await serveRuntime('stdio', rt);
    try {
      const { client, prompts } = modernClient({ answer: APPROVE });
      await s.connect(client);
      const before = deletes();
      const res = await client.callTool(deletePet(4));
      expect(textOf(res as never)).toContain('CONFIRMATION REQUIRED');
      expect(prompts).toHaveLength(0);
      expect(deletes()).toBe(before);
    } finally {
      await s.close();
    }
  });

  it('asks again, and sends nothing, when an answer comes back without its approval id', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    try {
      const { client } = modernClient({ manual: true });
      await s.connect(client);
      const before = deletes();
      const res = await secondRound(client, undefined, APPROVE);
      expect(res.resultType).toBe('input_required');
      expect(deletes()).toBe(before);
    } finally {
      await s.close();
    }
  });

  it('refuses an approval id after confirmation.ttlSeconds', async () => {
    const { rt, outcomeList } = await petRuntime({ confirmation: { ttlSeconds: 60 } });
    const s = await serveRuntime('stdio', rt);
    try {
      const { client } = modernClient({ manual: true });
      await s.connect(client);
      const before = deletes();
      const { requestState } = await firstRound(client);
      const later = Date.now() + 61_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      const res = await secondRound(client, requestState, APPROVE);
      vi.restoreAllMocks();
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('The approval expired');
      expect(deletes()).toBe(before);
      expect(outcomeList()).toEqual(['confirmation-requested', 'approval-refused: expired']);
    } finally {
      await s.close();
    }
  });

  it('keeps approval ids and confirm tokens apart: neither works as the other', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    try {
      const before = deletes();
      const asker = modernClient({ manual: true });
      await s.connect(asker.client);
      const tokenUser = modernClient({ capabilities: {} });
      await s.connect(tokenUser.client);

      // An approval id sent as a confirm token.
      const { requestState } = await firstRound(asker.client);
      const asToken = await tokenUser.client.callTool(deletePet(4, { confirm: requestState }));
      expect(asToken.isError).toBe(true);
      expect(textOf(asToken as never)).toContain('Unknown or already used confirmation token');

      // A confirm token sent back as an approval id.
      const challenge = textOf((await tokenUser.client.callTool(deletePet(4))) as never);
      const token = /"confirm": "(confirm_[^"]+)"/.exec(challenge)?.[1] ?? '';
      const asApproval = await secondRound(asker.client, token, APPROVE);
      expect(asApproval.isError).toBe(true);
      expect(textOf(asApproval)).toContain('Unknown approval');
      expect(deletes()).toBe(before);
    } finally {
      await s.close();
    }
  });

  it('checks the write rate limit before asking the human', async () => {
    const { rt, outcomes } = await petRuntime({ limits: { maxWritesPerMinute: 1 } });
    const s = await serveRuntime('http', rt);
    try {
      const first = modernClient({ answer: APPROVE });
      await s.connect(first.client);
      expect((await first.client.callTool(deletePet(4))).isError).toBeFalsy();
      const second = modernClient({ answer: APPROVE });
      await s.connect(second.client);
      const before = deletes();
      const res = await second.client.callTool(deletePet(5));
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toContain('Rate limit');
      expect(second.prompts).toHaveLength(0);
      expect(deletes()).toBe(before);
      expect(outcomes().map((e) => e.outcome)).toEqual([
        'confirmation-requested',
        'sent',
        'rate-limited',
      ]);
    } finally {
      await s.close();
    }
  });

  it('asks for SQL write queries the same way', async () => {
    const t = tempDir('apitame-mrtr-sql-');
    const file = join(t.dir, 'shop.db');
    createSqliteShop(file);
    const config = parseConfig({
      name: 'shop',
      mode: 'read-write',
      source: { type: 'sqlite', path: file },
      writes: { allow: ['archive_order'], destructive: ['archive_order'] },
      sql: {
        queries: [
          {
            name: 'archive_order',
            description: 'Archive one order',
            write: true,
            sql: "UPDATE orders SET status = 'cancelled' WHERE id = :id",
            params: { id: { type: 'integer' } },
          },
        ],
      },
    });
    const rt = new SqlRuntime(config, new SqliteDriver(file), new Redactor());
    const s = await serveRuntime('stdio', rt);
    try {
      const { client, prompts } = modernClient({ answer: APPROVE });
      await s.connect(client);
      const res = await client.callTool({ name: 'archive_order', arguments: { id: 1 } });
      expect(res.isError).toBeFalsy();
      expect(textOf(res as never)).toContain('"affectedRows":1');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("UPDATE orders SET status = 'cancelled'");
    } finally {
      await s.close();
      await rt.close();
      t.cleanup();
    }
  });
});

describe('2025-era clients through the dual-era entries', () => {
  for (const kind of ['stdio', 'http --sessions'] as const) {
    it(`are still asked in the middle of the call over ${kind}`, async () => {
      const { rt, outcomes } = await petRuntime();
      const s = await serveRuntime(kind, rt);
      try {
        for (const approve of [false, true]) {
          const { client, prompts } = legacyClient({ action: 'accept', content: { approve } });
          await s.connect(client);
          expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
          const before = deletes();
          const res = await client.callTool(deletePet(4));
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).toContain('/pet/4');
          expect(Boolean(res.isError)).toBe(!approve);
          expect(deletes() - before).toBe(approve ? 1 : 0);
        }
        // Asked once each time, never through a second round.
        expect(outcomes().map((e) => e.outcome)).toEqual(['declined', 'sent']);
      } finally {
        await s.close();
      }
    });
  }

  it('get the token flow over stateless HTTP, as before', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    try {
      const { client, prompts } = legacyClient(APPROVE);
      await s.connect(client);
      const before = deletes();
      const res = await client.callTool(deletePet(4));
      expect(textOf(res as never)).toContain('CONFIRMATION REQUIRED');
      expect(prompts).toHaveLength(0);
      expect(deletes()).toBe(before);
    } finally {
      await s.close();
    }
  });
});

/** A raw 2026-07-28 request, as the SDK client sends it. */
const MODERN_LIST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {
    _meta: {
      [PROTOCOL_VERSION_META_KEY]: MODERN,
      [CLIENT_INFO_META_KEY]: { name: 'raw', version: '1' },
      [CLIENT_CAPABILITIES_META_KEY]: {},
    },
  },
});
const MODERN_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': MODERN,
  'Mcp-Method': 'tools/list',
};

/** POST with any Host header (fetch cannot set one). */
function rawPost(url: URL, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('HTTP checks in front of the 2026-07-28 handler', () => {
  it('refuses a foreign Host or Origin before the request is served', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    try {
      const url = s.url!;
      // The control: this exact request is a valid 2026-07-28 request.
      expect(await rawPost(url, MODERN_HEADERS, MODERN_LIST)).toBe(200);
      expect(await rawPost(url, { ...MODERN_HEADERS, Host: 'evil.example' }, MODERN_LIST)).toBe(
        403,
      );
      expect(
        await rawPost(url, { ...MODERN_HEADERS, Origin: 'https://evil.example' }, MODERN_LIST),
      ).toBe(403);
      const { client } = modernClient();
      await expect(
        client.connect(
          new StreamableHTTPClientTransport(url, {
            requestInit: { headers: { Origin: 'https://evil.example' } },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await s.close();
    }
  });

  it('requires the bearer token', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt, { token: 's3cret-mrtr-token' });
    try {
      const url = s.url!;
      expect(await rawPost(url, MODERN_HEADERS, MODERN_LIST)).toBe(401);
      expect(
        await rawPost(
          url,
          { ...MODERN_HEADERS, Authorization: 'Bearer s3cret-mrtr-token' },
          MODERN_LIST,
        ),
      ).toBe(200);
      const anonymous = modernClient();
      await expect(
        anonymous.client.connect(new StreamableHTTPClientTransport(url)),
      ).rejects.toThrow();
      const authed = modernClient({ answer: APPROVE });
      await s.connect(authed.client, { Authorization: 'Bearer s3cret-mrtr-token' });
      expect((await authed.client.callTool(deletePet(4))).isError).toBeFalsy();
    } finally {
      await s.close();
    }
  });

  it('with OAuth, binds an approval to the user who was asked', async () => {
    const as = await FakeAuthServer.start();
    const key = makeKey('rsa', 'rsa-1');
    as.publish(key);
    const resource = 'https://mcp.example.com/mcp';
    const options: OAuthOptions = {
      issuer: as.issuer,
      resource,
      scopes: ['mcp:tools'],
      audiences: [],
    };
    const tokenFor = (sub: string) =>
      signJwt(
        { alg: 'RS256', kid: 'rsa-1', typ: 'at+jwt' },
        claimsFor(as.issuer, resource, { sub }),
        signers.rs(key.privateKey),
      );
    const { rt, outcomes } = await petRuntime();
    const s = await serveRuntime('http', rt, {
      oauth: { verifier: new JwtVerifier(options), options, name: 'petstore' },
    });
    try {
      const url = s.url!;
      expect(await rawPost(url, MODERN_HEADERS, MODERN_LIST)).toBe(401);
      const alice = modernClient({ manual: true });
      await s.connect(alice.client, { Authorization: `Bearer ${tokenFor('alice')}` });
      const bob = modernClient({ manual: true });
      await s.connect(bob.client, { Authorization: `Bearer ${tokenFor('bob')}` });
      const before = deletes();

      const { requestState } = await firstRound(alice.client);
      const stolen = await secondRound(bob.client, requestState, APPROVE);
      expect(stolen.isError).toBe(true);
      expect(textOf(stolen)).toContain('a different user');
      expect(deletes()).toBe(before);

      const asked = await firstRound(alice.client);
      const own = await secondRound(alice.client, asked.requestState, APPROVE);
      expect(own.isError).toBeFalsy();
      expect(deletes()).toBe(before + 1);
      // The audit log names who approved and sent it.
      expect(outcomes().at(-1)).toMatchObject({ outcome: 'sent', subject: 'alice' });
    } finally {
      await s.close();
      await as.close();
    }
  });
});

describe('serve --watch with 2026-07-28 clients', () => {
  const listenFor = () => {
    let changed!: () => void;
    const heard = new Promise<void>((r) => (changed = r));
    const client = new Client(
      { name: 'watch-test', version: '1.0.0' },
      {
        versionNegotiation: { mode: { pin: MODERN } },
        listChanged: { tools: { onChanged: () => changed() } },
      },
    );
    return { client, heard };
  };
  const within = <T>(p: Promise<T>, ms = 5_000) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no list change')), ms)),
    ]);
  /** The client opens its subscriptions/listen stream after connecting; wait for the server's ack. */
  const subscribed = async (client: Client) => {
    const until = Date.now() + 5_000;
    while (!client.autoOpenedSubscription) {
      if (Date.now() > until) throw new Error('no subscription');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('delivers list changes on subscriptions/listen over HTTP', async () => {
    const { rt } = await petRuntime();
    const events = new InMemoryServerEventBus();
    const s = await serveRuntime('http', rt, { events });
    try {
      const { client, heard } = listenFor();
      await s.connect(client);
      await subscribed(client);
      events.publish({ kind: 'tools_list_changed' });
      await within(heard);
    } finally {
      await s.close();
    }
  });

  it('delivers list changes from the connection server over stdio', async () => {
    const { rt } = await petRuntime();
    const servers = new Set<Server>();
    const s = await serveRuntime('stdio', rt, { servers });
    try {
      const { client, heard } = listenFor();
      await s.connect(client);
      await subscribed(client);
      for (const server of servers) await server.sendToolListChanged();
      await within(heard);
    } finally {
      await s.close();
    }
  });
});

describe('protocol era logging', () => {
  it('logs the era of each HTTP request and of each stdio connection at debug level', async () => {
    const lines: string[] = [];
    const logger = new Logger(new Redactor(), 'debug', (l) => lines.push(l));
    const { rt } = await petRuntime();
    const http = await serveRuntime('http', rt, { logger });
    const stdio = await serveRuntime('stdio', rt, { logger });
    try {
      await http.connect(modernClient().client);
      await http.connect(legacyClient(APPROVE).client);
      const pinned = modernClient();
      await stdio.connect(pinned.client);
      // Logged on the first call after the server/discover probe.
      await pinned.client.listTools();
      await stdio.connect(legacyClient(APPROVE).client);
      // The 2025-era handshake ends with a notification the server handles after connect.
      const until = Date.now() + 5_000;
      while (!lines.join('').includes('(2025 era)') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const log = lines.join('');
      expect(log).toContain('debug: HTTP POST: protocol 2026-07-28 request');
      expect(log).toContain('debug: HTTP POST: 2025-era request');
      expect(log).toContain('debug: stdio: the client uses protocol 2026-07-28');
      expect(log).toContain('debug: stdio: the client negotiated protocol 2025-11-25 (2025 era)');
    } finally {
      await http.close();
      await stdio.close();
    }
  });
});

describe('HTTP without authentication', () => {
  for (const kind of ['http', 'http --sessions'] as const) {
    it(`under confirmation.method: elicitation, refuses 2026-07-28 approvals (${kind})`, async () => {
      const { rt, outcomeList } = await petRuntime({ confirmation: { method: 'elicitation' } });
      const s = await serveRuntime(kind, rt);
      try {
        const before = deletes();
        const { client, prompts } = modernClient({ answer: APPROVE });
        await s.connect(client);
        const res = await client.callTool(deletePet(4));
        expect(res.isError).toBe(true);
        const text = textOf(res as never);
        expect(text).toContain('does not support elicitation over this connection');
        expect(text).toContain('without authentication');
        expect(prompts).toHaveLength(0);

        // An answer sent straight away, as any local script could, is refused the same way.
        const manual = modernClient({ manual: true });
        await s.connect(manual.client);
        const forged = await secondRound(manual.client, 'approval_made-up', APPROVE);
        expect(textOf(forged)).toContain('without authentication');
        expect(deletes()).toBe(before);
        expect(outcomeList()).toEqual([
          'declined: unauthenticated HTTP',
          'declined: unauthenticated HTTP',
        ]);
      } finally {
        await s.close();
      }
    });
  }

  it('under confirmation.method: elicitation, refuses 2025-era sessions before asking', async () => {
    const { rt, outcomeList } = await petRuntime({ confirmation: { method: 'elicitation' } });
    const s = await serveRuntime('http --sessions', rt);
    try {
      const before = deletes();
      const { client, prompts } = legacyClient(APPROVE);
      await s.connect(client);
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const res = await client.callTool(deletePet(4));
      expect(res.isError).toBe(true);
      expect(textOf(res as never)).toContain(
        'does not support elicitation over this connection: apitame serves HTTP without authentication',
      );
      // Nothing was shown: a local script with its own session could have answered it.
      expect(prompts).toHaveLength(0);
      expect(deletes()).toBe(before);
      expect(outcomeList()).toEqual(['declined: unauthenticated HTTP']);
    } finally {
      await s.close();
    }
  });

  it('still asks under auto, with a token, and over stdio, in both eras', async () => {
    const cases: Array<
      [string, 'auto' | 'elicitation', Kind, string | undefined, 'modern' | 'legacy']
    > = [
      ['auto, no token', 'auto', 'http', undefined, 'modern'],
      ['elicitation, token', 'elicitation', 'http', 's3cret-mrtr-token', 'modern'],
      ['elicitation, stdio', 'elicitation', 'stdio', undefined, 'modern'],
      ['auto, 2025-era session, no token', 'auto', 'http --sessions', undefined, 'legacy'],
      [
        'elicitation, 2025-era session, token',
        'elicitation',
        'http --sessions',
        's3cret-mrtr-token',
        'legacy',
      ],
      ['elicitation, 2025-era, stdio', 'elicitation', 'stdio', undefined, 'legacy'],
    ];
    for (const [label, method, kind, token, era] of cases) {
      const { rt } = await petRuntime({ confirmation: { method } });
      const s = await serveRuntime(kind, rt, token ? { token } : {});
      try {
        const before = deletes();
        const { client, prompts } =
          era === 'modern' ? modernClient({ answer: APPROVE }) : legacyClient(APPROVE);
        await s.connect(client, token ? { Authorization: `Bearer ${token}` } : {});
        expect((await client.callTool(deletePet(4))).isError, label).toBeFalsy();
        expect(prompts, label).toHaveLength(1);
        expect(deletes(), label).toBe(before + 1);
      } finally {
        await s.close();
      }
    }
  });
});

/** POST a body without waiting for it to be sent in full: Content-Length says `declared`. */
function partialPost(url: URL, declared: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': declared,
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode ?? 0, text, ms: Date.now() - started });
        });
      },
    );
    // The server answers before the body is complete; the rest of the upload then fails.
    req.on('error', () => {});
    req.write(Buffer.alloc(64 * 1024, 0x20));
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no answer while the body was still being sent'));
    }, 3_000);
  });
}

describe('HTTP request bodies', () => {
  it('with sessions, refuses a large body without a session id before reading it', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http --sessions', rt);
    try {
      const early = await partialPost(s.url!, 3_000_000);
      expect(early.status).toBe(413);
      expect(early.text).toContain('Request body too large.');
      // So does a 2026-07-28 request without a session id: the era is only known once the body
      // has been read.
      const modern = await partialPost(s.url!, 1_100_000, MODERN_HEADERS);
      expect(modern.status).toBe(413);
    } finally {
      await s.close();
    }
  });

  it('lets the 2025-era transport answer bodies that are not JSON-RPC, as before', async () => {
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt);
    const post = (body: string) =>
      fetch(s.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body,
      });
    try {
      for (const [body, answer] of [
        ['{not json', 'Parse error: Invalid JSON'],
        ['', 'Parse error: Invalid JSON'],
        // JSON that is not a JSON-RPC message belongs to neither era.
        ['{"hello":1}', 'Parse error: Invalid JSON-RPC message'],
      ]) {
        const res = await post(body!);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain(answer);
      }
    } finally {
      await s.close();
    }
  });
});

describe('subscriptions/listen limits', () => {
  /** Open a listen stream with raw HTTP. `first` resolves with the first chunk (ack or error). */
  function listen(url: URL, token: string | undefined, id: number) {
    let req!: ReturnType<typeof request>;
    const first = new Promise<string>((resolve, reject) => {
      req = request(
        url,
        {
          method: 'POST',
          agent: false,
          headers: {
            ...MODERN_HEADERS,
            'Mcp-Method': 'subscriptions/listen',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => res.once('data', (c) => resolve(String(c))),
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'subscriptions/listen',
          params: {
            notifications: { toolsListChanged: true },
            _meta: JSON.parse(MODERN_LIST).params._meta,
          },
        }),
      );
    });
    return { first, close: () => req.destroy() };
  }
  const ACK = 'subscriptions/acknowledged';

  it('with OAuth, one user cannot hold every stream', async () => {
    const as = await FakeAuthServer.start();
    const key = makeKey('rsa', 'rsa-1');
    as.publish(key);
    const resource = 'https://mcp.example.com/mcp';
    const options: OAuthOptions = {
      issuer: as.issuer,
      resource,
      scopes: ['mcp:tools'],
      audiences: [],
    };
    const tokenFor = (sub: string) =>
      signJwt(
        { alg: 'RS256', kid: 'rsa-1', typ: 'at+jwt' },
        claimsFor(as.issuer, resource, { sub }),
        signers.rs(key.privateKey),
      );
    const { rt } = await petRuntime();
    const s = await serveRuntime('http', rt, {
      oauth: { verifier: new JwtVerifier(options), options, name: 'petstore' },
      maxSessionsPerOwner: 2,
      maxSessions: 3,
    });
    const open: Array<{ close: () => void }> = [];
    try {
      const alice = tokenFor('alice');
      const a1 = listen(s.url!, alice, 1);
      const a2 = listen(s.url!, alice, 2);
      open.push(a1, a2);
      expect(await a1.first).toContain(ACK);
      expect(await a2.first).toContain(ACK);
      const a3 = listen(s.url!, alice, 3);
      open.push(a3);
      expect(await a3.first).toContain('Subscription limit reached for this user (at most 2');
      // Alice's streams do not lock Bob out.
      const b1 = listen(s.url!, tokenFor('bob'), 4);
      open.push(b1);
      expect(await b1.first).toContain(ACK);
      // The handler's own limit is the session limit (3 here).
      const c1 = listen(s.url!, tokenFor('carol'), 5);
      open.push(c1);
      expect(await c1.first).toContain('Subscription limit reached');
      // A stream that closes makes room for its owner again.
      a1.close();
      const until = Date.now() + 3_000;
      let again = '';
      while (Date.now() < until) {
        const retry = listen(s.url!, alice, 6);
        open.push(retry);
        again = await retry.first;
        if (again.includes(ACK)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(again).toContain(ACK);
    } finally {
      for (const o of open) o.close();
      await s.close();
      await as.close();
    }
  });
});

describe('stdio probe', () => {
  it('forgets a server/discover probe the client falls back from, and does not log its era', async () => {
    const lines: string[] = [];
    const logger = new Logger(new Redactor(), 'debug', (l) => lines.push(l));
    const { rt } = await petRuntime();
    const servers = new Set<Server>();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = await serveStdio(() => trackOpen(servers, createMcpServer(rt)), {
      transport: serverSide,
      logger,
    });
    const inbox: Array<{ id?: number }> = [];
    clientSide.onmessage = (m) => inbox.push(m as { id?: number });
    await clientSide.start();
    const ask = async (message: { id: number } & Record<string, unknown>) => {
      await clientSide.send(message as never);
      const until = Date.now() + 3_000;
      while (!inbox.some((m) => m.id === message.id)) {
        if (Date.now() > until) throw new Error(`no answer to ${message.id}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      const meta = JSON.parse(MODERN_LIST).params._meta;
      await ask({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
      expect(servers.size).toBe(1);
      await ask({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'fallback', version: '1' },
        },
      });
      await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await ask({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      // Only the 2025-era server is left; the probe's was closed and dropped.
      expect(servers.size).toBe(1);
      const log = lines.join('');
      expect(log).toContain('stdio: the client negotiated protocol 2025-11-25 (2025 era)');
      expect(log).not.toContain('2026-07-28');
    } finally {
      await clientSide.close();
      await handle.close();
    }
  });
});
