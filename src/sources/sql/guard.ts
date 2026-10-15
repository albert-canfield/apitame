import mysqlBuild from 'node-sql-parser/build/mysql.js';
import postgresBuild from 'node-sql-parser/build/postgresql.js';
import sqliteBuild from 'node-sql-parser/build/sqlite.js';
import { DUCKDB_DENIED_TABLES, duckdbFromCheck, isDeniedDuckdbFunction } from './duckdb-rules.js';
import {
  calledFunctions,
  LexError,
  splitStatements,
  tokenize,
  type Dialect,
  type Token,
} from './lexer.js';

export type { Dialect } from './lexer.js';

export interface GuardOptions {
  dialect: Dialect;
  /** If non-empty, only these tables (bare or schema-qualified) may be referenced. */
  allowTables?: string[];
  /** Tables that may never be referenced. Added to the built-in list. */
  denyTables?: string[];
  maxLength?: number;
  /** Skip the AST layer (used for named queries the config author wrote and the parser cannot read). */
  skipParser?: boolean;
  /** Allow `:name` / `$1` parameters (named queries only). */
  allowParams?: boolean;
}

export type GuardResult =
  | { ok: true; sql: string; tables: string[]; parserWarning?: string }
  | { ok: false; reason: string };

/** Keywords that never appear in a read-only SELECT outside strings, comments and quoted identifiers. */
const FORBIDDEN_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'COPY',
  'VACUUM',
  'REINDEX',
  'CALL',
  'EXECUTE',
  'PREPARE',
  'DEALLOCATE',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'REFRESH',
  'DISCARD',
  'CHECKPOINT',
  'REASSIGN',
  'INTO',
]);

/** Functions with side effects, file or network access, or that run SQL passed as a string. */
const DENIED_FUNCTIONS = new Set([
  'set_config',
  'nextval',
  'setval',
  'pg_notify',
  'lowrite',
  'loread',
  'load_extension',
  'readfile',
  'writefile',
  'edit',
  'fts3_tokenizer',
  'sleep',
  'benchmark',
  'load_file',
  'get_lock',
  'release_lock',
  'release_all_locks',
  'master_pos_wait',
  'source_pos_wait',
  'wait_for_executed_gtid_set',
  'wait_until_sql_thread_after_gtids',
  'txid_current',
  'pg_current_xact_id',
  'pg_export_snapshot',
  // Run a SQL string given as text: the tables inside the string escape the allow and deny lists.
  'ts_stat',
  'ts_rewrite',
  'connectby',
  'xpath_table',
  // Read any table by name (extensions), below the allow and deny lists.
  'get_raw_page',
  'pgrowlocks',
  'pg_relpages',
]);
const DENIED_FUNCTION_PREFIXES = [
  'pg_read',
  'pg_ls_',
  'pg_stat_file',
  'pg_file_',
  'pg_advisory',
  'pg_try_advisory',
  'pg_terminate',
  'pg_cancel',
  'pg_reload',
  'pg_rotate',
  'pg_promote',
  'pg_switch',
  'pg_create_',
  'pg_drop_',
  'pg_replication_',
  'pg_logical_',
  'pg_stat_reset',
  'pg_wal_replay',
  'pg_backup',
  'pg_start_backup',
  'pg_stop_backup',
  'pg_log_',
  'pg_import_',
  'pg_sleep',
  'lo_',
  'dblink',
  'binary_upgrade_',
  'query_to_xml',
  'cursor_to_xml',
  'table_to_xml',
  'schema_to_xml',
  'database_to_xml',
  'pg_sequence_last_value',
  // tablefunc's crosstab*() runs SQL strings; pgstattuple's pgstat*() read tables by name.
  'crosstab',
  'pgstat',
  // pg_stat_get_activity() and friends: other sessions' statements, like pg_stat_activity.
  'pg_stat_get_',
];

/** Catalogs that expose credentials or other sessions' queries. */
const BUILTIN_DENIED_TABLES = [
  'pg_authid',
  'pg_shadow',
  'pg_user_mapping',
  'pg_user_mappings',
  'pg_hba_file_rules',
  'pg_ident_file_mappings',
  'pg_file_settings',
  'pg_largeobject',
  'pg_stat_activity',
  'pg_subscription',
  // Query texts of other sessions (with their literal values) and stored FDW credentials.
  'pg_stat_statements',
  'pg_stat_statements_info',
  'user_mapping_options',
  // MySQL: statements other sessions are running.
  'processlist',
  'innodb_trx',
  // Planner statistics hold sampled column values (most common values, histograms, index
  // samples), so they would show the contents of denied tables.
  'pg_stats',
  'pg_stats_ext',
  'pg_stats_ext_exprs',
  'pg_statistic',
  'pg_statistic_ext_data',
  'sqlite_stat3',
  'sqlite_stat4',
  'column_statistics',
];

