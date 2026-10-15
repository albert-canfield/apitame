import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { Logger } from '../../src/log.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { OTEL_NPX, readTelemetrySettings } from '../../src/telemetry/config.js';
import {
  startTelemetry,
  telemetryFindings,
  type OtelModule,
  type Telemetry,
} from '../../src/telemetry/index.js';
import { createTelemetry, SHUTDOWN_TIMEOUT_MS } from '../../src/telemetry/otel.js';
import type { Runtime } from '../../src/types.js';
import { fakeApi, PETSTORE, tempDir } from '../helpers.js';

const ARG_SECRET = 'fake-key-argument-31415926';
const RESPONSE_SECRET = 'fake-key-response-27182818';
const HEADER_SECRET = 'fake-key-otlp-header-16180339';

afterEach(() => {
  vi.unstubAllEnvs();
});

function quiet() {
  const logs: string[] = [];
  const redactor = new Redactor();
  return { logs, redactor, logger: new Logger(redactor, 'debug', (l) => logs.push(l)) };
}

const deps = (q: ReturnType<typeof quiet>) => ({
  transport: 'stdio' as const,
  logger: q.logger,
  redactor: q.redactor,
  server: { name: 'shop', source: 'openapi' },
});

/** An OTLP/HTTP receiver on 127.0.0.1 that records every request. */
async function receiver() {
  const requests: Array<{ path: string; headers: IncomingMessage['headers']; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A collector that accepts connections and requests, and never answers. */
async function deadCollector() {
  let received = 0;
  const server = createServer((req) => {
    received++;
    req.resume();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received: () => received,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const runtime = () =>
  fakeApi({
    paths: {
      '/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    config: { tools: [{ name: 'items', description: 'Items', operations: ['getItem'] }] },
    respond: () =>
      new Response(JSON.stringify({ secret: RESPONSE_SECRET }), {
        headers: { 'content-type': 'application/json' },
      }),
  }).rt;

async function callOnce(rt: Runtime, telemetry: Telemetry) {
  const server = createMcpServer(rt, { telemetry });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'export-test', version: '1.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  await client.callTool({ name: 'items', arguments: { id: ARG_SECRET } });
  await client.close();
}

/** One finished span without an MCP connection, for the shutdown tests. */
function recordOne(telemetry: Telemetry) {
  const call = telemetry.startToolCall({
    name: 'items',
    runtime: { summarizeTools: () => [] } as unknown as Runtime,
    ctx: { mcpReq: { id: 1 } } as unknown as ServerContext,
  });
  call.end({ content: [] });
}

describe('startTelemetry: nothing is loaded unless an endpoint is set', () => {
  const failLoad = () =>
    vi.fn(async (): Promise<OtelModule> => {
      throw new Error('must not load');
    });

  it('without an OTLP endpoint, the packages are never imported', async () => {
    const q = quiet();
    const load = failLoad();
    expect(await startTelemetry({ ...deps(q), env: {}, load })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(q.logs).toEqual([]);
  });

  it('with OTEL_SDK_DISABLED=true, the packages are never imported', async () => {
    const q = quiet();
    const load = failLoad();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_SDK_DISABLED: 'true' };
    expect(await startTelemetry({ ...deps(q), env, load })).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('with the packages missing: a warning with the exact command, and serving goes on', async () => {
    const q = quiet();
    const load = vi.fn(async (): Promise<OtelModule> => {
      const err = new Error(
        "Cannot find package '@opentelemetry/sdk-trace' imported from /usr/lib/node_modules/apitame/dist/otel-ABC.js",
      ) as Error & { code: string };
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    });
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };
    expect(await startTelemetry({ ...deps(q), env, load })).toBeUndefined();
    expect(load).toHaveBeenCalledOnce();
    const text = q.logs.join('');
    expect(text).toContain('warn: OpenTelemetry export is on');
    expect(text).toContain('serves without telemetry until they are');
    expect(text).toContain(`${OTEL_NPX} serve`);
    expect(text).not.toContain('loading them failed');
  });

  it('another load failure is shown as it is', async () => {
    const q = quiet();
    const load = vi.fn(async (): Promise<OtelModule> => {
      throw new SyntaxError('Unexpected token in otel.js');
    });
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' };
    expect(await startTelemetry({ ...deps(q), env, load })).toBeUndefined();
    expect(q.logs.join('')).toContain('(loading them failed with: Unexpected token in otel.js)');
  });

  it('logs the settings it cannot use, even when it stays off', async () => {
    const q = quiet();
    await startTelemetry({ ...deps(q), env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc-host:4317' } });
    expect(q.logs.join('')).toMatch(
      /warn: OpenTelemetry: OTEL_EXPORTER_OTLP_ENDPOINT is not an http/,
    );
  });
});

describe('OTLP export over HTTP', () => {
  it('sends spans and metrics with the configured headers, and flushes them on shutdown', async () => {
    const rx = await receiver();
    try {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', rx.url);
      vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', `x-api-key=${HEADER_SECRET}`);
      vi.stubEnv('OTEL_SERVICE_NAME', 'apitame-under-test');
      const q = quiet();
      const telemetry = await startTelemetry(deps(q));
      expect(telemetry).toBeDefined();
      expect(q.logs.join('')).toContain(
        `OpenTelemetry: traces to ${rx.url}/v1/traces, metrics every 60 s to ${rx.url}/v1/metrics`,
      );
      // The vendor key in the headers is a secret now.
      expect(q.redactor.text(`key ${HEADER_SECRET}`)).not.toContain(HEADER_SECRET);

      await callOnce(runtime(), telemetry!);
      // Spans are batched for 5 s and metrics for 60 s: only shutdown sends them now.
      expect(rx.requests).toEqual([]);
      await telemetry!.shutdown();

      const traces = rx.requests.filter((r) => r.path === '/v1/traces');
      expect(traces).toHaveLength(1);
      expect(traces[0]!.headers['x-api-key']).toBe(HEADER_SECRET);
      expect(traces[0]!.headers['content-type']).toBe('application/x-protobuf');
      const body = traces[0]!.body.toString('latin1');
      for (const expected of [
        'tools/call items',
        'apitame.outcome',
        'getItem',
        'execute_tool',
        'apitame-under-test',
      ]) {
        expect(body).toContain(expected);
      }
      const metrics = rx.requests.filter((r) => r.path === '/v1/metrics');
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.body.toString('latin1')).toContain('apitame.tool.calls');
      for (const r of rx.requests) {
        const text = r.body.toString('latin1');
        for (const secret of [ARG_SECRET, RESPONSE_SECRET, HEADER_SECRET])
          expect(text).not.toContain(secret);
      }
    } finally {
      await rx.close();
    }
  });

  it('shutdown with a collector that never answers ends within the bound', async () => {
    const dead = await deadCollector();
    try {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', dead.url);
      // The exporter alone would wait this long.
      vi.stubEnv('OTEL_EXPORTER_OTLP_TIMEOUT', '30000');
      const q = quiet();
      const telemetry = createTelemetry(readTelemetrySettings(process.env), {
        ...deps(q),
        shutdownTimeoutMs: 500,
      });
      recordOne(telemetry);
      const t0 = performance.now();
      await telemetry.shutdown();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2_500);
      expect(dead.received()).toBeGreaterThan(0);
      expect(q.logs.join('')).toMatch(/did not take the last spans and metrics within 0.5 s/);
    } finally {
      await dead.close();
    }
  });

  it(`serve's bound is ${SHUTDOWN_TIMEOUT_MS / 1000} seconds`, async () => {
    const dead = await deadCollector();
    try {
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', dead.url);
      vi.stubEnv('OTEL_EXPORTER_OTLP_TIMEOUT', '30000');
      const q = quiet();
      const telemetry = await startTelemetry(deps(q));
      recordOne(telemetry!);
      const t0 = performance.now();
      await telemetry!.shutdown();
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 2_000);
    } finally {
      await dead.close();
    }
  });
});

describe('doctor', () => {
  it('reports telemetry off, missing packages, and packages that load, without contacting the collector', async () => {
    expect(await telemetryFindings({})).toEqual([
      { status: 'info', detail: 'off (OTEL_EXPORTER_OTLP_ENDPOINT is not set)' },
    ]);
    const missing = async (): Promise<OtelModule> => {
      throw Object.assign(new Error("Cannot find package '@opentelemetry/api'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
    };
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    };
    const [protocol, notLoaded] = await telemetryFindings(env, missing);
    expect(protocol).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/grpc is not supported/),
    });
    expect(notLoaded!.status).toBe('warn');
    expect(notLoaded!.detail).toContain(OTEL_NPX);
    expect(notLoaded!.detail).not.toContain('\n');
    // The real packages (development dependencies here) load; port 1 is never contacted.
    expect(await telemetryFindings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' })).toEqual([
      {
        status: 'ok',
        detail:
          'traces to http://127.0.0.1:1/v1/traces, metrics to http://127.0.0.1:1/v1/metrics; packages load (6 of them). The collector is not contacted by doctor.',
      },
    ]);
  });

  it('shows the telemetry line in the doctor report', async () => {
    const t = tempDir('apitame-otel-doctor-');
    try {
      const config = join(t.dir, 'apitame.config.yaml');
      writeFileSync(
        config,
        `name: petstore\nsource:\n  type: openapi\n  spec: ${JSON.stringify(PETSTORE)}\n`,
      );
      vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'http://127.0.0.1:1/v1/traces');
      const findings = await runDoctor({ config, offline: true });
      expect(findings.find((f) => f.check === 'Telemetry')).toEqual({
        status: 'ok',
        check: 'Telemetry',
        detail:
          'traces to http://127.0.0.1:1/v1/traces; packages load (6 of them). The collector is not contacted by doctor.',
      });
    } finally {
      t.cleanup();
    }
  });
});
