import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectSource } from '../../src/cli/detect.js';
import { parseConfig } from '../../src/config/load.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import {
  DUCKDB_READ_ONLY_SETTINGS,
  DuckdbDriver,
  loadDuckdb,
} from '../../src/sources/sql/duckdb.js';
import { duckdbParserCheck, guardDuckdbSelect } from '../../src/sources/sql/duckdb-guard.js';
import { splitStatements, tokenize } from '../../src/sources/sql/lexer.js';
import { createDuckdbShop, duckdbForTests, jsonOf, ROOT, tempDir, textOf } from '../helpers.js';

const { duck, reason } = await duckdbForTests();
const tmp = tempDir('apitame-duckdb-');
const file = join(tmp.dir, 'shop.duckdb');
const csv = join(tmp.dir, 'secrets.csv');
const opts = { rowLimit: 50, timeoutMs: 5_000 };

beforeAll(async () => {
  writeFileSync(csv, 'name,value\napi_key,sk_live_123\n');
  if (duck) await createDuckdbShop(file, duck);
}, 60_000);
afterAll(() => tmp.cleanup());

function runtime(extra: Record<string, unknown> = {}, path = file) {
  const config = parseConfig({
    name: 'shop',
    source: { type: 'duckdb', path },
    limits: { rowLimit: 25, timeoutMs: 3_000 },
    ...extra,
  });
  return new SqlRuntime(config, new DuckdbDriver(path, duck!), new Redactor());
}

async function withDriver<T>(fn: (d: DuckdbDriver) => Promise<T>, path = file): Promise<T> {
  const driver = new DuckdbDriver(path, duck!);
  try {
    return await fn(driver);
  } finally {
    await driver.close();
  }
}

describe('DuckDB driver package', () => {
  it.runIf(!duck)(`is skipped: @duckdb/node-api cannot load here (${reason})`, () => {});

  it('explains exactly how to run apitame when @duckdb/node-api is missing', async () => {
    const missing = () =>
      Promise.reject(
        Object.assign(
          new Error("Cannot find package '@duckdb/node-api' imported from /x/dist/cli.js"),
          {
            code: 'ERR_MODULE_NOT_FOUND',
          },
        ),
      );
    await expect(loadDuckdb(missing)).rejects.toThrow(
      'Run apitame together with it, for example: npx -p apitame -p @duckdb/node-api apitame init ./data.duckdb',
    );
    await expect(loadDuckdb(missing)).rejects.toThrow('npm install @duckdb/node-api');
    // A native binary that does not load on this platform says why.
    const broken = () =>
      Promise.reject(Object.assign(new Error('dlopen failed: GLIBC_2.38 not found'), {}));
    await expect(loadDuckdb(broken)).rejects.toThrow(/loading it failed with: dlopen failed/);
    // Too old for the parse tree and settings apitame checks.
    await expect(loadDuckdb(async () => ({ version: () => 'v1.3.2' }))).rejects.toThrow(
      /needs DuckDB 1\.4 or later, but @duckdb\/node-api provides v1\.3\.2/,
    );
  });
});