/**
 * Whether a function is refused. The shared list applies to every dialect; DuckDB adds
 * its file readers, SQL-string runners and engine-state functions (see duckdb-rules.ts).
 */
export function isDeniedFunction(name: string, dialect?: Dialect): boolean {
  const bare = name.toLowerCase().split('.').pop() ?? '';
  return (
    DENIED_FUNCTIONS.has(bare) ||
    DENIED_FUNCTION_PREFIXES.some((p) => bare.startsWith(p)) ||
    (dialect === 'duckdb' && isDeniedDuckdbFunction(bare))
  );
}

type SqlParser = {
  astify(sql: string, opt: { database: string }): unknown;
  tableList(sql: string, opt: { database: string }): string[];
};
type ParserModule = { Parser: new () => SqlParser };
/** Dialects that node-sql-parser reads. DuckDB is parsed by DuckDB itself (duckdb-guard.ts). */
type NodeParserDialect = Exclude<Dialect, 'duckdb'>;
const parsers = new Map<Dialect, SqlParser>();

/**
 * Only the three dialect builds apitame needs are imported, so the bundler
 * ships about 800 KB instead of the whole node-sql-parser package.
 */
const PARSER_BUILDS: Record<NodeParserDialect, ParserModule> = {
  postgres: postgresBuild as unknown as ParserModule,
  sqlite: sqliteBuild as unknown as ParserModule,
  mysql: mysqlBuild as unknown as ParserModule,
};

function parser(dialect: NodeParserDialect): SqlParser {
  let p = parsers.get(dialect);
  if (!p) {
    p = new PARSER_BUILDS[dialect].Parser();
    parsers.set(dialect, p);
  }
  return p;
}

const PARSER_DB: Record<NodeParserDialect, string> = {
  postgres: 'PostgresQL',
  sqlite: 'sqlite',
  mysql: 'MySQL',
};

/**
 * Extra keywords that only matter in one dialect (MySQL locking reads and file export;
 * DuckDB extension, export, import and settings statements).
 */
const DIALECT_KEYWORDS: Record<Dialect, string[]> = {
  postgres: [],
  sqlite: [],
  mysql: ['LOCK', 'SHARE', 'HANDLER', 'OUTFILE', 'DUMPFILE', 'LOAD'],
  duckdb: ['INSTALL', 'LOAD', 'EXPORT', 'IMPORT', 'SET', 'RESET', 'SHOW', 'DESCRIBE', 'SUMMARIZE'],
};

/** Schemas that hold credentials or other sessions' statements. */
const SYSTEM_SCHEMAS: Record<Dialect, string[]> = {
  postgres: [],
  sqlite: [],
  mysql: ['mysql', 'performance_schema', 'sys'],
  // The catalog shows every table and setting past the table lists (see duckdb-rules.ts).
  duckdb: ['information_schema', 'pg_catalog'],
};

/** Statements a query may start with. DuckDB also accepts FROM-first queries (`FROM orders`). */
const FIRST_WORDS: Record<Dialect, string[]> = {
  postgres: ['SELECT', 'WITH', 'VALUES'],
  sqlite: ['SELECT', 'WITH', 'VALUES'],
  mysql: ['SELECT', 'WITH', 'VALUES'],
  duckdb: ['SELECT', 'WITH', 'VALUES', 'FROM'],
};

/** Every table name that is refused: built in, per dialect, and from the config. */
export function deniedTables(dialect: Dialect, configured: string[] = []): string[] {
  return [
    ...BUILTIN_DENIED_TABLES,
    ...(dialect === 'duckdb' ? DUCKDB_DENIED_TABLES : []),
    ...configured,
  ];
}

const lower = (s: string) => s.toLowerCase();

export function tableMatches(
  ref: { schema: string | null; table: string },
  list: string[],
): boolean {
  const full = ref.schema ? `${lower(ref.schema)}.${lower(ref.table)}` : lower(ref.table);
  return list.some((entry) => {
    const e = lower(entry);
    return (
      e === full ||
      e === lower(ref.table) ||
      (e.includes('.') && ref.schema === null && e.split('.').pop() === lower(ref.table))
    );
  });
}

interface AstFacts {
  types: Set<string>;
  functions: string[];
  /** Table references that are not CTEs in scope where they appear. */
  tables: Array<{ schema: string | null; table: string }>;
  selectInto: boolean;
  locking: boolean;
}

