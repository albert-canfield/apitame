import { DUCKDB_TABLE_FUNCTIONS, looksLikeFilePath } from './duckdb-rules.js';
import {
  checkTableRefs,
  guardSelect,
  isDeniedFunction,
  type GuardOptions,
  type GuardResult,
} from './guard.js';

/**
 * Returns `json_serialize_sql(sql)`: DuckDB's own parse tree of a query, as JSON.
 * The DuckDB driver runs it on a separate in-memory database with the query bound
 * as a parameter, so the query itself is never executed there.
 */
export type DuckdbSerializer = (sql: string) => Promise<string>;

export type DuckdbGuardOptions = Omit<GuardOptions, 'dialect' | 'skipParser'>;

interface TableRef {
  catalog: string | null;
  schema: string | null;
  table: string;
}

export interface DuckdbFacts {
  /** Every function called (scalar, aggregate, window and table functions), lowercased. */
  functions: string[];
  /** Functions called in FROM (table functions and table macros), lowercased. */
  tableFunctions: string[];
  /** Table references that are not CTEs in scope where they appear. */
  tables: TableRef[];
}

/** Query node types that json_serialize_sql produces (DuckDB 1.4 and 1.5). */
const QUERY_NODES = new Set([
  'SELECT_NODE',
  'SET_OPERATION_NODE',
  'RECURSIVE_CTE_NODE',
  'CTE_NODE',
]);
/** Table reference types the parser produces. Anything else is refused. */
const TABLE_REFS = new Set([
  'BASE_TABLE',
  'JOIN',
  'SUBQUERY',
  'TABLE_FUNCTION',
  'EXPRESSION_LIST',
  'EMPTY',
  'PIVOT',
  'SHOW_REF',
]);

const lower = (s: string) => s.toLowerCase();
const fail = (reason: string): GuardResult => ({ ok: false, reason });

class UnknownShape extends Error {}

/**
 * Walk DuckDB's parse tree of one statement and collect the functions and tables it
 * uses. CTE names are resolved per scope as DuckDB binds them: a CTE is visible in
 * later CTEs of the same WITH, in its main query and in nested subqueries, never in
 * its own body except in the recursive part of a recursive CTE (in the anchor part,
 * and without UNION, its own name means the real table). The walk fails closed on
 * shapes it does not know, so a parse tree from a newer DuckDB cannot hide a table.
 */
export function duckdbAstFacts(statement: unknown): DuckdbFacts {
  const facts: DuckdbFacts = { functions: [], tableFunctions: [], tables: [] };
  const unknown = (what: string) => {
    throw new UnknownShape(what);
  };

  const visit = (
    node: unknown,
    key: string | undefined,
    parentType: string | undefined,
    scope: ReadonlySet<string>,
  ): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, key, parentType, scope);
      return;
    }
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    const cls = typeof obj.class === 'string' ? obj.class : undefined;

    const isTableRefSlot =
      key === 'from_table' ||
      key === 'source' ||
      ((key === 'left' || key === 'right') && parentType === 'JOIN');
    const isQuerySlot =
      key === 'node' ||
      ((key === 'left' || key === 'right') &&
        (parentType === 'SET_OPERATION_NODE' || parentType === 'RECURSIVE_CTE_NODE'));
    if (isTableRefSlot && !(type && TABLE_REFS.has(type))) unknown(`table reference ${type}`);
    if (isQuerySlot && !(type && QUERY_NODES.has(type))) unknown(`query node ${type}`);
    if ('table_name' in obj && type !== 'BASE_TABLE' && type !== 'SHOW_REF') {
      unknown(`table name in ${type ?? cls}`);
    }
    const isCall = cls === 'FUNCTION' || cls === 'WINDOW';
    if ('function_name' in obj && !isCall) unknown(`function in ${cls ?? type}`);

    // WITH: each CTE body sees the CTEs defined before it; the rest of the node sees all of them.
    let inner = scope;
    const cteMap = (obj.cte_map as { map?: unknown } | undefined)?.map;
    if (cteMap !== undefined && !Array.isArray(cteMap)) unknown('CTE list');
    if (Array.isArray(cteMap) && cteMap.length > 0) {
      let visible = new Set(scope);
      for (const entry of cteMap as Array<{ key?: unknown; value?: unknown }>) {
        if (typeof entry.key !== 'string') unknown('CTE name');
        visit(entry.value, 'cte', type, visible);
        visible = new Set([...visible, lower(entry.key as string)]);
      }
      inner = visible;
    }

    if (type === 'RECURSIVE_CTE_NODE') {
      if (typeof obj.cte_name !== 'string') unknown('recursive CTE name');
      const self = new Set([...inner, lower(obj.cte_name as string)]);
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'cte_map') continue;
        visit(v, k, type, k === 'right' ? self : inner);
      }
      return;
    }

    if (type === 'BASE_TABLE') {
      if (typeof obj.table_name !== 'string' || !obj.table_name) unknown('table without a name');
      const table = obj.table_name as string;
      const schema =
        typeof obj.schema_name === 'string' && obj.schema_name ? obj.schema_name : null;
      const catalog =
        typeof obj.catalog_name === 'string' && obj.catalog_name ? obj.catalog_name : null;
      const isCte = schema === null && catalog === null && inner.has(lower(table));
      if (!isCte) facts.tables.push({ catalog, schema, table });
    }
    if (type === 'TABLE_FUNCTION') {
      const fn = (obj.function as { function_name?: unknown } | undefined)?.function_name;
      if (typeof fn !== 'string') unknown('table function without a name');
      facts.tableFunctions.push(lower(fn as string));
    }
    if (isCall) {
      if (typeof obj.function_name !== 'string') unknown('function without a name');
      facts.functions.push(lower(obj.function_name as string));
    }

    for (const [k, v] of Object.entries(obj)) {
      if (k === 'cte_map') continue;
      if (v && typeof v === 'object') visit(v, k, type, inner);
    }
  };

  const root = (statement as { node?: unknown } | undefined)?.node;
  visit(root, 'node', undefined, new Set());
  return facts;
}

