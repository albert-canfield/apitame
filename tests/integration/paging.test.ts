import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { generateOpenApiSkill } from '../../src/generator/skills.js';
import { startMockServer, type MockServer, type RecordedRequest } from '../../src/mock/server.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import {
  callOperation,
  fakeApi,
  GITHUB,
  jsonOf,
  petstore,
  petstoreConfig,
  ROOT,
  tempDir,
  textOf,
  type SentRequest,
} from '../helpers.js';

interface Paged<T = Record<string, unknown>> {
  status: number;
  data: T;
  note?: string;
  pagination?: { pages: number; more?: boolean; next?: Record<string, unknown>; note?: string };
}

const json = (schema: unknown, headers?: Record<string, unknown>) => ({
  '200': {
    description: 'ok',
    content: { 'application/json': { schema } },
    ...(headers ? { headers } : {}),
  },
});
const q = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({
  name,
  in: 'query',
  schema: { type, ...extra },
});
const list = { type: 'array', items: { type: 'object' } };
const reply = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const query = (s: SentRequest) => Object.fromEntries(new URL(s.url).searchParams);

/** 12 customers, cus_01 to cus_12, served the way Stripe pages them. */
const CUSTOMERS = Array.from({ length: 12 }, (_, i) => ({
  id: `cus_${String(i + 1).padStart(2, '0')}`,
  name: `Customer ${i + 1}`,
}));
const stripePaths = {
  '/customers': {
    get: {
      operationId: 'GetCustomers',
      parameters: [q('email'), q('ending_before'), q('limit', 'integer'), q('starting_after')],
      responses: json({
        type: 'object',
        properties: {
          data: list,
          has_more: { type: 'boolean' },
          object: { type: 'string' },
          url: { type: 'string' },
        },
      }),
    },
  },
  '/customers/search': {
    get: {
      operationId: 'GetCustomersSearch',
      parameters: [q('limit', 'integer'), q('page'), { ...q('query'), required: true }],
      responses: json({
        type: 'object',
        properties: {
          data: list,
          has_more: { type: 'boolean' },
          next_page: { type: 'string', nullable: true },
          total_count: { type: 'integer' },
        },
      }),
    },
  },
};
function stripe(s: SentRequest, rows: Array<Record<string, unknown>> = CUSTOMERS): Response {
  const p = query(s);
  const limit = Number(p.limit ?? 10);
  const url = new URL(s.url);
  if (url.pathname.endsWith('/search')) {
    const start = p.page ? Number(p.page.replace('page_', '')) : 0;
    const data = rows.slice(start, start + limit);
    const more = start + limit < rows.length;
    return reply({
      object: 'search_result',
      data,
      has_more: more,
      next_page: more ? `page_${start + limit}` : null,
      total_count: rows.length,
    });
  }
  let data: Array<Record<string, unknown>>;
  if (p.ending_before) {
    const end = rows.findIndex((c) => c.id === p.ending_before);
    data = rows.slice(Math.max(0, end - limit), end);
    return reply({ object: 'list', data, has_more: end - limit > 0, url: '/v1/customers' });
  }
  const start = p.starting_after ? rows.findIndex((c) => c.id === p.starting_after) + 1 : 0;
  data = rows.slice(start, start + limit);
  return reply({
    object: 'list',
    data,
    has_more: start + limit < rows.length,
    url: '/v1/customers',
  });
}

