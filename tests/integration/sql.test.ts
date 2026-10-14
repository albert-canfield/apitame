import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import type { SqlDriver } from '../../src/sources/sql/driver.js';
import { MysqlDriver } from '../../src/sources/sql/mysql.js';
import { PostgresDriver } from '../../src/sources/sql/postgres.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import {
  createSqliteShop,
  jsonOf,
  setupMysqlServer,
  setupPostgresServer,
  startPostgresShop,
  tempDir,
  textOf,
} from '../helpers.js';

type Dialect = 'sqlite' | 'postgres' | 'mysql';

interface Target {
  name: string;
  dialect: Dialect;
  /** PGlite does not enforce statement_timeout; real servers do. */
  realServer: boolean;
  driver: () => SqlDriver;
  count: (table: string) => Promise<number>;
}

type NamedQueries = NonNullable<NonNullable<ConfigInput['sql']>['queries']>;

const tmp = tempDir();
let pg: Awaited<ReturnType<typeof startPostgresShop>>;
const sqliteFile = join(tmp.dir, 'shop.db');

// Real servers are opt-in (CI starts them as service containers).
const PG_SERVER = process.env.APITAME_TEST_POSTGRES_URL;
const MYSQL_SERVER = process.env.APITAME_TEST_MYSQL_URL;
let pgServer: Awaited<ReturnType<typeof setupPostgresServer>> | undefined;
let mysqlServer: Awaited<ReturnType<typeof setupMysqlServer>> | undefined;

beforeAll(async () => {
  createSqliteShop(sqliteFile);
  pg = await startPostgresShop();
  if (PG_SERVER) pgServer = await setupPostgresServer(PG_SERVER);
  if (MYSQL_SERVER) mysqlServer = await setupMysqlServer(MYSQL_SERVER);
}, 120_000);

afterAll(async () => {
  await pg.close();
  tmp.cleanup();
});

async function countWith(driver: SqlDriver, table: string): Promise<number> {
  try {
    const r = await driver.readQuery(`SELECT count(*) FROM ${table}`, [], {
      rowLimit: 1,
      timeoutMs: 5_000,
    });
    return Number(r.rows[0]![0]);
  } finally {
    await driver.close();
  }
}

const targets: Target[] = [
  {
    name: 'sqlite',
    dialect: 'sqlite',
    realServer: false,
    driver: () => new SqliteDriver(sqliteFile),
    count: async (table) => {
      const db = new Database(sqliteFile, { readonly: true });
      const n = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      db.close();
      return n;
    },
  },
  {
    name: 'postgres (PGlite)',
    dialect: 'postgres',
    realServer: false,
    driver: () => new PostgresDriver(pg.url, ['public'], 5_000),
    count: (table) => countWith(new PostgresDriver(pg.url, ['public']), table),
  },
  ...(PG_SERVER
    ? [
        {
          name: 'postgres (server)',
          dialect: 'postgres' as const,
          realServer: true,
          driver: () => new PostgresDriver(pgServer!.url, ['public'], 5_000),
          count: (table: string) => countWith(new PostgresDriver(pgServer!.url, ['public']), table),
        },
      ]
    : []),
  ...(MYSQL_SERVER
    ? [
        {
          name: 'mysql (server)',
          dialect: 'mysql' as const,
          realServer: true,
          driver: () => new MysqlDriver(mysqlServer!.url),
          count: (table: string) => countWith(new MysqlDriver(mysqlServer!.url), table),
        },
      ]
    : []),
];

function config(
  type: Dialect,
  overrides: Omit<Partial<ConfigInput>, 'sql'> & {
    sql?: {
      queries?: readonly NamedQueries[number][];
      tables?: { allow?: string[]; deny?: string[] };
    };
  } = {},
) {
  return parseConfig({
    name: 'shop',
    source:
      type === 'sqlite' ? { type: 'sqlite', path: sqliteFile } : { type, url: '${DATABASE_URL}' },
    limits: { rowLimit: 25, timeoutMs: 3_000 },
    ...(overrides as Partial<ConfigInput>),
  });
}