/**
 * Layer 2 for DuckDB on its own: DuckDB's parser must read exactly one SELECT, and its
 * parse tree must not call refused functions, call table functions outside the reviewed
 * list, read files, or touch tables outside the allow and deny lists.
 *
 * Unlike node-sql-parser for the other engines, this parser is the engine's own. It
 * cannot disagree with DuckDB about what a query means, but it is not independent of
 * DuckDB either: a parser bug would affect both. The lexer (layer 1) and the database
 * settings (layer 3) do not depend on it.
 */
export async function duckdbParserCheck(
  sql: string,
  opts: DuckdbGuardOptions,
  serialize: DuckdbSerializer,
): Promise<GuardResult> {
  let raw: string;
  try {
    raw = await serialize(sql);
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'error';
    return fail(`DuckDB's parser could not check the query (${msg}), so it was refused.`);
  }
  let parsed: {
    error?: boolean;
    error_type?: string;
    error_message?: string;
    statements?: unknown[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return fail(
      "DuckDB's parser returned something apitame cannot read, so the query was refused.",
    );
  }
  if (parsed.error) {
    const message = String(parsed.error_message ?? '').split('\n')[0] ?? '';
    if (/only select statements/i.test(message)) {
      return fail(
        "Only SELECT queries are allowed (DuckDB's parser read another kind of statement).",
      );
    }
    return fail(
      `The query could not be parsed, so it was refused (${String(parsed.error_type ?? 'error')}: ${message.slice(0, 160)}). Simplify it, or ask the user to add it as a named query in apitame.config.yaml.`,
    );
  }
  if (!Array.isArray(parsed.statements) || parsed.statements.length !== 1) {
    return fail('Only one statement is allowed per query.');
  }

  let facts: DuckdbFacts;
  try {
    facts = duckdbAstFacts(parsed.statements[0]);
  } catch (err) {
    if (!(err instanceof UnknownShape)) throw err;
    return fail(
      `DuckDB's parser returned a query shape apitame does not know (${err.message}), so the query was refused.`,
    );
  }
  for (const fn of facts.functions) {
    if (isDeniedFunction(fn, 'duckdb'))
      return fail(`Function ${fn}() is not allowed in read-only queries.`);
  }
  for (const fn of facts.tableFunctions) {
    if (!DUCKDB_TABLE_FUNCTIONS.has(fn)) {
      return fail(
        `Table function ${fn}() is not allowed. Allowed table functions: range, generate_series, unnest, json_each and the duckdb_* catalog functions.`,
      );
    }
  }
  for (const t of facts.tables) {
    if (looksLikeFilePath(t.table)) {
      return fail(`Reading files is not allowed: DuckDB reads "${t.table}" as a file path.`);
    }
  }
  return checkTableRefs(
    facts.tables.map((t) => ({ schema: t.schema, table: t.table })),
    { ...opts, dialect: 'duckdb' },
    sql,
  );
}

/**
 * Validate that `sql` is exactly one read-only DuckDB SELECT: the lexer (layer 1, with
 * PostgreSQL quoting rules and DuckDB's keywords and functions), then DuckDB's own
 * parser (layer 2). The driver adds layer 3 (a read-only, locked-down database).
 */
export async function guardDuckdbSelect(
  sql: string,
  opts: DuckdbGuardOptions,
  serialize: DuckdbSerializer,
): Promise<GuardResult> {
  const lexed = guardSelect(sql, { ...opts, dialect: 'duckdb', skipParser: true });
  if (!lexed.ok) return lexed;
  return duckdbParserCheck(lexed.sql, opts, serialize);
}
