import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { OTEL_NPX } from '../../src/telemetry/config.js';
import { PETSTORE, ROOT, tempDir } from '../helpers.js';

const CLI = join(ROOT, 'src/cli.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;

/**
 * A module resolution hook for the child process: it writes every `@opentelemetry/*` specifier
 * that anything tries to import to a file, and with `block` refuses it as if the package were
 * not installed. This is how a default install, without the optional peers, behaves.
 */
const HOOK = `
import { appendFileSync } from 'node:fs';
let options = {};
export function initialize(data) { options = data; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@opentelemetry/')) {
    appendFileSync(options.log, specifier + '\\n');
    if (options.block) {
      const err = new Error("Cannot find package '" + specifier + "' imported from " + context.parentURL);
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    }
  }
  return next(specifier, context);
}`;

const t = tempDir('apitame-otel-cli-');
let mock: MockServer;
const hookFile = join(t.dir, 'record-otel.mjs');

beforeAll(async () => {
  const spec = await loadSpec(PETSTORE);
  mock = await startMockServer(extractOperations(spec.doc));
  writeFileSync(
    join(t.dir, 'apitame.config.yaml'),
    `name: petstore\nsource:\n  type: openapi\n  spec: ${JSON.stringify(PETSTORE)}\n  baseUrl: ${mock.url}\n`,
  );
  writeFileSync(
    hookFile,
    `import { register } from 'node:module';
const { OTEL_HOOK_LOG: log, OTEL_HOOK_BLOCK: block } = process.env;
register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(HOOK)}), { data: { log, block: block === '1' } });
`,
  );
});
afterAll(async () => {
  await mock.close();
  t.cleanup();
});

/** The environment without any OTEL_* variable the developer may have set. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !k.startsWith('OTEL_') && !k.startsWith('APITAME_OTEL_'),
    ),
  ) as Record<string, string>;
  return { ...env, NO_COLOR: '1', APITAME_LOG_LEVEL: 'info', ...extra };
}

/** Serve over stdio, make one tool call, and close stdin (the shutdown path MCP clients use). */
async function serveOnce(name: string, env: Record<string, string>) {
  const log = join(t.dir, `${name}.log`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', TSX, '--import', pathToFileURL(hookFile).href, CLI, 'serve'],
    cwd: t.dir,
    env: cleanEnv({ OTEL_HOOK_LOG: log, ...env }),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: 'otel-e2e', version: '1.0.0' });
  await client.connect(transport);
  const res = await client.callTool({
    name: 'call_operation',
    arguments: { operationId: 'getPetById', params: { petId: 1 } },
  });
  await client.close();
  return {
    res,
    stderr,
    imported: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

describe('serve over stdio with OpenTelemetry', () => {
  it('without an endpoint, no OpenTelemetry package is ever imported', async () => {
    const run = await serveOnce('off', {});
    expect(run.res.isError).toBeFalsy();
    expect(run.imported).toEqual([]);
    expect(run.stderr).not.toMatch(/OpenTelemetry/);
  });

  it('with an endpoint and the packages missing, it warns with the command and keeps serving', async () => {
    const run = await serveOnce('missing', {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_HOOK_BLOCK: '1',
    });
    expect(run.imported.length).toBeGreaterThan(0);
    expect(run.res.isError).toBeFalsy();
    expect(run.stderr).toContain('OpenTelemetry export is on');
    expect(run.stderr).toContain(`${OTEL_NPX} serve`);
  });

  it('with an endpoint and the packages, the span reaches the collector when the client closes stdin', async () => {
    const received: Array<{ path: string; body: Buffer }> = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const { port } = collector.address() as AddressInfo;
    try {
      const run = await serveOnce('on', {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      });
      expect(run.res.isError).toBeFalsy();
      expect(run.stderr).toContain(`OpenTelemetry: traces to http://127.0.0.1:${port}/v1/traces`);
      const traces = received.filter((r) => r.path === '/v1/traces');
      expect(traces).toHaveLength(1);
      const body = traces[0]!.body.toString('latin1');
      expect(body).toContain('tools/call call_operation');
      expect(body).toContain('getPetById');
      expect(body).toContain('pipe');
      expect(received.some((r) => r.path === '/v1/metrics')).toBe(true);
    } finally {
      collector.closeAllConnections();
      await new Promise<void>((r) => collector.close(() => r()));
    }
  });
});
