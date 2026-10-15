import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import {
  argumentsOf,
  countFindings,
  diffSpecs,
  FAIL_ON_VALUES,
  type SpecDiff,
} from '../../src/diff/compare.js';
import { Logger } from '../../src/log.js';
import { Redactor } from '../../src/safety/redact.js';
import type { RulesConfig } from '../../src/safety/rules.js';
import { OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import type { LoadedSpec, OpenApiDocument } from '../../src/sources/openapi/load.js';
import { toolListCost } from '../../src/tokens/estimate.js';

type Paths = Record<string, Record<string, unknown>>;

const ok = { '200': { description: 'OK' } };
const idParam = (name = 'orderId') => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
});
const jsonBody = (schema: Record<string, unknown>, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

/** Version 1 of a small shop API. Tests copy it and change what they need. */
function v1(): Paths {
  return {
    '/orders': {
      get: { operationId: 'listOrders', summary: 'List orders', responses: ok },
      post: {
        operationId: 'createOrder',
        summary: 'Create an order',
        requestBody: jsonBody({
          type: 'object',
          required: ['sku'],
          properties: {
            sku: { type: 'string' },
            quantity: { type: 'integer' },
            note: { type: 'string' },
            items: {
              type: 'array',
              items: { type: 'object', properties: { price: { type: 'integer' } } },
            },
          },
        }),
        responses: ok,
      },
    },
    '/orders/{orderId}': {
      get: { operationId: 'getOrder', parameters: [idParam()], responses: ok },
      delete: { operationId: 'cancelOrder', parameters: [idParam()], responses: ok },
    },
    '/orders/{orderId}/refunds': {
      post: {
        operationId: 'createRefund',
        parameters: [idParam()],
        requestBody: jsonBody({ type: 'object', properties: { amount: { type: 'integer' } } }),
        responses: ok,
      },
    },
    '/reports/export': {
      get: { operationId: 'exportReport', responses: ok },
    },
  };
}

const spec = (paths: Paths, extra: Partial<OpenApiDocument> = {}): LoadedSpec => ({
  doc: { openapi: '3.0.3', info: { title: 'Shop', version: '1' }, paths, ...extra },
  location: '/specs/openapi.yaml',
  isUrl: false,
});

const config = (overrides: Partial<ConfigInput> = {}) =>
  parseConfig({ name: 'shop', source: { type: 'openapi', spec: './openapi.yaml' }, ...overrides });

/** A read-write config like the ones people write: wildcards, a confirm, rules and groups. */
const shopConfig = (overrides: Partial<ConfigInput> = {}) =>
  config({
    mode: 'read-write',
    tools: [
      {
        name: 'orders',
        operations: ['listOrders', 'getOrder', 'createOrder', 'cancelOrder', 'createRefund'],
      },
      { name: 'reports', operations: ['exportReport'] },
    ],
    writes: {
      allow: ['create*', 'cancelOrder'],
      confirm: ['createRefund'],
      rules: { createRefund: { amount: { max: 5000 } } },
    },
    ...overrides,
  });

function diff(before: Paths, after: Paths, cfg = shopConfig()): SpecDiff {
  return diffSpecs(cfg, spec(before), spec(after));
}

const ids = (refs: Array<{ id: string }>) => refs.map((r) => r.id);

afterEach(() => vi.restoreAllMocks());

describe('apitame diff: operations', () => {
  it('finds nothing when the spec did not change', () => {
    const d = diff(v1(), v1());
    expect(d.operations).toEqual({ before: 6, after: 6 });
    for (const category of FAIL_ON_VALUES) expect(countFindings(d, category)).toBe(0);
    expect(d.tokens.after).toBe(d.tokens.before);
    expect(d.tokens.tools).toEqual([]);
  });

  it('lists added operations and the tool they land in', () => {
    const after = v1();
    after['/invoices'] = { get: { operationId: 'listInvoices', responses: ok } };
    after['/customers'] = { get: { operationId: 'listCustomers', responses: ok } };
    const cfg = shopConfig({
      tools: [{ name: 'customers', operations: ['listCustomers'] }],
    });
    const d = diff(v1(), after, cfg);
    expect(d.added).toEqual([
      {
        id: 'listInvoices',
        method: 'GET',
        path: '/invoices',
        access: 'read',
        tools: ['call_operation'],
        confirm: false,
      },
      // Named in a group before it existed: it lands there.
      expect.objectContaining({ id: 'listCustomers', tools: ['customers'] }),
    ]);
    expect(d.removed).toEqual([]);
    expect(d.renamed).toEqual([]);
  });

  it('lists removed operations and the tool they were in', () => {
    const after = v1();
    delete after['/reports/export'];
    const d = diff(v1(), after);
    expect(d.removed).toEqual([
      expect.objectContaining({ id: 'exportReport', access: 'read', tools: ['reports'] }),
    ]);
    expect(d.added).toEqual([]);
  });

  it('says why an operation is out of reach', () => {
    const after = v1();
    after['/orders/{orderId}/ship'] = {
      post: { operationId: 'shipOrder', parameters: [idParam()], responses: ok },
    };
    expect(diff(v1(), after).added[0]).toMatchObject({ tools: [], blocked: 'not in writes.allow' });
    expect(diff(v1(), after, config()).added[0]).toMatchObject({ blocked: 'read-only mode' });
    const noTail = shopConfig({ writes: { allow: ['*'] }, longTail: { enabled: false } });
    expect(diff(v1(), after, noTail).added[0]).toMatchObject({
      blocked: 'in no tool, and longTail is off',
    });
  });

  it('pairs a new id on the same method and path as a rename, ignoring path parameter names', () => {
    const after = v1();
    delete after['/orders/{orderId}/refunds'];
    after['/orders/{id}/refunds'] = {
      post: { ...v1()['/orders/{orderId}/refunds']!.post!, operationId: 'createOrderRefund' },
    };
    const d = diff(v1(), after);
    expect(d.renamed).toEqual([
      {
        kind: 'id',
        before: expect.objectContaining({ id: 'createRefund', tools: ['orders'], confirm: true }),
        after: expect.objectContaining({
          id: 'createOrderRefund',
          path: '/orders/{id}/refunds',
          tools: ['call_operation'],
          confirm: false,
        }),
      },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('pairs the same id on a new method or path as a rename of the endpoint', () => {
    const after = v1();
    delete after['/reports/export'];
    after['/v2/reports/export'] = { get: { operationId: 'exportReport', responses: ok } };
    const d = diff(v1(), after);
    expect(d.renamed).toEqual([
      {
        kind: 'endpoint',
        before: expect.objectContaining({ id: 'exportReport', path: '/reports/export' }),
        after: expect.objectContaining({ id: 'exportReport', path: '/v2/reports/export' }),
      },
    ]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('does not guess when several operations share the endpoint', () => {
    const before: Paths = { '/a/{x}': { get: { operationId: 'one', responses: ok } } };
    const after: Paths = {
      '/a/{y}': { get: { operationId: 'two', responses: ok } },
      '/a/{z}': { get: { operationId: 'three', responses: ok } },
    };
    const d = diff(before, after, config());
    expect(d.renamed).toEqual([]);
    expect(ids(d.removed)).toEqual(['one']);
    expect(ids(d.added)).toEqual(['two', 'three']);
  });
});

describe('apitame diff: access levels', () => {
  it('reports a read that became a write, and what that means for the agent', () => {
    const after = v1();
    after['/reports/export'] = { post: { operationId: 'exportReport', responses: ok } };
    const d = diff(
      v1(),
      after,
      config({ tools: [{ name: 'reports', operations: ['exportReport'] }] }),
    );
    expect(d.accessChanges).toEqual([
      {
        before: expect.objectContaining({ id: 'exportReport', access: 'read', tools: ['reports'] }),
        after: expect.objectContaining({
          id: 'exportReport',
          method: 'POST',
          access: 'write',
          tools: [],
          blocked: 'read-only mode',
        }),
        escalation: true,
      },
    ]);
  });

  it('reports a write that became destructive, and the reverse', () => {
    const destructive = v1();
    destructive['/orders/{orderId}/refunds']!.post = {
      ...destructive['/orders/{orderId}/refunds']!.post!,
      'x-apitame-access': 'destructive',
    };
    const up = diff(v1(), destructive);
    expect(up.accessChanges).toEqual([
      {
        before: expect.objectContaining({ id: 'createRefund', access: 'write' }),
        after: expect.objectContaining({ id: 'createRefund', access: 'destructive' }),
        escalation: true,
      },
    ]);

    // cancelOrder (DELETE) stops asking for approval when it becomes a plain write.
    const softer = v1();
    softer['/orders/{orderId}']!.delete = {
      ...softer['/orders/{orderId}']!.delete!,
      'x-apitame-access': 'write',
    };
    const down = diff(v1(), softer);
    expect(down.accessChanges).toEqual([
      {
        before: expect.objectContaining({
          id: 'cancelOrder',
          access: 'destructive',
          confirm: true,
        }),
        after: expect.objectContaining({ id: 'cancelOrder', access: 'write', confirm: false }),
        escalation: false,
      },
    ]);
  });

  it('reports a write that the spec now marks as a read', () => {
    const after = v1();
    after['/orders']!.post = { ...after['/orders']!.post!, 'x-apitame-access': 'read' };
    const d = diff(v1(), after, config());
    expect(d.accessChanges).toEqual([
      {
        before: expect.objectContaining({
          id: 'createOrder',
          access: 'write',
          blocked: 'read-only mode',
        }),
        after: expect.objectContaining({
          id: 'createOrder',
          access: 'read',
          tools: ['call_operation'],
        }),
        escalation: false,
      },
    ]);
  });
});

describe('apitame diff: new writes the config allows without naming them', () => {
  it('lists an added write that a writes.allow wildcard lets through, with its confirmation', () => {
    const after = v1();
    after['/refunds/bulk'] = { post: { operationId: 'createBulkRefund', responses: ok } };
    after['/coupons'] = { post: { operationId: 'createCoupon', responses: ok } };
    const d = diff(v1(), after);
    expect(d.newWrites).toEqual([
      expect.objectContaining({
        id: 'createBulkRefund',
        access: 'destructive',
        tools: ['call_operation'],
        confirm: true,
        via: 'writes.allow',
        allowedBy: ['create*'],
        why: 'added',
      }),
      expect.objectContaining({
        id: 'createCoupon',
        access: 'write',
        confirm: false,
        why: 'added',
      }),
    ]);
  });

  it('leaves out writes listed by exact id, writes it does not allow and read-only mode', () => {
    const after = v1();
    after['/coupons'] = { post: { operationId: 'createCoupon', responses: ok } };
    after['/orders/{orderId}/ship'] = {
      post: { operationId: 'shipOrder', parameters: [idParam()], responses: ok },
    };
    const listed = shopConfig({ writes: { allow: ['create*', 'createCoupon'] } });
    expect(diff(v1(), after, listed).newWrites).toEqual([]);
    expect(ids(diff(v1(), after).newWrites)).toEqual(['createCoupon']);
    expect(diff(v1(), after, shopConfig({ mode: 'read-only', writes: {} })).newWrites).toEqual([]);
  });

  it('counts a renamed write: nothing the config said about the old id follows it', () => {
    const after = v1();
    delete after['/orders/{orderId}/refunds'];
    after['/orders/{orderId}/refunds'] = {
      post: { ...v1()['/orders/{orderId}/refunds']!.post!, operationId: 'createOrderRefund' },
    };
    const d = diff(v1(), after);
    expect(d.newWrites).toEqual([
      expect.objectContaining({
        id: 'createOrderRefund',
        confirm: false,
        why: 'renamed',
        before: expect.objectContaining({ id: 'createRefund', confirm: true }),
      }),
    ]);
  });

  it('counts an operation that was a read and is now an allowed write', () => {
    const before: Paths = { '/exports': { get: { operationId: 'createExport', responses: ok } } };
    const after: Paths = { '/exports': { post: { operationId: 'createExport', responses: ok } } };
    const d = diff(before, after);
    expect(d.newWrites).toEqual([
      expect.objectContaining({
        id: 'createExport',
        why: 'changed',
        before: expect.objectContaining({ access: 'read' }),
      }),
    ]);
    // An allowed write that stays one is not new.
    expect(diff(after, after).newWrites).toEqual([]);
  });

  it('counts a POST that runs as a read through a treatAsRead pattern, even in read-only mode', () => {
    const after = v1();
    after['/orders/search'] = { post: { operationId: 'searchAndArchive', responses: ok } };
    const d = diff(v1(), after, config({ writes: { treatAsRead: ['search*'] } }));
    expect(d.newWrites).toEqual([
      expect.objectContaining({
        id: 'searchAndArchive',
        access: 'read',
        via: 'writes.treatAsRead',
        allowedBy: ['search*'],
        tools: ['call_operation'],
      }),
    ]);
    const exact = config({ writes: { treatAsRead: ['search*', 'searchAndArchive'] } });
    expect(diff(v1(), after, exact).newWrites).toEqual([]);
  });

  it('counts a POST that the spec marks as a read', () => {
    const after = v1();
    after['/orders/purge'] = {
      post: { operationId: 'purgeOrders', 'x-apitame-access': 'read', responses: ok },
    };
    expect(diff(v1(), after, config()).newWrites).toEqual([
      expect.objectContaining({ id: 'purgeOrders', via: 'x-apitame-access', allowedBy: [] }),
    ]);
  });
});

describe('apitame diff: config references', () => {
  it('reports names and patterns that matched an operation before and match none now', () => {
    const after = v1();
    delete after['/orders/{orderId}/refunds'];
    after['/orders/{orderId}/refunds'] = {
      post: { ...v1()['/orders/{orderId}/refunds']!.post!, operationId: 'refundOrder' },
    };
    delete after['/orders/{orderId}']!.delete;
    const cfg = shopConfig({
      writes: {
        allow: ['create*', 'cancelOrder', 'cancel*', 'typoOrder'],
        confirm: ['createRefund'],
        treatAsRead: ['exportReport'],
        destructive: ['createRefund'],
        rules: { createRefund: { amount: { max: 5000 } } },
      },
      http: {
        oauth: {
          issuer: 'https://id.example.com',
          resource: 'https://mcp.example.com',
          scopes: ['mcp'],
          permissions: { byScope: { support: { writes: ['cancelOrder'] } } },
        },
      },
    });
    const d = diff(v1(), after, cfg);
    expect(d.staleConfig).toEqual([
      { where: 'writes.allow', ref: 'cancelOrder', matched: ['cancelOrder'], renamedTo: [] },
      { where: 'writes.allow', ref: 'cancel*', matched: ['cancelOrder'], renamedTo: [] },
      {
        where: 'writes.confirm',
        ref: 'createRefund',
        matched: ['createRefund'],
        renamedTo: ['refundOrder'],
      },
      {
        where: 'writes.destructive',
        ref: 'createRefund',
        matched: ['createRefund'],
        renamedTo: ['refundOrder'],
      },
      {
        where: 'writes.rules',
        ref: 'createRefund',
        matched: ['createRefund'],
        renamedTo: ['refundOrder'],
      },
      { where: 'tools.orders', ref: 'cancelOrder', matched: ['cancelOrder'], renamedTo: [] },
      {
        where: 'tools.orders',
        ref: 'createRefund',
        matched: ['createRefund'],
        renamedTo: ['refundOrder'],
      },
      {
        where: 'http.oauth.permissions.byScope.support.writes',
        ref: 'cancelOrder',
        matched: ['cancelOrder'],
        renamedTo: [],
      },
    ]);
    // A pattern that still matches something, and a typo that never matched, are not reported.
    expect(d.staleConfig.map((s) => s.ref)).not.toContain('create*');
    expect(d.staleConfig.map((s) => s.ref)).not.toContain('typoOrder');
  });
});

describe('apitame diff: arguments of allowed writes', () => {
  const createOrder = (paths: Paths) => paths['/orders']!.post as Record<string, unknown>;
  const bodyOf = (paths: Paths) =>
    (
      createOrder(paths).requestBody as {
        content: Record<string, { schema: Record<string, unknown> }>;
      }
    ).content['application/json']!.schema as {
      required?: string[];
      properties: Record<string, unknown>;
      additionalProperties?: unknown;
    };
  const rulesConfig = (rules: RulesConfig) =>
    shopConfig({ writes: { allow: ['create*', 'cancelOrder'], rules } });

  it('lists added, newly required and removed arguments', () => {
    const after = v1();
    const body = bodyOf(after);
    body.properties.currency = { type: 'string' };
    body.properties.gift = { type: 'object', properties: { message: { type: 'string' } } };
    body.required = ['sku', 'currency', 'note'];
    delete body.properties.items;
    const d = diff(v1(), after);
    expect(d.writeChanges).toEqual([
      expect.objectContaining({
        id: 'createOrder',
        tools: ['orders'],
        added: [
          { path: 'body.currency', required: true },
          { path: 'body.gift', required: false },
        ],
        nowRequired: ['body.note'],
        removed: ['body.items'],
        rules: [],
      }),
    ]);
  });

  it('says which rules lose their field', () => {
    const after = v1();
    delete bodyOf(after).properties.quantity;
    const items = bodyOf(after).properties.items as {
      items: { properties: Record<string, unknown> };
    };
    delete items.items.properties.price;
    const cfg = rulesConfig({
      createOrder: { 'body.quantity': { max: 10 }, 'body.items[].price': { max: 100 } },
    });
    const d = diff(v1(), after, cfg);
    expect(d.writeChanges).toEqual([
      expect.objectContaining({
        id: 'createOrder',
        removed: ['body.quantity', 'body.items[].price'],
        rules: [
          'writes.rules.createOrder.body.quantity: there is no field "quantity" in body',
          'writes.rules.createOrder.body.items[].price: there is no field "price" in body.items[]',
        ],
      }),
    ]);
  });

  it('flags a rule on a removed field when the body takes other fields too', () => {
    const before = v1();
    bodyOf(before).additionalProperties = { type: 'integer' };
    const after = v1();
    bodyOf(after).additionalProperties = { type: 'integer' };
    delete bodyOf(after).properties.quantity;
    const d = diff(before, after, rulesConfig({ createOrder: { 'body.quantity': { max: 10 } } }));
    expect(d.writeChanges[0]!.rules).toEqual([
      'writes.rules.createOrder.body.quantity: the new spec removes body.quantity.',
    ]);
  });

  it('flags a rule whose field changed type, even with the same names', () => {
    const after = v1();
    bodyOf(after).properties.quantity = { type: 'boolean' };
    const d = diff(v1(), after, rulesConfig({ createOrder: { 'body.quantity': { max: 10 } } }));
    expect(d.writeChanges).toEqual([
      expect.objectContaining({
        id: 'createOrder',
        added: [],
        removed: [],
        nowRequired: [],
        rules: [
          'writes.rules.createOrder.body.quantity: min and max compare numbers, but the field is boolean',
        ],
      }),
    ]);
  });

  it('only looks at writes the agent can call', () => {
    const after = v1();
    delete bodyOf(after).properties.quantity;
    expect(diff(v1(), after, config()).writeChanges).toEqual([]);
    expect(diff(v1(), after).writeChanges).toHaveLength(1);
  });
});

describe('apitame diff: argument paths', () => {
  it('uses the paths of writes.rules, and alternatives do not make a field required', () => {
    const args = argumentsOf({
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'string' },
        body: {
          type: 'object',
          allOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'string' } } }],
          anyOf: [
            { type: 'object', required: ['b'], properties: { b: { type: 'string' } } },
            { type: 'object', properties: { c: { type: 'string' } } },
          ],
          properties: {
            lines: {
              type: 'array',
              items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } },
            },
          },
        },
      },
    });
    expect(Object.fromEntries(args)).toEqual({
      id: true,
      body: true,
      'body.lines': false,
      'body.lines[].sku': true,
      'body.a': true,
      'body.b': false,
      'body.c': false,
    });
  });
});

