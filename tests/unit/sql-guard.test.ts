import { describe, expect, it } from 'vitest';
import {
  analyzeWrite,
  bindNamedParams,
  guardSelect,
  isDeniedFunction,
} from '../../src/sources/sql/guard.js';
import type { Dialect } from '../../src/sources/sql/lexer.js';

const dialects: Dialect[] = ['postgres', 'sqlite', 'mysql'];

const allowed = (sql: string, dialect: Dialect) => guardSelect(sql, { dialect });

describe.each(dialects)('guardSelect (%s): valid reads pass', (dialect) => {
  it.each([
    'SELECT 1',
    'select * from orders',
    "SELECT id, total FROM orders WHERE status = 'paid' ORDER BY total DESC LIMIT 10",
    'SELECT c.name, count(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name HAVING count(*) > 2',
    'WITH recent AS (SELECT * FROM orders WHERE total > 100) SELECT count(*) FROM recent',
    "SELECT * FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE country = 'GB')",
    'SELECT 1 UNION ALL SELECT 2',
    'SELECT * FROM orders;',
    'SELECT * FROM orders; -- trailing comment',
    'SELECT "update" FROM t',
    "SELECT 'DROP TABLE x; DELETE FROM y' AS harmless_string",
    "SELECT name FROM customers WHERE name LIKE '%; DELETE%'",
    '/* leading comment */ SELECT 1',
  ])('%s', (sql) => {
    const r = allowed(sql, dialect);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });
});