describe('cursor paging (Stripe)', () => {
  it('reads the following pages with starting_after and merges data', async () => {
    const { rt, sent } = fakeApi({ paths: stripePaths, respond: (s) => stripe(s) });
    const r = jsonOf<Paged<{ data: Array<{ id: string }>; has_more: boolean }>>(
      await callOperation(rt, 'GetCustomers', { limit: 4, email: 'a@b.test' }, { pages: 5 }),
    );
    expect(r.data.data.map((c) => c.id)).toEqual(CUSTOMERS.map((c) => c.id));
    // The envelope comes from the last page, and has_more agrees with pagination.
    expect(r.data.has_more).toBe(false);
    expect(r.pagination).toEqual({ pages: 3, more: false });
    expect(sent.map(query)).toEqual([
      { email: 'a@b.test', limit: '4' },
      { email: 'a@b.test', limit: '4', starting_after: 'cus_04' },
      { email: 'a@b.test', limit: '4', starting_after: 'cus_08' },
    ]);
  });

  it('says how to continue when it stops at `pages`, and the advice works', async () => {
    const { rt, sent } = fakeApi({ paths: stripePaths, respond: (s) => stripe(s) });
    const first = jsonOf<Paged<{ data: Array<{ id: string }>; has_more: boolean }>>(
      await callOperation(rt, 'GetCustomers', { limit: 5 }),
    );
    expect(sent).toHaveLength(1);
    expect(first.pagination).toEqual({ pages: 1, more: true, next: { starting_after: 'cus_05' } });
    expect(first.data.has_more).toBe(true);
    const second = jsonOf<Paged<{ data: Array<{ id: string }> }>>(
      await callOperation(
        rt,
        'GetCustomers',
        { limit: 5, ...first.pagination!.next },
        { pages: 2 },
      ),
    );
    expect(second.data.data.map((c) => c.id)).toEqual(CUSTOMERS.slice(5).map((c) => c.id));
    expect(second.pagination).toEqual({ pages: 2, more: false });
  });

  it('gives ending_before back for backward paging, and does not follow it', async () => {
    const { rt, sent } = fakeApi({ paths: stripePaths, respond: (s) => stripe(s) });
    const r = jsonOf<Paged<{ data: Array<{ id: string }> }>>(
      await callOperation(rt, 'GetCustomers', { limit: 3, ending_before: 'cus_10' }, { pages: 3 }),
    );
    expect(sent).toHaveLength(1);
    expect(r.data.data.map((c) => c.id)).toEqual(['cus_07', 'cus_08', 'cus_09']);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { ending_before: 'cus_07' } });
    expect(r.pagination!.note).toMatch(/only reads following pages forward \(starting_after\)/);
  });

  it('cuts a page between items at the byte budget, and next continues right after', async () => {
    const rows = CUSTOMERS.map((c) => ({ ...c, bio: 'x'.repeat(120) }));
    const { rt, sent } = fakeApi({
      paths: stripePaths,
      config: { limits: { maxResponseBytes: 1000 } },
      respond: (s) => stripe(s, rows),
    });
    const r = jsonOf<Paged<{ data: Array<{ id: string }>; has_more: boolean }>>(
      await callOperation(rt, 'GetCustomers', { limit: 4 }, { pages: 5 }),
    );
    expect(sent).toHaveLength(2);
    const ids = r.data.data.map((c) => c.id);
    // Each item takes about 160 bytes: page 1 fits whole, page 2 only in part.
    expect(ids.length).toBeGreaterThan(4);
    expect(ids.length).toBeLessThan(8);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(1000);
    expect(r.data.has_more).toBe(true);
    expect(r.pagination).toMatchObject({
      pages: 2,
      more: true,
      next: { starting_after: ids.at(-1) },
    });
    expect(r.pagination!.note).toMatch(
      /Page 2 was cut to \d of 4 items to fit limits\.maxResponseBytes \(1000 bytes\); "next" continues right after the last item returned\./,
    );

    // When the last page is the one cut, has_more still says that more items follow.
    const tail = jsonOf<Paged<{ data: Array<{ id: string }>; has_more: boolean }>>(
      await callOperation(rt, 'GetCustomers', { limit: 4, starting_after: 'cus_04' }, { pages: 5 }),
    );
    expect(tail.data.data[0]!.id).toBe('cus_05');
    expect(tail.data.data.length).toBeLessThan(8);
    expect(tail.data.has_more).toBe(true);
    expect(tail.pagination).toMatchObject({ pages: 2, more: true });

    // Without field selection fewer items fit than with it: fields apply before the budget.
    const slim = jsonOf<Paged<{ data: Array<{ id: string }> }>>(
      await callOperation(
        rt,
        'GetCustomers',
        { limit: 4 },
        { pages: 5, fields: ['data.id', 'has_more'] },
      ),
    );
    expect(slim.data.data.map((c) => c.id)).toEqual(CUSTOMERS.map((c) => c.id));
    expect(slim.pagination).toEqual({ pages: 3, more: false });
  });
});

describe('token paging (Stripe search)', () => {
  it('passes next_page back as page until it is null', async () => {
    const { rt, sent } = fakeApi({ paths: stripePaths, respond: (s) => stripe(s) });
    const r = jsonOf<Paged<{ data: unknown[]; next_page: string | null }>>(
      await callOperation(rt, 'GetCustomersSearch', { query: "name:'x'", limit: 5 }, { pages: 5 }),
    );
    expect(sent.map((s) => query(s).page)).toEqual([undefined, 'page_5', 'page_10']);
    expect(sent.every((s) => query(s).query === "name:'x'")).toBe(true);
    expect(r.data.data).toHaveLength(12);
    expect(r.data.next_page).toBeNull();
    expect(r.pagination).toEqual({ pages: 3, more: false });

    const one = jsonOf<Paged>(
      await callOperation(rt, 'GetCustomersSearch', { query: "name:'x'", limit: 5 }),
    );
    expect(one.pagination).toEqual({ pages: 1, more: true, next: { page: 'page_5' } });
  });
});

