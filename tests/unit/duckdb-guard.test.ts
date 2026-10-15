import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../../src/config/load.js';
import { bindNamedParams, guardSelect } from '../../src/sources/sql/guard.js';
import { splitStatements, tokenize } from '../../src/sources/sql/lexer.js';

// Layer 1 on its own: the DuckDB lexer rules, with no DuckDB needed.
const lex = (sql: string, extra: { denyTables?: string[] } = {}) =>
  guardSelect(sql, { dialect: 'duckdb', skipParser: true, ...extra });

describe('DuckDB lexer (layer 1): valid reads pass', () => {
  it.each([
    'SELECT 1',
    'FROM orders LIMIT 5',
    'FROM orders SELECT id, total',
    'SELECT * EXCLUDE (status) FROM orders',
    'SELECT status, count(*) FROM orders GROUP BY ALL',
    'SELECT id, row_number() OVER (PARTITION BY status ORDER BY total DESC) AS rn FROM orders QUALIFY rn = 1',
    "SELECT EXTRACT(year FROM created_at), trim(both 'x' FROM status), substring(status FROM 1 FOR 2) FROM orders",
    "SELECT EXTRACT(year FROM '2026-01-02'::DATE)",
    'SELECT * FROM range(3) r(x), generate_series(1, 2) g(y)',
    'SELECT * FROM unnest([1, 2, 3]) t(x)',
    "SELECT list_transform([1, 2], x -> x + 1), [y FOR y IN [1, 2] IF y > 1], {'a': 1}",
    'SELECT x FROM (SELECT [1, 2, 3] AS l, 1 AS a, 2 AS b) t, LATERAL (SELECT l[a:b] AS x)',
    'SELECT j: 42',
    'SELECT 1 /* a /* nested */ comment */',
    'SELECT $$a;b$$, $tag$c;d$tag$',
    "SELECT E'it\\'s'",
    "SELECT * FROM orders PIVOT (count(*) FOR status IN ('paid', 'shipped'))",
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT * FROM c',
    'SELECT * FROM "orders"',
    'SELECT * FROM main.orders',
  ])('%s', (sql) => {
    const r = lex(sql);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });
});

describe('DuckDB lexer (layer 1): refusals', () => {
  it.each([
    ['install an extension', 'INSTALL httpfs'],
    ['load an extension', 'LOAD httpfs'],
    ['attach a database', "ATTACH 'other.duckdb' AS o"],
    ['detach', 'DETACH o'],
    ['export', "EXPORT DATABASE 'out'"],
    ['import', "IMPORT DATABASE 'in'"],
    ['pragma', 'PRAGMA enable_profiling'],
    ['set', 'SET enable_external_access = true'],
    ['reset', 'RESET threads'],
    ['copy', "COPY orders TO 'orders.csv'"],
    ['checkpoint', 'CHECKPOINT'],
    ['temp table', 'CREATE TEMP TABLE t AS SELECT 1'],
    ['temp macro', 'CREATE TEMP MACRO m(x) AS x + 1'],
    ['two statements', 'SELECT 1; SELECT 2'],
    ['a plain backslash ends the string', "SELECT '\\'; DELETE FROM orders; --'"],
    ['select into', 'SELECT * INTO backup FROM orders'],
    ['describe', 'DESCRIBE orders'],
    ['summarize', 'SUMMARIZE orders'],
    ['query() runs SQL strings', "SELECT * FROM query('SELECT 1')"],
    ['query_table() reads tables by name', "FROM query_table('customers')"],
    ['json_execute_serialized_sql', "SELECT * FROM json_execute_serialized_sql('{}')"],
    ['read_csv', "SELECT * FROM read_csv('/etc/hosts')"],
    ['read_csv_auto', "SELECT * FROM read_csv_auto('x.csv')"],
    ['read_text', "SELECT * FROM read_text('/etc/hosts')"],
    ['read_blob', "SELECT * FROM read_blob('/etc/hosts')"],
    ['read_parquet', "SELECT * FROM read_parquet('x.parquet')"],
    ['read_json', "SELECT * FROM read_json('x.json')"],
    ['parquet_scan', "SELECT * FROM parquet_scan('x.parquet')"],
    ['parquet_metadata', "SELECT * FROM parquet_metadata('x.parquet')"],
    ['sqlite_scan', "SELECT * FROM sqlite_scan('x.db', 't')"],
    ['glob', "SELECT * FROM glob('/etc/*')"],
    ['sniff_csv', "SELECT * FROM sniff_csv('x.csv')"],
    ['getenv', "SELECT getenv('HOME')"],
    ['sleep_ms', 'SELECT sleep_ms(100000)'],
    ['enable_logging (prints to stdout)', "SELECT * FROM enable_logging(storage = 'stdout')"],
    ['enable_profiling', 'SELECT * FROM enable_profiling()'],
    ['enable_peg_parser (changes the parser)', 'SELECT * FROM enable_peg_parser()'],
    ['checkpoint()', 'SELECT * FROM checkpoint()'],
    ['duckdb_secrets()', 'SELECT * FROM duckdb_secrets()'],
    ['duckdb_logs view', 'SELECT * FROM duckdb_logs'],
    ['duckdb_table_sample', "SELECT * FROM duckdb_table_sample('customers')"],
    ['pragma_storage_info (min and max values)', "SELECT * FROM pragma_storage_info('customers')"],
    ['schema-qualified reader', "SELECT * FROM main.read_csv('x.csv')"],
    ['method call syntax', "SELECT ('/etc/hosts').read_text()"],
    ['file in FROM', "SELECT * FROM '/etc/hosts'"],
    ['file in FROM-first', "FROM 'orders.csv'"],
    ['file after a comma', "SELECT * FROM orders, 'orders.csv'"],
    ['file in a join', "SELECT * FROM orders JOIN 'customers.parquet' c ON true"],
    ['quoted file name', 'SELECT * FROM "orders.csv"'],
    ['table macro reading a table by name', "SELECT * FROM histogram('customers', email)"],
    ['table function not on the list', 'SELECT * FROM test_all_types()'],
    ['positional parameter', 'SELECT * FROM orders WHERE id = ?'],
    ['dollar parameter', 'SELECT * FROM orders WHERE id = $1'],
    ['unterminated nested comment', 'SELECT 1 /* a /* b */'],
    // Settings and the catalog: list_tables and describe_table apply the table lists instead.
    ['a setting (proxy password)', "SELECT current_setting('http_proxy')"],
    ['a variable', "SELECT getvariable('x')"],
    ['duckdb_settings()', "SELECT value FROM duckdb_settings() WHERE name = 'http_proxy'"],
    ['duckdb_tables() (DDL of every table)', 'SELECT sql FROM duckdb_tables()'],
    ['duckdb_databases() (file paths)', 'SELECT path FROM duckdb_databases()'],
    ['the duckdb_tables view', 'SELECT sql FROM duckdb_tables'],
    ['a qualified catalog view', 'SELECT * FROM system.main.duckdb_views'],
    ['information_schema', 'SELECT * FROM information_schema.tables'],
    ['pg_catalog', 'SELECT * FROM pg_catalog.pg_settings'],
    ['pg_settings', 'SELECT setting FROM pg_settings'],
    ['sqlite_master', 'SELECT sql FROM sqlite_master'],
    ['pragma_table_info', "SELECT * FROM pragma_table_info('customers')"],
    ['pragma_database_list', 'SELECT * FROM pragma_database_list'],
    ['SHOW TABLES in a subquery', 'SELECT * FROM (SHOW TABLES)'],
    ['DESCRIBE in a subquery', 'SELECT * FROM (DESCRIBE customers)'],
    ['SUMMARIZE in a subquery', 'SELECT * FROM (SUMMARIZE customers)'],
    ['summary()', 'SELECT * FROM summary((SELECT 1))'],
    ['the database file', "SELECT * FROM read_blob('shop.duckdb')"],
  ])('%s', (_name, sql) => {
    const r = lex(sql);
    expect(r.ok).toBe(false);
  });

  it('applies the configured deny list to word tokens', () => {
    expect(lex('SELECT * FROM customers', { denyTables: ['customers'] }).ok).toBe(false);
  });
});

