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
import { Logger } from '../src/log.js';
import { Redactor } from '../src/safety/redact.js';
import { OpenApiRuntime } from '../src/server/openapi-runtime.js';

export const ROOT = resolve(import.meta.dirname, '..');
export const PETSTORE = join(ROOT, 'examples/petstore/openapi.yaml');
export const GITHUB = join(ROOT, 'examples/github-subset/openapi.yaml');
export const SHOP_SEED = join(ROOT, 'examples/postgres-shop/seed.sql');

export function tempDir(prefix = 'apitame-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      // Windows cannot remove the current directory, and releases file handles a little late.
      if (process.cwd().startsWith(dir)) process.chdir(tmpdir());
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // Best effort: it is a temporary folder.
      }
    },
  };
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

const SERVER_DB = 'apitame_test';

/**
 * A fresh database with the shop data on a real PostgreSQL server, plus a
 * read-only role. Opt-in: set APITAME_TEST_POSTGRES_URL to an admin URL.
 */
export async function setupPostgresServer(
  adminUrl: string,
): Promise<{ url: string; readOnlyUrl: string; close: () => Promise<void> }> {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SERVER_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SERVER_DB}`);
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'apitame_ro') THEN CREATE ROLE apitame_ro LOGIN; END IF; END $$`,
  );
  await admin.query(`ALTER ROLE apitame_ro WITH LOGIN PASSWORD 'apitame_ro_pw'`);
  const url = new URL(adminUrl);
  url.pathname = `/${SERVER_DB}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(readFileSync(SHOP_SEED, 'utf8'));
  await db.query(`GRANT CONNECT ON DATABASE ${SERVER_DB} TO apitame_ro`);
  await db.query('GRANT USAGE ON SCHEMA public TO apitame_ro');
  await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO apitame_ro');
  await db.query('ANALYZE');
  await db.end();
  await admin.end();
  const ro = new URL(url);
  ro.username = 'apitame_ro';
  ro.password = 'apitame_ro_pw';
  return { url: url.toString(), readOnlyUrl: ro.toString(), close: async () => {} };
}

/**
 * The same for a real MySQL server. Opt-in: set APITAME_TEST_MYSQL_URL to an admin URL.
 */
export async function setupMysqlServer(
  adminUrl: string,
): Promise<{ url: string; readOnlyUrl: string; close: () => Promise<void> }> {
  const mysql = (await import('mysql2/promise')).default;
  const admin = await mysql.createConnection({ uri: adminUrl, multipleStatements: true });
  await admin.query(
    `DROP DATABASE IF EXISTS ${SERVER_DB}; CREATE DATABASE ${SERVER_DB}; USE ${SERVER_DB};`,
  );
  // MySQL cannot index TEXT without a length; the rest of the seed is portable.
  await admin.query(readFileSync(SHOP_SEED, 'utf8').replace(/\bTEXT\b/g, 'VARCHAR(255)'));
  await admin.query(
    // MySQL 8 parses inline REFERENCES but ignores them, so foreign keys are added explicitly.
    `ALTER TABLE orders ADD FOREIGN KEY (customer_id) REFERENCES customers(id);
     ALTER TABLE order_items ADD FOREIGN KEY (order_id) REFERENCES orders(id), ADD FOREIGN KEY (product_id) REFERENCES products(id);
     CREATE USER IF NOT EXISTS 'apitame_ro'@'%' IDENTIFIED BY 'apitame_ro_pw'; ALTER USER 'apitame_ro'@'%' IDENTIFIED BY 'apitame_ro_pw'; GRANT SELECT ON ${SERVER_DB}.* TO 'apitame_ro'@'%'; ANALYZE TABLE customers, products, orders, order_items;`,
  );
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${SERVER_DB}`;
  const ro = new URL(url);
  ro.username = 'apitame_ro';
  ro.password = 'apitame_ro_pw';
  return { url: url.toString(), readOnlyUrl: ro.toString(), close: async () => {} };
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * An OpenAPI runtime over an in-memory spec, with a fake fetch: every request
 * is recorded in `sent`, and `respond` decides the response (200 `{"ok":true}`
 * by default). Logs are captured in `logs`.
 */
export function fakeApi(opts: {
  paths: Record<string, unknown>;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  baseUrl?: string;
  respond?: (s: SentRequest) => Response;
}): { rt: OpenApiRuntime; sent: SentRequest[]; logs: string[] } {
  const sent: SentRequest[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const s: SentRequest = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    };
    sent.push(s);
    return opts.respond
      ? opts.respond(s)
      : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const config = parseConfig({
    name: 't',
    source: {
      type: 'openapi',
      spec: 'x.yaml',
      baseUrl: opts.baseUrl ?? 'https://api.example.com/v1',
    },
    ...opts.config,
  });
  const spec = {
    doc: { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: opts.paths },
    location: '/x.yaml',
    isUrl: false,
  } as unknown as LoadedSpec;
  const redactor = new Redactor();
  const logger = new Logger(redactor, 'debug', (l) => logs.push(l));
  const rt = new OpenApiRuntime(config, spec, {
    configDir: '.',
    env: opts.env ?? {},
    fetchImpl,
    redactor,
    logger,
  });
  return { rt, sent, logs };
}

/** Call an operation through the long-tail tool (for configs without tool groups). */
export function callOperation(
  rt: OpenApiRuntime,
  operationId: string,
  params: Record<string, unknown> = {},
  flags: Record<string, unknown> = {},
) {
  return rt.callTool('call_operation', { operationId, params, ...flags });
}
