import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { continuation, nextLink, applyPosition, positionAfter } from '../../src/server/pages.js';
import { loadSpec, type OpenApiDocument } from '../../src/sources/openapi/load.js';
import { extractOperations, type Operation } from '../../src/sources/openapi/operations.js';
import type { Paging } from '../../src/sources/openapi/pagination.js';
import { GITHUB, PETSTORE } from '../helpers.js';

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
const list = (item: unknown = { type: 'object', properties: { id: { type: 'string' } } }) => ({
  type: 'array',
  items: item,
});
const linkHeader = { Link: { schema: { type: 'string' } } };

function ops(paths: Record<string, unknown>, opts = {}): Map<string, Operation> {
  const doc = { openapi: '3.0.3', info: { title: 't', version: '1' }, paths } as OpenApiDocument;
  return new Map(extractOperations(doc, opts).map((o) => [o.id, o]));
}

/** Operations shaped like the real Stripe and GitHub ones (parameters and envelopes as published). */
const REAL = {
  // Stripe: GET /v1/customers (CustomerResourceCustomerList).
  '/v1/customers': {
    get: {
      operationId: 'GetCustomers',
      parameters: [
        { name: 'created', in: 'query', style: 'deepObject', explode: true, schema: {} },
        q('email'),
        q('ending_before'),
        { name: 'expand', in: 'query', style: 'deepObject', schema: { type: 'array' } },
        q('limit', 'integer'),
        q('starting_after'),
      ],
      responses: json({
        type: 'object',
        required: ['data', 'has_more', 'object', 'url'],
        properties: {
          data: list(),
          has_more: { type: 'boolean' },
          object: { type: 'string', enum: ['list'] },
          url: { type: 'string' },
        },
      }),
    },
    post: {
      operationId: 'PostCustomers',
      parameters: [q('starting_after')],
      responses: json({
        type: 'object',
        properties: { data: list(), has_more: { type: 'boolean' } },
      }),
    },
  },
  // Stripe: GET /v1/customers/search (SearchResult).
  '/v1/customers/search': {
    get: {
      operationId: 'GetCustomersSearch',
      parameters: [
        q('expand', 'array'),
        q('limit', 'integer'),
        q('page'),
        { ...q('query'), required: true },
      ],
      responses: json({
        type: 'object',
        properties: {
          data: list(),
          has_more: { type: 'boolean' },
          next_page: { type: 'string', nullable: true },
          object: { type: 'string', enum: ['search_result'] },
          total_count: { type: 'integer' },
          url: { type: 'string' },
        },
      }),
    },
  },
  // GitHub: GET /repos/{owner}/{repo}/issues, with the Link header and `since` as a filter.
  '/repos/{owner}/{repo}/issues': {
    get: {
      operationId: 'issues/list-for-repo',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        q('state', 'string', { enum: ['open', 'closed', 'all'], default: 'open' }),
        q('since', 'string', { format: 'date-time' }),
        q('per_page', 'integer', { default: 30 }),
        q('page', 'integer', { default: 1 }),
      ],
      responses: json(list(), linkHeader),
    },
  },
  // GitHub: GET /users pages with `since` (a user id) alone.
  '/users': {
    get: {
      operationId: 'users/list',
      parameters: [q('since', 'integer'), q('per_page', 'integer', { default: 30 })],
      responses: json(list(), linkHeader),
    },
  },
  // GitHub: cursors in before/after, given in the Link header.
  '/orgs/{org}/projectsV2': {
    get: {
      operationId: 'projects/list-for-org',
      parameters: [
        { name: 'org', in: 'path', required: true, schema: { type: 'string' } },
        q('q'),
        q('before'),
        q('after'),
        q('per_page', 'integer', { default: 30 }),
      ],
      responses: json(list(), linkHeader),
    },
  },
  // GitHub: search declares no Link header; page and per_page, items in an envelope.
  '/search/repositories': {
    get: {
      operationId: 'search/repos',
      parameters: [
        { ...q('q'), required: true },
        q('per_page', 'integer', { default: 30 }),
        q('page', 'integer', { default: 1 }),
      ],
      responses: json({
        type: 'object',
        properties: {
          total_count: { type: 'integer' },
          incomplete_results: { type: 'boolean' },
          items: list(),
        },
      }),
    },
  },
  // GitHub: one object with lists inside is not a list endpoint.
  '/repos/{owner}/{repo}/commits/{ref}': {
    get: {
      operationId: 'repos/get-commit',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
        q('page', 'integer'),
        q('per_page', 'integer'),
      ],
      responses: json({
        type: 'object',
        properties: { sha: { type: 'string' }, parents: list(), files: list() },
      }),
    },
  },
  // GitHub: stargazers are one list or another (anyOf).
  '/repos/{owner}/{repo}/stargazers': {
    get: {
      operationId: 'activity/list-stargazers-for-repo',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        q('per_page', 'integer'),
        q('page', 'integer'),
      ],
      responses: json({ anyOf: [list(), list({ type: 'object' })] }),
    },
  },
  // GitHub: a Link header, but nothing to say where a page starts.
  '/repos/{owner}/{repo}/git/matching-refs/{ref}': {
    get: {
      operationId: 'git/list-matching-refs',
      parameters: [
        { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: json(list(), linkHeader),
    },
  },
};

describe('detecting how an operation pages', () => {
  const byId = ops(REAL);

  it('Stripe lists page with starting_after, ending_before and has_more', () => {
    expect(byId.get('GetCustomers')!.paging).toEqual({
      kind: 'cursor',
      items: 'data',
      param: { name: 'starting_after', key: 'starting_after', type: 'string' },
      before: { name: 'ending_before', key: 'ending_before', type: 'string' },
      more: 'has_more',
    });
  });

  it('Stripe search pages with next_page in the body, passed back as page', () => {
    expect(byId.get('GetCustomersSearch')!.paging).toEqual({
      kind: 'token',
      items: 'data',
      param: { name: 'page', key: 'page', type: 'string' },
      field: 'next_page',
    });
  });

  it('GitHub lists with a Link header take page from it, and `since` stays a filter', () => {
    expect(byId.get('issues/list-for-repo')!.paging).toEqual({
      kind: 'link',
      items: '',
      params: [{ name: 'page', key: 'page', type: 'integer' }],
    });
    expect(byId.get('users/list')!.paging).toEqual({
      kind: 'link',
      items: '',
      params: [{ name: 'since', key: 'since', type: 'integer' }],
    });
    expect(byId.get('projects/list-for-org')!.paging).toMatchObject({
      kind: 'link',
      params: [{ name: 'after' }, { name: 'before' }],
    });
  });

  it('GitHub search without a Link header pages by number, inside its envelope', () => {
    expect(byId.get('search/repos')!.paging).toEqual({
      kind: 'page',
      items: 'items',
      param: { name: 'page', key: 'page', type: 'integer' },
      first: 1,
      size: { name: 'per_page', key: 'per_page', type: 'integer' },
      sizeDefault: 30,
    });
    expect(byId.get('activity/list-stargazers-for-repo')!.paging).toMatchObject({
      kind: 'page',
      items: '',
    });
  });

  it('leaves out what it cannot page safely', () => {
    // A single object with several lists, a Link header with no position, and every write.
    expect(byId.get('repos/get-commit')!.paging).toBeUndefined();
    expect(byId.get('git/list-matching-refs')!.paging).toBeUndefined();
    expect(byId.get('PostCustomers')!.paging).toBeUndefined();
    // A write treated as a read is still not a GET: it is never repeated.
    expect(
      ops(REAL, { treatAsRead: ['PostCustomers'] }).get('PostCustomers')!.paging,
    ).toBeUndefined();
    // A GET marked as a write is not paged either.
    expect(
      ops(REAL, { destructive: ['GetCustomers'] }).get('GetCustomers')!.paging,
    ).toBeUndefined();
  });

  it('offset and limit, page and limit, and next links in the body', () => {
    const byId = ops({
      '/a': {
        get: {
          operationId: 'offsetList',
          parameters: [q('offset', 'integer'), q('limit', 'integer', { default: 20 })],
          responses: json({
            type: 'object',
            properties: { results: list(), total: { type: 'integer' } },
          }),
        },
      },
      '/b': {
        get: {
          operationId: 'pageLimit',
          parameters: [q('page', 'integer', { minimum: 0 }), q('limit', 'integer')],
          responses: json(list()),
        },
      },
      '/c': {
        get: {
          operationId: 'drf',
          parameters: [q('page', 'integer'), q('page_size', 'integer')],
          responses: json({
            type: 'object',
            properties: {
              count: { type: 'integer' },
              next: { type: 'string', format: 'uri', nullable: true },
              results: list(),
            },
          }),
        },
      },
      '/d': {
        get: {
          operationId: 'googleStyle',
          parameters: [q('pageToken'), q('maxResults', 'integer')],
          responses: json({
            type: 'object',
            properties: { nextPageToken: { type: 'string' }, files: list() },
          }),
        },
      },
      '/e': {
        get: {
          operationId: 'slackStyle',
          parameters: [q('cursor'), q('limit', 'integer')],
          responses: json({
            type: 'object',
            properties: {
              members: list(),
              response_metadata: {
                type: 'object',
                properties: { next_cursor: { type: 'string' } },
              },
            },
          }),
        },
      },
      '/f': {
        get: {
          operationId: 'pageAlone',
          parameters: [q('page', 'integer')],
          responses: json(list()),
        },
      },
    });
    expect(byId.get('offsetList')!.paging).toMatchObject({
      kind: 'offset',
      items: 'results',
      param: { name: 'offset' },
      first: 0,
      size: { name: 'limit' },
      sizeDefault: 20,
    });
    // Zero-based page numbers start at the minimum when there is no default.
    expect(byId.get('pageLimit')!.paging).toMatchObject({
      kind: 'page',
      first: 0,
      size: { name: 'limit' },
    });
    expect(byId.get('drf')!.paging).toMatchObject({
      kind: 'link',
      field: 'next',
      params: [{ name: 'page' }],
    });
    expect(byId.get('googleStyle')!.paging).toMatchObject({
      kind: 'token',
      field: 'nextPageToken',
      param: { name: 'pageToken' },
      items: 'files',
    });
    expect(byId.get('slackStyle')!.paging).toMatchObject({
      kind: 'token',
      field: 'response_metadata.next_cursor',
      param: { name: 'cursor' },
    });
    // A page number without a page size is not enough to know where the data ends.
    expect(byId.get('pageAlone')!.paging).toBeUndefined();
  });

  it('finds paging in the GitHub example and none in Petstore', async () => {
    const github = extractOperations((await loadSpec(GITHUB)).doc);
    const paged = github.filter((o) => o.paging).map((o) => o.id);
    expect(paged).toContain('issues/list-for-repo');
    expect(paged).toContain('search/repos');
    expect(paged).not.toContain('issues/get');
    expect(github.filter((o) => o.paging).every((o) => o.method === 'get')).toBe(true);
    const petstore = extractOperations((await loadSpec(PETSTORE)).doc);
    expect(petstore.filter((o) => o.paging)).toEqual([]);
  });
});

describe('Link headers', () => {
  it('finds rel="next" among other relations, quoted or not', () => {
    const header =
      '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", <https://api.github.com/repositories/1/issues?page=3>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"';
    expect(nextLink(header)).toBe('https://api.github.com/repositories/1/issues?page=3');
    expect(nextLink('<https://x.test/a?page=2>; title="x"; rel=next')).toBe(
      'https://x.test/a?page=2',
    );
    expect(nextLink('<https://x.test/a?page=2>; rel="next last"')).toBe('https://x.test/a?page=2');
    expect(nextLink('<https://x.test/a?page=1>; rel="prev"')).toBeUndefined();
    expect(nextLink('<https://x.test/a?page=1>; rel="nextish"')).toBeUndefined();
    expect(nextLink(undefined)).toBeUndefined();
  });
});

describe('Link header parsing', () => {
  it('is not fooled by links and relations inside quoted values', () => {
    const header =
      '<https://x.test/a?page=2>; title="x, <https://x.test/a?page=999>; rel=next ; y"; rel="prev"';
    expect(nextLink(header)).toBeUndefined();
    expect(
      nextLink(
        '<https://x.test/a?page=1>; title="a \\" rel=next"; rel="prev", <https://x.test/a?page=3>; rel="next"',
      ),
    ).toBe('https://x.test/a?page=3');
    // Only the first rel parameter of a link counts.
    expect(nextLink('<https://x.test/a?page=2>; rel="prev"; rel="next"')).toBeUndefined();
  });

  it('takes linear time on hostile headers', () => {
    const started = Date.now();
    expect(nextLink('<'.repeat(200_000))).toBeUndefined();
    expect(nextLink(`${'<a>; rel="prev", '.repeat(40_000)}<b>; rel=next`)).toBe('b');
    expect(nextLink(`<a>; title="${'<'.repeat(200_000)}`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('where the next page starts', () => {
  const base = new URL('https://api.example.com/v1');
  const url = new URL('https://api.example.com/v1/repos/o/r/issues');
  const link: Paging = {
    kind: 'link',
    items: '',
    params: [
      { name: 'page', key: 'page', type: 'integer' },
      { name: 'after', key: 'after', type: 'string' },
    ],
  };
  const at = (header: string) =>
    continuation(
      link,
      { args: { owner: 'o', page: 1 }, body: [], items: [], link: header, url },
      base,
    );

  it('takes only the paging parameters of a next link, typed like the parameter', () => {
    expect(
      at('<https://api.example.com/v1/repositories/1/issues?page=2&state=closed>; rel="next"'),
    ).toEqual({
      more: true,
      position: { page: 2 },
    });
    expect(at('</v1/x?after=Y3Vy&per_page=100>; rel="next"')).toEqual({
      more: true,
      position: { after: 'Y3Vy' },
    });
    expect(at('<https://api.example.com/v1/x?page=1>; rel="prev"')).toEqual({ more: false });
  });

  it('refuses next links on another origin or outside the base path', () => {
    for (const header of [
      '<https://evil.example.net/v1/repos/o/r/issues?page=2>; rel="next"',
      '<http://api.example.com/v1/repos/o/r/issues?page=2>; rel="next"',
      '<https://api.example.com:8443/v1/issues?page=2>; rel="next"',
      '<https://api.example.com/v10/issues?page=2>; rel="next"',
      '<https://api.example.com/other?page=2>; rel="next"',
      '<//evil.example.net/v1/issues?page=2>; rel="next"',
    ]) {
      const c = at(header);
      expect(c.more).toBe(true);
      expect(c.position).toBeUndefined();
      expect(c.problem).toMatch(/points outside https:\/\/api\.example\.com\/v1/);
    }
  });

  it('refuses a next link with no position it can use', () => {
    const c = at('<https://api.example.com/v1/x?$skiptoken=abc>; rel="next"');
    expect(c).toMatchObject({ more: true });
    expect(c.problem).toMatch(/sets none of page, after/);
  });

  it('replaces only what the link sets, and the other half of a cursor pair', () => {
    const pair: Paging = {
      kind: 'link',
      items: '',
      params: [
        { name: 'page', key: 'page', type: 'integer' },
        { name: 'after', key: 'after', type: 'string' },
        { name: 'before', key: 'before', type: 'string' },
      ],
    };
    // A position the link leaves out stays as the agent set it.
    expect(
      applyPosition(pair, { owner: 'o', page: 1, before: 'x', per_page: 5 }, { page: 2 }),
    ).toEqual({ owner: 'o', page: 2, before: 'x', per_page: 5 });
    // Going forward drops the cursor that pointed backwards, and the other way round.
    expect(applyPosition(pair, { owner: 'o', before: 'x' }, { after: 'Y' })).toEqual({
      owner: 'o',
      after: 'Y',
    });
    expect(applyPosition(pair, { after: 'x' }, { before: 'Z' })).toEqual({ before: 'Z' });
    // Other styles replace every parameter they own.
    const cursor: Paging = {
      kind: 'cursor',
      items: 'data',
      param: { name: 'starting_after', key: 'starting_after', type: 'string' },
      before: { name: 'ending_before', key: 'ending_before', type: 'string' },
      more: 'has_more',
    };
    expect(
      applyPosition(cursor, { ending_before: 'a', limit: 3 }, { starting_after: 'b' }),
    ).toEqual({ limit: 3, starting_after: 'b' });
  });

  it('a cursor continues after the last item, or before the first one going back', () => {
    const cursor: Paging = {
      kind: 'cursor',
      items: 'data',
      param: { name: 'starting_after', key: 'starting_after', type: 'string' },
      before: { name: 'ending_before', key: 'ending_before', type: 'string' },
      more: 'has_more',
    };
    const items = [{ id: 'cus_1' }, { id: 'cus_2' }, { id: 'cus_3' }];
    const body = { data: items, has_more: true };
    expect(continuation(cursor, { args: {}, body, items, url }, base)).toEqual({
      more: true,
      position: { starting_after: 'cus_3' },
    });
    expect(
      continuation(cursor, { args: { ending_before: 'cus_9' }, body, items, url }, base),
    ).toEqual({
      more: true,
      position: { ending_before: 'cus_1' },
      backwards: true,
    });
    expect(
      continuation(cursor, { args: {}, body: { ...body, has_more: false }, items, url }, base),
    ).toEqual({
      more: false,
    });
    expect(positionAfter(cursor, {}, items, 2)).toEqual({ starting_after: 'cus_2' });
  });
});

describe('limits.maxPages', () => {
  it('defaults to 5 and accepts 1 to 20', () => {
    const base = { name: 'x', source: { type: 'openapi', spec: 'x.yaml' } };
    expect(parseConfig(base).limits.maxPages).toBe(5);
    expect(parseConfig({ ...base, limits: { maxPages: 1 } }).limits.maxPages).toBe(1);
    expect(() => parseConfig({ ...base, limits: { maxPages: 0 } })).toThrow(/maxPages/);
    expect(() => parseConfig({ ...base, limits: { maxPages: 21 } })).toThrow(/maxPages/);
  });
});

// Opt-in: the full Stripe and GitHub descriptions are too large to keep in the repository.
// Download spec3.json (github.com/stripe/openapi) and api.github.com.json (github.com/github/rest-api-description)
// into one folder as stripe.json and github.json, and set APITAME_TEST_BIG_SPECS to it.
const BIG = process.env.APITAME_TEST_BIG_SPECS;
describe.skipIf(!BIG || !existsSync(join(BIG, 'stripe.json')))(
  'detection on the full specs',
  () => {
    const count = (list: Operation[]) => {
      const out: Record<string, number> = {};
      for (const o of list)
        out[o.paging?.kind ?? 'none'] = (out[o.paging?.kind ?? 'none'] ?? 0) + 1;
      return out;
    };

    it('Stripe: every list with starting_after and has_more, and every search', async () => {
      const all = extractOperations((await loadSpec(join(BIG!, 'stripe.json'))).doc);
      const reads = all.filter((o) => o.method === 'get');
      const lists = reads.filter((o) => o.params.some((p) => p.name === 'starting_after'));
      expect(lists.length).toBeGreaterThan(100);
      expect(lists.every((o) => o.paging?.kind === 'cursor')).toBe(true);
      const searches = reads.filter((o) => o.path.endsWith('/search'));
      expect(searches.length).toBeGreaterThan(5);
      expect(searches.every((o) => o.paging?.kind === 'token')).toBe(true);
      expect(all.filter((o) => o.method !== 'get' && o.paging)).toEqual([]);
    });

    it('GitHub: Link headers and page numbers', async () => {
      const all = extractOperations((await loadSpec(join(BIG!, 'github.json'))).doc);
      const reads = all.filter((o) => o.method === 'get');
      const counts = count(reads);
      expect(counts.link).toBeGreaterThan(150);
      expect(counts.page).toBeGreaterThan(40);
      const issues = reads.find((o) => o.id === 'issues/list-for-repo')!;
      expect(issues.paging).toMatchObject({ kind: 'link', params: [{ name: 'page' }] });
      expect(reads.find((o) => o.id === 'search/repos')!.paging).toMatchObject({
        kind: 'page',
        items: 'items',
      });
      expect(all.filter((o) => o.method !== 'get' && o.paging)).toEqual([]);
    });
  },
);
