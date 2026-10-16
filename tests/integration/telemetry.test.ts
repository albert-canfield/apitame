import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { diag, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { Logger } from '../../src/log.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { JwtVerifier, type OAuthOptions } from '../../src/server/oauth.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import { serveHttp } from '../../src/server/transport.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import { hashSubject, readTelemetrySettings } from '../../src/telemetry/config.js';
import type { Telemetry } from '../../src/telemetry/index.js';
import { createTelemetry, sessionHash } from '../../src/telemetry/otel.js';
import type { Runtime } from '../../src/types.js';
import { createSqliteShop, fakeApi, tempDir, type SentRequest } from '../helpers.js';
import { claimsFor, FakeAuthServer, makeKey, signers, signJwt } from '../oauth-fixtures.js';

// Secrets in every place a careless exporter could pick them up: the API credentials, the
// arguments the agent sends and the response the API returns.
const AUTH_SECRET = 'fake-key-auth-token-5f1c2d9a';
const ARG_SECRET = 'fake-key-argument-7e3b1f20';
const RESPONSE_SECRET = 'fake-key-response-c0ffee42';
const TRACESTATE_SECRET = 'fake-key-tracestate-3b9d1e70';
const BAGGAGE_SECRET = 'fake-key-baggage-9c2e4a18';
const SECRETS = [AUTH_SECRET, ARG_SECRET, RESPONSE_SECRET];

const SEMCONV_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

const ok = (schema: unknown = { type: 'object' }) => ({
  '200': { description: 'ok', content: { 'application/json': { schema } } },
});
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const body = {
  required: true,
  content: {
    'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
  },
};
const q = (name: string, type = 'string') => ({ name, in: 'query', schema: { type } });

const PATHS = {
  '/items/{id}': {
    get: { operationId: 'getItem', parameters: [id], responses: ok() },
    put: { operationId: 'updateItem', parameters: [id], requestBody: body, responses: ok() },
    delete: { operationId: 'deleteItem', parameters: [id], responses: ok() },
  },
  '/items': { post: { operationId: 'createItem', requestBody: body, responses: ok() } },
  '/customers': {
    get: {
      operationId: 'GetCustomers',
      parameters: [q('ending_before'), q('limit', 'integer'), q('starting_after')],
      responses: ok({
        type: 'object',
        properties: {
          data: { type: 'array', items: { type: 'object' } },
          has_more: { type: 'boolean' },
          object: { type: 'string' },
          url: { type: 'string' },
        },
      }),
    },
  },
  '/broken': { get: { operationId: 'getBroken', responses: ok() } },
};

const CUSTOMERS = Array.from({ length: 12 }, (_, i) => ({
  id: `cus_${String(i + 1).padStart(2, '0')}`,
}));

const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function respond(s: SentRequest): Response {
  const url = new URL(s.url);
  if (url.pathname.endsWith('/broken')) return reply({ error: 'boom' }, 500);
  if (url.pathname.endsWith('/customers')) {
    const limit = Number(url.searchParams.get('limit') ?? 10);
    const after = url.searchParams.get('starting_after');
    const start = after ? CUSTOMERS.findIndex((c) => c.id === after) + 1 : 0;
    return reply({
      object: 'list',
      data: CUSTOMERS.slice(start, start + limit),
      has_more: start + limit < CUSTOMERS.length,
      url: '/v1/customers',
    });
  }
  // The API echoes the arguments and a secret of its own, and the credentials it got.
  return reply({ path: url.pathname, secret: RESPONSE_SECRET, auth: s.headers.Authorization });
}

function api(config: Record<string, unknown> = {}) {
  return fakeApi({
    paths: PATHS,
    env: { API_TOKEN: AUTH_SECRET },
    respond,
    config: {
      mode: 'read-write',
      auth: { type: 'bearer', token: '${API_TOKEN}' },
      writes: { allow: ['createItem', 'deleteItem'] },
      tools: [
        {
          name: 'items',
          description: 'Items',
          operations: ['getItem', 'createItem', 'deleteItem'],
        },
        { name: 'customers', description: 'Customers', operations: ['GetCustomers'] },
        { name: 'broken', description: 'Always fails', operations: ['getBroken'] },
      ],
      ...config,
    },
  }).rt;
}

const started: Telemetry[] = [];
afterEach(async () => {
  for (const t of started.splice(0)) await t.shutdown();
});

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

/** Telemetry with in-memory exporters, exactly as `serve` builds it otherwise. */
function otel(
  env: Record<string, string> = {},
  transport: 'stdio' | 'http' = 'stdio',
  redactor = new Redactor(),
) {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3_600_000,
  });
  const logs: string[] = [];
  const telemetry = createTelemetry(
    readTelemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9', ...env }),
    {
      transport,
      logger: new Logger(redactor, 'debug', (l) => logs.push(l)),
      redactor,
      server: { name: 'shop', source: 'openapi' },
      spanExporter,
      metricReader,
    },
  );
  started.push(telemetry);
  return {
    telemetry,
    logs,
    spans: async (): Promise<ReadableSpan[]> => {
      await telemetry.flush();
      return spanExporter.getFinishedSpans();
    },
    metrics: async (): Promise<MetricData[]> => {
      await telemetry.flush();
      const last = metricExporter.getMetrics().at(-1);
      return last?.scopeMetrics.flatMap((s) => s.metrics) ?? [];
    },
  };
}