describe.each(targets)('SQL runtime on $name', (target) => {
  const withRuntime = async (
    overrides: Parameters<typeof config>[1],
    fn: (rt: SqlRuntime) => Promise<void>,
  ) => {
    const rt = new SqlRuntime(config(target.dialect, overrides), target.driver(), new Redactor());
    try {
      await fn(rt);
    } finally {
      await rt.close();
    }
  };

  it('lists and describes tables, with foreign keys', async () => {
    await withRuntime({}, async (rt) => {
      const tables = jsonOf<{ tables: Array<{ name: string }> }>(
        await rt.callTool('list_tables', {}),
      ).tables.map((t) => t.name);
      const bare = tables.map((t) => t.replace(/^public\./, ''));
      expect(bare).toEqual(
        expect.arrayContaining(['customers', 'orders', 'order_items', 'products']),
      );

      const d = jsonOf<{
        columns: Array<{ name: string; pk?: boolean }>;
        primaryKey: string[];
        foreignKeys: Array<{ columns: string[]; references: { table: string } }>;
      }>(await rt.callTool('describe_table', { table: 'orders' }));
      expect(d.primaryKey).toEqual(['id']);
      expect(d.columns.map((c) => c.name)).toEqual([
        'id',
        'customer_id',
        'status',
        'total',
        'created_at',
      ]);
      expect(d.foreignKeys[0]).toMatchObject({ columns: ['customer_id'] });
      expect(d.foreignKeys[0]!.references.table).toMatch(/customers$/);

      expect((await rt.callTool('describe_table', { table: 'nope' })).isError).toBe(true);
    });
  });

  it('runs SELECT queries with a row limit', async () => {
    await withRuntime({}, async (rt) => {
      const r = jsonOf<{ columns: string[]; rows: unknown[][]; truncated?: boolean }>(
        await rt.callTool('query', { sql: 'SELECT id, status FROM orders ORDER BY id' }),
      );
      expect(r.columns).toEqual(['id', 'status']);
      expect(r.rows).toHaveLength(25);
      expect(r.truncated).toBe(true);

      const small = jsonOf<{ rows: unknown[][] }>(
        await rt.callTool('query', { sql: 'SELECT id FROM orders ORDER BY id', limit: 3 }),
      );
      expect(small.rows).toEqual([[1], [2], [3]]);

      const joined = jsonOf<{ rows: unknown[][] }>(
        await rt.callTool('query', {
          sql: 'SELECT c.country, count(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.country ORDER BY n DESC',
        }),
      );
      expect(joined.rows.length).toBeGreaterThan(1);
    });
  });

  it('refuses every write and injection attempt, and the data stays intact', async () => {
    const before = await target.count('orders');
    await withRuntime({}, async (rt) => {
      const attacks = [
        'DELETE FROM orders',
        "UPDATE orders SET status = 'cancelled'",
        'DROP TABLE orders',
        'COMMIT; DROP TABLE orders;',
        'SELECT 1; DELETE FROM orders',
        'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
        'SELECT * INTO backup FROM orders',
        ...(target.dialect === 'mysql'
          ? [
              'SELECT 1 /*!50000 , (SELECT COUNT(*) FROM orders) */',
              'SELECT 1 --; DELETE FROM orders',
            ]
          : ["SELECT '\\'; DELETE FROM orders; --'"]),
      ];
      for (const sql of attacks) {
        const res = await rt.callTool('query', { sql });
        expect(res.isError, `${sql} -> ${textOf(res)}`).toBe(true);
      }
      // Comments nest in PostgreSQL (one harmless SELECT) but not in SQLite or MySQL (two statements: refused).
      const nested = await rt.callTool('query', {
        sql: 'SELECT 1 /* x /* y */ ; DELETE FROM orders; */',
      });
      if (target.dialect !== 'postgres') expect(nested.isError).toBe(true);
      else expect(jsonOf<{ rows: unknown[][] }>(nested).rows).toEqual([[1]]);
    });
    expect(await target.count('orders')).toBe(before);
  });

  it('enforces read-only at the database level even if a write reaches the driver', async () => {
    const driver = target.driver();
    try {
      await expect(
        driver.readQuery('DELETE FROM order_items', [], { rowLimit: 5, timeoutMs: 3_000 }),
      ).rejects.toThrow();
      const stacked =
        target.dialect === 'mysql'
          ? 'SELECT 1; DELETE FROM order_items'
          : "SELECT '\\'; DELETE FROM order_items; --'";
      await expect(
        driver.readQuery(stacked, [], { rowLimit: 5, timeoutMs: 3_000 }),
      ).rejects.toThrow();
    } finally {
      await driver.close();
    }
    expect(await target.count('order_items')).toBeGreaterThan(100);
  });

  it('applies table allow and deny lists to every tool', async () => {
    await withRuntime({ sql: { tables: { deny: ['customers'] } } }, async (rt) => {
      const tables = jsonOf<{ tables: Array<{ name: string }> }>(
        await rt.callTool('list_tables', {}),
      ).tables.map((t) => t.name);
      expect(tables.some((t) => t.endsWith('customers'))).toBe(false);
      expect((await rt.callTool('describe_table', { table: 'customers' })).isError).toBe(true);
      expect((await rt.callTool('query', { sql: 'SELECT * FROM customers' })).isError).toBe(true);
      expect(
        (
          await rt.callTool('query', {
            sql: 'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id',
          })
        ).isError,
      ).toBe(true);
    });
  });

  it('runs named read queries with bound parameters', async () => {
    const queries = [
      {
        name: 'orders_by_status',
        description: 'Orders with a status',
        sql: 'SELECT id, total FROM orders WHERE status = :status ORDER BY id LIMIT :n',
        params: { status: { type: 'string' }, n: { type: 'integer' } },
      },
    ] as const satisfies NamedQueries;
    await withRuntime({ sql: { queries } }, async (rt) => {
      const tool = rt.listTools().find((t) => t.name === 'orders_by_status')!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      const r = jsonOf<{ rows: unknown[][] }>(
        await rt.callTool('orders_by_status', { status: 'paid', n: 2 }),
      );
      expect(r.rows).toHaveLength(2);
      // Injection through a parameter is just a string value.
      const inj = jsonOf<{ rows: unknown[][] }>(
        await rt.callTool('orders_by_status', { status: "paid' OR '1'='1", n: 50 }),
      );
      expect(inj.rows).toHaveLength(0);
    });
  });

  it('named write queries: hidden in read-only mode, dry run and confirmation in read-write mode', async () => {
    const queries = [
      {
        name: 'cancel_order',
        description: 'Cancel one order',
        sql: "UPDATE orders SET status = 'cancelled' WHERE id = :id",
        params: { id: { type: 'integer' } },
        write: true,
      },
      {
        name: 'purge_cancelled',
        description: 'Delete cancelled orders items',
        sql: "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'cancelled')",
        write: true,
      },
    ] as const satisfies NamedQueries;
    await withRuntime(
      { sql: { queries }, writes: { allow: ['cancel_order', 'purge_cancelled'] } },
      async (rt) => {
        expect(rt.listTools().map((t) => t.name)).not.toContain('cancel_order');
        expect(rt.blockedQueries().map((b) => b.name)).toEqual(['cancel_order', 'purge_cancelled']);
      },
    );

    const itemsBefore = await target.count('order_items');
    await withRuntime(
      {
        mode: 'read-write',
        sql: { queries },
        writes: { allow: ['cancel_order', 'purge_cancelled'] },
      },
      async (rt) => {
        const tools = rt.listTools();
        expect(tools.find((t) => t.name === 'cancel_order')!.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: false,
        });
        expect(tools.find((t) => t.name === 'purge_cancelled')!.annotations).toMatchObject({
          destructiveHint: true,
        });

        const dry = jsonOf<{ dryRun: boolean; wouldAffectRows: number }>(
          await rt.callTool('purge_cancelled', { dryRun: true }),
        );
        expect(dry.dryRun).toBe(true);
        expect(dry.wouldAffectRows).toBeGreaterThan(0);
        expect(await target.count('order_items')).toBe(itemsBefore);

        const challenge = await rt.callTool('purge_cancelled', {});
        expect(textOf(challenge)).toMatch(/CONFIRMATION REQUIRED/);
        expect(textOf(challenge)).toMatch(/Rows that would be affected now: \d+/);
        expect(await target.count('order_items')).toBe(itemsBefore);

        const token = /"confirm": "(confirm_[^"]+)"/.exec(textOf(challenge))![1]!;
        const done = jsonOf<{ affectedRows: number }>(
          await rt.callTool('purge_cancelled', { confirm: token }),
        );
        expect(done.affectedRows).toBe(dry.wouldAffectRows);
        expect(await target.count('order_items')).toBe(itemsBefore - dry.wouldAffectRows);

        // dryRun fails closed: the string "true" is a dry run, other non-booleans are refused.
        const asString = jsonOf<{ dryRun?: boolean; affectedRows?: number }>(
          await rt.callTool('cancel_order', { id: 1, dryRun: 'true' }),
        );
        expect(asString.dryRun).toBe(true);
        expect(asString.affectedRows).toBeUndefined();
        const refused = await rt.callTool('cancel_order', { id: 1, dryRun: 1 });
        expect(refused.isError).toBe(true);
        expect(textOf(refused)).toContain('"dryRun" must be true or false');

        const updated = jsonOf<{ affectedRows: number }>(
          await rt.callTool('cancel_order', { id: 1 }),
        );
        expect(updated.affectedRows).toBe(1);
      },
    );
  });

  it('skips named queries that are not what they claim', async () => {
    const queries = [
      { name: 'sneaky', description: 'Looks like a read', sql: 'DELETE FROM orders' },
      {
        name: 'missing_param',
        description: 'Uses an undeclared parameter',
        sql: 'SELECT * FROM orders WHERE id = :id',
      },
    ];
    await withRuntime({ sql: { queries } }, async (rt) => {
      expect(rt.listTools().map((t) => t.name)).not.toContain('sneaky');
      expect(rt.warnings.join('\n')).toMatch(/sneaky/);
      expect(rt.warnings.join('\n')).toMatch(/missing_param.*id/);
    });
  });
});

