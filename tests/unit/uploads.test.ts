import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { buildRequest } from '../../src/server/http-client.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations, signature } from '../../src/sources/openapi/operations.js';
import { jsonOf, petstore, petstoreConfig, ROOT, textOf } from '../helpers.js';

const SWAGGER2 = join(ROOT, 'tests/fixtures/petstore-swagger2.json');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

describe('upload bodies', () => {
  it('builds multipart form data with files and plain fields', async () => {
    const op = extractOperations((await loadSpec(SWAGGER2)).doc).find(
      (o) => o.id === 'uploadFile',
    )!;
    expect(op.body).toMatchObject({ kind: 'multipart', fileFields: ['file'] });
    expect(signature(op)).toContain('body?: {additionalMetadata?: string, file?: file}');
    const req = buildRequest(
      op,
      {
        petId: 1,
        body: {
          additionalMetadata: 'front',
          file: { filename: 'a.png', contentType: 'image/png', base64: png },
        },
      },
      'https://p.test',
    );
    expect(req.body).toBeInstanceOf(FormData);
    expect(req.headers['Content-Type']).toBeUndefined();
    const form = req.body as FormData;
    expect(form.get('additionalMetadata')).toBe('front');
    const file = form.get('file') as File;
    expect(file.name).toBe('a.png');
    expect(file.size).toBe(8);
    expect(req.bodyPreview).toEqual({
      multipart: {
        additionalMetadata: 'front',
        file: { file: 'a.png', contentType: 'image/png', bytes: 8 },
      },
    });
  });

  it('sends raw binary bodies, from base64 or text', async () => {
    const op = extractOperations((await petstore()).doc).find((o) => o.id === 'uploadFile')!;
    const req = buildRequest(
      op,
      { petId: 1, body: { base64: png, contentType: 'image/png' } },
      'https://p.test',
    );
    expect(req.headers['Content-Type']).toBe('image/png');
    expect(Buffer.from(req.body as Uint8Array).toString('base64')).toBe(png);
    const text = buildRequest(op, { petId: 1, body: { text: 'hello' } }, 'https://p.test');
    expect(Buffer.from(text.body as Uint8Array).toString()).toBe('hello');
    expect(text.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('refuses uploads over the size limit and non-file values', async () => {
    const op = extractOperations((await petstore()).doc).find((o) => o.id === 'uploadFile')!;
    expect(() =>
      buildRequest(
        op,
        { petId: 1, body: { text: 'x'.repeat(2_000) } },
        'https://p.test',
        {},
        { maxUploadBytes: 1_000 },
      ),
    ).toThrow(/maxUploadBytes/);
    expect(() => buildRequest(op, { petId: 1, body: 42 }, 'https://p.test')).toThrow(
      /takes a file/,
    );
  });
});

describe('uploads through the runtime', () => {
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockServer(extractOperations((await petstore()).doc));
  });
  afterAll(() => mock.close());

  it('dry runs summarize files, real calls send the bytes', async () => {
    const config = await petstoreConfig({ mode: 'read-write', writes: { allow: ['uploadFile'] } });
    const rt = await createOpenApiRuntime({
      config,
      configDir: '.',
      spec: await petstore(),
      baseUrlOverride: mock.url,
      env: {},
    });
    const args = {
      operation: 'uploadFile',
      params: { petId: 3, body: { filename: 'pet.png', contentType: 'image/png', base64: png } },
    };
    const dry = jsonOf<{ request: { body: unknown } }>(
      await rt.callTool('pet', { ...args, dryRun: true }),
    );
    expect(dry.request.body).toEqual({ file: 'pet.png', contentType: 'image/png', bytes: 8 });
    expect(textOf(await rt.callTool('pet', { ...args, dryRun: true }))).not.toContain(png);

    const res = await rt.callTool('pet', args);
    expect(res.isError).toBeUndefined();
    const sent = mock.requests.at(-1)!;
    expect(sent.path).toBe('/pet/3/uploadImage');
    expect(sent.headers['content-type']).toBe('image/png');
    expect(Buffer.from(sent.body, 'latin1').length).toBeGreaterThan(0);
  });

  it('reports a missing file clearly', async () => {
    const config = parseConfig({
      ...(await petstoreConfig({ mode: 'read-write', writes: { allow: ['uploadFile'] } })),
    });
    const rt = await createOpenApiRuntime({
      config,
      configDir: '.',
      spec: await petstore(),
      baseUrlOverride: mock.url,
      env: {},
    });
    const res = await rt.callTool('pet', {
      operation: 'uploadFile',
      params: { petId: 3, body: 'not a file' },
    });
    expect(res.isError).toBe(true);
  });
});
