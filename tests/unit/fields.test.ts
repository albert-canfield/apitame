import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { parseFields, projectFields } from '../../src/server/fields.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { jsonOf, petstore, petstoreConfig, tempDir } from '../helpers.js';

describe('projectFields', () => {
  const repo = { id: 1, full_name: 'a/b', owner: { login: 'octo', id: 9 }, topics: ['x'] };

  it('keeps top-level and nested fields', () => {
    expect(projectFields(repo, ['id', 'owner.login'])).toEqual({ id: 1, owner: { login: 'octo' } });
  });

  it('maps over arrays, including arrays inside wrapper objects', () => {
    expect(projectFields([repo, repo], ['full_name'])).toEqual([
      { full_name: 'a/b' },
      { full_name: 'a/b' },
    ]);
    expect(
      projectFields({ total_count: 2, items: [repo] }, ['total_count', 'items.owner.login']),
    ).toEqual({
      total_count: 2,
      items: [{ owner: { login: 'octo' } }],
    });
  });

  it('a whole field wins over its subpaths, and unknown paths are ignored', () => {
    expect(projectFields(repo, ['owner', 'owner.login', 'nope.x'])).toEqual({
      owner: { login: 'octo', id: 9 },
    });
  });

  it('parses arrays and comma-separated strings', () => {
    expect(parseFields(['id', ' name '])).toEqual(['id', 'name']);
    expect(parseFields('id, owner.login')).toEqual(['id', 'owner.login']);
    expect(parseFields([])).toBeUndefined();
    expect(parseFields(undefined)).toBeUndefined();
  });
});

describe('fields in the OpenAPI runtime', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockServer(extractOperations((await petstore()).doc));
  });
  afterAll(() => mock.close());

  it('returns only the requested fields', async () => {
    const config = await petstoreConfig();
    const rt = await createOpenApiRuntime({
      config,
      configDir: '.',
      spec: await petstore(),
      baseUrlOverride: mock.url,
      env: {},
    });
    const full = jsonOf<{ data: Record<string, unknown> }>(
      await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } }),
    );
    expect(Object.keys(full.data).length).toBeGreaterThan(2);
    const slim = jsonOf<{ data: unknown }>(
      await rt.callTool('pet', {
        operation: 'getPetById',
        params: { petId: 1 },
        fields: ['name', 'category.name'],
      }),
    );
    expect(slim.data).toEqual({ name: 'doggie', category: { name: 'Dogs' } });
    const list = jsonOf<{ data: unknown[] }>(
      await rt.callTool('call_operation', {
        operationId: 'findPetsByStatus',
        params: { status: 'sold' },
        fields: 'id',
      }),
    );
    expect(list.data.every((p) => Object.keys(p as object).join() === 'id')).toBe(true);
    expect(rt.instructions()).toMatch(/"fields"/);
  });

  it("lets an operation's own `fields` parameter win in single-operation tools", async () => {
    const t = tempDir();
    try {
      const spec = {
        openapi: '3.0.3',
        info: { title: 'Sparse', version: '1' },
        servers: [{ url: 'https://sparse.test' }],
        paths: {
          '/items': {
            get: {
              operationId: 'listItems',
              tags: ['items'],
              parameters: [{ name: 'fields', in: 'query', schema: { type: 'string' } }],
              responses: {
                '200': {
                  description: 'ok',
                  content: {
                    'application/json': { schema: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        },
      };
      const file = join(t.dir, 'sparse.json');
      writeFileSync(file, JSON.stringify(spec));
      const loaded = await loadSpec(file);
      const sparseMock = await startMockServer(extractOperations(loaded.doc));
      try {
        const config = parseConfig({
          name: 'sparse',
          source: { type: 'openapi', spec: file },
          tools: [{ name: 'items', operations: ['listItems'] }],
        });
        const rt = await createOpenApiRuntime({
          config,
          configDir: t.dir,
          spec: loaded,
          baseUrlOverride: sparseMock.url,
          env: {},
        });
        expect(
          (rt.listTools()[0]!.inputSchema.properties as Record<string, { type: string }>).fields!
            .type,
        ).toBe('string');
        await rt.callTool('items', { fields: 'name,price' });
        expect(sparseMock.requests.at(-1)!.query).toEqual({ fields: 'name,price' });
      } finally {
        await sparseMock.close();
      }
    } finally {
      t.cleanup();
    }
  });
});