async function connect(rt: Runtime, telemetry: Telemetry, elicit?: 'accept' | 'decline') {
  const server = createMcpServer(rt, { telemetry });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'telemetry-test', version: '1.0.0' },
    elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (elicit) {
    client.setRequestHandler('elicitation/create', async () =>
      elicit === 'accept'
        ? { action: 'accept', content: { approve: true } }
        : { action: 'decline' },
    );
  }
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, version: server.getNegotiatedProtocolVersion() };
}

/** Everything a span or metric carries, as one string, to search for secrets. */
const exported = (spans: ReadableSpan[], metrics: MetricData[] = []) =>
  JSON.stringify({
    spans: spans.map((s) => ({
      name: s.name,
      attributes: s.attributes,
      events: s.events,
      links: s.links,
      status: s.status,
      resource: s.resource.attributes,
    })),
    metrics,
  });

const base = (tool: string, version: string | undefined) => ({
  'mcp.method.name': 'tools/call',
  'gen_ai.operation.name': 'execute_tool',
  'gen_ai.tool.name': tool,
  'network.transport': 'pipe',
  'mcp.protocol.version': version,
  'jsonrpc.request.id': expect.stringMatching(/^\d+$/),
});

describe('telemetry: one span per tool call, with the audit outcome', () => {
  it('a read that is sent: exact attributes, and no secret anywhere', async () => {
    const o = otel();
    const { client, version } = await connect(api(), o.telemetry);
    const res = await client.callTool({
      name: 'items',
      arguments: { operation: 'getItem', params: { id: ARG_SECRET } },
    });
    expect(res.isError).toBeFalsy();
    const [span, ...rest] = await o.spans();
    expect(rest).toEqual([]);
    expect(span!.name).toBe('tools/call items');
    expect(span!.kind).toBe(SpanKind.SERVER);
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.attributes).toEqual({
      ...base('items', version),
      'apitame.outcome': 'sent',
      'apitame.access': 'read',
      'apitame.operation': 'getItem',
      'apitame.upstream.status_code': 200,
      'apitame.upstream.requests': 1,
    });
    expect(span!.resource.attributes).toMatchObject({
      'service.name': 'apitame',
      'apitame.server.name': 'shop',
      'apitame.source.type': 'openapi',
    });
    expect(span!.instrumentationScope.name).toBe('apitame');
    const text = exported([span!], await o.metrics());
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // The secret really was in the call: the API saw it and answered with the others.
    expect(JSON.stringify(res)).toContain(ARG_SECRET);
    await client.close();
  });

  it('a write the server does not allow: blocked, as an error', async () => {
    const o = otel();
    const { client, version } = await connect(api(), o.telemetry);
    const res = await client.callTool({
      name: 'call_operation',
      arguments: { operationId: 'updateItem', params: { id: ARG_SECRET, body: { name: 'x' } } },
    });
    expect(res.isError).toBe(true);
    const [span] = await o.spans();
    expect(span!.name).toBe('tools/call call_operation');
    expect(span!.attributes).toEqual({
      ...base('call_operation', version),
      'apitame.outcome': 'blocked',
      'apitame.access': 'write',
      'apitame.operation': 'updateItem',
      'error.type': 'tool_error',
    });
    // The status message is the outcome, never the refusal text (which may quote arguments).
    expect(span!.status).toEqual({ code: SpanStatusCode.ERROR, message: 'blocked' });
    await client.close();
  });

  it('a destructive write without elicitation: confirmation requested, not an error', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    const res = await client.callTool({
      name: 'items',
      arguments: { operation: 'deleteItem', params: { id: ARG_SECRET } },
    });
    expect(JSON.stringify(res)).toMatch(/CONFIRMATION REQUIRED/);
    const [span] = await o.spans();
    expect(span!.attributes).toMatchObject({
      'apitame.outcome': 'confirmation-requested',
      'apitame.access': 'destructive',
      'apitame.operation': 'deleteItem',
    });
    expect(span!.attributes['error.type']).toBeUndefined();
    expect(span!.attributes['apitame.upstream.requests']).toBeUndefined();
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    await client.close();
  });

  it('a destructive write the human declines, and one the human approves', async () => {
    const declined = otel();
    const a = await connect(api(), declined.telemetry, 'decline');
    await a.client.callTool({
      name: 'items',
      arguments: { operation: 'deleteItem', params: { id: 'one' } },
    });
    const [no] = await declined.spans();
    expect(no!.attributes).toMatchObject({
      'apitame.outcome': 'declined',
      'error.type': 'tool_error',
    });
    await a.client.close();

    const approved = otel();
    const b = await connect(api(), approved.telemetry, 'accept');
    await b.client.callTool({
      name: 'items',
      arguments: { operation: 'deleteItem', params: { id: 'one' } },
    });
    const [yes] = await approved.spans();
    expect(yes!.attributes).toMatchObject({
      'apitame.outcome': 'sent',
      'apitame.access': 'destructive',
      'apitame.upstream.status_code': 200,
    });
    await b.client.close();
  });

  it('a dry run', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({
      name: 'items',
      arguments: { operation: 'createItem', params: { body: { name: ARG_SECRET } }, dryRun: true },
    });
    const [span] = await o.spans();
    expect(span!.attributes).toMatchObject({
      'apitame.outcome': 'dry-run',
      'apitame.access': 'write',
      'apitame.operation': 'createItem',
    });
    expect(exported([span!])).not.toContain(ARG_SECRET);
    await client.close();
  });

  it('calls over the per-minute limits: rate-limited', async () => {
    const o = otel();
    const { client } = await connect(
      api({ limits: { maxCallsPerMinute: 1, maxWritesPerMinute: 0 } }),
      o.telemetry,
    );
    await client.callTool({ name: 'broken', arguments: {} });
    const res = await client.callTool({ name: 'broken', arguments: {} });
    expect(JSON.stringify(res)).toMatch(/Rate limit/);
    const [, limited] = await o.spans();
    // Refused before the runtime looked at the operation: the tool still names it.
    expect(limited!.attributes).toMatchObject({
      'gen_ai.tool.name': 'broken',
      'apitame.outcome': 'rate-limited',
      'apitame.access': 'read',
      'apitame.operation': 'getBroken',
      'error.type': 'tool_error',
    });

    const w = otel();
    const writes = await connect(api({ limits: { maxWritesPerMinute: 1 } }), w.telemetry);
    for (let i = 0; i < 2; i++) {
      await writes.client.callTool({
        name: 'items',
        arguments: { operation: 'createItem', params: { body: { name: 'n' } } },
      });
    }
    const [first, second] = await w.spans();
    expect(first!.attributes['apitame.outcome']).toBe('sent');
    expect(second!.attributes).toMatchObject({
      'apitame.outcome': 'rate-limited',
      'apitame.access': 'write',
      'apitame.operation': 'createItem',
    });
    await client.close();
    await writes.client.close();
  });

  it('an API error: the upstream status', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({ name: 'broken', arguments: {} });
    const [span] = await o.spans();
    expect(span!.attributes).toMatchObject({
      'apitame.outcome': 'error',
      'apitame.upstream.status_code': 500,
      'apitame.upstream.requests': 1,
      'error.type': 'tool_error',
    });
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await client.close();
  });

  it('a paged call: one span, with the number of requests', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    const res = await client.callTool({ name: 'customers', arguments: { limit: 2, pages: 3 } });
    expect(JSON.stringify(res)).toContain('cus_06');
    const spans = await o.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes).toMatchObject({
      'apitame.outcome': 'sent',
      'apitame.operation': 'GetCustomers',
      'apitame.upstream.status_code': 200,
      'apitame.upstream.requests': 3,
    });
    await client.close();
  });

  it('a call apitame answers itself, and a tool name the server does not have', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({ name: 'search_operations', arguments: { query: 'items' } });
    await client.callTool({ name: `nope-${ARG_SECRET}`, arguments: {} });
    const [search, unknown] = await o.spans();
    expect(search!.attributes).toMatchObject({ 'apitame.outcome': 'ok', 'apitame.access': 'read' });
    expect(search!.attributes['apitame.upstream.requests']).toBeUndefined();
    // A made-up name comes from the client unchecked: it is not exported.
    expect(unknown!.name).toBe('tools/call');
    expect(unknown!.attributes['gen_ai.tool.name']).toBeUndefined();
    expect(unknown!.attributes).toMatchObject({
      'apitame.outcome': 'error',
      'error.type': 'tool_error',
    });
    expect(exported([unknown!], await o.metrics())).not.toContain(ARG_SECRET);
    await client.close();
  });
});

