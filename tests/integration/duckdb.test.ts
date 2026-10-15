import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectSource } from '../../src/cli/detect.js';
import { parseConfig } from '../../src/config/load.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import {
  DUCKDB_READ_ONLY_SETTINGS,
  DuckdbDriver,
  probeDuckdb,
  resolveDuckdb,
} from '../../src/sources/sql/duckdb.js';
import { duckdbParserCheck, guardDuckdbSelect } from '../../src/sources/sql/duckdb-guard.js';
import { guardSelect } from '../../src/sources/sql/guard.js';
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
  return new SqlRuntime(
    config,
    new DuckdbDriver(path, {
      memoryLimit: config.sql.duckdb?.memoryLimit,
      threads: config.sql.duckdb?.threads,
    }),
    new Redactor(),
  );
}

async function withDriver<T>(
  fn: (d: DuckdbDriver) => Promise<T>,
  path = file,
  options: ConstructorParameters<typeof DuckdbDriver>[1] = {},
): Promise<T> {
  const driver = new DuckdbDriver(path, options);
  try {
    return await fn(driver);
  } finally {
    await driver.close();
  }
}

describe('DuckDB driver package', () => {
  it.runIf(!duck)(`is skipped: @duckdb/node-api cannot load here (${reason})`, () => {});

  it('explains exactly how to run apitame when @duckdb/node-api is missing', () => {
    const missing = () => {
      throw Object.assign(
        new Error("Cannot find package '@duckdb/node-api' imported from /x/dist/cli.js"),
        { code: 'ERR_MODULE_NOT_FOUND' },
      );
    };
    expect(() => resolveDuckdb(missing)).toThrow(
      'Run apitame together with it, for example: npx -p apitame -p @duckdb/node-api@1.5.6-r.1 apitame init ./data.duckdb',
    );
    expect(() => resolveDuckdb(missing)).toThrow('npm install @duckdb/node-api@1.5.6-r.1');
    // The driver checks for the package before it starts anything.
    expect(() => new DuckdbDriver(csv, { resolve: missing })).toThrow(
      /needs the "@duckdb\/node-api" package/,
    );
  });

  // Fake driver packages: the child process loads them like the real one.
  const fake = (name: string, body: string) => {
    const path = join(tmp.dir, name);
    writeFileSync(path, body);
    return () => pathToFileURL(path).href;
  };

  it('reports a driver that does not load, and checks its version', async () => {
    const broken = fake('broken.mjs', "throw new Error('dlopen failed: GLIBC_2.38 not found');");
    await expect(probeDuckdb({ resolve: broken })).rejects.toThrow(
      /loading it failed with: dlopen failed/,
    );
    await expect(
      probeDuckdb({ resolve: fake('old.mjs', "export const version = () => 'v1.3.2';") }),
    ).rejects.toThrow(/needs DuckDB 1\.4 or later, but @duckdb\/node-api provides v1\.3\.2/);
    // A newer release than the tested one runs, with a warning.
    const newer = fake('newer.mjs', "export const version = () => 'v1.6.0';");
    expect(await probeDuckdb({ resolve: newer })).toMatchObject({
      version: 'v1.6.0',
      warning: expect.stringMatching(
        /newer than the release apitame is tested with \(1\.5\.6-r\.1\)/,
      ),
    });
    const warnings: string[] = [];
    const driver = new DuckdbDriver(csv, { resolve: newer, warn: (m) => warnings.push(m) });
    try {
      expect(await driver.version()).toBe('v1.6.0');
      expect(warnings).toEqual([expect.stringMatching(/DuckDB v1\.6\.0 is newer/)]);
    } finally {
      await driver.close();
    }
  });

  it.runIf(Boolean(duck))('loads the tested release in a child process', async () => {
    expect(await probeDuckdb()).toEqual({ version: 'v1.5.6' });
  });
});

