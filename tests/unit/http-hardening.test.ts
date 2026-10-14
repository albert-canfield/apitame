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

  it('never re-attaches credentials after the chain has left the origin', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.host === 'api.test' && url.pathname === '/v1/files/1')
        return new Response(null, { status: 302, headers: { location: 'https://cdn.test/x' } });
      if (url.host === 'cdn.test')
        return new Response(null, { status: 302, headers: { location: 'https://api.test/v1/me' } });
      return Response.json({ ok: true });
    });
    await sendRequest(
      {
        method: 'GET',
        url: new URL('https://api.test/v1/files/1'),
        headers: { 'X-Api-Key': 'k-123456' },
      },
      auth(),
      { ...opts, basePath: '/v1', fetchImpl: impl },
    );
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/files/1',
      'https://cdn.test/x',
      'https://api.test/v1/me',
    ]);
    expect(calls[2]!.headers.Authorization).toBeUndefined();
    expect(calls[2]!.headers['X-Api-Key']).toBeUndefined();
  });

  it('does not resend a write (307, 308) outside the base path', async () => {
    for (const location of ['https://cdn.test/upload', 'https://api.test/admin/purge-all']) {
      const { impl, calls } = stubFetch(
        () => new Response(null, { status: 307, headers: { location } }),
      );
      await expect(
        sendRequest(
          { method: 'POST', url: new URL('https://api.test/v1/uploads'), headers: {}, body: '{}' },
          auth(),
          { ...opts, basePath: '/v1', fetchImpl: impl },
        ),
      ).rejects.toThrow(/not resent outside https:\/\/api\.test\/v1/);
      expect(calls).toHaveLength(1);
    }
  });

  it('still follows a write redirect under the base path, with credentials', async () => {
    const { impl, calls } = stubFetch((url) =>
      url.pathname === '/v1/uploads'
        ? new Response(null, { status: 308, headers: { location: '/v1/uploads/' } })
        : Response.json({ ok: true }),
    );
    const res = await sendRequest(
      { method: 'POST', url: new URL('https://api.test/v1/uploads'), headers: {}, body: '{}' },
      auth(),
      { ...opts, basePath: '/v1', fetchImpl: impl },
    );
    expect(res.status).toBe(200);
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.headers.Authorization).toBe('Bearer secret-token-123');
  });

  it('applies the timeout to the whole chain, not to each hop', async () => {
    let hops = 0;
    const impl = (async (input: URL | string, init: RequestInit = {}) => {
      hops++;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 120);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(init.signal?.reason as Error);
        });
      });
      return new URL(String(input)).pathname === '/v1/end'
        ? Response.json({ ok: true })
        : new Response(null, { status: 302, headers: { location: `/v1/hop${hops}` } });
    }) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      sendRequest(
        { method: 'GET', url: new URL('https://api.test/v1/start'), headers: {} },
        undefined,
        { ...opts, timeoutMs: 300, fetchImpl: impl },
      ),
    ).rejects.toThrow('Request timed out after 300 ms.');
    expect(Date.now() - started).toBeLessThan(600);
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

describe('base URL and query parameters', () => {
  it('keeps a query string on the base URL as query parameters', async () => {
    const getPet = await op(PETSTORE, 'getPetById');
    const req = buildRequest(getPet, { petId: 7 }, 'https://api.test/v1?api-version=2024-01-01');
    expect(req.url.toString()).toBe('https://api.test/v1/pet/7?api-version=2024-01-01');
  });

  it('refuses keys an exploded object query parameter does not declare', () => {
    const search = {
      id: 'search',
      method: 'post',
      path: '/search',
      params: [
        {
          name: 'filter',
          key: 'filter',
          in: 'query',
          required: false,
          schema: { type: 'object', properties: { status: { type: 'string' } } },
          rawSchema: {},
          description: '',
          style: 'form',
          explode: true,
        },
      ],
    } as unknown as Operation;
    expect(
      buildRequest(search, { filter: { status: 'open' } }, 'https://api.test').url.search,
    ).toBe('?status=open');
    expect(() =>
      buildRequest(search, { filter: { status: 'open', _method: 'DELETE' } }, 'https://api.test'),
    ).toThrow(/does not accept "_method"/);
    const open = {
      ...search,
      params: [
        {
          ...search.params[0]!,
          schema: { type: 'object', additionalProperties: { type: 'string' } },
        },
      ],
    } as Operation;
    expect(buildRequest(open, { filter: { any: 'x' } }, 'https://api.test').url.search).toBe(
      '?any=x',
    );
  });
});

describe('binary responses', () => {
  it('treats +json and +xml types as text', async () => {
    const { impl } = stubFetch(() =>
      Response.json(
        { data: [{ id: '1' }] },
        {
          headers: { 'content-type': 'application/vnd.api+json' },
        },
      ),
    );
    const res = await sendRequest(
      { method: 'GET', url: new URL('https://api.test/articles'), headers: {} },
      undefined,
      { ...opts, fetchImpl: impl },
    );
    expect(res.data).toEqual({ data: [{ id: '1' }] });
  });

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