describe('telemetry: SQL sources', () => {
  const t = tempDir('apitame-otel-sql-');
  const db = join(t.dir, 'shop.db');
  beforeAll(() => createSqliteShop(db));
  afterAll(() => t.cleanup());

  it('records sent, refused and rate-limited queries, never the SQL', async () => {
    const config = parseConfig({
      name: 'shop',
      source: { type: 'sqlite', path: db },
      limits: { maxCallsPerMinute: 4 },
      sql: {
        queries: [
          {
            name: 'order_total',
            description: 'One order',
            sql: 'SELECT total FROM orders WHERE id = :id',
            params: { id: { type: 'integer' } },
          },
        ],
      },
    });
    const rt = new SqlRuntime(config, new SqliteDriver(db), new Redactor());
    const o = otel();
    const { client } = await connect(rt, o.telemetry);
    await client.callTool({ name: 'query', arguments: { sql: `SELECT '${ARG_SECRET}' AS s` } });
    await client.callTool({ name: 'query', arguments: { sql: 'DELETE FROM orders' } });
    await client.callTool({ name: 'order_total', arguments: { id: 1 } });
    await client.callTool({ name: 'list_tables', arguments: {} });
    await client.callTool({ name: 'order_total', arguments: { id: 2 } });
    const [sent, refused, named, tables, limited] = await o.spans();
    expect(sent!.attributes).toMatchObject({
      'gen_ai.tool.name': 'query',
      'apitame.outcome': 'sent',
      'apitame.access': 'read',
      'apitame.upstream.requests': 1,
    });
    expect(sent!.attributes['apitame.operation']).toBeUndefined();
    expect(refused!.attributes).toMatchObject({
      'apitame.outcome': 'refused',
      'error.type': 'tool_error',
    });
    expect(named!.attributes).toMatchObject({
      'apitame.outcome': 'sent',
      'apitame.operation': 'order_total',
    });
    expect(tables!.attributes).toMatchObject({ 'apitame.outcome': 'ok', 'apitame.access': 'read' });
    expect(limited!.attributes).toMatchObject({
      'apitame.outcome': 'rate-limited',
      'apitame.operation': 'order_total',
      'error.type': 'tool_error',
    });
    const text = exported([sent!, refused!, named!, tables!], await o.metrics());
    expect(text).not.toContain(ARG_SECRET);
    expect(text).not.toMatch(/SELECT|DELETE/);
    await client.close();
    await rt.close();
  });
});