function functionName(node: Record<string, unknown>): string {
  const n = node.name;
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object') {
    const parts =
      (n as { name?: Array<{ value?: unknown }>; schema?: { value?: unknown } }).name ?? [];
    const schema = (n as { schema?: { value?: unknown } }).schema?.value;
    const base = parts.map((p) => String(p.value ?? '')).join('.');
    return schema ? `${String(schema)}.${base}` : base;
  }
  return '';
}

function collect(ast: unknown): AstFacts {
  const facts: AstFacts = {
    types: new Set(),
    functions: [],
    tables: [],
    selectInto: false,
    locking: false,
  };
  const seen = new WeakSet<object>();
  // CTE names are resolved per scope, as the database does: a CTE is visible in later CTEs of
  // the same WITH and in its main query, never in outer queries, and in its own body only with
  // RECURSIVE. Otherwise `WITH customers AS (SELECT * FROM customers)` would hide a real table.
  const visit = (node: unknown, key: string | undefined, scope: ReadonlySet<string>): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) visit(v, key, scope);
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : undefined;
    if (type) facts.types.add(type);
    if (type === 'function') facts.functions.push(functionName(obj));
    let inner = scope;
    if (type === 'select') {
      const into = obj.into as { expr?: unknown; position?: unknown } | undefined;
      if (into && (into.expr || into.position)) facts.selectInto = true;
      if (obj.locking_read || obj.for_update) facts.locking = true;
      const ctes =
        (obj.with as Array<{
          name?: { value?: unknown } | string;
          stmt?: unknown;
          recursive?: unknown;
        }> | null) ?? [];
      const cteName = (w: (typeof ctes)[number]) => {
        const n = typeof w.name === 'string' ? w.name : w.name?.value;
        return typeof n === 'string' ? lower(n) : '';
      };
      if (ctes.length > 0) {
        const all = new Set([...scope, ...ctes.map(cteName)]);
        const recursive = ctes.some((w) => w.recursive === true);
        let visible = new Set(scope);
        for (const w of ctes) {
          visit(w.stmt, 'with', recursive ? all : visible);
          visible = new Set([...visible, cteName(w)]);
        }
        inner = all;
      }
    }
    if (key === 'from' || key === 'join') {
      if (typeof obj.table === 'string') {
        const schema = (obj.schema ?? obj.db) as string | null | undefined;
        const isCte = (schema === null || schema === undefined) && scope.has(lower(obj.table));
        if (!isCte) {
          facts.tables.push({
            schema: typeof schema === 'string' ? schema : null,
            table: obj.table,
          });
        }
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'with' && inner !== scope) continue;
      if (v && typeof v === 'object') visit(v, k, inner);
    }
  };
  visit(ast, undefined, new Set());
  return facts;
}

const fail = (reason: string): GuardResult => ({ ok: false, reason });

/**
 * Validate that `sql` is exactly one read-only SELECT.
 *
 * Layer 1: a lexer with the database's own quoting rules (statement count,
 * forbidden keywords, denied functions and tables).
 * Layer 2: a real SQL parser (statement type, SELECT INTO, row locks,
 * functions and tables from the AST). Anything it cannot parse is refused.
 *
 * The database layer (read-only transaction, single-statement protocol,
 * timeout) is applied by the drivers on top of this.
 */