describe('timeouts', () => {
  it('sqlite: a runaway query is stopped and the next query still works', async () => {
    const rt = new SqlRuntime(
      config('sqlite', { limits: { timeoutMs: 300, rowLimit: 10 } }),
      new SqliteDriver(sqliteFile),
      new Redactor(),
    );
    try {
      const started = Date.now();
      const res = await rt.callTool('query', {
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/timed out/);
      expect(Date.now() - started).toBeLessThan(5_000);
      const ok = await rt.callTool('query', { sql: 'SELECT count(*) FROM orders' });
      expect(ok.isError).toBeUndefined();
    } finally {
      await rt.close();
    }
  });
});

describe('secrets', () => {
  it('never shows the database password in errors', async () => {
    const redactor = new Redactor();
    redactor.addSecret('secret-pg-password');
    const badUrl = pg.url.replace(/:\d+\//, ':1/');
    const rt = new SqlRuntime(
      config('postgres'),
      new PostgresDriver(badUrl, ['public'], 2_000),
      redactor,
    );
    try {
      const res = await rt.callTool('list_tables', {});
      expect(res.isError).toBe(true);
      expect(textOf(res)).not.toContain('secret-pg-password');
    } finally {
      await rt.close();
    }
  });
});

describe.runIf(Boolean(PG_SERVER || MYSQL_SERVER))('real database servers', () => {
  it.runIf(Boolean(PG_SERVER))('postgres: statement_timeout cancels a slow query', async () => {
    const rt = new SqlRuntime(
      config('postgres', { limits: { timeoutMs: 300, rowLimit: 10 } }),
      new PostgresDriver(pgServer!.url, ['public'], 300),
      new Redactor(),
    );
    try {
      const res = await rt.callTool('query', {
        sql: 'SELECT count(*) FROM generate_series(1, 2000000000)',
      });
      expect(textOf(res)).toMatch(/timed out/);
      expect((await rt.callTool('query', { sql: 'SELECT 1' })).isError).toBeUndefined();
    } finally {
      await rt.close();
    }
  });

  it.runIf(Boolean(MYSQL_SERVER))('mysql: max_execution_time cancels a slow query', async () => {
    const rt = new SqlRuntime(
      config('mysql', { limits: { timeoutMs: 300, rowLimit: 10 } }),
      new MysqlDriver(mysqlServer!.url),
      new Redactor(),
    );
    try {
      const res = await rt.callTool('query', {
        sql: 'SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
      });
      expect(textOf(res)).toMatch(/timed out/);
      expect((await rt.callTool('query', { sql: 'SELECT 1' })).isError).toBeUndefined();
    } finally {
      await rt.close();
    }
  });

  it.runIf(Boolean(PG_SERVER))('postgres: a read-only role is recognised', async () => {
    const admin = new PostgresDriver(pgServer!.url, ['public']);
    const ro = new PostgresDriver(pgServer!.readOnlyUrl, ['public']);
    try {
      expect((await admin.privileges()).canWrite).toBe(true);
      expect(await ro.privileges()).toEqual({
        canWrite: false,
        detail: 'role "apitame_ro" has no write privileges',
      });
    } finally {
      await admin.close();
      await ro.close();
    }
  });

  it.runIf(Boolean(MYSQL_SERVER))(
    'mysql: a read-only user is recognised, and the DDL dry run is refused',
    async () => {
      const admin = new MysqlDriver(mysqlServer!.url);
      const ro = new MysqlDriver(mysqlServer!.readOnlyUrl);
      try {
        expect((await admin.privileges()).canWrite).toBe(true);
        expect((await ro.privileges()).canWrite).toBe(false);
        await expect(
          admin.writeQuery('DROP TABLE order_items', [], { timeoutMs: 3_000, dryRun: true }),
        ).rejects.toThrow(/DDL/);
        expect(await countWith(new MysqlDriver(mysqlServer!.url), 'order_items')).toBeGreaterThan(
          100,
        );
      } finally {
        await admin.close();
        await ro.close();
      }
    },
  );
});

describe('privileges', () => {
  it('postgres: reports a role that could write', async () => {
    const driver = new PostgresDriver(pg.url, ['public'], 5_000);
    try {
      const p = await driver.privileges();
      expect(p.canWrite).toBe(true);
      expect(p.detail).toMatch(/superuser|can write/);
    } finally {
      await driver.close();
    }
  });
});