describe('apitame diff: tokens and base URL', () => {
  it('estimates the tool list before and after exactly as inspect does', () => {
    const after = v1();
    after['/orders/{orderId}/notes'] = {
      get: { operationId: 'listOrderNotes', parameters: [idParam()], responses: ok },
    };
    delete after['/reports/export'];
    const cfg = shopConfig({
      tools: [
        { name: 'orders', operations: ['listOrders', 'getOrder', 'listOrderNotes'] },
        { name: 'reports', operations: ['exportReport'] },
      ],
    });
    const d = diff(v1(), after, cfg);

    const cost = (paths: Paths) => {
      const redactor = new Redactor();
      const rt = new OpenApiRuntime(cfg, spec(paths), {
        configDir: '.',
        env: {},
        redactor,
        logger: new Logger(redactor, 'silent'),
      });
      return toolListCost(rt.listTools(), rt.instructions());
    };
    const was = cost(v1());
    const now = cost(after);
    expect(d.tokens.before).toBe(was.total);
    expect(d.tokens.after).toBe(now.total);
    expect(d.tokens.after).toBeGreaterThan(0);
    const tokensOf = (c: typeof was, name: string) => c.tools.find((t) => t.name === name)!.tokens;
    expect(d.tokens.tools).toEqual([
      { name: 'orders', before: tokensOf(was, 'orders'), after: tokensOf(now, 'orders') },
      { name: 'reports', before: tokensOf(was, 'reports'), after: null },
    ]);
    expect(tokensOf(now, 'orders')).toBeGreaterThan(tokensOf(was, 'orders'));
  });

  it('reports a new server URL unless the config sets source.baseUrl', () => {
    const before = spec(v1(), { servers: [{ url: 'https://api.shop.test/v1' }] });
    const after = spec(v1(), { servers: [{ url: 'https://api.other.test/v1' }] });
    expect(diffSpecs(shopConfig(), before, after).baseUrl).toEqual({
      before: 'https://api.shop.test/v1',
      after: 'https://api.other.test/v1',
    });
    const pinned = shopConfig({
      source: { type: 'openapi', spec: './openapi.yaml', baseUrl: '${SHOP_URL}' },
    });
    expect(diffSpecs(pinned, before, after).baseUrl).toBeNull();
    expect(diffSpecs(shopConfig(), before, before).baseUrl).toBeNull();
  });

  it('needs no credentials or environment and never calls the API', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cfg = shopConfig({
      source: {
        type: 'openapi',
        spec: './openapi.yaml',
        baseUrl: '${SHOP_URL}',
        headers: { 'X-Tenant': '${SHOP_TENANT}' },
      },
      auth: { type: 'bearer', token: '${SHOP_TOKEN}' },
      audit: { file: './audit.jsonl' },
    });
    const after = v1();
    after['/coupons'] = { post: { operationId: 'createCoupon', responses: ok } };
    expect(ids(diffSpecs(cfg, spec(v1()), spec(after)).newWrites)).toEqual(['createCoupon']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('apitame diff: --fail-on categories', () => {
  it('counts each category on its own, and any counts them all', () => {
    const after = v1();
    after['/invoices'] = { get: { operationId: 'listInvoices', responses: ok } };
    const d = diff(v1(), after);
    expect(FAIL_ON_VALUES).toEqual([
      'new-writes',
      'access-changes',
      'added',
      'removed',
      'renamed',
      'stale-config',
      'write-changes',
      'base-url',
      'any',
    ]);
    const counts = Object.fromEntries(FAIL_ON_VALUES.map((c) => [c, countFindings(d, c)]));
    expect(counts).toEqual({
      'new-writes': 0,
      'access-changes': 0,
      added: 1,
      removed: 0,
      renamed: 0,
      'stale-config': 0,
      'write-changes': 0,
      'base-url': 0,
      any: 1,
    });
  });
});