export function guardSelect(sql: string, opts: GuardOptions): GuardResult {
  const maxLength = opts.maxLength ?? 20_000;
  const text = sql.trim();
  if (!text) return fail('Empty query.');
  if (text.length > maxLength) return fail(`Query is longer than ${maxLength} characters.`);
  if (text.includes('\0')) return fail('Query contains a NUL byte.');

  let tokens: Token[];
  try {
    tokens = tokenize(text, opts.dialect);
  } catch (err) {
    if (err instanceof LexError) return fail(err.message);
    throw err;
  }
  const statements = splitStatements(tokens);
  if (statements.length === 0) return fail('Empty query.');
  if (statements.length > 1) return fail('Only one statement is allowed per query.');
  const stmt = statements[0] as Token[];

  const first = stmt[0];
  const firstWord = first?.type === 'word' ? first.value.toUpperCase() : '';
  if (!FIRST_WORDS[opts.dialect].includes(firstWord) && first?.type !== 'lparen') {
    return fail(`Only SELECT queries are allowed (query starts with "${first?.value ?? ''}").`);
  }
  const extraKeywords = new Set(DIALECT_KEYWORDS[opts.dialect]);
  const quoteHint = opts.dialect === 'mysql' ? 'backticks' : 'double quotes';
  for (const t of stmt) {
    const upper = t.type === 'word' ? t.value.toUpperCase() : '';
    if (FORBIDDEN_KEYWORDS.has(upper) || extraKeywords.has(upper)) {
      return fail(
        `"${t.value}" is not allowed in a read-only query. If it is a column or table name, wrap it in ${quoteHint}.`,
      );
    }
    if (!opts.allowParams && (t.type === 'param' || t.type === 'named')) {
      return fail('Query parameters are not supported here. Write literal values instead.');
    }
  }
  for (const fn of calledFunctions(stmt)) {
    if (isDeniedFunction(fn, opts.dialect))
      return fail(`Function ${fn}() is not allowed in read-only queries.`);
  }
  if (opts.dialect === 'duckdb') {
    const reason = duckdbFromCheck(stmt);
    if (reason) return fail(reason);
  }
  const systemSchemas = SYSTEM_SCHEMAS[opts.dialect];
  for (let k = 0; k < stmt.length - 1; k++) {
    const t = stmt[k] as Token;
    if (
      (t.type === 'word' || t.type === 'quoted') &&
      stmt[k + 1]?.type === 'dot' &&
      systemSchemas.includes(lower(t.value))
    ) {
      return fail(`The "${t.value}" schema is not available.`);
    }
  }
  const denied = deniedTables(opts.dialect, opts.denyTables);
  for (const t of stmt) {
    if (
      (t.type === 'word' || t.type === 'quoted') &&
      denied.some((d) => lower(d.split('.').pop() ?? d) === lower(t.value))
    ) {
      return fail(`Table "${t.value}" is not available.`);
    }
  }

  // Cut at the first top-level semicolon: only trailing semicolons and comments remain after it.
  const end = (stmt[stmt.length - 1] as Token).end;
  const cleanSql = text.slice(0, end);

  if (opts.skipParser) {
    return { ok: true, sql: cleanSql, tables: [] };
  }
  if (opts.dialect === 'duckdb') {
    // No bundled parser reads DuckDB SQL: guardDuckdbSelect (duckdb-guard.ts) asks DuckDB's own parser.
    throw new Error('DuckDB queries are checked with guardDuckdbSelect, not guardSelect.');
  }
  const dialect = opts.dialect;

  let ast: unknown;
  try {
    ast = parser(dialect).astify(cleanSql, { database: PARSER_DB[dialect] });
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'parse error';
    return fail(
      `The query could not be parsed, so it was refused (${msg}). Simplify it, or ask the user to add it as a named query in apitame.config.yaml.`,
    );
  }
  const list = (Array.isArray(ast) ? ast : [ast]).filter(Boolean);
  if (list.length !== 1) return fail('Only one statement is allowed per query.');
  const root = list[0] as { type?: string };
  if (String(root.type).toLowerCase() !== 'select') {
    return fail(`Only SELECT queries are allowed (got ${String(root.type).toUpperCase()}).`);
  }

  const facts = collect(root);
  const writeTypes = [
    'insert',
    'update',
    'delete',
    'replace',
    'create',
    'drop',
    'alter',
    'truncate',
    'grant',
    'revoke',
    'rename',
    'set',
    'lock',
    'call',
    'exec',
    'execute',
    'transaction',
    'use',
    'attach',
    'detach',
    'pragma',
  ];
  for (const t of writeTypes) {
    if (facts.types.has(t))
      return fail(`A ${t.toUpperCase()} statement is not allowed in a read-only query.`);
  }
  if (facts.selectInto) return fail('SELECT INTO creates a table and is not allowed.');
  if (facts.locking) return fail('Row locking clauses (FOR UPDATE / FOR SHARE) are not allowed.');
  for (const fn of facts.functions) {
    if (isDeniedFunction(fn)) return fail(`Function ${fn}() is not allowed in read-only queries.`);
  }
  return checkTableRefs(facts.tables, opts, cleanSql);
}

/**
 * Apply the system schema, deny and allow lists to the table references a parser found.
 * Shared by the node-sql-parser layer and the DuckDB parser layer.
 */
export function checkTableRefs(
  tables: Array<{ schema: string | null; table: string }>,
  opts: GuardOptions,
  cleanSql: string,
): GuardResult {
  const systemSchemas = SYSTEM_SCHEMAS[opts.dialect];
  const denied = deniedTables(opts.dialect, opts.denyTables);
  for (const t of tables) {
    if (t.schema && systemSchemas.includes(lower(t.schema))) {
      return fail(`The "${t.schema}" schema is not available.`);
    }
    if (tableMatches(t, denied)) return fail(`Table "${t.table}" is not available.`);
    if (opts.allowTables && opts.allowTables.length > 0 && !tableMatches(t, opts.allowTables)) {
      return fail(
        `Table "${t.schema ? `${t.schema}.` : ''}${t.table}" is not in the allowed table list.`,
      );
    }
  }
  const names = [...new Set(tables.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table)))];
  return { ok: true, sql: cleanSql, tables: names };
}