/** GitHub-style issues: page numbers, and a Link header on every page but the last. */
const issuesPaths = (linkHeader: boolean) => ({
  '/repos/{owner}/{repo}/issues': {
    get: {
      operationId: 'issues/list-for-repo',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        q('state', 'string', { enum: ['open', 'closed', 'all'] }),
        q('per_page', 'integer', { default: 30, maximum: 100 }),
        q('page', 'integer', { default: 1 }),
      ],
      responses: json(list, linkHeader ? { Link: { schema: { type: 'string' } } } : undefined),
    },
    post: {
      operationId: 'issues/create',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        q('page', 'integer'),
        q('per_page', 'integer'),
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: json({ type: 'object' }),
    },
  },
});
const ISSUES = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}` }));
function issues(
  s: SentRequest,
  opts: {
    total?: number;
    next?: (page: number, per: number) => string | undefined;
    pad?: number;
  } = {},
): Response {
  const p = query(s);
  const page = Number(p.page ?? 1);
  const per = Number(p.per_page ?? 30);
  const rows = Array.from({ length: opts.total ?? 7 }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i + 1}`,
    ...(opts.pad ? { body: 'b'.repeat(opts.pad) } : {}),
  }));
  const data = rows.slice((page - 1) * per, page * per);
  const next = opts.next?.(page, per);
  if (next === undefined) return reply(data);
  // Like GitHub, the last page still has a Link header, without rel="next".
  const last = page * per >= rows.length;
  const first = '<https://api.example.com/v1/repositories/1/issues?page=1>; rel="first"';
  return reply(data, { link: last ? first : `<${next}>; rel="next", ${first}` });
}

describe('page number paging', () => {
  it('reads pages until one comes back short', async () => {
    const { rt, sent } = fakeApi({ paths: issuesPaths(false), respond: (s) => issues(s) });
    const r = jsonOf<Paged<Array<{ number: number }>>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 5 },
      ),
    );
    expect(r.data.map((i) => i.number)).toEqual(ISSUES.map((i) => i.number));
    expect(r.pagination).toEqual({ pages: 3, more: false });
    expect(sent.map((s) => query(s).page)).toEqual([undefined, '2', '3']);
  });

  it('believes a Link header without rel="next" when the API sends one', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      // 6 issues: the second page is full, but the API says it is the last one.
      respond: (s) =>
        issues(s, {
          total: 6,
          next: (page) => `https://api.example.com/v1/repos/o/r/issues?page=${page + 1}`,
        }),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 5 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.data).toHaveLength(6);
    expect(r.pagination).toEqual({ pages: 2, more: false });
  });

  it('adds following pages whole or not at all, so next is exact', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { maxResponseBytes: 1000 } },
      respond: (s) => issues(s, { total: 12, pad: 150 }),
    });
    const r = jsonOf<Paged<Array<{ number: number }>>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 4 },
        { pages: 3 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.data.map((i) => i.number)).toEqual([1, 2, 3, 4]);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(
      /Page 2 did not fit in limits\.maxResponseBytes \(1000 bytes\)/,
    );
  });

  it('cuts a first page that is too large, and says next skips the rest', async () => {
    const { rt } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { maxResponseBytes: 1000 } },
      respond: (s) => issues(s, { total: 12, pad: 150 }),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(rt, 'issues/list-for-repo', { owner: 'o', repo: 'r', per_page: 10 }),
    );
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data.length).toBeLessThan(10);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(1000);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(
      /Page 1 was cut to \d of 10 items .*, and "next" skips the \d that were cut\. Ask for fewer/,
    );

    // The only page, cut: more items exist, but no page follows to point to.
    const { rt: single } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { maxResponseBytes: 1000 } },
      respond: (s) => issues(s, { total: 6, pad: 150 }),
    });
    const only = jsonOf<Paged<unknown[]>>(
      await callOperation(single, 'issues/list-for-repo', { owner: 'o', repo: 'r', per_page: 10 }),
    );
    expect(only.data.length).toBeLessThan(6);
    expect(only.pagination).toEqual({
      pages: 1,
      more: true,
      note: `Page 1 was cut to ${only.data.length} of 6 items to fit limits.maxResponseBytes (1000 bytes). Ask for fewer items per page, or select fewer fields.`,
    });
  });

  it('stops at a page that fails and says where to retry', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      respond: (s) => (query(s).page === '2' ? reply({ message: 'boom' }, {}, 502) : issues(s)),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 3 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.status).toBe(200);
    expect(r.data).toHaveLength(3);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(/Page 2 answered with status 502/);
  });
});