describe.skipIf(!duck)('DuckDB', () => {
  describe('layer 2 on its own: DuckDB parser', () => {
    // One driver (one child process) for all parser checks.
    let parser: DuckdbDriver;
    beforeAll(() => {
      parser = new DuckdbDriver(file);
    });
    afterAll(() => parser.close());
    const check = (sql: string, extra: Record<string, unknown> = {}) =>
      duckdbParserCheck(sql, extra, (s) => parser.serializeSelect(s));

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
      ['a setting', "SELECT current_setting('http_proxy')", /current_setting\(\) is not allowed/],
      ['a variable', "SELECT getvariable('x')", /getvariable\(\) is not allowed/],
      ['the settings', 'SELECT * FROM duckdb_settings()', /duckdb_settings\(\) is not allowed/],
      ['a catalog function', 'SELECT sql FROM duckdb_tables()', /duckdb_tables\(\) is not allowed/],
      ['a catalog view', 'SELECT sql FROM duckdb_tables', /catalog .* is not available/],
      ['information_schema', 'SELECT * FROM information_schema.tables', /catalog/],
      ['pg_settings', 'SELECT * FROM pg_settings', /catalog/],
      ['sqlite_master', 'SELECT sql FROM sqlite_master', /catalog/],
      ['SHOW TABLES', 'SELECT * FROM (SHOW TABLES)', /catalog/],
      ['DESCRIBE', 'SELECT * FROM (DESCRIBE orders)', /catalog/],
      ['pragma_table_info', "SELECT * FROM pragma_table_info('orders')", /pragma_table_info/],
      ['the database file itself', "SELECT * FROM read_blob('shop.duckdb')", /read_blob/],
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

  describe('resources and isolation (child process)', () => {
    /** Run fn while sampling how long this process's event loop is blocked. */
    async function stalls<T>(fn: () => Promise<T>): Promise<{ value: T; maxStallMs: number }> {
      let last = Date.now();
      let maxStallMs = 0;
      const tick = setInterval(() => {
        const now = Date.now();
        maxStallMs = Math.max(maxStallMs, now - last - 20);
        last = now;
      }, 20);
      try {
        return { value: await fn(), maxStallMs };
      } finally {
        clearInterval(tick);
      }
    }

    it('refuses a result too large to convert, without blocking or crashing the server', async () => {
      const rt = runtime({ limits: { timeoutMs: 10_000, rowLimit: 10 } });
      try {
        for (const sql of [
          // Before: these ran Node out of memory or blocked the event loop for seconds.
          "SELECT list_transform(range((SELECT 2500000)), x -> {'a': x, 'b': x + 1, 'c': x + 2}) AS l",
          'SELECT range((SELECT 4000000)) AS l',
        ]) {
          const { value, maxStallMs } = await stalls(() => rt.callTool('query', { sql }));
          expect(textOf(value)).toMatch(/first row is larger than the 50000-byte response limit/);
          expect(maxStallMs).toBeLessThan(1_000);
        }
        expect(
          jsonOf<{ rows: unknown[][] }>(
            await rt.callTool('query', { sql: 'SELECT count(*) FROM orders' }),
          ).rows,
        ).toEqual([[60]]);
      } finally {
        await rt.close();
      }
    }, 60_000);

    it('a crash of the DuckDB process is an error for that call only', async () => {
      // A small heap makes converting a 100 MB string run the child out of memory for real.
      await withDriver(
        async (d) => {
          await expect(
            d.readQuery("SELECT repeat('x', 100000000) AS s", [], {
              rowLimit: 1,
              timeoutMs: 30_000,
              maxBytes: 1e9,
            }),
          ).rejects.toThrow(/used too much memory and was stopped/);
          expect((await d.readQuery('SELECT 42 AS n', [], opts)).rows).toEqual([[42]]);
        },
        file,
        { heapMb: 32 },
      );
    }, 60_000);

    it('the timeout covers planning, which interrupt() cannot stop', async () => {
      const rt = runtime({ limits: { timeoutMs: 500, rowLimit: 10 } });
      try {
        // DuckDB plans a 200-way join for seconds and ignores interrupt() while it does.
        const joins = Array.from(
          { length: 200 },
          (_, i) => ` JOIN orders o${i + 1} USING (id)`,
        ).join('');
        const started = Date.now();
        const res = await rt.callTool('query', { sql: `SELECT 1 FROM orders o0${joins}` });
        expect(textOf(res)).toMatch(/took longer than 500 ms and was stopped/);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(
          jsonOf<{ rows: unknown[][] }>(await rt.callTool('query', { sql: 'SELECT 1 AS n' })).rows,
        ).toEqual([[1]]);
      } finally {
        await rt.close();
      }
    }, 30_000);

    it.runIf(process.env.APITAME_HEAVY_TESTS === '1')(
      'the timeout covers constant folding of a large list (heavy: about 2 GB)',
      async () => {
        const rt = runtime({ limits: { timeoutMs: 500, rowLimit: 10 } });
        try {
          const started = Date.now();
          const res = await rt.callTool('query', {
            sql: 'SELECT len(list_sort(range(30000000))) AS n',
          });
          expect(textOf(res)).toMatch(/took longer than 500 ms and was stopped/);
          expect(Date.now() - started).toBeLessThan(5_000);
        } finally {
          await rt.close();
        }
      },
      60_000,
    );

    it('applies and reads back memory, thread and spill limits', async () => {
      const read = (d: DuckdbDriver) =>
        d.readQuery(
          "SELECT current_setting('memory_limit') AS m, current_setting('threads')::INT AS t, current_setting('max_temp_directory_size') AS s, current_setting('temp_directory') AS d",
          [],
          opts,
        );
      await withDriver(async (d) => {
        expect((await read(d)).rows).toEqual([['953.6 MiB', 2, '0 bytes', '']]);
      });
      const limited = join(tmp.dir, 'limited.duckdb');
      copyFileSync(file, limited);
      await withDriver(
        async (d) => {
          expect((await read(d)).rows).toEqual([['244.1 MiB', 1, '0 bytes', '']]);
          // Over the memory limit, DuckDB stops instead of spilling next to the database.
          await expect(
            d.readQuery('SELECT count(*) FROM (SELECT DISTINCT range FROM range(50000000))', [], {
              rowLimit: 1,
              timeoutMs: 30_000,
            }),
          ).rejects.toThrow(/Out of Memory/);
          expect(readdirSync(tmp.dir).filter((f) => f.startsWith('limited.duckdb.tmp'))).toEqual(
            [],
          );
        },
        limited,
        { memoryLimit: '256MB', threads: 1 },
      );
      // A setting DuckDB does not apply as asked is caught by the read-back.
      await withDriver(
        async (d) => {
          await expect(d.readQuery('SELECT 1', [], opts)).rejects.toThrow(
            /did not apply apitame's read-only settings \(memory_limit\)/,
          );
        },
        file,
        { memoryLimit: '-1' },
      );
    }, 60_000);

    it('gives the child no environment, so a proxy password never reaches DuckDB', async () => {
      const saved = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY };
      process.env.HTTP_PROXY = 'http://user:hunter2@proxy.example:3128';
      process.env.HTTPS_PROXY = 'http://user:hunter2@proxy.example:3128';
      try {
        await withDriver(async (d) => {
          // Through the driver alone (no lexer or parser): the setting is the placeholder.
          const r = await d.readQuery(
            "SELECT current_setting('http_proxy') AS p, current_setting('http_proxy_password') AS w",
            [],
            opts,
          );
          expect(r.rows).toEqual([['none', '']]);
        });
        const rt = runtime();
        try {
          for (const sql of [
            "SELECT current_setting('http_proxy')",
            "SELECT value FROM duckdb_settings() WHERE name = 'http_proxy'",
            "SELECT setting FROM pg_settings WHERE name = 'http_proxy'",
          ]) {
            const res = await rt.callTool('query', { sql });
            expect(res.isError, sql).toBe(true);
            expect(textOf(res)).not.toMatch(/hunter2/);
          }
        } finally {
          await rt.close();
        }
      } finally {
        if (saved.http === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = saved.http;
        if (saved.https === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = saved.https;
      }
    });

    it('releases the file after a truncated result and after a timeout', async () => {
      const shared = join(tmp.dir, 'shared.duckdb');
      copyFileSync(file, shared);
      // Another program opening the file for writing, as a data job would between calls.
      const writerCanOpen = async () => {
        for (let attempt = 0; attempt < 10; attempt++) {
          const res = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `const { DuckDBInstance } = await import('@duckdb/node-api');
               const db = await DuckDBInstance.create(process.env.DUCK_FILE);
               db.closeSync();`,
            ],
            { cwd: ROOT, env: { ...process.env, DUCK_FILE: shared }, encoding: 'utf8' },
          );
          if (res.status === 0) return true;
          await new Promise((r) => setTimeout(r, 200));
        }
        return false;
      };
      await withDriver(async (d) => {
        const r = await d.readQuery('SELECT * FROM range(1000000)', [], {
          rowLimit: 3,
          timeoutMs: 5_000,
        });
        expect(r.truncated).toBe(true);
        expect(await writerCanOpen()).toBe(true);
        await expect(
          d.readQuery('SELECT count(*) FROM range(100000000000)', [], {
            rowLimit: 1,
            timeoutMs: 300,
          }),
        ).rejects.toThrow(/took longer than 300 ms/);
        expect(await writerCanOpen()).toBe(true);
      }, shared);
    }, 60_000);

    it('the database file itself is reachable by DuckDB, so the name lists refuse its readers', async () => {
      // With external access off, DuckDB still allows the database file and its WAL.
      const db = await duck!.DuckDBInstance.create(file, DUCKDB_READ_ONLY_SETTINGS);
      const conn = await db.connect();
      try {
        const raw = await conn.runAndReadAll(`SELECT size FROM read_blob('${file}')`);
        expect(Number(raw.getRowsJS()[0]?.[0])).toBeGreaterThan(0);
      } finally {
        conn.closeSync();
        db.closeSync();
      }
      for (const sql of [
        `SELECT content FROM read_blob('${file}')`,
        `SELECT * FROM read_text('${file}')`,
        `SELECT count(*) FROM '${file}'`,
        `ATTACH '${file}' AS again (READ_ONLY)`,
      ]) {
        expect(guardSelect(sql, { dialect: 'duckdb', skipParser: true }).ok, sql).toBe(false);
        const parsed = await withDriver((d) =>
          duckdbParserCheck(sql, {}, (q) => d.serializeSelect(q)),
        );
        expect(parsed.ok, sql).toBe(false);
      }
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
        expect(textOf(res)).toMatch(/timed out: it took longer than 300 ms and was stopped/);
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
