import { describe, expect, it } from 'vitest';
import { groupOperations, toToolName } from '../../src/sources/openapi/grouping.js';
import { loadSpec, resolveBaseUrl, type OpenApiDocument } from '../../src/sources/openapi/load.js';
import {
  classifyAccess,
  extractOperations,
  generateOperationId,
  signature,
} from '../../src/sources/openapi/operations.js';
import { compactSchema, typeLabel } from '../../src/sources/openapi/schema.js';
import { GITHUB, PETSTORE } from '../helpers.js';

describe('compactSchema', () => {
  it('converts OpenAPI 3.0 nullable and exclusive bounds to JSON Schema', () => {
    expect(
      compactSchema(
        { type: 'integer', nullable: true, minimum: 0, exclusiveMinimum: true },
        { direction: 'request' },
      ),
    ).toEqual({
      type: ['integer', 'null'],
      exclusiveMinimum: 0,
    });
  });

  it('drops readOnly properties from requests and writeOnly from responses', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name', 'password'],
      properties: {
        id: { type: 'integer', readOnly: true },
        name: { type: 'string' },
        password: { type: 'string', writeOnly: true },
      },
    };
    const req = compactSchema(schema, { direction: 'request' });
    expect(Object.keys(req.properties as object)).toEqual(['name', 'password']);
    expect(req.required).toEqual(['name', 'password']);
    const res = compactSchema(schema, { direction: 'response' });
    expect(Object.keys(res.properties as object)).toEqual(['id', 'name']);
  });

  it('survives circular schemas', () => {
    const node: Record<string, unknown> = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    (node.properties as Record<string, unknown>).children = { type: 'array', items: node };
    const out = compactSchema(node, { direction: 'response' });
    expect(JSON.stringify(out)).toContain('recursive');
  });

  it('merges simple allOf and relaxes oneOf to anyOf', () => {
    const out = compactSchema(
      {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'integer' } } },
        ],
      },
      { direction: 'request' },
    );
    expect(out).toMatchObject({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    });
    expect(
      compactSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, { direction: 'request' }),
    ).toEqual({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    });
  });

  it('labels types compactly', () => {
    expect(typeLabel({ type: 'string', enum: ['a', 'b'] })).toBe('"a"|"b"');
    expect(typeLabel({ type: 'array', items: { type: 'integer' } })).toBe('integer[]');
    expect(
      typeLabel({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }),
    ).toBe('{x: string}');
  });
});