describe('next links (Link header and body)', () => {
  const linked = (next: (page: number, per: number) => string) =>
    fakeApi({
      paths: issuesPaths(true),
      config: { auth: { type: 'bearer', token: '${GH_TOKEN}' } },
      env: { GH_TOKEN: 'ghp_secret_value_123456' },
      respond: (s) => issues(s, { next }),
    });

  it('takes the page from the Link header and builds the request from the operation', async () => {
    // GitHub answers /repos/{owner}/{repo}/issues with links to /repositories/{id}/issues.
    const { rt, sent } = linked(
      (page, per) =>
        `https://api.example.com/v1/repositories/42/issues?state=closed&per_page=100&page=${page + 1}&per=${per}`,
    );
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', state: 'open', per_page: 3 },
        { pages: 3 },
      ),
    );
    expect(r.data).toHaveLength(7);
    expect(r.pagination).toEqual({ pages: 3, more: false });
    // Same path, same arguments; only the page comes from the link.
    expect(sent.map((s) => `${new URL(s.url).pathname}?${new URL(s.url).searchParams}`)).toEqual([
      '/v1/repos/o/r/issues?state=open&per_page=3',
      '/v1/repos/o/r/issues?state=open&per_page=3&page=2',
      '/v1/repos/o/r/issues?state=open&per_page=3&page=3',
    ]);
    expect(sent.every((s) => s.method === 'GET')).toBe(true);
    expect(sent.every((s) => s.headers.Authorization === 'Bearer ghp_secret_value_123456')).toBe(
      true,
    );
  });

  it('refuses a next link to another origin or outside the base path, and sends nothing there', async () => {
    for (const target of [
      'https://evil.example.net/v1/repos/o/r/issues?page=2',
      'http://api.example.com/v1/repos/o/r/issues?page=2',
      'https://api.example.com/v2/repos/o/r/issues?page=2',
    ]) {
      const { rt, sent } = linked(() => target);
      const r = jsonOf<Paged<unknown[]>>(
        await callOperation(
          rt,
          'issues/list-for-repo',
          { owner: 'o', repo: 'r', per_page: 3 },
          { pages: 3 },
        ),
      );
      expect(sent).toHaveLength(1);
      expect(sent.every((s) => s.url.startsWith('https://api.example.com/v1/'))).toBe(true);
      expect(r.data).toHaveLength(3);
      expect(r.pagination).toEqual({
        pages: 1,
        more: true,
        note: "The API's next link points outside https://api.example.com/v1, so apitame did not follow it.",
      });
    }
  });

  it('validates the position from a link like any argument', async () => {
    const { rt, sent } = linked(() => 'https://api.example.com/v1/repositories/1/issues?page=two');
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 3 },
      ),
    );
    expect(sent).toHaveLength(1);
    expect(r.pagination).toMatchObject({ pages: 1, more: true });
    expect(r.pagination!.next).toBeUndefined();
    expect(r.pagination!.note).toMatch(
      /position for the next page is not valid: page: must be integer/,
    );
  });

  it('stops when a link points at the same page again', async () => {
    const { rt, sent } = linked(() => 'https://api.example.com/v1/repos/o/r/issues?page=2');
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 5 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.data).toHaveLength(6);
    expect(r.pagination!.note).toMatch(/same page again/);
  });

  it('follows a next URL in the body the same way', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
    const paths = {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [q('page', 'integer'), q('page_size', 'integer')],
          responses: json({
            type: 'object',
            properties: { count: { type: 'integer' }, next: { type: 'string' }, results: list },
          }),
        },
      },
    };
    const drf = (s: SentRequest, host: string) => {
      const p = query(s);
      const page = Number(p.page ?? 1);
      const size = Number(p.page_size ?? 2);
      const more = page * size < rows.length;
      return reply({
        count: rows.length,
        next: more ? `${host}/v1/items/?page=${page + 1}&page_size=${size}` : null,
        results: rows.slice((page - 1) * size, page * size),
      });
    };
    const ok = fakeApi({ paths, respond: (s) => drf(s, 'https://api.example.com') });
    const r = jsonOf<Paged<{ results: unknown[]; next: string | null }>>(
      await callOperation(ok.rt, 'listItems', { page_size: 2 }, { pages: 5 }),
    );
    expect(r.data.results).toHaveLength(5);
    expect(r.data.next).toBeNull();
    expect(r.pagination).toEqual({ pages: 3, more: false });

    const evil = fakeApi({ paths, respond: (s) => drf(s, 'https://evil.example.net') });
    const e = jsonOf<Paged>(
      await callOperation(evil.rt, 'listItems', { page_size: 2 }, { pages: 5 }),
    );
    expect(evil.sent).toHaveLength(1);
    expect(e.pagination!.note).toMatch(/points outside/);
  });
});