describe('telemetry: metrics', () => {
  it('counts calls by tool, access and outcome, and records durations with the semconv buckets', async () => {
    const o = otel();
    const { client, version } = await connect(api(), o.telemetry);
    await client.callTool({
      name: 'items',
      arguments: { operation: 'getItem', params: { id: 'a' } },
    });
    await client.callTool({
      name: 'items',
      arguments: { operation: 'getItem', params: { id: 'b' } },
    });
    await client.callTool({ name: 'broken', arguments: {} });
    const metrics = await o.metrics();
    const calls = metrics.find((m) => m.descriptor.name === 'apitame.tool.calls')!;
    expect(calls.descriptor.unit).toBe('{call}');
    expect(calls.dataPointType).toBe(DataPointType.SUM);
    const points = calls.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value }));
    expect(points).toEqual(
      expect.arrayContaining([
        {
          attributes: {
            'gen_ai.tool.name': 'items',
            'apitame.access': 'read',
            'apitame.outcome': 'sent',
          },
          value: 2,
        },
        {
          attributes: {
            'gen_ai.tool.name': 'broken',
            'apitame.access': 'read',
            'apitame.outcome': 'error',
          },
          value: 1,
        },
      ]),
    );
    expect(points).toHaveLength(2);

    const duration = metrics.find((m) => m.descriptor.name === 'mcp.server.operation.duration')!;
    expect(duration.descriptor.unit).toBe('s');
    expect(duration.dataPointType).toBe(DataPointType.HISTOGRAM);
    const attrs = duration.dataPoints.map((p) => p.attributes);
    expect(attrs).toEqual(
      expect.arrayContaining([
        {
          'mcp.method.name': 'tools/call',
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'items',
          'network.transport': 'pipe',
          'mcp.protocol.version': version,
        },
        {
          'mcp.method.name': 'tools/call',
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'broken',
          'network.transport': 'pipe',
          'mcp.protocol.version': version,
          'error.type': 'tool_error',
        },
      ]),
    );
    const histogram = duration.dataPoints[0]!.value as { buckets: { boundaries: number[] } };
    expect(histogram.buckets.boundaries).toEqual(SEMCONV_BUCKETS);
    await client.close();
  });
});

