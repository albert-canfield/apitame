import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import { createSqliteShop, jsonOf, tempDir, textOf } from '../helpers.js';

const t = tempDir();
const db = join(t.dir, 'shop.db');
beforeAll(() => createSqliteShop(db));
afterAll(() => t.cleanup());
afterEach(() => {
  vi.useRealTimers();
});

const queries = [
  {
    name: 'archive_order',
    description: 'Archive one order',
    write: true,
    sql: "UPDATE orders SET status = 'cancelled' WHERE id = :id",
    params: { id: { type: 'integer' } },
  },
  {
    name: 'touch_order',
    description: 'Touch one order',
    write: true,
    sql: 'UPDATE orders SET status = status WHERE id = :id',
    params: { id: { type: 'integer' } },
  },
  {
    name: 'type_of',
    description: 'The SQL type a value is bound as',
    sql: 'SELECT typeof(:v) AS t',
    params: { v: { type: 'string' } },
  },
];

function runtime(extra: Record<string, unknown> = {}) {
  const config = parseConfig({
    name: 'shop',
    mode: 'read-write',
    source: { type: 'sqlite', path: db },
    writes: { allow: ['archive_order', 'touch_order'], destructive: ['archive_*'] },
    confirmation: { method: 'token' },
    sql: { queries },
    ...extra,
  });
  return new SqlRuntime(config, new SqliteDriver(db), new Redactor());
}

const tokenIn = (out: string) => /"confirm": "([^"]+)"/.exec(out)?.[1];

describe('SQL runtime safety', () => {
  it('applies * patterns in writes.destructive to named queries', async () => {
    const rt = runtime();
    try {
      const tool = rt.listTools().find((x) => x.name === 'archive_order');
      expect(tool?.annotations?.destructiveHint).toBe(true);
      const res = await rt.callTool('archive_order', { id: 1 });
      expect(textOf(res)).toContain('CONFIRMATION REQUIRED');
    } finally {
      await rt.close();
    }
  });

  it('binds the validated, coerced parameter values', async () => {
    const rt = runtime();
    try {
      const out = jsonOf<{ rows: unknown[][] }>(await rt.callTool('type_of', { v: 0 }));
      expect(out.rows[0]?.[0]).toBe('text');
    } finally {
      await rt.close();
    }
  });

  it('refuses dryRun: null instead of writing', async () => {
    const rt = runtime();
    try {
      const res = await rt.callTool('touch_order', { id: 1, dryRun: null });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('"dryRun" must be true or false');
    } finally {
      await rt.close();
    }
  });

  it('does not use up an approval when the write limit is reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rt = runtime({ limits: { maxWritesPerMinute: 1 } });
    try {
      const token = tokenIn(textOf(await rt.callTool('archive_order', { id: 2 })));
      expect(token).toBeTruthy();
      expect((await rt.callTool('touch_order', { id: 1 })).isError).toBeFalsy();
      const limited = await rt.callTool('archive_order', { id: 2, confirm: token });
      expect(textOf(limited)).toContain('Rate limit');
      vi.setSystemTime(Date.now() + 61_000);
      const done = jsonOf<{ affectedRows: number }>(
        await rt.callTool('archive_order', { id: 2, confirm: token }),
      );
      expect(done.affectedRows).toBe(1);
    } finally {
      await rt.close();
    }
  });

  it('caps and redacts list_tables and describe_table', async () => {
    const wide = join(t.dir, 'wide.db');
    const conn = new Database(wide);
    for (let i = 0; i < 80; i++) conn.exec(`CREATE TABLE table_with_a_long_name_${i} (id INTEGER)`);
    conn.exec("CREATE TABLE creds (id INTEGER, header TEXT DEFAULT 'Bearer abcdef123456789')");
    conn.close();
    const config = parseConfig({
      name: 'wide',
      source: { type: 'sqlite', path: wide },
      limits: { maxResponseBytes: 1_000 },
    });
    const rt = new SqlRuntime(config, new SqliteDriver(wide), new Redactor());
    try {
      const listed = textOf(await rt.callTool('list_tables', {}));
      expect(Buffer.byteLength(listed)).toBeLessThan(1_400);
      expect(listed).toContain('truncated');
      const described = textOf(await rt.callTool('describe_table', { table: 'creds' }));
      expect(described).not.toContain('abcdef123456789');
    } finally {
      await rt.close();
    }
  });
});