describe('offset paging', () => {
  const paths = {
    '/events': {
      get: {
        operationId: 'listEvents',
        parameters: [q('offset', 'integer'), q('limit', 'integer', { default: 3 })],
        responses: json({
          type: 'object',
          properties: { total: { type: 'integer' }, results: list },
        }),
      },
    },
  };
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: i, text: 't'.repeat(150) }));
  const respond = (s: SentRequest) => {
    const p = query(s);
    const offset = Number(p.offset ?? 0);
    return reply({
      total: rows.length,
      results: rows.slice(offset, offset + Number(p.limit ?? 3)),
    });
  };

  it('advances by the number of items read', async () => {
    const { rt, sent } = fakeApi({ paths, respond });
    const r = jsonOf<Paged<{ results: Array<{ id: number }> }>>(
      await callOperation(rt, 'listEvents', {}, { pages: 5, fields: ['results.id'] }),
    );
    expect(r.data.results.map((e) => e.id)).toEqual(rows.map((e) => e.id));
    expect(sent.map((s) => query(s).offset)).toEqual([undefined, '3', '6']);
    expect(r.pagination).toEqual({ pages: 3, more: false });
  });

  it('cuts inside a page at the budget and continues from the exact offset', async () => {
    const { rt } = fakeApi({ paths, config: { limits: { maxResponseBytes: 1000 } }, respond });
    const r = jsonOf<Paged<{ results: Array<{ id: number }> }>>(
      await callOperation(rt, 'listEvents', { offset: 1 }, { pages: 5 }),
    );
    const ids = r.data.results.map((e) => e.id);
    expect(ids[0]).toBe(1);
    expect(r.pagination).toMatchObject({ more: true, next: { offset: 1 + ids.length } });
    expect(r.pagination!.note).toMatch(/was cut to \d of 3 items/);
  });
});

describe('limits on paging', () => {
  it('caps pages at limits.maxPages and says so', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { maxPages: 2 } },
      respond: (s) => issues(s),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 2 },
        { pages: 9 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.pagination).toEqual({
      pages: 2,
      more: true,
      next: { page: 3 },
      note: '"pages" is capped at 2 (limits.maxPages).',
    });
  });

  it('counts every page against the per-minute call limits', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { maxCallsPerMinute: 3 } },
      respond: (s) => issues(s),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 1 },
        { pages: 5 },
      ),
    );
    expect(sent).toHaveLength(3);
    expect(r.pagination).toMatchObject({ pages: 3, more: true, next: { page: 4 } });
    expect(r.pagination!.note).toMatch(
      /Stopped before page 4\. Rate limit: more than 3 calls per minute/,
    );
    const refused = await callOperation(rt, 'issues/list-for-repo', { owner: 'o', repo: 'r' });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/Rate limit/);
    expect(sent).toHaveLength(3);
  });

  it('counts every page against a tool limit too', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { perTool: { call_operation: 2 } } },
      respond: (s) => issues(s),
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 1 },
        { pages: 5 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.pagination!.note).toMatch(/more than 2 calls per minute to "call_operation"/);
  });

  it('shares one deadline between all pages of a call', async () => {
    let page2: { started: number; aborted?: number } | undefined;
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { limits: { timeoutMs: 1000 } },
      respond: async (s, init) => {
        if (query(s).page !== '2') {
          await new Promise((r) => setTimeout(r, 700));
          return issues(s);
        }
        const seen = { started: Date.now() } as { started: number; aborted?: number };
        page2 = seen;
        return new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () => {
            seen.aborted = Date.now();
            reject(init.signal!.reason as Error);
          });
        });
      },
    });
    const r = jsonOf<Paged<unknown[]>>(
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 3 },
      ),
    );
    expect(sent).toHaveLength(2);
    expect(r.data).toHaveLength(3);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(/limits\.timeoutMs \(1000 ms\) covers every page of a call/);
    // Page 2 only had what was left of the call's 1000 ms, not 1000 ms of its own.
    expect(page2!.aborted! - page2!.started).toBeLessThan(700);
  });
});

describe('secrets and paging', () => {
  it('redacts every page before the budget is applied, and cuts only between items', async () => {
    const secret = `sk_live_${'s'.repeat(300)}`;
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `cus_${String(i + 1).padStart(2, '0')}`,
      note: `key ${secret}`,
    }));
    const { rt } = fakeApi({
      paths: stripePaths,
      config: {
        auth: { type: 'bearer', token: '${STRIPE_KEY}' },
        limits: { maxResponseBytes: 1000 },
      },
      env: { STRIPE_KEY: secret },
      respond: (s) => stripe(s, rows),
    });
    const res = await callOperation(rt, 'GetCustomers', { limit: 4 }, { pages: 5 });
    const text = textOf(res);
    expect(text).not.toContain('sssssssssssssssssssssssssssssss');
    const r = JSON.parse(text) as Paged<{ data: Array<{ id: string; note: string }> }>;
    // Measured after redaction, all 12 items fit; measured before, not even 3 would.
    expect(r.data.data.map((c) => c.id)).toEqual(rows.map((c) => c.id));
    expect(r.data.data.every((c) => c.note === 'key [REDACTED]')).toBe(true);
    expect(r.pagination).toEqual({ pages: 3, more: false });
  });
});

