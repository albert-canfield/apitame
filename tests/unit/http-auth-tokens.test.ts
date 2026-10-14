import { describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../src/auth/index.js';
import { Redactor } from '../../src/safety/redact.js';
import { buildRequest, fitJson } from '../../src/server/http-client.js';
import { extractOperations, type Operation } from '../../src/sources/openapi/operations.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { estimateTokens, toolListCost } from '../../src/tokens/estimate.js';
import { GITHUB, PETSTORE } from '../helpers.js';

async function op(spec: string, id: string): Promise<Operation> {
  const loaded = await loadSpec(spec);
  return extractOperations(loaded.doc).find((o) => o.id === id)!;
}

describe('buildRequest', () => {
  it('fills path params, encodes them, and serializes query arrays', async () => {
    const o = await op(GITHUB, 'repos/get-content');
    const req = buildRequest(
      o,
      { owner: 'oct cat', repo: 'x', path: 'docs/a b.md', ref: 'main' },
      'https://api.github.com/',
    );
    expect(req.method).toBe('GET');
    expect(req.url.toString()).toBe(
      'https://api.github.com/repos/oct%20cat/x/contents/docs%2Fa%20b.md?ref=main',
    );
  });

  it('explodes array query parameters', async () => {
    const o = await op(PETSTORE, 'findPetsByTags');
    const req = buildRequest(o, { tags: ['a', 'b'] }, 'https://p.test');
    expect(req.url.search).toBe('?tags=a&tags=b');
  });

  it('sends JSON bodies with the right content type', async () => {
    const o = await op(PETSTORE, 'addPet');
    const req = buildRequest(o, { body: { name: 'rex', photoUrls: [] } }, 'https://p.test');
    expect(req.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(req.body as string)).toEqual({ name: 'rex', photoUrls: [] });
  });

  it('refuses a missing path parameter instead of calling a wrong URL', async () => {
    const o = await op(PETSTORE, 'getPetById');
    expect(() => buildRequest(o, {}, 'https://p.test')).toThrow(/petId/);
  });
});

describe('fitJson', () => {
  it('keeps small values intact', () => {
    expect(fitJson({ a: 1 }, 100)).toEqual({ value: { a: 1 } });
  });

  it('trims arrays to fit and says how much was kept', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item ${i}` }));
    const out = fitJson(items, 2_000);
    expect(Array.isArray(out.value)).toBe(true);
    expect(JSON.stringify(out.value).length).toBeLessThanOrEqual(2_000);
    expect(out.note).toMatch(/showing \d+ of 500/);
  });

  it('trims the biggest array inside an object (search results shape)', () => {
    const value = { total_count: 1000, items: Array.from({ length: 300 }, (_, i) => ({ id: i })) };
    const out = fitJson(value, 1_000);
    expect((out.value as { total_count: number }).total_count).toBe(1000);
    expect(out.note).toMatch(/"items" shows/);
  });
});

describe('auth', () => {
  it('applies bearer and api keys and registers them as secrets', async () => {
    const redactor = new Redactor();
    const bearer = createAuth({ type: 'bearer', token: '${TOK}' }, redactor, { TOK: 'tok-123456' });
    const req = { url: new URL('https://x.test'), headers: {} as Record<string, string> };
    await bearer.apply(req);
    expect(req.headers.Authorization).toBe('Bearer tok-123456');

    const key = createAuth(
      { type: 'apiKey', in: 'query', name: 'api_key', value: '${K}' },
      redactor,
      { K: 'key-abcdef' },
    );
    const req2 = { url: new URL('https://x.test'), headers: {} as Record<string, string> };
    await key.apply(req2);
    expect(req2.url.searchParams.get('api_key')).toBe('key-abcdef');
    expect(redactor.text(req2.url.toString())).not.toContain('key-abcdef');
  });

  it('runs the OAuth2 client credentials flow once and caches the token', async () => {
    const redactor = new Redactor();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at-999999', expires_in: 3600 }), {
          status: 200,
        }),
    );
    const auth = createAuth(
      {
        type: 'oauth2',
        flow: 'client_credentials',
        tokenUrl: 'https://auth.test/token',
        clientId: 'cid',
        clientSecret: '${CS}',
        scopes: ['read'],
        clientAuthMethod: 'client_secret_basic',
      },
      redactor,
      { CS: 'client-secret-xyz' },
      fetchMock as unknown as typeof fetch,
    );
    const r1 = { url: new URL('https://x.test'), headers: {} as Record<string, string> };
    const r2 = { url: new URL('https://x.test'), headers: {} as Record<string, string> };
    await Promise.all([auth.apply(r1), auth.apply(r2)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1.headers.Authorization).toBe('Bearer at-999999');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain('grant_type=client_credentials');
    expect(String(init.body)).toContain('scope=read');
    expect(String(init.body)).not.toContain('client-secret-xyz');
    expect(redactor.text('leak: at-999999 client-secret-xyz')).toBe('leak: [REDACTED] [REDACTED]');
    await auth.apply(r1, { forceRefresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never puts the client secret in token endpoint errors', async () => {
    const redactor = new Redactor();
    const fetchMock = vi.fn(
      async () => new Response('invalid client client-secret-xyz', { status: 401 }),
    );
    const auth = createAuth(
      {
        type: 'oauth2',
        flow: 'client_credentials',
        tokenUrl: 'https://auth.test/token',
        clientId: 'cid',
        clientSecret: '${CS}',
        scopes: [],
        clientAuthMethod: 'client_secret_post',
      },
      redactor,
      { CS: 'client-secret-xyz' },
      fetchMock as unknown as typeof fetch,
    );
    await expect(auth.apply({ url: new URL('https://x.test'), headers: {} })).rejects.toThrow(
      /HTTP 401: invalid client \[REDACTED\]/,
    );
  });
});

describe('estimateTokens', () => {
  it('grows with content and stays in a sane range for JSON', () => {
    expect(estimateTokens('')).toBe(0);
    const text = JSON.stringify({
      name: 'getPetById',
      description: 'Find pet by ID',
      input_schema: { type: 'object', properties: { petId: { type: 'integer' } } },
    });
    const t = estimateTokens(text);
    // About one token per 3 to 5 characters of JSON.
    expect(t).toBeGreaterThan(text.length / 6);
    expect(t).toBeLessThan(text.length / 2);
  });

  it('sums tool costs and instructions', () => {
    const cost = toolListCost(
      [{ name: 'a', description: 'b', inputSchema: { type: 'object' } }],
      'hello world',
    );
    expect(cost.total).toBe(cost.tools[0]!.tokens + cost.instructions);
  });
});