describe('telemetry: trace context', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';

  it('continues the trace a client sends in params._meta, even when it is marked not sampled', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({
      name: 'broken',
      arguments: {},
      _meta: { traceparent: `00-${TRACE}-${PARENT}-00` },
    });
    const [span] = await o.spans();
    expect(span!.spanContext().traceId).toBe(TRACE);
    expect(span!.parentSpanContext?.spanId).toBe(PARENT);
    expect(span!.parentSpanContext?.isRemote).toBe(true);
    await client.close();
  });

  it('starts a new trace for an invalid traceparent, and with OTEL_PROPAGATORS=none', async () => {
    for (const [env, traceparent] of [
      [{}, `00-${TRACE.toUpperCase()}-${PARENT}-01`],
      [{ OTEL_PROPAGATORS: 'none' }, `00-${TRACE}-${PARENT}-01`],
    ] as const) {
      const o = otel(env);
      const { client } = await connect(api(), o.telemetry);
      await client.callTool({ name: 'broken', arguments: {}, _meta: { traceparent } });
      const [span] = await o.spans();
      expect(span!.spanContext().traceId).not.toBe(TRACE);
      expect(span!.parentSpanContext).toBeUndefined();
      await client.close();
    }
  });

  it('reads neither tracestate nor baggage from params._meta', async () => {
    const o = otel();
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({
      name: 'broken',
      arguments: {},
      _meta: {
        traceparent: `00-${TRACE}-${PARENT}-01`,
        tracestate: `vendor=${TRACESTATE_SECRET}`,
        baggage: `user=${BAGGAGE_SECRET}`,
      },
    });
    const [span] = await o.spans();
    expect(span!.spanContext().traceId).toBe(TRACE);
    expect(span!.spanContext().traceState).toBeUndefined();
    expect(span!.parentSpanContext?.traceState).toBeUndefined();
    const text = exported([span!], await o.metrics());
    expect(text).not.toContain(TRACESTATE_SECRET);
    expect(text).not.toContain(BAGGAGE_SECRET);
    await client.close();
  });

  it('with traceidratio, a client trace id neither hides a call nor forces it in', async () => {
    const o = otel({ OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.5' });
    const { client } = await connect(api(), o.telemetry);
    // TraceIdRatioBasedSampler never samples the first id at 0.5 and always samples the second.
    const hide = 'ffffffff' + '0'.repeat(23) + '1';
    const force = '0'.repeat(31) + '1';
    for (const traceId of [hide, force]) {
      for (let i = 0; i < 60; i++) {
        await client.callTool({
          name: 'broken',
          arguments: {},
          _meta: { traceparent: `00-${traceId}-${PARENT}-01` },
        });
      }
    }
    const spans = await o.spans();
    for (const traceId of [hide, force]) {
      const n = spans.filter((sp) => sp.spanContext().traceId === traceId).length;
      // About 30 of 60 each, decided on the server.
      expect(n, traceId).toBeGreaterThan(10);
      expect(n, traceId).toBeLessThan(50);
    }
    // Metrics count every call, sampled or not.
    const calls = (await o.metrics()).find((m) => m.descriptor.name === 'apitame.tool.calls')!;
    expect(calls.dataPoints[0]!.value).toBe(120);
    await client.close();
  });

  it('follows the incoming sampled flag only with a parentbased sampler', async () => {
    const o = otel({ OTEL_TRACES_SAMPLER: 'parentbased_always_on' });
    const { client } = await connect(api(), o.telemetry);
    await client.callTool({
      name: 'broken',
      arguments: {},
      _meta: { traceparent: `00-${TRACE}-${PARENT}-00` },
    });
    await client.callTool({
      name: 'broken',
      arguments: {},
      _meta: { traceparent: `00-${TRACE}-${PARENT}-01` },
    });
    const spans = await o.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.parentSpanContext?.spanId).toBe(PARENT);
    // Metrics count every call, sampled or not.
    const calls = (await o.metrics()).find((m) => m.descriptor.name === 'apitame.tool.calls')!;
    expect(calls.dataPoints[0]!.value).toBe(2);
    await client.close();
  });
});

