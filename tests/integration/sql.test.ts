import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import type { SqlDriver } from '../../src/sources/sql/driver.js';
import { PostgresDriver } from '../../src/sources/sql/postgres.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import { createSqliteShop, jsonOf, startPostgresShop, tempDir, textOf } from '../helpers.js';

interface Target {
  name: 'sqlite' | 'postgres';
  driver: () => SqlDriver;
  count: (table: string) => Promise<number>;
  url?: string;
}

type NamedQueries = NonNullable<NonNullable<ConfigInput['sql']>['queries']>;

const tmp = tempDir();
let pg: Awaited<ReturnType<typeof startPostgresShop>>;
const sqliteFile = join(tmp.dir, 'shop.db');

beforeAll(async () => {
  createSqliteShop(sqliteFile);
  pg = await startPostgresShop();
});

afterAll(async () => {
  await pg.close();
  tmp.cleanup();
});

const targets: Target[] = [
  {
    name: 'sqlite',
    driver: () => new SqliteDriver(sqliteFile),
    count: async (table) => {
      const db = new Database(sqliteFile, { readonly: true });
      const n = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      db.close();
      return n;
    },
  },
  {
    name: 'postgres',
    driver: () => new PostgresDriver(pg.url, ['public'], 5_000),
    count: async (table) => {
      const d = new PostgresDriver(pg.url, ['public']);
      const r = await d.readQuery(`SELECT count(*) FROM ${table}`, [], {
        rowLimit: 1,
        timeoutMs: 5_000,
      });
      await d.close();
      return Number(r.rows[0]![0]);
    },
  },
];

function config(
  type: 'sqlite' | 'postgres',
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
      type === 'sqlite'
        ? { type: 'sqlite', path: sqliteFile }
        : { type: 'postgres', url: '${DATABASE_URL}' },
    limits: { rowLimit: 25, timeoutMs: 3_000 },
    ...(overrides as Partial<ConfigInput>),
  });
}

describe.each(targets)('SQL runtime on $name', (target) => {
  const withRuntime = async (
    overrides: Parameters<typeof config>[1],
    fn: (rt: SqlRuntime) => Promise<void>,
  ) => {
    const rt = new SqlRuntime(config(target.name, overrides), target.driver(), new Redactor());
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
        "SELECT '\\'; DELETE FROM orders; --'",
        'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
        'SELECT * INTO backup FROM orders',
      ];
      for (const sql of attacks) {
        const res = await rt.callTool('query', { sql });
        expect(res.isError, `${sql} -> ${textOf(res)}`).toBe(true);
      }
      // Comments nest in PostgreSQL (so this is one harmless SELECT) but not in SQLite (two statements: refused).
      const nested = await rt.callTool('query', {
        sql: 'SELECT 1 /* x /* y */ ; DELETE FROM orders; */',
      });
      if (target.name === 'sqlite') expect(nested.isError).toBe(true);
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
      await expect(
        driver.readQuery("SELECT '\\'; DELETE FROM order_items; --'", [], {
          rowLimit: 5,
          timeoutMs: 3_000,
        }),
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
