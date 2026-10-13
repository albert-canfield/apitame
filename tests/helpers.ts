import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { parseConfig } from '../src/config/load.js';
import type { Config, ConfigInput } from '../src/config/schema.js';
import { groupOperations } from '../src/sources/openapi/grouping.js';
import { loadSpec, type LoadedSpec } from '../src/sources/openapi/load.js';
import { extractOperations } from '../src/sources/openapi/operations.js';

export const ROOT = resolve(import.meta.dirname, '..');
export const PETSTORE = join(ROOT, 'examples/petstore/openapi.yaml');
export const GITHUB = join(ROOT, 'examples/github-subset/openapi.yaml');
export const SHOP_SEED = join(ROOT, 'examples/postgres-shop/seed.sql');

export function tempDir(prefix = 'apitame-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Create the sample shop database as a SQLite file. */
export function createSqliteShop(file: string): void {
  const db = new Database(file);
  db.exec(readFileSync(SHOP_SEED, 'utf8'));
  db.close();
}

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

/** A real PostgreSQL (PGlite, in-process) with the shop data, reachable over the wire protocol. */
export async function startPostgresShop(): Promise<{ url: string; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const db = await PGlite.create();
  await db.exec(readFileSync(SHOP_SEED, 'utf8'));
  await db.exec("COMMENT ON TABLE orders IS 'One row per checkout'");
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
  await server.start();
  return {
    url: `postgres://postgres:secret-pg-password@127.0.0.1:${port}/postgres`,
    close: async () => {
      await server.stop();
      await db.close();
    },
  };
}

let petstoreSpec: LoadedSpec | undefined;
export async function petstore(): Promise<LoadedSpec> {
  petstoreSpec ??= await loadSpec(PETSTORE);
  return petstoreSpec;
}

/** A petstore config with generated tool groups, plus overrides. */
export async function petstoreConfig(overrides: Partial<ConfigInput> = {}): Promise<Config> {
  const spec = await petstore();
  const ops = extractOperations(spec.doc);
  const { groups } = groupOperations(spec.doc, ops, {
    maxTools: 12,
    maxOperationsPerTool: 15,
    longTail: true,
  });
  return parseConfig({
    name: 'petstore',
    source: { type: 'openapi', spec: PETSTORE },
    tools: groups,
    ...overrides,
  });
}

export function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n');
}

export function jsonOf<T = Record<string, unknown>>(result: {
  content: Array<{ text: string }>;
}): T {
  return JSON.parse(textOf(result)) as T;
}