describe('DuckDB lexer: quoting follows PostgreSQL', () => {
  it('reads standard strings with a plain backslash, E strings with escapes', () => {
    expect(
      splitStatements(tokenize("SELECT '\\'; DELETE FROM orders; --'", 'duckdb')),
    ).toHaveLength(2);
    expect(
      splitStatements(tokenize("SELECT E'x\\'; DELETE FROM orders; --'", 'duckdb')),
    ).toHaveLength(1);
  });

  it('nests block comments and reads dollar quoting', () => {
    expect(
      splitStatements(tokenize('SELECT 1 /* x /* y */ ; DELETE FROM orders; */', 'duckdb')),
    ).toHaveLength(1);
    expect(splitStatements(tokenize('SELECT $a$ ; $b$ ; $a$', 'duckdb'))).toHaveLength(1);
  });

  it('reads list slices and prefix aliases as operators, :name after a space as a parameter', () => {
    expect(tokenize('SELECT l[a:b]', 'duckdb').some((t) => t.type === 'named')).toBe(false);
    expect(
      tokenize('SELECT * FROM t WHERE id = :id', 'duckdb').filter((t) => t.type === 'named'),
    ).toHaveLength(1);
  });

  it('binds named query parameters as $1..$n', () => {
    expect(
      bindNamedParams("SELECT * FROM orders WHERE status = :s AND id > :n AND :s <> ''", 'duckdb', {
        s: 'paid',
        n: 3,
      }),
    ).toEqual({
      sql: "SELECT * FROM orders WHERE status = $1 AND id > $2 AND $1 <> ''",
      params: ['paid', 3],
    });
  });
});

describe('DuckDB config', () => {
  it('accepts a duckdb source with a path', () => {
    const cfg = parseConfig({ name: 'shop', source: { type: 'duckdb', path: './shop.duckdb' } });
    expect(cfg.source).toEqual({ type: 'duckdb', path: './shop.duckdb' });
  });

  it('refuses named write queries with a clear message', () => {
    const attempt = () =>
      parseConfig({
        name: 'shop',
        mode: 'read-write',
        source: { type: 'duckdb', path: './shop.duckdb' },
        sql: {
          queries: [
            { name: 'recent', description: 'Recent orders', sql: 'SELECT * FROM orders' },
            {
              name: 'cancel_order',
              description: 'Cancel',
              write: true,
              sql: "UPDATE orders SET status = 'cancelled' WHERE id = :id",
              params: { id: { type: 'integer' } },
            },
          ],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(
      /sql\.queries\.1\.write: Named write queries are not supported for DuckDB sources.*"cancel_order"/,
    );
  });
});