describe.each(dialects)('guardSelect (%s): writes and tricks are refused', (dialect) => {
  it.each([
    ['plain delete', 'DELETE FROM orders'],
    ['update', "UPDATE orders SET status = 'paid'"],
    ['insert', 'INSERT INTO orders (id) VALUES (1)'],
    ['drop', 'DROP TABLE orders'],
    ['truncate', 'TRUNCATE orders'],
    ['alter', 'ALTER TABLE orders ADD COLUMN x int'],
    ['create', 'CREATE TABLE x (id int)'],
    ['grant', 'GRANT ALL ON orders TO public'],
    ['stacked statement', 'SELECT 1; DROP TABLE orders'],
    ['stacked after comment', 'SELECT 1; /* hi */ DELETE FROM orders'],
    ['commit escape (reference server bypass)', 'COMMIT; DROP SCHEMA public CASCADE;'],
    ['rollback escape', 'ROLLBACK; DELETE FROM orders'],
    ['select then commit', 'SELECT 1; COMMIT'],
    ['data-modifying CTE', 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d'],
    [
      'insert in CTE',
      'WITH i AS (INSERT INTO orders (id) VALUES (9) RETURNING id) SELECT * FROM i',
    ],
    ['select into', 'SELECT * INTO backup FROM orders'],
    ['explain analyze executes', 'EXPLAIN ANALYZE DELETE FROM orders'],
    ['empty', '   '],
    ['comment only', '-- nothing'],
    ['unterminated string', "SELECT 'abc"],
    ['unterminated comment', 'SELECT 1 /* never closed'],
    ['nul byte', 'SELECT 1\u0000; DROP TABLE x'],
    ['pragma', 'PRAGMA writable_schema = 1'],
    ['attach', "ATTACH DATABASE '/tmp/x.db' AS x"],
    ['parameter placeholder', 'SELECT * FROM orders WHERE id = ?'],
  ])('%s', (_name, sql) => {
    const r = allowed(sql, dialect);
    expect(r.ok).toBe(false);
  });
});

describe('guardSelect: parser and database disagree (differential attacks)', () => {
  it('postgres: backslash is not an escape in standard strings, so a hidden second statement is caught', () => {
    // The SQL parser reads one string literal here; PostgreSQL reads two statements.
    const r = guardSelect("SELECT '\\'; DELETE FROM orders; --'", { dialect: 'postgres' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/one statement/i);
  });

  it('sqlite: same trick is caught', () => {
    const r = guardSelect("SELECT '\\'; DELETE FROM orders; --'", { dialect: 'sqlite' });
    expect(r.ok).toBe(false);
  });

  it('postgres: E-strings do use backslash escapes, so this one is a single harmless string', () => {
    const r = guardSelect("SELECT E'\\'; DELETE FROM orders; --'", { dialect: 'postgres' });
    // Either refused by the parser (fail closed) or accepted as one SELECT; never two statements.
    if (r.ok) expect(r.sql).toBe("SELECT E'\\'; DELETE FROM orders; --'");
  });

  it('postgres: nested block comments are honoured', () => {
    const r = guardSelect('SELECT 1 /* outer /* inner */ ; DELETE FROM orders; */', {
      dialect: 'postgres',
    });
    // PostgreSQL sees one SELECT and a comment. Accepting it is correct; it must not be two statements.
    if (r.ok) expect(r.sql.startsWith('SELECT 1')).toBe(true);
  });

  it('sqlite: block comments do not nest, so the same text hides a DELETE and is refused', () => {
    const r = guardSelect('SELECT 1 /* outer /* inner */ ; DELETE FROM orders; */', {
      dialect: 'sqlite',
    });
    expect(r.ok).toBe(false);
  });

  it('postgres: $1 placeholders are refused in ad-hoc queries', () => {
    expect(guardSelect('SELECT * FROM orders WHERE id = $1', { dialect: 'postgres' }).ok).toBe(
      false,
    );
  });

  it('postgres: dollar-quoted strings are strings, and cannot hide a second statement', () => {
    const inside = guardSelect('SELECT $$; DELETE FROM orders; $$', { dialect: 'postgres' });
    // Accepted as one SELECT of a string, or refused by the parser. Never run as two statements.
    if (inside.ok) expect(inside.sql).toBe('SELECT $$; DELETE FROM orders; $$');
    expect(guardSelect('SELECT $x$ $$ $x$; DELETE FROM orders', { dialect: 'postgres' }).ok).toBe(
      false,
    );
  });

  it('a function hidden from the parser inside a fake string is still seen by the lexer', () => {
    const r = guardSelect("SELECT '\\', pg_terminate_backend(1) --'", { dialect: 'postgres' });
    expect(r.ok).toBe(false);
  });
});

describe('guardSelect: dangerous functions and catalogs', () => {
  it.each([
    'SELECT pg_sleep(100)',
    'SELECT pg_terminate_backend(123)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM pg_ls_dir('.')",
    "SELECT set_config('statement_timeout', '0', false)",
    "SELECT nextval('orders_id_seq')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT query_to_xml('delete from orders', true, true, '')",
    "SELECT dblink_exec('dbname=x', 'drop table y')",
    'SELECT pg_catalog.pg_sleep(1)',
    'SELECT pg_advisory_lock(1)',
    "SELECT pg_notify('ch', 'x')",
    'SELECT * FROM pg_shadow',
    'SELECT * FROM pg_authid',
    'SELECT query FROM pg_stat_activity',
    'SELECT * FROM pg_user_mappings',
    'SELECT query FROM pg_stat_statements',
    'SELECT * FROM information_schema.user_mapping_options',
  ])('postgres refuses %s', (sql) => {
    expect(guardSelect(sql, { dialect: 'postgres' }).ok).toBe(false);
  });

  it.each([
    "SELECT load_extension('/tmp/evil.so')",
    "SELECT readfile('/etc/passwd')",
    "SELECT writefile('/tmp/x', 'y')",
  ])('sqlite refuses %s', (sql) => {
    expect(guardSelect(sql, { dialect: 'sqlite' }).ok).toBe(false);
  });

  it('common functions stay allowed', () => {
    for (const sql of [
      "SELECT lower(name), upper(name), replace(name, 'a', 'b'), length(name) FROM customers",
      'SELECT coalesce(NULL, 1), round(2.5), abs(-1)',
    ]) {
      const r = guardSelect(sql, { dialect: 'postgres' });
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    }
    expect(isDeniedFunction('lower')).toBe(false);
    expect(isDeniedFunction('PG_SLEEP')).toBe(true);
  });
});

describe('guardSelect: table allow and deny lists', () => {
  it('denies configured tables, including through joins and subqueries', () => {
    const opts = { dialect: 'postgres' as const, denyTables: ['secrets'] };
    expect(guardSelect('SELECT * FROM secrets', opts).ok).toBe(false);
    expect(guardSelect('SELECT * FROM orders o JOIN secrets s ON s.id = o.id', opts).ok).toBe(
      false,
    );
    expect(
      guardSelect('SELECT * FROM orders WHERE id IN (SELECT id FROM public.secrets)', opts).ok,
    ).toBe(false);
    expect(guardSelect('SELECT * FROM orders', opts).ok).toBe(true);
  });

  it('allow list limits queries to listed tables, but CTE names are fine', () => {
    const opts = { dialect: 'postgres' as const, allowTables: ['orders', 'customers'] };
    expect(guardSelect('SELECT * FROM orders JOIN customers ON true', opts).ok).toBe(true);
    expect(guardSelect('WITH x AS (SELECT * FROM orders) SELECT * FROM x', opts).ok).toBe(true);
    expect(guardSelect('SELECT * FROM products', opts).ok).toBe(false);
  });

  it('returns the referenced tables', () => {
    const r = guardSelect(
      'SELECT * FROM orders o JOIN public.customers c ON c.id = o.customer_id',
      { dialect: 'postgres' },
    );
    expect(r.ok && r.tables).toEqual(['orders', 'public.customers']);
  });
});

describe('guardSelect: limits', () => {
  it('refuses very long queries', () => {
    expect(guardSelect(`SELECT ${'1,'.repeat(20_000)}1`, { dialect: 'postgres' }).ok).toBe(false);
  });

  it('strips trailing semicolons and comments from the SQL sent to the database', () => {
    const r = guardSelect('SELECT 1 ;  -- done', { dialect: 'postgres' });
    expect(r.ok && r.sql).toBe('SELECT 1');
  });
});

describe('analyzeWrite', () => {
  it('classifies destructive statements', () => {
    expect(analyzeWrite('DELETE FROM orders WHERE id = :id', 'postgres')).toMatchObject({
      ok: true,
      kind: 'DELETE',
      destructive: true,
    });
    expect(analyzeWrite("UPDATE orders SET status = 'paid'", 'postgres')).toMatchObject({
      kind: 'UPDATE',
      destructive: true,
    });
    expect(
      analyzeWrite("UPDATE orders SET status = 'paid' WHERE id = :id", 'postgres'),
    ).toMatchObject({ kind: 'UPDATE', destructive: false });
    expect(analyzeWrite('INSERT INTO orders (id) VALUES (:id)', 'sqlite')).toMatchObject({
      kind: 'INSERT',
      destructive: false,
    });
    expect(analyzeWrite('DROP TABLE orders', 'postgres')).toMatchObject({
      kind: 'DROP',
      destructive: true,
    });
    expect(analyzeWrite('TRUNCATE orders', 'postgres')).toMatchObject({ destructive: true });
  });

  it('finds the statement after a CTE and ignores WHERE inside subqueries', () => {
    expect(
      analyzeWrite(
        'WITH x AS (SELECT id FROM t WHERE a = 1) UPDATE orders SET status = 1',
        'postgres',
      ),
    ).toMatchObject({
      kind: 'UPDATE',
      destructive: true,
    });
  });

  it('refuses multiple statements', () => {
    expect(analyzeWrite('UPDATE a SET x = 1 WHERE id = 1; DELETE FROM b', 'postgres').ok).toBe(
      false,
    );
  });
});

describe('bindNamedParams', () => {
  it('rewrites :name to $n for postgres, reusing numbers, and keeps casts', () => {
    const r = bindNamedParams(
      "SELECT * FROM t WHERE a = :x AND b = :y AND c = :x AND d::text = ':not_a_param'",
      'postgres',
      { x: 1, y: 'two' },
    );
    expect(r.sql).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $1 AND d::text = ':not_a_param'",
    );
    expect(r.params).toEqual([1, 'two']);
  });

  it('keeps :name for sqlite and binds by name', () => {
    const r = bindNamedParams('SELECT * FROM t WHERE a = :x', 'sqlite', { x: 5 });
    expect(r.sql).toBe('SELECT * FROM t WHERE a = :x');
    expect(r.params).toEqual({ x: 5 });
  });
});

describe('guardSelect: MySQL specifics', () => {
  const my = (sql: string) => guardSelect(sql, { dialect: 'mysql' });

  it('refuses executable comments and optimizer hints, which MySQL runs', () => {
    expect(my('SELECT 1 /*!50000 , SLEEP(10) */').ok).toBe(false);
    expect(my('SELECT 1 /*! ; DELETE FROM orders */').ok).toBe(false);
    expect(my('SELECT /*+ MAX_EXECUTION_TIME(100000000) */ * FROM orders').ok).toBe(false);
  });

  it('only treats "--" as a comment when whitespace follows, like MySQL', () => {
    expect(my('SELECT 1 --; DELETE FROM orders').ok).toBe(false);
    const r = my('SELECT 1 -- ; DELETE FROM orders');
    expect(r.ok && r.sql).toBe('SELECT 1');
  });

  it('understands # comments and backslash escapes', () => {
    const hash = my('SELECT 1 # ; DELETE FROM orders');
    expect(hash.ok && hash.sql).toBe('SELECT 1');
    // In MySQL this is one string, so it is one harmless statement.
    const bs = my("SELECT 'a\\'; DELETE FROM orders; -- '");
    expect(bs.ok).toBe(true);
    const dq = my('SELECT "a\\"; DELETE FROM orders; -- "');
    expect(dq.ok).toBe(true);
  });

  it('refuses MySQL side-effect functions, locking reads, file export and system schemas', () => {
    for (const sql of [
      'SELECT SLEEP(5)',
      'SELECT BENCHMARK(100000000, MD5(1))',
      "SELECT LOAD_FILE('/etc/passwd')",
      "SELECT GET_LOCK('x', 10)",
      'SELECT * FROM orders LOCK IN SHARE MODE',
      'SELECT * FROM orders FOR SHARE',
      "SELECT * FROM orders INTO OUTFILE '/tmp/x'",
      'SELECT user, authentication_string FROM mysql.user',
      'SELECT * FROM performance_schema.events_statements_history',
      'SELECT * FROM `mysql`.`user`',
      'SELECT info FROM information_schema.processlist',
    ]) {
      expect(my(sql).ok, sql).toBe(false);
    }
  });

  it('accepts backtick identifiers and user variables', () => {
    expect(my('SELECT `order`, `select` FROM `orders` WHERE id = 1').ok).toBe(true);
    expect(my('SELECT @@version').ok).toBe(true);
  });

  it('binds named parameters as positional placeholders', () => {
    const r = bindNamedParams('SELECT * FROM t WHERE a = :x AND b = :y OR c = :x', 'mysql', {
      x: 1,
      y: 'two',
    });
    expect(r).toEqual({
      sql: 'SELECT * FROM t WHERE a = ? AND b = ? OR c = ?',
      params: [1, 'two', 1],
    });
  });

  it('treats RENAME as destructive', () => {
    expect(analyzeWrite('RENAME TABLE a TO b', 'mysql')).toMatchObject({
      kind: 'RENAME',
      destructive: true,
    });
  });
});