describe('pages that are not what the spec says', () => {
  const paths = issuesPaths(false);
  const call = (rt: OpenApiRuntime, pages = 3, per_page = 3) =>
    callOperation(rt, 'issues/list-for-repo', { owner: 'o', repo: 'r', per_page }, { pages });

  it('a first page that is not a list is returned as it is', async () => {
    const { rt, sent } = fakeApi({ paths, respond: () => reply({ message: 'odd', items: 3 }) });
    const r = jsonOf<Paged>(await call(rt));
    expect(sent).toHaveLength(1);
    expect(r.data).toEqual({ message: 'odd', items: 3 });
    expect(r.pagination).toEqual({
      pages: 1,
      note: 'There is no list at the body in this response, so apitame read one page.',
    });
  });

  it('a first page that is not JSON is returned as it is', async () => {
    const { rt, sent } = fakeApi({
      paths,
      respond: () => new Response('plain text', { headers: { 'content-type': 'text/plain' } }),
    });
    const r = jsonOf<Paged>(await call(rt));
    expect(sent).toHaveLength(1);
    expect(r.data).toBe('plain text');
    expect(r.pagination!.note).toMatch(/not a JSON list apitame can page through/);
  });

  it('a following page that is not a list is left out', async () => {
    const { rt, sent } = fakeApi({
      paths,
      respond: (s) => (query(s).page === '2' ? reply({ error: 'gone' }) : issues(s)),
    });
    const r = jsonOf<Paged<unknown[]>>(await call(rt));
    expect(sent).toHaveLength(2);
    expect(r.data).toHaveLength(3);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(/Page 2 has no list at the body/);
  });

  it('a following page that fails to arrive is left out', async () => {
    const { rt, sent } = fakeApi({
      paths,
      respond: (s) => {
        if (query(s).page === '2') throw new TypeError('fetch failed');
        return issues(s);
      },
    });
    const r = jsonOf<Paged<unknown[]>>(await call(rt));
    expect(sent).toHaveLength(2);
    expect(r.data).toHaveLength(3);
    expect(r.pagination).toMatchObject({ pages: 1, more: true, next: { page: 2 } });
    expect(r.pagination!.note).toMatch(/Page 2 failed \(Request failed: fetch failed\)/);
  });

  it('an item larger than the budget falls back to trimming, with no next', async () => {
    const { rt } = fakeApi({
      paths,
      config: { limits: { maxResponseBytes: 1000 } },
      respond: (s) => issues(s, { pad: 2000 }),
    });
    const r = jsonOf<Paged>(await call(rt));
    expect(r.note).toMatch(/truncated/);
    expect(r.pagination).toEqual({
      pages: 1,
      more: true,
      note: 'Not even one item fits in limits.maxResponseBytes (1000 bytes). Select fewer fields.',
    });
  });

  it('items without ids leave a cursor nowhere to continue', async () => {
    const { rt } = fakeApi({
      paths: stripePaths,
      respond: () => reply({ object: 'list', data: [{ name: 'no id' }], has_more: true }),
    });
    const r = jsonOf<Paged>(await callOperation(rt, 'GetCustomers', {}, { pages: 2 }));
    expect(r.pagination).toEqual({
      pages: 1,
      more: true,
      note: 'The last item has no id, so apitame cannot tell where the next page starts.',
    });

    // Cut at the budget, there is no id to continue after either.
    const { rt: cut } = fakeApi({
      paths: stripePaths,
      config: { limits: { maxResponseBytes: 1000 } },
      respond: () =>
        reply({
          object: 'list',
          data: Array.from({ length: 10 }, () => ({ name: 'n'.repeat(150) })),
          has_more: false,
        }),
    });
    const c = jsonOf<Paged<{ data: unknown[] }>>(await callOperation(cut, 'GetCustomers', {}));
    expect(c.data.data.length).toBeLessThan(10);
    expect(c.pagination).toEqual({
      pages: 1,
      more: true,
      note: `Page 1 was cut to ${c.data.data.length} of 10 items to fit limits.maxResponseBytes (1000 bytes), and the last item returned has no id to continue from.`,
    });
  });
});

