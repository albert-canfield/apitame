import type { Token } from './lexer.js';

/**
 * DuckDB functions that are refused anywhere in a query: they run SQL passed as a
 * string, read files or other databases, read a table by name (escaping the table
 * allow and deny lists), expose secrets or logs, or change the state of the
 * engine. DuckDB runs several of these even on a read-only database with a locked
 * configuration: `query()` and `query_table()` run, `enable_logging(storage =
 * 'stdout')` prints every later query to standard output (the MCP channel over
 * stdio), and `enable_peg_parser()` switches the parser for every connection.
 */
export const DUCKDB_DENIED_FUNCTIONS = new Set([
  'query',
  'query_table',
  'json_execute_serialized_sql',
  'json_serialize_plan',
  'glob',
  'sniff_csv',
  'getenv',
  'sleep_ms',
  'write_log',
  'checkpoint',
  'force_checkpoint',
  'enable_profiling',
  'disable_profiling',
  'enable_logging',
  'disable_logging',
  'truncate_duckdb_logs',
  'enable_peg_parser',
  'disable_peg_parser',
  'check_peg_parser',
  'duckdb_secrets',
  'which_secret',
  'duckdb_logs',
  'duckdb_logs_parsed',
  'duckdb_log_contexts',
  'duckdb_table_sample',
  'pragma_storage_info',
  'add_parquet_key',
  'import_database',
  'copy_database',
]);

/** File and foreign database readers: read_csv, read_parquet, parquet_metadata, sqlite_scan, ... */
export const DUCKDB_DENIED_PREFIXES = [
  'read_',
  'parquet_',
  'iceberg_',
  'delta_',
  'sqlite_',
  'postgres_',
  'mysql_',
  'arrow_',
];
export const DUCKDB_DENIED_SUFFIXES = ['_scan', '_attach', '_query', '_execute'];

/** Catalog views that hold secrets or the text of earlier queries. */
export const DUCKDB_DENIED_TABLES = [
  'duckdb_secrets',
  'duckdb_logs',
  'duckdb_logs_parsed',
  'duckdb_log_contexts',
];

/**
 * The only table functions a query may call in FROM. Everything else is refused,
 * so a table function added by a future DuckDB release is refused until it is
 * reviewed. These generate rows or read the catalog (structure, not data).
 */
export const DUCKDB_TABLE_FUNCTIONS = new Set([
  'range',
  'generate_series',
  'unnest',
  'repeat',
  'repeat_row',
  'json_each',
  'json_tree',
  'summary',
  'duckdb_columns',
  'duckdb_constraints',
  'duckdb_databases',
  'duckdb_dependencies',
  'duckdb_extensions',
  'duckdb_functions',
  'duckdb_indexes',
  'duckdb_keywords',
  'duckdb_optimizers',
  'duckdb_schemas',
  'duckdb_sequences',
  'duckdb_settings',
  'duckdb_tables',
  'duckdb_types',
  'duckdb_views',
  'pragma_table_info',
  'pragma_show',
  'pragma_version',
  'pragma_platform',
  'pragma_database_size',
  'pragma_collations',
  'pg_timezone_names',
  'icu_calendar_names',
]);

export function isDeniedDuckdbFunction(bare: string): boolean {
  return (
    DUCKDB_DENIED_FUNCTIONS.has(bare) ||
    DUCKDB_DENIED_PREFIXES.some((p) => bare.startsWith(p)) ||
    DUCKDB_DENIED_SUFFIXES.some((s) => bare.endsWith(s))
  );
}

/** A table name that DuckDB would read as a file (a replacement scan), such as 'orders.csv'. */
export function looksLikeFilePath(name: string): boolean {
  return /[./\\:*?~]/.test(name);
}

/** Keywords that end the FROM clause of the query at the same depth. */
const FROM_END = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'QUALIFY',
  'WINDOW',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'SELECT',
  'RETURNING',
  'FETCH',
]);

/**
 * Lexer-level checks of what DuckDB reads in a FROM clause: a string literal
 * (`FROM 'orders.csv'`) or a quoted name that looks like a path is a file read,
 * and a table function must be on the reviewed list. FROM inside function syntax
 * (`EXTRACT(year FROM ts)`, `trim(both 'x' FROM s)`) is not a FROM clause and is
 * skipped: a query FROM is the first token of its level or follows a SELECT.
 */
export function duckdbFromCheck(stmt: Token[]): string | undefined {
  let depth = 0;
  const sawSelect: boolean[] = [false];
  const inFrom: boolean[] = [false];
  const expect: boolean[] = [false];
  let levelStart = true;
  for (let k = 0; k < stmt.length; k++) {
    const t = stmt[k] as Token;
    const first = levelStart;
    levelStart = false;
    const upper = t.type === 'word' ? t.value.toUpperCase() : '';
    if (t.type === 'lparen') {
      // A reference that starts with "(" (a subquery or a nested join) is checked at its own level.
      expect[depth] = false;
      depth++;
      sawSelect[depth] = false;
      inFrom[depth] = false;
      expect[depth] = false;
      levelStart = true;
      continue;
    }
    if (t.type === 'rparen') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (upper === 'SELECT') sawSelect[depth] = true;
    if ((upper === 'FROM' && (first || sawSelect[depth])) || upper === 'JOIN') {
      inFrom[depth] = true;
      expect[depth] = true;
      continue;
    }
    if (FROM_END.has(upper)) {
      inFrom[depth] = false;
      expect[depth] = false;
      continue;
    }
    if (t.type === 'op' && t.value === ',') {
      if (inFrom[depth]) expect[depth] = true;
      continue;
    }
    if (!expect[depth] || upper === 'LATERAL') continue;
    expect[depth] = false;

    if (t.type === 'string') {
      return `Reading files is not allowed: DuckDB reads ${t.value} in a FROM clause as a file.`;
    }
    if (t.type !== 'word' && t.type !== 'quoted') continue;
    // Collect a qualified name (catalog.schema.name), then see whether it is called.
    let j = k;
    while (
      stmt[j + 1]?.type === 'dot' &&
      (stmt[j + 2]?.type === 'word' || stmt[j + 2]?.type === 'quoted')
    ) {
      j += 2;
    }
    const last = stmt[j] as Token;
    if (stmt[j + 1]?.type === 'lparen') {
      const fn = last.value.toLowerCase();
      if (!DUCKDB_TABLE_FUNCTIONS.has(fn)) {
        return `Table function ${fn}() is not allowed. Allowed table functions: ${[...DUCKDB_TABLE_FUNCTIONS].slice(0, 6).join(', ')} and the duckdb_* catalog functions.`;
      }
    } else if (last.type === 'quoted' && looksLikeFilePath(last.value)) {
      return `Reading files is not allowed: DuckDB reads "${last.value}" as a file path.`;
    }
    k = j;
  }
  return undefined;
}
