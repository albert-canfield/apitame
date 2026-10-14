import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { groupOperations } from '../../src/sources/openapi/grouping.js';
import { loadSpec, resolveBaseUrl, SpecError } from '../../src/sources/openapi/load.js';
import { extractOperations, signature } from '../../src/sources/openapi/operations.js';
import { suggestAuth } from '../../src/generator/config.js';
import { jsonOf, ROOT, tempDir } from '../helpers.js';

const FIXTURE = join(ROOT, 'tests/fixtures/petstore-swagger2.json');

describe('Swagger 2.0 import', () => {
  it('converts in memory and says so', async () => {
    const spec = await loadSpec(FIXTURE);
    expect(spec.convertedFrom).toBe('Swagger 2.0');
    expect(spec.doc.openapi).toBe('3.0.3');
    expect(resolveBaseUrl(spec.doc, spec.location)).toBe('https://petstore.example.test/v2');
  });

  it('maps parameters, bodies, form data and responses', async () => {
    const ops = extractOperations((await loadSpec(FIXTURE)).doc);
    const byId = Object.fromEntries(ops.map((o) => [o.id, o]));
    expect(Object.keys(byId).sort()).toEqual(
      [
        'addPet',
        'deletePet',
        'findPetsByStatus',
        'findPetsByTags',
        'getInventory',
        'getPetById',
        'updatePetWithForm',
        'uploadFile',
      ].sort(),
    );

    // Path-level parameters are inherited.
    expect(signature(byId.getPetById!)).toBe('getPetById(petId: integer)');

    // Body parameter becomes a JSON request body built from the referenced definition.
    expect(byId.addPet!.body?.contentType).toBe('application/json');
    expect(byId.addPet!.inputSchema.required).toEqual(['body']);
    const pet = byId.addPet!.body!.schema as {
      required: string[];
      properties: Record<string, { type: unknown }>;
    };
    expect(pet.required).toEqual(['name', 'photoUrls']);
    expect(pet.properties.nickname!.type).toEqual(['string', 'null']);

    // formData becomes a urlencoded body; a file field makes it multipart (unsupported for now).
    expect(byId.updatePetWithForm!.body?.contentType).toBe('application/x-www-form-urlencoded');
    expect(byId.uploadFile!.body?.contentType).toBe('multipart/form-data');

    // csv arrays are not exploded; multi arrays are.
    expect(byId.findPetsByStatus!.params[0]).toMatchObject({ style: 'form', explode: false });
    expect(byId.findPetsByTags!.params[0]).toMatchObject({ explode: true });
    expect(byId.findPetsByTags!.deprecated).toBe(true);

    // Response schema comes from the first 2xx and the produces list.
    expect(byId.findPetsByStatus!.response?.contentType).toBe('application/json');
  });

  it('maps security definitions so init can suggest auth', async () => {
    const spec = await loadSpec(FIXTURE);
    const schemes = (spec.doc.components as { securitySchemes: Record<string, unknown> })
      .securitySchemes;
    expect(schemes.api_key).toEqual({ type: 'apiKey', in: 'header', name: 'api_key' });
    expect(schemes.partner).toMatchObject({
      type: 'oauth2',
      flows: { clientCredentials: { tokenUrl: 'https://petstore.example.test/oauth/token' } },
    });
    expect(suggestAuth(spec.doc, 'petstore').auth).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'api_key',
      value: '${PETSTORE_API_KEY}',
    });
  });

  it('refuses Swagger 1.x', async () => {
    const t = tempDir();
    try {
      writeFileSync(
        join(t.dir, 'old.json'),
        JSON.stringify({ swagger: '1.2', info: { title: 'x' } }),
      );
      await expect(loadSpec(join(t.dir, 'old.json'))).rejects.toThrow(SpecError);
    } finally {
      t.cleanup();
    }
  });
});

describe('Swagger 2.0 runtime', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockServer(extractOperations((await loadSpec(FIXTURE)).doc), {
      basePath: '',
    });
  });
  afterAll(() => mock.close());

  it('serves the converted API and serializes csv arrays the Swagger 2.0 way', async () => {
    const spec = await loadSpec(FIXTURE);
    const ops = extractOperations(spec.doc);
    const { groups } = groupOperations(spec.doc, ops, {
      maxTools: 12,
      maxOperationsPerTool: 15,
      longTail: true,
    });
    const config = parseConfig({
      name: 'petstore2',
      source: { type: 'openapi', spec: FIXTURE },
      tools: groups,
    });
    const rt = await createOpenApiRuntime({
      config,
      configDir: ROOT,
      spec,
      baseUrlOverride: mock.url,
      env: {},
    });
    expect(rt.listTools().map((t) => t.name)).toEqual([
      'pet',
      'store',
      'search_operations',
      'call_operation',
    ]);
    const res = await rt.callTool('pet', {
      operation: 'findPetsByStatus',
      params: { status: ['available', 'sold'] },
    });
    expect(jsonOf(res)).toMatchObject({ status: 200 });
    expect(mock.requests.at(-1)!.query).toEqual({ status: 'available,sold' });
  });
});
