import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { jsonOf, PETSTORE, petstore, petstoreConfig, textOf } from '../helpers.js';
import type { ConfigInput } from '../../src/config/schema.js';

const SECRET = 'live-secret-token-0123456789';

let mock: MockServer;

beforeAll(async () => {
  const spec = await petstore();
  const { extractOperations } = await import('../../src/sources/openapi/operations.js');
  mock = await startMockServer(extractOperations(spec.doc), {
    handler: (req) => {
      // An API that echoes credentials back (it happens). The agent must never see them.
      if (req.path === '/user/login') {
        return {
          status: 200,
          body: { echoed: req.headers.authorization, note: `your token is ${SECRET}` },
        };
      }
      return undefined;
    },
  });
});

afterAll(async () => {
  await mock.close();
});

async function runtime(
  overrides: Partial<ConfigInput> = {},
  env: NodeJS.ProcessEnv = {},
): Promise<OpenApiRuntime> {
  const config = await petstoreConfig({
    auth: { type: 'bearer', token: '${PET_TOKEN}' },
    ...overrides,
  });
  return createOpenApiRuntime({
    config,
    configDir: '.',
    spec: await petstore(),
    baseUrlOverride: mock.url,
    env: { PET_TOKEN: SECRET, ...env },
  });
}

const sent = (opId: string) => mock.requests.filter((r) => r.operationId === opId).length;

