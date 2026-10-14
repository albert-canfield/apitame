import { describe, expect, it } from 'vitest';
import { createAuth } from '../../src/auth/index.js';
import { Redactor } from '../../src/safety/redact.js';
import { buildRequest, sendRequest } from '../../src/server/http-client.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations, type Operation } from '../../src/sources/openapi/operations.js';
import { GITHUB, PETSTORE } from '../helpers.js';

async function op(spec: string, id: string): Promise<Operation> {
  const loaded = await loadSpec(spec);
  return extractOperations(loaded.doc).find((o) => o.id === id)!;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub that answers from a routing function and records every call. */
function stubFetch(route: (url: URL, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({
      url: url.toString(),
      method: String(init.method),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    });
    return route(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const opts = { timeoutMs: 5_000, maxResponseBytes: 50_000 };

describe('path parameters', () => {
  it('refuses dot segments that would change the endpoint', async () => {
    const o = await op(GITHUB, 'repos/get');
    for (const bad of ['..', '.']) {
      expect(() =>
        buildRequest(o, { owner: bad, repo: 'admin' }, 'https://api.github.com'),
      ).toThrow(/cannot be "\." or "\.\."/);
    }
  });

  it('keeps encoded look-alikes encoded and inside the base path', async () => {
    const o = await op(GITHUB, 'repos/get');
    const req = buildRequest(o, { owner: '%2e%2e', repo: 'a/../b' }, 'https://api.example.com/v3');
    expect(req.url.pathname).toBe('/v3/repos/%252e%252e/a%2F..%2Fb');
  });

  it('sends a User-Agent', async () => {
    const o = await op(PETSTORE, 'getPetById');
    expect(buildRequest(o, { petId: 1 }, 'https://p.test').headers['User-Agent']).toMatch(
      /^apitame\//,
    );
  });
});

describe('redirects', () => {
  const auth = () =>
    createAuth({ type: 'bearer', token: '${T}' }, new Redactor(), { T: 'secret-token-123' });

  it('keeps credentials on same-origin redirects', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : Response.json({ ok: true }),
    );
    const res = await sendRequest(
      { method: 'GET', url: new URL('https://api.test/old'), headers: { 'X-Api-Key': 'k-123456' } },
      auth(),
      { ...opts, fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.Authorization).toBe('Bearer secret-token-123');
    expect(calls[1]!.headers['X-Api-Key']).toBe('k-123456');
  });

  it('never sends credentials or custom headers to another origin', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.host === 'api.test'
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://files.other.test/blob' },
          })
        : Response.json({ ok: true }),
    );
    const res = await sendRequest(
      {
        method: 'GET',
        url: new URL('https://api.test/download'),
        headers: { 'X-Api-Key': 'k-123456', Accept: 'application/json' },
      },
      auth(),
      { ...opts, fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    const hop = calls[1]!;
    expect(hop.url).toBe('https://files.other.test/blob');
    expect(hop.headers.Authorization).toBeUndefined();
    expect(hop.headers['X-Api-Key']).toBeUndefined();
    expect(JSON.stringify(hop.headers)).not.toContain('secret-token-123');
  });

  it('turns POST into GET on 303 and drops the body', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.pathname === '/jobs'
        ? new Response(null, { status: 303, headers: { location: '/jobs/1' } })
        : Response.json({ id: 1 }),
    );
    await sendRequest(
      { method: 'POST', url: new URL('https://api.test/jobs'), headers: {}, body: '{"a":1}' },
      undefined,
      { ...opts, fetchImpl: impl },
    );
    expect(calls[1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('stops redirect loops and non-HTTP targets', async () => {
    const loop = stubFetch(
      () => new Response(null, { status: 302, headers: { location: '/again' } }),
    );
    await expect(
      sendRequest({ method: 'GET', url: new URL('https://api.test/x'), headers: {} }, undefined, {
        ...opts,
        fetchImpl: loop.impl,
      }),
    ).rejects.toThrow(/Too many redirects/);
    const file = stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    );
    await expect(
      sendRequest({ method: 'GET', url: new URL('https://api.test/x'), headers: {} }, undefined, {
        ...opts,
        fetchImpl: file.impl,
      }),
    ).rejects.toThrow(/file: URL/);
  });
});

describe('binary responses', () => {
  it('describes binary bodies instead of returning bytes', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        }),
    );
    const res = await sendRequest(
      { method: 'GET', url: new URL('https://api.test/logo'), headers: {} },
      undefined,
      { ...opts, fetchImpl: impl },
    );
    expect(res.data).toEqual({ binary: true, contentType: 'image/png', bytes: 4 });
    expect(res.note).toMatch(/Binary content/);
  });
});