describe('the pages argument', () => {
  it('is refused for writes, with nothing sent', async () => {
    const { rt, sent } = fakeApi({
      paths: issuesPaths(false),
      config: { mode: 'read-write', writes: { allow: ['*'] } },
    });
    const res = await callOperation(
      rt,
      'issues/create',
      { owner: 'o', repo: 'r', body: {} },
      { pages: 2 },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/"pages" only applies to read operations.*Nothing was sent/);
    expect(sent).toHaveLength(0);
  });

  it('must be a whole number of at least 1', async () => {
    const { rt, sent } = fakeApi({ paths: issuesPaths(false), respond: (s) => issues(s) });
    for (const pages of [0, -1, 1.5, 'two', null, true]) {
      const res = await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r' },
        { pages },
      );
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/"pages" must be a whole number of at least 1/);
    }
    expect(sent).toHaveLength(0);
    const ok = await callOperation(
      rt,
      'issues/list-for-repo',
      { owner: 'o', repo: 'r', per_page: 3 },
      { pages: '2' },
    );
    expect(jsonOf<Paged>(ok).pagination!.pages).toBe(2);
  });

  it('reads one page of an operation apitame cannot page, and says so', async () => {
    const { rt, sent } = fakeApi({
      paths: { '/thing': { get: { operationId: 'getThing', responses: json(list) } } },
      respond: () => reply([{ a: 1 }]),
    });
    const r = jsonOf<Paged>(await callOperation(rt, 'getThing', {}, { pages: 3 }));
    expect(sent).toHaveLength(1);
    expect(r.pagination).toEqual({
      pages: 1,
      note: 'apitame does not know how this operation pages, so it read one page.',
    });
    // Without pages, nothing changes for such operations.
    expect(jsonOf<Paged>(await callOperation(rt, 'getThing', {})).pagination).toBeUndefined();
  });

  it('is offered where an operation pages, and not with limits.maxPages: 1', async () => {
    const paths = issuesPaths(false);
    const on = fakeApi({
      paths,
      config: { tools: [{ name: 'issues', operations: ['issues/list-for-repo'] }] },
    });
    const props = (rt: OpenApiRuntime, name: string) =>
      rt.listTools().find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        unknown
      >;
    expect(props(on.rt, 'issues').pages).toEqual({ type: 'integer', minimum: 1, maximum: 5 });
    expect(props(on.rt, 'call_operation').pages).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
    expect(on.rt.instructions()).toMatch(/"pages" \(up to 5\) reads the following pages/);

    const off = fakeApi({
      paths,
      config: {
        limits: { maxPages: 1 },
        tools: [{ name: 'issues', operations: ['issues/list-for-repo'] }],
      },
    });
    expect(props(off.rt, 'issues').pages).toBeUndefined();
    expect(props(off.rt, 'call_operation').pages).toBeUndefined();
    expect(off.rt.instructions()).not.toMatch(/"pages"/);

    const none = fakeApi({ paths: { '/x': { get: { operationId: 'x', responses: json(list) } } } });
    expect(props(none.rt, 'call_operation').pages).toBeUndefined();
  });

  it("lets an API's own `pages` parameter win in single-operation tools, like `fields`", async () => {
    // A report API whose own `pages` filter has nothing to do with apitame's paging.
    const paths = {
      '/reports': {
        get: {
          operationId: 'listReports',
          parameters: [
            q('pages', 'integer', { description: 'Only reports with this many pages.' }),
            q('page', 'integer'),
            q('per_page', 'integer'),
          ],
          responses: json(list),
        },
      },
    };
    const respond = (s: SentRequest) => {
      const page = Number(query(s).page ?? 1);
      return reply(page <= 3 ? [{ id: page }] : []);
    };
    const single = fakeApi({
      paths,
      config: { tools: [{ name: 'reports', operations: ['listReports'] }] },
      respond,
    });
    const schema = single.rt.listTools().find((t) => t.name === 'reports')!.inputSchema;
    expect(
      (schema.properties as Record<string, { description?: string }>).pages!.description,
    ).toMatch(/Only reports/);
    await single.rt.callTool('reports', { pages: 7, per_page: 1 });
    expect(single.sent.map(query)).toEqual([{ pages: '7', per_page: '1' }]);

    // In a grouped tool and in call_operation, the API's parameter lives in params.
    const grouped = fakeApi({
      paths: { ...paths, '/other': { get: { operationId: 'other', responses: json(list) } } },
      config: { tools: [{ name: 'reports', operations: ['listReports', 'other'] }] },
      respond,
    });
    const r = jsonOf<Paged<unknown[]>>(
      await grouped.rt.callTool('reports', {
        operation: 'listReports',
        params: { pages: 7, per_page: 1 },
        pages: 2,
      }),
    );
    expect(grouped.sent.map(query)).toEqual([
      { pages: '7', per_page: '1' },
      { pages: '7', per_page: '1', page: '2' },
    ]);
    expect(r.pagination).toEqual({ pages: 2, more: true, next: { page: 3 } });
  });

  it('writes one audit entry per page', async () => {
    const t = tempDir();
    try {
      const file = join(t.dir, 'audit.jsonl');
      const { rt } = fakeApi({
        paths: issuesPaths(false),
        config: { audit: { file, include: 'all' } },
        respond: (s) => issues(s),
      });
      await callOperation(
        rt,
        'issues/list-for-repo',
        { owner: 'o', repo: 'r', per_page: 3 },
        { pages: 3 },
      );
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { outcome: string; args: { page?: number } });
      expect(lines.map((l) => [l.outcome, l.args.page])).toEqual([
        ['sent', undefined],
        ['sent', 2],
        ['sent', 3],
      ]);
    } finally {
      t.cleanup();
    }
  });
});