describe('telemetry with protocol 2026-07-28', () => {
  it('records both rounds of an approval, with the protocol version and the client trace', async () => {
    const o = otel({}, 'http');
    const rt = api();
    const http = await serveHttp(() => createMcpServer(rt, { telemetry: o.telemetry }), {
      host: '127.0.0.1',
      port: 0,
      logger: new Logger(new Redactor(), 'silent'),
    });
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
    const client = new Client(
      { name: 'modern-telemetry', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { approve: true },
    }));
    const TRACE = '5b8efff798038103d269b633813fc60c';
    try {
      await client.connect(new StreamableHTTPClientTransport(url));
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const res = await client.callTool({
        name: 'items',
        arguments: { operation: 'deleteItem', params: { id: ARG_SECRET } },
        _meta: { traceparent: `00-${TRACE}-eee19b7ec3c1b174-01` },
      });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
      await stop(http);
    }
    const spans = await o.spans();
    expect(spans.map((sp) => sp.attributes['apitame.outcome'])).toEqual([
      'confirmation-requested',
      'sent',
    ]);
    for (const span of spans) {
      expect(span.attributes).toMatchObject({
        'gen_ai.tool.name': 'items',
        'apitame.operation': 'deleteItem',
        'apitame.access': 'destructive',
        'mcp.protocol.version': '2026-07-28',
        'network.transport': 'tcp',
      });
      expect(span.spanContext().traceId).toBe(TRACE);
    }
    expect(exported(spans)).not.toContain(ARG_SECRET);
  });
});

