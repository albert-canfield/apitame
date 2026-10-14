import { createRequire } from 'node:module';
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
];

export function isDeniedFunction(name: string): boolean {
  const bare = name.toLowerCase().split('.').pop() ?? '';
  return DENIED_FUNCTIONS.has(bare) || DENIED_FUNCTION_PREFIXES.some((p) => bare.startsWith(p));
}

const require = createRequire(import.meta.url);
type SqlParser = { astify(sql: string, opt: { database: string }): unknown };
const parsers = new Map<Dialect, SqlParser>();

function parser(dialect: Dialect): SqlParser {
  let p = parsers.get(dialect);
  if (!p) {
    const mod = require(`node-sql-parser/build/${PARSER_BUILD[dialect]}`) as {
      Parser: new () => SqlParser;
    };
    p = new mod.Parser();
    parsers.set(dialect, p);
  }
  return p;
}

const PARSER_DB: Record<Dialect, string> = {
  postgres: 'PostgresQL',
  sqlite: 'sqlite',
  mysql: 'MySQL',
};
const PARSER_BUILD: Record<Dialect, string> = {
  postgres: 'postgresql',
  sqlite: 'sqlite',
  mysql: 'mysql',
};

/** Extra keywords that only matter in one dialect (MySQL locking reads and file export). */
const DIALECT_KEYWORDS: Record<Dialect, string[]> = {
  postgres: [],
  sqlite: [],
  mysql: ['LOCK', 'SHARE', 'HANDLER', 'OUTFILE', 'DUMPFILE', 'LOAD'],
};

/** Schemas that hold credentials or other sessions' statements. */
const SYSTEM_SCHEMAS: Record<Dialect, string[]> = {
  postgres: [],
  sqlite: [],
  mysql: ['mysql', 'performance_schema', 'sys'],
};

const lower = (s: string) => s.toLowerCase();

function tableMatches(ref: { schema: string | null; table: string }, list: string[]): boolean {
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
  tables: Array<{ schema: string | null; table: string }>;
  cteNames: Set<string>;
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
    cteNames: new Set(),
    selectInto: false,
    locking: false,
  };
  const seen = new WeakSet<object>();
  const visit = (node: unknown, key?: string): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const v of node) visit(v, key);
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : undefined;
    if (type) facts.types.add(type);
    if (type === 'function') facts.functions.push(functionName(obj));
    if (type === 'select') {
      const into = obj.into as { expr?: unknown; position?: unknown } | undefined;
      if (into && (into.expr || into.position)) facts.selectInto = true;
      if (obj.locking_read || obj.for_update) facts.locking = true;
      for (const w of (obj.with as Array<{ name?: { value?: unknown } | string }> | null) ?? []) {
        const name = typeof w.name === 'string' ? w.name : w.name?.value;
        if (typeof name === 'string') facts.cteNames.add(lower(name));
      }
    }
    if (key === 'from' || key === 'join') {
      if (typeof obj.table === 'string') {
        const schema = (obj.schema ?? obj.db) as string | null | undefined;
        facts.tables.push({ schema: typeof schema === 'string' ? schema : null, table: obj.table });
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') visit(v, k);
    }
  };
  visit(ast);
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
  if (!['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(firstWord) && first?.type !== 'lparen') {
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
    if (isDeniedFunction(fn)) return fail(`Function ${fn}() is not allowed in read-only queries.`);
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
  const denied = [...BUILTIN_DENIED_TABLES, ...(opts.denyTables ?? [])];
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

  let ast: unknown;
  try {
    ast = parser(opts.dialect).astify(cleanSql, { database: PARSER_DB[opts.dialect] });
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

  const tables = facts.tables.filter(
    (t) => !(t.schema === null && facts.cteNames.has(lower(t.table))),
  );
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
 * Rewrite `:name` parameters for the driver. Postgres gets `$1..$n`, MySQL
 * gets `?` (one per occurrence), SQLite keeps `:name` (bound by name).
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