describe('paging against the mock server', () => {
  let mock: MockServer;
  let rt: OpenApiRuntime;
  beforeAll(async () => {
    const dir = join(ROOT, 'examples/github-subset');
    const spec = await loadSpec(GITHUB);
    // Like GitHub: Link headers point to /repositories/{id}/..., and page 3 is the last.
    mock = await startMockServer(extractOperations(spec.doc), {
      handler: (r: RecordedRequest) => {
        if (r.path !== '/repos/octo/hello/issues') return undefined;
        const page = Number(r.query.page ?? 1);
        const per = Number(r.query.per_page ?? 30);
        const all = Array.from({ length: 7 }, (_, i) => ({
          number: i + 1,
          title: `Issue ${i + 1}`,
        }));
        const body = all.slice((page - 1) * per, page * per);
        const next =
          page * per < all.length
            ? { Link: `<${mock.url}/repositories/1/issues?page=${page + 1}>; rel="next"` }
            : undefined;
        return { status: 200, body, ...(next ? { headers: next } : {}) };
      },
    });
    const { config } = await loadConfig(join(dir, 'apitame.config.yaml'));
    rt = await createOpenApiRuntime({
      config,
      configDir: dir,
      spec,
      baseUrlOverride: mock.url,
      env: { GITHUB_TOKEN: 'mock-token' },
    });
  });
  afterAll(() => mock.close());

  it('reads every page of the GitHub example through its grouped tool', async () => {
    const r = jsonOf<Paged<Array<{ number: number }>>>(
      await rt.callTool('issues', {
        operation: 'issues/list-for-repo',
        params: { owner: 'octo', repo: 'hello', per_page: 3 },
        pages: 5,
        fields: ['number'],
      }),
    );
    expect(r.data).toEqual(ISSUES.map((i) => ({ number: i.number })));
    expect(r.pagination).toEqual({ pages: 3, more: false });
    const pages = mock.requests.filter((x) => x.path === '/repos/octo/hello/issues');
    expect(pages.map((x) => x.query.page)).toEqual([undefined, '2', '3']);
    expect(pages.every((x) => x.headers.authorization === 'Bearer mock-token')).toBe(true);
  });

  it('answers sample data for other list operations with one page by default', async () => {
    const r = jsonOf<Paged<unknown[]>>(
      await rt.callTool('pulls', {
        operation: 'pulls/list',
        params: { owner: 'octo', repo: 'hello' },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.pagination).toMatchObject({ pages: 1, more: false });
  });

  it('the generated skill explains pages where an operation pages', async () => {
    const skill = generateOpenApiSkill(rt).find((f) => f.path.endsWith('SKILL.md'))!.content;
    expect(skill).toMatch(/List operations that page take `"pages"` \(up to 5\)/);
    const pets = await createOpenApiRuntime({
      config: await petstoreConfig(),
      configDir: '.',
      spec: await petstore(),
      env: {},
    });
    const petSkill = generateOpenApiSkill(pets).find((f) => f.path.endsWith('SKILL.md'))!.content;
    expect(petSkill).not.toMatch(/"pages"/);
  });

  it('Petstore operations do not page', async () => {
    const pets = await startMockServer(extractOperations((await petstore()).doc));
    try {
      const prt = await createOpenApiRuntime({
        config: await petstoreConfig(),
        configDir: '.',
        spec: await petstore(),
        baseUrlOverride: pets.url,
        env: {},
      });
      const r = jsonOf<Paged>(
        await prt.callTool('call_operation', {
          operationId: 'findPetsByStatus',
          params: { status: 'sold' },
          pages: 2,
        }),
      );
      expect(pets.requests).toHaveLength(1);
      expect(r.pagination!.note).toMatch(/does not know how this operation pages/);
      expect(
        prt
          .listTools()
          .some((t) => 'pages' in ((t.inputSchema.properties ?? {}) as Record<string, unknown>)),
      ).toBe(false);
    } finally {
      await pets.close();
    }
  });
});