describe('telemetry over HTTP with OAuth: caller identity, sessions and the traceparent header', () => {
  const RESOURCE = 'https://mcp.example.com/mcp';
  const SUBJECT = 'alice@example.com';
  const SUBJECT_KEY = 'fake-key-subject-hmac-0123456789';
  const TRACE = '0af7651916cd43dd8448eb211c80319c';
  const GATEWAY = 'b7ad6b7169203331';
  let as: FakeAuthServer;
  let options: OAuthOptions;
  const key = makeKey('rsa', 'rsa-otel');

  beforeAll(async () => {
    as = await FakeAuthServer.start();
    as.publish(key);
    options = { issuer: as.issuer, resource: RESOURCE, scopes: ['mcp:tools'], audiences: [] };
  });
  afterAll(() => as.close());

  const token = () =>
    signJwt(
      { alg: 'RS256', kid: 'rsa-otel', typ: 'at+jwt' },
      claimsFor(as.issuer, RESOURCE, { sub: SUBJECT, client_id: 'triage-bot' }),
      signers.rs(key.privateKey),
    );

  async function serve(telemetry: Telemetry, sessions = false) {
    const rt = api();
    const http = await serveHttp(() => createMcpServer(rt, { telemetry }), {
      host: '127.0.0.1',
      port: 0,
      logger: new Logger(new Redactor(), 'silent'),
      sessions,
      oauth: { verifier: new JwtVerifier(options), options, name: 'shop' },
    });
    const { port } = http.address() as AddressInfo;
    return { http, url: `http://127.0.0.1:${port}/mcp` };
  }

  const HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
  };
  const call = (
    url: string,
    headers: Record<string, string> = {},
    meta?: unknown,
    id: string | number = 7,
  ) =>
    fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, Authorization: `Bearer ${token()}`, ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'broken', arguments: {}, ...(meta ? { _meta: meta } : {}) },
      }),
    }).then((r) => r.text());

  it('records the client, leaves the subject out by default, and continues the header trace', async () => {
    const o = otel({}, 'http');
    const { http, url } = await serve(o.telemetry);
    try {
      await call(url, { traceparent: `00-${TRACE}-${GATEWAY}-01` });
    } finally {
      await stop(http);
    }
    const [span] = await o.spans();
    expect(span!.attributes).toMatchObject({
      'network.transport': 'tcp',
      'network.protocol.name': 'http',
      'mcp.protocol.version': '2025-11-25',
      'jsonrpc.request.id': '7',
      'apitame.caller.client': 'triage-bot',
    });
    expect(span!.attributes['user.id']).toBeUndefined();
    expect(span!.attributes['user.hash']).toBeUndefined();
    expect(span!.attributes['mcp.session.id']).toBeUndefined();
    expect(span!.spanContext().traceId).toBe(TRACE);
    expect(span!.parentSpanContext?.spanId).toBe(GATEWAY);
    expect(exported([span!], await o.metrics())).not.toContain(SUBJECT);
  });

  it('prefers params._meta over the header, and links the header context', async () => {
    const o = otel({}, 'http');
    const { http, url } = await serve(o.telemetry);
    const META_TRACE = '11111111111111111111111111111111';
    try {
      await call(
        url,
        {
          traceparent: `00-${TRACE}-${GATEWAY}-01`,
          tracestate: `vendor=${TRACESTATE_SECRET}`,
          baggage: `user=${BAGGAGE_SECRET}`,
        },
        {
          traceparent: `00-${META_TRACE}-2222222222222222-01`,
          tracestate: `vendor=${TRACESTATE_SECRET}`,
          baggage: `user=${BAGGAGE_SECRET}`,
        },
      );
    } finally {
      await stop(http);
    }
    const [span] = await o.spans();
    expect(span!.spanContext().traceId).toBe(META_TRACE);
    expect(span!.links.map((l) => l.context.spanId)).toEqual([GATEWAY]);
    // Neither tracestate nor baggage is read, from the header or from params._meta.
    expect(span!.spanContext().traceState).toBeUndefined();
    expect(span!.parentSpanContext?.traceState).toBeUndefined();
    expect(span!.links[0]!.context.traceState).toBeUndefined();
    const text = exported([span!], await o.metrics());
    expect(text).not.toContain(TRACESTATE_SECRET);
    expect(text).not.toContain(BAGGAGE_SECRET);
  });

  it('exports the subject hashed with APITAME_OTEL_SUBJECT=hash, or as it is with plain, never in metrics', async () => {
    const hashed = otel(
      { APITAME_OTEL_SUBJECT: 'hash', APITAME_OTEL_SUBJECT_KEY: SUBJECT_KEY },
      'http',
    );
    const a = await serve(hashed.telemetry);
    try {
      await call(a.url);
    } finally {
      await stop(a.http);
    }
    const [h] = await hashed.spans();
    expect(h!.attributes['user.hash']).toBe(hashSubject(SUBJECT_KEY, SUBJECT));
    expect(h!.attributes['user.id']).toBeUndefined();
    const text = exported([h!], await hashed.metrics());
    expect(text).not.toContain(SUBJECT);
    expect(text).not.toContain(SUBJECT_KEY);

    const plain = otel({ APITAME_OTEL_SUBJECT: 'plain' }, 'http');
    const b = await serve(plain.telemetry);
    try {
      await call(b.url);
    } finally {
      await stop(b.http);
    }
    const [p] = await plain.spans();
    expect(p!.attributes['user.id']).toBe(SUBJECT);
    const metrics = JSON.stringify(await plain.metrics());
    expect(metrics).not.toContain(SUBJECT);
    expect(metrics).not.toContain('triage-bot');
  });

  it('records the session id with --sessions', async () => {
    const o = otel({}, 'http');
    const { http, url } = await serve(o.telemetry, true);
    let session: string | null | undefined;
    try {
      const init = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Bearer ${token()}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'raw', version: '1' },
          },
        }),
      });
      session = init.headers.get('mcp-session-id');
      await init.text();
      expect(session).toBeTruthy();
      await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': session! },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }).then((r) => r.text());
      await call(url, { 'Mcp-Session-Id': session! });
      const [span] = await o.spans();
      const exportedId = span!.attributes['mcp.session.id'] as string;
      // A hash of the id: the spans of one session stay together...
      expect(exportedId).toBe(sessionHash(session!));
      expect(exportedId).toMatch(/^[0-9a-f]{32}$/);
      expect(exported([span!])).not.toContain(session!);
      // ...but whoever reads the traces cannot use it to reach the session.
      const replay = await fetch(url, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': exportedId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      });
      await replay.text();
      expect(replay.status).toBe(404);
      const own = await call(url, { 'Mcp-Session-Id': session! });
      expect(own).toContain('boom');
    } finally {
      await stop(http);
    }
  });

  it('leaves the client out with APITAME_OTEL_CLIENT=off', async () => {
    const o = otel({ APITAME_OTEL_CLIENT: 'off' }, 'http');
    const { http, url } = await serve(o.telemetry);
    try {
      await call(url);
    } finally {
      await stop(http);
    }
    const [span] = await o.spans();
    expect(span!.attributes['apitame.caller.client']).toBeUndefined();
    expect(span!.attributes['apitame.outcome']).toBe('error');
    expect(exported([span!])).not.toContain('triage-bot');
  });

  it('exports a JSON-RPC id only when it is a number or a short plain token', async () => {
    const o = otel({}, 'http');
    const { http, url } = await serve(o.telemetry);
    const ids: Array<[string | number, string | undefined]> = [
      [42, '42'],
      ['req-1.a:b', 'req-1.a:b'],
      ['a'.repeat(64), 'a'.repeat(64)],
      ['a'.repeat(65), undefined],
      [`alice@example.com/${'p'.repeat(20)}`, undefined],
      ['two words', undefined],
      ['line\nbreak', undefined],
      ['under_score', 'under_score'],
      ['slash/inside', undefined],
    ];
    try {
      for (const [id] of ids) await call(url, {}, undefined, id);
    } finally {
      await stop(http);
    }
    const spans = await o.spans();
    expect(spans.map((sp) => sp.attributes['jsonrpc.request.id'])).toEqual(ids.map(([, e]) => e));
    expect(exported(spans)).not.toContain('alice@example.com');
  });
});