/** Every table a statement reads or writes, or null when the parser cannot read it. */
export function statementTables(
  sql: string,
  dialect: Dialect,
): Array<{ schema: string | null; table: string }> | null {
  if (dialect === 'duckdb') return null;
  try {
    const entries = parser(dialect).tableList(sql, { database: PARSER_DB[dialect] });
    const seen = new Map<string, { schema: string | null; table: string }>();
    for (const e of entries) {
      const [, db, table] = e.split('::');
      if (!table) return null;
      const schema = db && db !== 'null' ? db : null;
      seen.set(`${schema ?? ''}.${table}`, { schema, table });
    }
    return [...seen.values()];
  } catch {
    return null;
  }
}

export interface WriteAnalysis {
  ok: boolean;
  reason?: string;
  /** Main statement keyword, for example UPDATE. */
  kind?: string;
  destructive?: boolean;
  sql?: string;
}

/**
 * Classify a named write query from the config. DELETE, DROP, TRUNCATE,
 * ALTER and UPDATE without WHERE are destructive and need confirmation.
 */
export function analyzeWrite(sql: string, dialect: Dialect): WriteAnalysis {
  let tokens: Token[];
  try {
    tokens = tokenize(sql.trim(), dialect);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const statements = splitStatements(tokens);
  if (statements.length !== 1)
    return { ok: false, reason: 'A named query must contain exactly one statement.' };
  const stmt = statements[0] as Token[];

  // Find the main statement keyword at paren depth 0, skipping a leading WITH clause.
  let depth = 0;
  let kind = '';
  let hasWhere = false;
  for (const t of stmt) {
    if (t.type === 'lparen') depth++;
    else if (t.type === 'rparen') depth--;
    else if (depth === 0 && t.type === 'word') {
      const w = t.value.toUpperCase();
      if (
        !kind &&
        [
          'INSERT',
          'UPDATE',
          'DELETE',
          'MERGE',
          'REPLACE',
          'DROP',
          'TRUNCATE',
          'ALTER',
          'CREATE',
          'SELECT',
          'UPSERT',
          'RENAME',
        ].includes(w)
      )
        kind = w;
      if (w === 'WHERE' && (kind === 'UPDATE' || kind === 'DELETE')) hasWhere = true;
    }
  }
  if (!kind) return { ok: false, reason: 'Could not find the statement type.' };
  const destructive =
    ['DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'MERGE', 'RENAME'].includes(kind) ||
    (kind === 'UPDATE' && !hasWhere);
  const end = (stmt[stmt.length - 1] as Token).end;
  return { ok: true, kind, destructive, sql: sql.trim().slice(0, end) };
}

/**
 * Rewrite `:name` parameters for the driver. Postgres and DuckDB get `$1..$n`,
 * MySQL gets `?` (one per occurrence), SQLite keeps `:name` (bound by name).
 * Values are never interpolated.
 */
export function bindNamedParams(
  sql: string,
  dialect: Dialect,
  values: Record<string, unknown>,
): { sql: string; params: unknown[] | Record<string, unknown> } {
  const tokens = tokenize(sql, dialect).filter((t) => t.type === 'named');
  if (dialect === 'sqlite') {
    const params: Record<string, unknown> = {};
    for (const t of tokens) params[t.value] = normalizeValue(values[t.value]);
    return { sql, params };
  }
  if (dialect === 'mysql') {
    let out = '';
    let last = 0;
    for (const t of tokens) {
      out += `${sql.slice(last, t.start)}?`;
      last = t.end;
    }
    return {
      sql: out + sql.slice(last),
      params: tokens.map((t) => normalizeValue(values[t.value])),
    };
  }
  const order: string[] = [];
  let out = '';
  let last = 0;
  for (const t of tokens) {
    let idx = order.indexOf(t.value);
    if (idx < 0) {
      order.push(t.value);
      idx = order.length - 1;
    }
    out += `${sql.slice(last, t.start)}$${idx + 1}`;
    last = t.end;
  }
  out += sql.slice(last);
  return { sql: out, params: order.map((k) => normalizeValue(values[k])) };
}

function normalizeValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  return v;
}