describe('operations', () => {
  it('classifies access by method and by name', () => {
    const op = (method: 'get' | 'post' | 'put' | 'delete' | 'patch', id: string, path = '/x') =>
      classifyAccess({ id, method, path, summary: '' });
    expect(op('get', 'listPets')).toBe('read');
    expect(op('post', 'addPet')).toBe('write');
    expect(op('delete', 'anything')).toBe('destructive');
    expect(op('post', 'bulkDeleteUsers')).toBe('destructive');
    expect(op('post', 'cancelOrder')).toBe('destructive');
    expect(op('patch', 'updatePet')).toBe('write');
    expect(
      classifyAccess(
        { id: 'searchPets', method: 'post', path: '/pets/search', summary: '' },
        { treatAsRead: ['searchPets'] },
      ),
    ).toBe('read');
    expect(
      classifyAccess({ id: 'x', method: 'post', path: '/x', summary: '', extension: 'read' }),
    ).toBe('read');
  });

  it('generates ids for operations without operationId', () => {
    expect(generateOperationId('get', '/repos/{owner}/{repo}/issues')).toBe(
      'getReposByOwnerByRepoIssues',
    );
  });

  it('extracts petstore operations with merged parameters and bodies', async () => {
    const spec = await loadSpec(PETSTORE);
    const ops = extractOperations(spec.doc);
    expect(ops).toHaveLength(19);
    const getPet = ops.find((o) => o.id === 'getPetById')!;
    expect(getPet.access).toBe('read');
    expect(signature(getPet)).toBe('getPetById(petId: integer)');
    const addPet = ops.find((o) => o.id === 'addPet')!;
    expect(addPet.body?.contentType).toBe('application/json');
    expect(addPet.inputSchema.required).toEqual(['body']);
    const upload = ops.find((o) => o.id === 'uploadFile')!;
    expect(upload.unsupported).toBeUndefined();
    expect(upload.body).toMatchObject({ kind: 'binary', contentType: 'application/octet-stream' });
    expect(signature(upload)).toBe(
      'uploadFile(petId: integer, additionalMetadata?: string, body?: file)',
    );
    expect(
      ops
        .filter((o) => o.access === 'destructive')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['deleteOrder', 'deletePet', 'deleteUser']);
  });

  it('hides headers that auth handles', async () => {
    const spec = await loadSpec(PETSTORE);
    const ops = extractOperations(spec.doc, { authHeaders: ['api_key'] });
    expect(ops.find((o) => o.id === 'deletePet')!.params.map((p) => p.name)).toEqual(['petId']);
  });

  it('resolves base URLs, including server variables and relative servers', () => {
    const doc = {
      openapi: '3.0.0',
      servers: [{ url: 'https://{region}.api.test/v1', variables: { region: { default: 'eu' } } }],
    } as OpenApiDocument;
    expect(resolveBaseUrl(doc, '/tmp/spec.yaml')).toBe('https://eu.api.test/v1');
    const rel = { openapi: '3.0.0', servers: [{ url: '/api/v3' }] } as OpenApiDocument;
    expect(resolveBaseUrl(rel, 'https://petstore.test/openapi.json')).toBe(
      'https://petstore.test/api/v3',
    );
    expect(resolveBaseUrl(rel, '/tmp/spec.yaml')).toBeUndefined();
    expect(resolveBaseUrl(rel, '/tmp/spec.yaml', 'https://override.test/')).toBe(
      'https://override.test',
    );
  });

  it('converts a minimal Swagger 2.0 document instead of refusing it', async () => {
    const { tempDir } = await import('../helpers.js');
    const { writeFileSync } = await import('node:fs');
    const t = tempDir();
    try {
      writeFileSync(
        `${t.dir}/swagger.json`,
        JSON.stringify({ swagger: '2.0', info: { title: 'x', version: '1' }, paths: {} }),
      );
      const spec = await loadSpec(`${t.dir}/swagger.json`);
      expect(spec).toMatchObject({ convertedFrom: 'Swagger 2.0', doc: { openapi: '3.0.3' } });
    } finally {
      t.cleanup();
    }
  });
});

describe('grouping', () => {
  it('groups by tag and keeps reads first', async () => {
    const spec = await loadSpec(PETSTORE);
    const ops = extractOperations(spec.doc);
    const { groups, longTail } = groupOperations(spec.doc, ops, {
      maxTools: 12,
      maxOperationsPerTool: 15,
      longTail: true,
    });
    expect(groups.map((g) => g.name)).toEqual(['pet', 'user', 'store']);
    expect(groups[0]!.operations.slice(0, 3)).toEqual([
      'findPetsByStatus',
      'findPetsByTags',
      'getPetById',
    ]);
    expect(groups[0]!.description).toBe('Everything about your pets');
    expect(longTail).toEqual([]);
  });

  it('respects the tool budget, sending the rest to the long tail', async () => {
    const spec = await loadSpec(GITHUB);
    const ops = extractOperations(spec.doc);
    const { groups, longTail } = groupOperations(spec.doc, ops, {
      maxTools: 4,
      maxOperationsPerTool: 5,
      longTail: true,
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.operations.length <= 5)).toBe(true);
    const placed = groups.flatMap((g) => g.operations).length;
    expect(placed + longTail.length).toBe(ops.length);
  });

  it('makes safe tool names', () => {
    expect(toToolName('Pet Store')).toBe('pet_store');
    expect(toToolName('userAccounts')).toBe('user_accounts');
    expect(toToolName('2fa')).toBe('op_2fa');
  });
});