describe('telemetry: attribute limits', () => {
  it('caps string attributes at 256 characters', async () => {
    const longId = `op${'x'.repeat(300)}`;
    const { rt } = fakeApi({
      paths: { '/long': { get: { operationId: longId, responses: ok() } } },
      respond: () => reply({ ok: true }),
    });
    const o = otel();
    const { client } = await connect(rt, o.telemetry);
    await client.callTool({
      name: 'call_operation',
      arguments: { operationId: longId, params: {} },
    });
    const [span] = await o.spans();
    expect(span!.attributes['apitame.outcome']).toBe('sent');
    expect(span!.attributes['apitame.operation']).toBe(longId.slice(0, 256));
    await client.close();
  });
});

describe('telemetry never breaks a tool call', () => {
  it('a collector cannot forge log lines: response bodies are skipped, and line breaks become spaces', () => {
    const o = otel();
    // What the exporter logs when a collector answers 200 with a body that is not protobuf.
    diag.error(
      'OTLPExportDelegate Export succeeded but could not deserialize response - is the response specification compliant?',
      new Error('Unknown wire type 7, cannot safely skip'),
      Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff]),
        Buffer.from('\n[apitame] warn: FORGED log line from the collector\n'),
      ]),
    );
    expect(o.logs).toEqual([
      '[apitame] warn: OpenTelemetry: OTLPExportDelegate Export succeeded but could not deserialize response - is the response specification compliant? Unknown wire type 7, cannot safely skip\n',
    ]);
    const other = otel();
    diag.warn(
      new Error('Bad Request\n[apitame] warn: FORGED\r\u2028again\u0007') as unknown as string,
    );
    expect(other.logs).toEqual([
      '[apitame] warn: OpenTelemetry: Bad Request [apitame] warn: FORGED again\n',
    ]);
  });

  it("OpenTelemetry's own errors reach the log as their message, without the stack", () => {
    const o = otel();
    diag.error(
      JSON.stringify({
        message:
          'PeriodicExportingMetricReader: metrics export failed (error OTLPExporterError: Not Found)',
        stack: 'Error: at /home/someone/node_modules/x.js:1:1',
      }),
    );
    expect(o.logs).toEqual([
      '[apitame] warn: OpenTelemetry: PeriodicExportingMetricReader: metrics export failed (error OTLPExporterError: Not Found)\n',
    ]);
  });

  it('a failing exporter is a rate-limited warning, and calls keep working', async () => {
    const redactor = new Redactor();
    redactor.addSecret(AUTH_SECRET);
    const logs: string[] = [];
    const settings = readTelemetrySettings({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
      OTEL_METRICS_EXPORTER: 'none',
    });
    const telemetry = createTelemetry(settings, {
      transport: 'stdio',
      logger: new Logger(redactor, 'debug', (l) => logs.push(l)),
      redactor,
      server: { name: 'shop', source: 'openapi' },
      spanExporter: {
        export: (_spans, done) =>
          done({ code: 1, error: new Error(`collector said no to ${AUTH_SECRET}`) }),
        shutdown: async () => {},
      },
    });
    started.push(telemetry);
    const { client } = await connect(api(), telemetry);
    for (let i = 0; i < 3; i++) {
      const res = await client.callTool({ name: 'broken', arguments: {} });
      expect(JSON.stringify(res)).toContain('boom');
      // Never throws, whatever the exporter says.
      await telemetry.flush();
    }
    const warnings = logs.filter((l) => l.includes('OpenTelemetry'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/collector said no/);
    expect(warnings[0]).not.toContain(AUTH_SECRET);
    await client.close();
  });
});