describe.skipIf(!duck)('DuckDB', () => {
  describe('layer 2 on its own: DuckDB parser', () => {
    const check = (sql: string, extra: Record<string, unknown> = {}) =>
      withDriver((d) => duckdbParserCheck(sql, extra, (s) => d.serializeSelect(s)));

    it.each([
      ['a delete', 'DELETE FROM orders', /Only SELECT queries/],
      ['an extension install', 'INSTALL httpfs', /Only SELECT queries/],
      ['a pragma', 'PRAGMA version', /Only SELECT queries/],
      ['a temp table', 'CREATE TEMP TABLE t AS SELECT 1', /Only SELECT queries/],
      ['a setting', 'SET enable_external_access = true', /Only SELECT queries/],
      ['two statements', 'SELECT 1; SELECT 2', /one statement/],
      ['a hidden second statement', "SELECT '\\'; DELETE FROM orders; --'", /Only SELECT|one/],
      ['select into', 'SELECT 1 INTO t', /could not be parsed/],
      ['row locks', 'SELECT * FROM orders FOR UPDATE', /could not be parsed/],
      ['read_csv', "SELECT * FROM read_csv('x.csv')", /read_csv\(\) is not allowed/],
      ['query()', "SELECT * FROM query('SELECT 1')", /query\(\) is not allowed/],
      ['a file in FROM', "SELECT * FROM 'x.csv'", /Reading files is not allowed/],
      ['a quoted file name', 'SELECT * FROM "data/x.parquet"', /Reading files is not allowed/],
      [
        'a table macro reading a table by name',
        "SELECT * FROM histogram('customers', email)",
        /histogram\(\) is not allowed/,
      ],
      ['enable_peg_parser', 'SELECT * FROM enable_peg_parser()', /not allowed/],
      ['sleep_ms in a subquery', 'SELECT (SELECT sleep_ms(10))', /sleep_ms\(\) is not allowed/],
    ])('refuses %s', async (_name, sql, why) => {
      const r = await check(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });

    it('reads DuckDB syntax that other SQL parsers refuse', async () => {
      for (const sql of [
        'FROM orders SELECT id LIMIT 2',
        'SELECT * EXCLUDE (status) FROM orders',
        'SELECT status, count(*) FROM orders GROUP BY ALL',
        'SELECT id, row_number() OVER (ORDER BY total) AS rn FROM orders QUALIFY rn < 3',
      ]) {
        const r = await check(sql);
        expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      }
    });

    it('resolves CTE names per scope, so a CTE cannot hide a denied table', async () => {
      const deny = { denyTables: ['customers'] };
      for (const sql of [
        'WITH customers AS (SELECT * FROM customers) SELECT * FROM customers',
        'WITH RECURSIVE customers AS (SELECT * FROM customers UNION ALL SELECT * FROM customers WHERE false) SELECT 1',
        'WITH a AS (SELECT * FROM customers), customers AS (SELECT 1) SELECT * FROM a',
        'SELECT * FROM (WITH customers AS (SELECT 1) SELECT * FROM customers) s, customers',
        'SELECT * FROM (SUMMARIZE customers)',
        'SELECT * FROM shop.main.customers',
      ]) {
        const r = await check(sql, deny);
        expect(r.ok, sql).toBe(false);
      }
      const allow = { allowTables: ['orders'] };
      for (const sql of [
        'WITH c AS (SELECT * FROM orders) SELECT * FROM c',
        'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r, orders',
        'WITH customers AS (SELECT 1 AS id) SELECT * FROM customers JOIN orders ON true',
      ]) {
        const r = await check(sql, allow);
        expect(r.ok, `${sql}: ${r.ok ? '' : r.reason}`).toBe(true);
      }
      const shadow = await check(
        'WITH orders AS (SELECT * FROM customers) SELECT * FROM orders',
        allow,
      );
      expect(shadow).toEqual({
        ok: false,
        reason: 'Table "customers" is not in the allowed table list.',
      });
    });

    it('fails closed on a parse tree shape it does not know', async () => {
      const tree = {
        error: false,
        statements: [
          {
            node: {
              type: 'SELECT_NODE',
              cte_map: { map: [] },
              select_list: [],
              from_table: { type: 'MYSTERY_REF', name: 'customers' },
            },
          },
        ],
      };
      const r = await duckdbParserCheck('SELECT 1', {}, async () => JSON.stringify(tree));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/query shape apitame does not know/);
    });
  });

  describe('layer 1 against DuckDB: the lexer splits statements as DuckDB does', () => {
    // Differential check: wherever DuckDB itself reads the text, the lexer must find the same
    // number of statements (never fewer, or a statement could hide from the keyword checks).
    it.each([
      "SELECT 'a''b'; SELECT 2",
      "SELECT E'a\\'b'; SELECT 2",
      "SELECT 'a\\'; SELECT 2 --'",
      "SELECT E'x\\'; SELECT 2 --'",
      'SELECT $$a;b$$; SELECT 2',
      'SELECT $t$ $$ ; $t$; SELECT 2',
      'SELECT 1 /* /* */ ; */; SELECT 2',
      'SELECT 1 /*/ x */; SELECT 2',
      'SELECT 1 -- ;\n; SELECT 2',
      'SELECT 1 --\r; SELECT 2',
      'SELECT 1 --\r\n; SELECT 2',
      'SELECT 1 --\f; SELECT 2',
      'SELECT "a;b"; SELECT 2',
      "SELECT B'01', X'ff', N'abc'; SELECT 2",
      'SELECT 1;;; SELECT 2',
      "SELECT /* ' */ 1; SELECT 2",
      "SELECT '/*'; SELECT 2",
      "SELECT {'a;': 1}, [';']; SELECT 2",
    ])('%j', async (sql) => {
      const db = await duck!.DuckDBInstance.create(':memory:');
      const conn = await db.connect();
      try {
        const engine = (await conn.extractStatements(sql)).count;
        expect(splitStatements(tokenize(sql, 'duckdb'))).toHaveLength(engine);
      } finally {
        conn.closeSync();
        db.closeSync();
      }
    });
  });

  describe('layer 3 on its own: the database', () => {
    it('refuses file reads, extensions, settings, temp objects and stacked statements', async () => {
      await withDriver(async (d) => {
        const attempts: Array<[string, RegExp]> = [
          [`SELECT * FROM read_csv('${csv}')`, /file system operations are disabled/],
          [`SELECT * FROM '${csv}'`, /file system operations are disabled/],
          [`SELECT * FROM read_text('${csv}')`, /file system operations are disabled/],
          ["SELECT * FROM read_text('/etc/hosts')", /file system operations are disabled/],
          ['INSTALL httpfs', /Only SELECT queries are allowed \(DuckDB prepared a LOAD/],
          ['LOAD httpfs', /Only SELECT queries/],
          [`ATTACH '${join(tmp.dir, 'other.duckdb')}' AS o`, /Only SELECT queries/],
          // DuckDB checks file access while preparing COPY, before the statement type check.
          [
            `COPY orders TO '${join(tmp.dir, 'out.csv')}'`,
            /file system operations are disabled|Only SELECT queries/,
          ],
          ['CREATE TEMP TABLE t AS SELECT 1', /Only SELECT queries.*CREATE/],
          ['SET enable_external_access = true', /Only SELECT queries/],
          ['DELETE FROM orders', /Only SELECT queries.*DELETE/],
          ['SELECT 1; SELECT 2', /DuckDB read 2/],
          ["SELECT '\\'; DELETE FROM orders; --'", /DuckDB read 2/],
        ];
        for (const [sql, why] of attempts) {
          await expect(d.readQuery(sql, [], opts), sql).rejects.toThrow(why);
        }
      });
    });

    it('the settings alone block files, extensions, writes and changes to themselves', async () => {
      const db = await duck!.DuckDBInstance.create(file, DUCKDB_READ_ONLY_SETTINGS);
      const conn = await db.connect();
      try {
        const refused: Array<[string, RegExp]> = [
          [`SELECT * FROM read_csv('${csv}')`, /file system operations are disabled/],
          ['INSTALL httpfs', /file system operations are disabled|disabled/],
          ['LOAD httpfs', /disabled through configuration/],
          [`COPY orders TO '${join(tmp.dir, 'out.csv')}'`, /file system operations are disabled/],
          ["ATTACH ':memory:' AS m", /read-only mode/],
          ['SET enable_external_access = true', /configuration has been locked/],
          ['SET lock_configuration = false', /configuration has been locked/],
          ['DELETE FROM orders', /read-only mode/],
          ['CREATE TABLE t2 AS SELECT 1', /read-only mode/],
        ];
        for (const [sql, why] of refused) {
          await expect(conn.run(sql), sql).rejects.toThrow(why);
        }
        // Temporary objects live in memory and DuckDB allows them: the statement type check
        // in the driver (and the lexer and parser) is what refuses them.
        await expect(conn.run('CREATE TEMP TABLE t AS SELECT 1')).resolves.toBeDefined();
      } finally {
        conn.closeSync();
        db.closeSync();
      }
    });

    it('keeps no engine state between calls (each call opens its own instance)', async () => {
      await withDriver(async (d) => {
        // DuckDB runs this SELECT on a locked read-only database, and it switches the parser
        // for every connection of that instance. The next call must not see the change.
        await d.readQuery('SELECT * FROM enable_peg_parser()', [], opts);
        const r = await d.readQuery('SELECT 1 /* a /* nested */ comment */ AS x', [], opts);
        expect(r.rows).toEqual([[1]]);
      });
    });

    it('streams results and stops at the row limit', async () => {
      await withDriver(async (d) => {
        const r = await d.readQuery('SELECT * FROM range(100000)', [], {
          rowLimit: 7,
          timeoutMs: 5_000,
        });
        expect(r.rows).toHaveLength(7);
        expect(r.truncated).toBe(true);
        expect(r.columns).toEqual(['range']);
      });
    });

    it('returns JSON-friendly values', async () => {
      await withDriver(async (d) => {
        const r = await d.readQuery(
          "SELECT 'abc'::BLOB AS b, 9007199254740993::BIGINT AS big, 42::BIGINT AS small, 1.5::DECIMAL(3, 1) AS d, [1, 2] AS l, {'a': 1} AS s, DATE '2026-01-02' AS dt, NULL AS n",
          [],
          opts,
        );
        expect(r.rows).toEqual([
          ['<binary 3 bytes>', '9007199254740993', 42, '1.5', [1, 2], { a: 1 }, '2026-01-02', null],
        ]);
      });
    });

    it('explains a file that another process has open for writing', async () => {
      const locked = join(tmp.dir, 'locked.duckdb');
      copyFileSync(file, locked);
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { DuckDBInstance } = await import('@duckdb/node-api');
           const db = await DuckDBInstance.create(process.env.DUCK_FILE);
           await (await db.connect()).run('SELECT 1');
           process.stdout.write('ready\\n');
           process.stdin.resume();
           process.stdin.on('end', () => { db.closeSync(); process.exit(0); });`,
        ],
        { cwd: ROOT, env: { ...process.env, DUCK_FILE: locked }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const exited = new Promise((r) => child.on('exit', r));
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once('data', () => resolve());
          child.once('exit', (code) => reject(new Error(`lock holder exited with ${code}`)));
        });
        await withDriver(async (d) => {
          await expect(d.readQuery('SELECT 1', [], opts)).rejects.toThrow(
            /is open for writing in another process.*close the other program.*or point apitame at a copy/,
          );
        }, locked);
      } finally {
        child.stdin.end();
        await exited;
      }
    }, 30_000);

    it.skipIf(process.platform === 'win32')('reports whether the file is writable', async () => {
      const ro = join(tmp.dir, 'readonly.duckdb');
      copyFileSync(file, ro);
      await withDriver(async (d) => {
        expect((await d.privileges()).canWrite).toBe(true);
      }, ro);
      chmodSync(ro, 0o444);
      await withDriver(async (d) => {
        expect(await d.privileges()).toEqual({
          canWrite: false,
          detail: 'the database file is read-only for this user',
        });
        // A read-only file still opens (DuckDB only reads it).
        expect((await d.readQuery('SELECT count(*) FROM orders', [], opts)).rows).toEqual([[60]]);
      }, ro);
    });
  });

  describe('runtime', () => {
    it('serves DuckDB SQL through all three layers', async () => {
      const rt = runtime();
      try {
        const r = jsonOf<{ columns: string[]; rows: unknown[][] }>(
          await rt.callTool('query', {
            sql: 'FROM orders SELECT status, count(*) AS n GROUP BY ALL ORDER BY n DESC',
          }),
        );
        expect(r.columns).toEqual(['status', 'n']);
        expect(r.rows.length).toBeGreaterThan(1);
        const tables = jsonOf<{ tables: Array<{ name: string; rows?: number; comment?: string }> }>(
          await rt.callTool('list_tables', {}),
        ).tables;
        expect(tables.find((t) => t.name === 'orders')).toEqual({
          name: 'orders',
          type: 'table',
          rows: 60,
          comment: 'One row per checkout',
        });
        for (const sql of [
          "SELECT * FROM read_text('/etc/hosts')",
          "SELECT * FROM '/etc/hosts'",
          "SELECT * FROM query('DELETE FROM orders')",
          'INSTALL httpfs',
          'CREATE TEMP TABLE t AS SELECT 1',
        ]) {
          expect((await rt.callTool('query', { sql })).isError, sql).toBe(true);
        }
      } finally {
        await rt.close();
      }
    });

    it('interrupts a query at the timeout and keeps working', async () => {
      const rt = runtime({ limits: { timeoutMs: 300, rowLimit: 10 } });
      try {
        const started = Date.now();
        const res = await rt.callTool('query', {
          sql: 'SELECT count(*) FROM range(100000000000) t1',
        });
        expect(textOf(res)).toMatch(/timed out after 300 ms/);
        expect(Date.now() - started).toBeLessThan(5_000);
        const ok = jsonOf<{ rows: unknown[][] }>(
          await rt.callTool('query', { sql: 'SELECT count(*) FROM orders' }),
        );
        expect(ok.rows).toEqual([[60]]);
      } finally {
        await rt.close();
      }
    });

    it('applies the allow list, with CTE shadowing, to queries and tools', async () => {
      const rt = runtime({ sql: { tables: { allow: ['orders'] } } });
      try {
        expect(
          jsonOf<{ tables: Array<{ name: string }> }>(await rt.callTool('list_tables', {})).tables,
        ).toHaveLength(1);
        expect((await rt.callTool('describe_table', { table: 'customers' })).isError).toBe(true);
        expect(
          (await rt.callTool('query', { sql: 'WITH c AS (SELECT * FROM orders) SELECT * FROM c' }))
            .isError,
        ).toBeUndefined();
        const hidden = await rt.callTool('query', {
          sql: 'WITH orders AS (SELECT * FROM customers) SELECT * FROM orders',
        });
        expect(textOf(hidden)).toMatch(/customers.*not in the allowed table list/);
      } finally {
        await rt.close();
      }
    });

    it('checks named read queries with DuckDB parser on the first call', async () => {
      const rt = runtime({
        sql: {
          queries: [
            {
              name: 'orders_by_status',
              description: 'Orders with a status',
              sql: 'SELECT id FROM orders WHERE status = :status ORDER BY id LIMIT :n',
              params: { status: { type: 'string' }, n: { type: 'integer' } },
            },
            {
              name: 'broken',
              description: 'Not valid SQL',
              sql: 'SELECT id FROM orders WHERE id = :id AND',
              params: { id: { type: 'integer' } },
            },
          ],
        },
      });
      try {
        expect(
          jsonOf<{ rows: unknown[][] }>(
            await rt.callTool('orders_by_status', { status: 'paid', n: 2 }),
          ).rows,
        ).toEqual([[1], [5]]);
        const broken = await rt.callTool('broken', { id: 1 });
        expect(textOf(broken)).toMatch(
          /Refused: named query "broken": The query could not be parsed/,
        );
      } finally {
        await rt.close();
      }
    });
  });

  describe('init detection', () => {
    it('recognises .duckdb files, duckdb: URLs and DuckDB files with other names', () => {
      expect(detectSource(file)).toEqual({ kind: 'duckdb', file });
      expect(detectSource(`duckdb:${file}`)).toEqual({ kind: 'duckdb', file });
      const asDb = join(tmp.dir, 'warehouse.db');
      copyFileSync(file, asDb);
      expect(detectSource(asDb)).toEqual({ kind: 'duckdb', file: asDb });
      const noExt = join(tmp.dir, 'warehouse');
      copyFileSync(file, noExt);
      expect(detectSource(noExt)).toEqual({ kind: 'duckdb', file: noExt });
      expect(() => detectSource(join(tmp.dir, 'missing.duckdb'))).toThrow(/DuckDB file not found/);
    });
  });

  it('guards the whole pipeline in one call (lexer, then parser)', async () => {
    await withDriver(async (d) => {
      const serialize = (s: string) => d.serializeSelect(s);
      expect(await guardDuckdbSelect('SELECT * FROM orders', {}, serialize)).toEqual({
        ok: true,
        sql: 'SELECT * FROM orders',
        tables: ['orders'],
      });
      expect((await guardDuckdbSelect("SELECT * FROM glob('*')", {}, serialize)).ok).toBe(false);
    });
  });
});