describe('read-only mode (default)', () => {
  it('exposes only read operations as tools', async () => {
    const rt = await runtime();
    const tools = rt.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'pet',
      'user',
      'store',
      'search_operations',
      'call_operation',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const pet = tools.find((t) => t.name === 'pet')!;
    expect(
      (pet.inputSchema.properties as Record<string, { enum?: string[] }>).operation?.enum,
    ).toEqual(['findPetsByStatus', 'findPetsByTags', 'getPetById']);
    expect(pet.description).not.toMatch(/addPet|deletePet/);
    expect(JSON.stringify(tools)).not.toContain('dryRun');
  });

  it('runs reads through grouped tools', async () => {
    const rt = await runtime();
    const res = await rt.callTool('pet', { operation: 'getPetById', params: { petId: 10 } });
    expect(res.isError).toBeUndefined();
    expect(jsonOf(res)).toMatchObject({ status: 200, data: { name: 'doggie' } });
    const last = mock.requests.at(-1)!;
    expect(last.path).toBe('/pet/10');
    expect(last.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('blocks every write through every path, and never sends a request', async () => {
    const rt = await runtime();
    const before = mock.requests.length;
    const attempts = [
      rt.callTool('pet', { operation: 'deletePet', params: { petId: 1 } }),
      rt.callTool('pet', { operation: 'addPet', params: { body: { name: 'x', photoUrls: [] } } }),
      rt.callTool('call_operation', { operationId: 'deletePet', params: { petId: 1 } }),
      rt.callTool('call_operation', {
        operationId: 'addPet',
        params: { body: { name: 'x', photoUrls: [] } },
        dryRun: false,
      }),
      rt.callTool('call_operation', {
        operationId: 'deleteOrder',
        params: { orderId: 1 },
        confirm: 'confirm_forged',
      }),
      rt.callTool('call_operation', { operationId: 'DELETEPET', params: { petId: 1 } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.isError).toBe(true);
    }
    expect(textOf(await attempts[2]!)).toMatch(
      /Blocked: "deletePet" is a destructive operation and the server runs in read-only mode/,
    );
    expect(mock.requests.length).toBe(before);
  });

  it('a wildcard allowlist does not unlock writes while mode is read-only', async () => {
    const rt = await runtime({ writes: { allow: ['*'] } });
    const res = await rt.callTool('call_operation', {
      operationId: 'addPet',
      params: { body: { name: 'x', photoUrls: [] } },
    });
    expect(res.isError).toBe(true);
    expect(sent('addPet')).toBe(0);
  });

  it('search_operations shows blocked operations with the reason', async () => {
    const rt = await runtime();
    const res = jsonOf<{ results: Array<{ operationId: string; status: string }> }>(
      await rt.callTool('search_operations', { query: 'delete pet' }),
    );
    const del = res.results.find((r) => r.operationId === 'deletePet')!;
    expect(del.status).toMatch(/^blocked/);
  });
});

describe('read-write mode', () => {
  const rw: Partial<ConfigInput> = {
    mode: 'read-write',
    writes: { allow: ['addPet', 'deletePet', 'updatePet'], confirm: ['updatePet'] },
  };

  it('exposes only allowlisted writes, with dryRun and confirm parameters', async () => {
    const rt = await runtime(rw);
    const pet = rt.listTools().find((t) => t.name === 'pet')!;
    const ops = (pet.inputSchema.properties as Record<string, { enum?: string[] }>).operation?.enum;
    expect(ops).toEqual(expect.arrayContaining(['addPet', 'deletePet', 'updatePet']));
    expect(ops).not.toContain('updatePetWithForm');
    expect(pet.inputSchema.properties).toHaveProperty('dryRun');
    expect(pet.inputSchema.properties).toHaveProperty('confirm');
    expect(pet.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('blocks writes outside the allowlist', async () => {
    const rt = await runtime(rw);
    const res = await rt.callTool('call_operation', {
      operationId: 'createUser',
      params: { body: { username: 'x' } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in writes\.allow/);
    expect(sent('createUser')).toBe(0);
  });

  it('runs allowlisted non-destructive writes directly', async () => {
    const rt = await runtime(rw);
    const before = sent('addPet');
    const res = await rt.callTool('pet', {
      operation: 'addPet',
      params: { body: { name: 'rex', photoUrls: ['u'] } },
    });
    expect(res.isError).toBeUndefined();
    expect(sent('addPet')).toBe(before + 1);
  });

  it('dry run returns the exact request without sending it, with secrets hidden', async () => {
    const rt = await runtime(rw);
    const before = mock.requests.length;
    const res = await rt.callTool('pet', {
      operation: 'deletePet',
      params: { petId: 7, api_key: SECRET },
      dryRun: true,
    });
    const body = jsonOf<{
      dryRun: boolean;
      request: { method: string; url: string; headers: Record<string, string> };
    }>(res);
    expect(body.dryRun).toBe(true);
    expect(body.request.method).toBe('DELETE');
    expect(body.request.url).toMatch(/\/pet\/7$/);
    expect(textOf(res)).not.toContain(SECRET);
    expect(mock.requests.length).toBe(before);
  });

  it('destructive operations need a confirmation token bound to the same arguments', async () => {
    const rt = await runtime(rw);
    const before = sent('deletePet');

    const challenge = await rt.callTool('pet', { operation: 'deletePet', params: { petId: 3 } });
    expect(textOf(challenge)).toMatch(/CONFIRMATION REQUIRED/);
    expect(sent('deletePet')).toBe(before);
    const token = /"confirm": "(confirm_[^"]+)"/.exec(textOf(challenge))![1]!;

    // Same token, different pet: refused and burned.
    const wrong = await rt.callTool('pet', {
      operation: 'deletePet',
      params: { petId: 4 },
      confirm: token,
    });
    expect(wrong.isError).toBe(true);
    expect(sent('deletePet')).toBe(before);
    const reused = await rt.callTool('pet', {
      operation: 'deletePet',
      params: { petId: 3 },
      confirm: token,
    });
    expect(reused.isError).toBe(true);

    const second = await rt.callTool('pet', { operation: 'deletePet', params: { petId: 3 } });
    const token2 = /"confirm": "(confirm_[^"]+)"/.exec(textOf(second))![1]!;
    const done = await rt.callTool('call_operation', {
      operationId: 'deletePet',
      params: { petId: 3 },
      confirm: token2,
    });
    expect(done.isError).toBeUndefined();
    expect(sent('deletePet')).toBe(before + 1);
  });

  it('writes listed in writes.confirm also need confirmation', async () => {
    const rt = await runtime(rw);
    const res = await rt.callTool('pet', {
      operation: 'updatePet',
      params: { body: { name: 'x', photoUrls: [] } },
    });
    expect(textOf(res)).toMatch(/CONFIRMATION REQUIRED/);
  });

  it('uses elicitation when the client supports it', async () => {
    const rt = await runtime(rw);
    const before = sent('deletePet');
    const declined = await rt.callTool(
      'pet',
      { operation: 'deletePet', params: { petId: 5 } },
      { elicit: async () => 'decline' },
    );
    expect(declined.isError).toBe(true);
    expect(sent('deletePet')).toBe(before);
    const accepted = await rt.callTool(
      'pet',
      { operation: 'deletePet', params: { petId: 5 } },
      { elicit: async () => 'accept' },
    );
    expect(accepted.isError).toBeUndefined();
    expect(sent('deletePet')).toBe(before + 1);
  });
});

describe('validation and errors', () => {
  it('reports invalid arguments with the expected signature', async () => {
    const rt = await runtime();
    const res = await rt.callTool('pet', { operation: 'getPetById', params: { petIdd: 1 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/unknown property "petIdd"/);
    expect(textOf(res)).toMatch(/getPetById\(petId: integer\)/);
  });

  it('coerces stringified numbers', async () => {
    const rt = await runtime();
    const res = await rt.callTool('pet', { operation: 'getPetById', params: { petId: '12' } });
    expect(res.isError).toBeUndefined();
    expect(mock.requests.at(-1)!.path).toBe('/pet/12');
  });

  it('rejects operations that are not part of the tool', async () => {
    const rt = await runtime();
    const res = await rt.callTool('pet', { operation: 'getInventory' });
    expect(textOf(res)).toMatch(/Valid operations: findPetsByStatus/);
  });

  it('explains missing credentials instead of crashing', async () => {
    const config = await petstoreConfig({ auth: { type: 'bearer', token: '${NOT_SET_ANYWHERE}' } });
    const rt = await createOpenApiRuntime({
      config,
      configDir: '.',
      spec: await petstore(),
      baseUrlOverride: mock.url,
      env: {},
    });
    expect(rt.warnings.join()).toMatch(/NOT_SET_ANYWHERE/);
    const res = await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Missing environment variable NOT_SET_ANYWHERE/);
  });

  it('reports a spec without a usable base URL', async () => {
    const config = await petstoreConfig();
    const spec = await petstore();
    const noServers = { ...spec, doc: { ...spec.doc, servers: [] } };
    const rt = await createOpenApiRuntime({ config, configDir: '.', spec: noServers, env: {} });
    expect(
      textOf(await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } })),
    ).toMatch(/source\.baseUrl/);
  });
});

describe('secret redaction', () => {
  it('never returns a credential to the agent, even when the API echoes it', async () => {
    const rt = await runtime();
    const res = await rt.callTool('user', { operation: 'loginUser', params: {} });
    const text = textOf(res);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
  });

  it('naive tool list includes every operation (for the inspect comparison)', async () => {
    const rt = await runtime();
    expect(rt.naiveTools()).toHaveLength(19);
    expect(PETSTORE).toContain('petstore');
  });
});
