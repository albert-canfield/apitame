/**
 * The DuckDB child process. apitame forks this module (built to dist/duckdb-worker.js)
 * and sends it one request at a time over IPC. All DuckDB work happens here: opening the
 * file, parsing, planning, running and converting results. The parent kills this process
 * when a request takes longer than the timeout, and a crash (for example running out of
 * memory) only ends this process, never the MCP server.
 *
 * Self-contained on purpose (no local imports): it also runs from the TypeScript sources
 * with Node's type stripping, during development and tests.
 */
import type * as DuckDB from '@duckdb/node-api';

interface WorkerConfig {
  file: string;
  moduleUrl: string;
  /** Applied in this order when the file is opened (temp_directory must come first). */
  settings: Record<string, string>;
  /** What the settings must read back as. memory_limit is compared as a byte count. */
  expected: Record<string, string>;
  parserSettings: Record<string, string>;
}

type Request =
  | { id: number; op: 'tables' }
  | { id: number; op: 'describe'; schema: string | null; name: string }
  | { id: number; op: 'read'; sql: string; params: unknown[]; rowLimit: number; maxBytes: number }
  | { id: number; op: 'serialize'; sql: string };

type Json = DuckDB.Json;

// Plain fields only: this file must run with Node's type stripping (no parameter properties).
class WorkerError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Thrown while converting a row when the response budget runs out. */
class OverBudget extends Error {}

const config = JSON.parse(process.argv[2] ?? '{}') as WorkerConfig;
const send = (message: unknown) => process.send?.(message);
// The parent went away: nothing left to serve.
process.on('disconnect', () => process.exit(0));

let duck: typeof DuckDB;
let parserConn: DuckDB.DuckDBConnection | undefined;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** "953.6 MiB", "1GB" or "0 bytes" as a number of bytes. */
function bytesOf(text: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B|bytes?)?\s*$/i.exec(text);
  if (!m) return undefined;
  const unit = (m[2] ?? 'B').toUpperCase();
  const factor: Record<string, number> = {
    B: 1,
    BYTE: 1,
    BYTES: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
  };
  const f = factor[unit];
  return f === undefined ? undefined : Number(m[1]) * f;
}

function openError(err: unknown): WorkerError {
  const message = String((err as Error).message ?? err);
  const file = config.file;
  // Unix: "Could not set lock on file ... Conflicting lock is held in <program> (PID n)".
  // Windows can also report a sharing violation ("being used by another process").
  if (/Could not set lock on file|used by another process/i.test(message)) {
    const holder = /Conflicting lock is held in ([^.]*?\(PID \d+\))/.exec(message)?.[1];
    return new WorkerError(
      `The DuckDB file ${file} is open for writing in another process${holder ? ` (${holder})` : ''}. ` +
        'DuckDB lets one process write to a file or several read it, not both: close the other program ' +
        '(a DuckDB shell, a notebook or a data job), or point apitame at a copy of the file.',
      'DUCKDB_LOCKED',
    );
  }
  if (/not a valid DuckDB database file/i.test(message)) {
    return new WorkerError(`${file} is not a DuckDB database file.`);
  }
  if (/database does not exist/i.test(message)) {
    return new WorkerError(`DuckDB database not found: ${file}`);
  }
  return new WorkerError(`Could not open the DuckDB file ${file}: ${message.split('\n')[0]}`);
}

/** Refuse to run anything if DuckDB did not apply apitame's settings. */
async function checkSettings(conn: DuckDB.DuckDBConnection, expected: Record<string, string>) {
  const names = Object.keys(expected);
  const reader = await conn.runAndReadAll(
    `SELECT ${names.map((n) => `current_setting('${n}')::VARCHAR`).join(', ')}`,
  );
  const row = reader.getRowsJS()[0] ?? [];
  const wrong = names.filter((name, i) => {
    const actual = String(row[i] ?? '').toLowerCase();
    const want = String(expected[name]).toLowerCase();
    if (name === 'memory_limit') {
      const a = bytesOf(actual);
      const w = bytesOf(want);
      return a === undefined || w === undefined || Math.abs(a - w) > w * 0.02;
    }
    return actual !== want;
  });
  if (wrong.length > 0) {
    throw new WorkerError(
      `DuckDB did not apply apitame's read-only settings (${wrong.join(', ')}), so no query was run.`,
    );
  }
}

async function withDb<T>(fn: (conn: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
  let db: DuckDB.DuckDBInstance;
  try {
    db = await duck.DuckDBInstance.create(config.file, config.settings);
  } catch (err) {
    throw openError(err);
  }
  let conn: DuckDB.DuckDBConnection | undefined;
  try {
    conn = await db.connect();
    await checkSettings(conn, config.expected);
    return await fn(conn);
  } finally {
    try {
      conn?.closeSync();
    } catch {
      // already closed
    }
    try {
      db.closeSync();
    } catch {
      // already closed
    }
  }
}

async function rows(
  conn: DuckDB.DuckDBConnection,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const reader = await conn.runAndReadAll(sql, params as DuckDB.DuckDBValue[]);
  return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
}

function tables() {
  return withDb((conn) =>
    rows(
      conn,
      `SELECT schema_name AS schema, table_name AS name, 'table' AS type, estimated_size AS estimate, comment
         FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary
       UNION ALL
       SELECT schema_name, view_name, 'view', NULL, comment
         FROM duckdb_views() WHERE database_name = current_database() AND NOT internal AND NOT temporary
       ORDER BY 1, 2`,
    ),
  );
}

function describe(schema: string | null, name: string) {
  return withDb(async (conn) => {
    const found = await rows(
      conn,
      `SELECT * FROM (
         SELECT schema_name AS schema, table_name AS name, 'table' AS type, comment
           FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal
            AND lower(table_name) = lower($1) AND ($2::VARCHAR IS NULL OR lower(schema_name) = lower($2))
         UNION ALL
         SELECT schema_name, view_name, 'view', comment
           FROM duckdb_views() WHERE database_name = current_database() AND NOT internal
            AND lower(view_name) = lower($1) AND ($2::VARCHAR IS NULL OR lower(schema_name) = lower($2))
       ) ORDER BY (schema = 'main') DESC, schema
       LIMIT 1`,
      [name, schema],
    );
    const t = found[0];
    if (!t) return null;
    const where = [String(t.schema), String(t.name)];
    const cols = await rows(
      conn,
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS dflt, comment
         FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
        ORDER BY column_index`,
      where,
    );
    const cons = await rows(
      conn,
      `SELECT constraint_type AS kind, constraint_column_names AS columns,
              referenced_table AS ref_table, referenced_column_names AS ref_columns
         FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
          AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`,
      where,
    );
    const idx = await rows(
      conn,
      `SELECT index_name AS name, is_unique AS uniq, expressions
         FROM duckdb_indexes() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
        ORDER BY index_name`,
      where,
    );
    return { table: t, cols, cons, idx };
  });
}

/**
 * Convert one value of a result vector to JSON, walking nested lists, maps and structs
 * through their vectors so that nothing larger than the remaining budget is ever
 * materialized: a list of 25 million items is refused after reading its length.
 */
function makeConverter() {
  const id = duck.DuckDBTypeId;
  const json = duck.JsonDuckDBValueConverter;
  const wide = new Set<number>([id.BIGINT, id.UBIGINT, id.HUGEINT, id.UHUGEINT]);
  const leaf: DuckDB.DuckDBValueConverter<Json> = (value, type) => {
    if (value === null) return null;
    if (wide.has(type.typeId) && typeof value === 'bigint') {
      return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
    }
    try {
      return json(value, type, leaf);
    } catch {
      return String(value);
    }
  };

  const budget = { left: 0 };
  const spend = (n: number) => {
    budget.left -= n;
    if (budget.left < 0) throw new OverBudget();
  };

  const convert = (vector: DuckDB.DuckDBVector, index: number): Json => {
    const typeId = vector.type.typeId;
    if (typeId === id.LIST || typeId === id.MAP) {
      const list = (
        typeId === id.MAP ? (vector as unknown as { listVector?: unknown }).listVector : vector
      ) as DuckDB.DuckDBListVector | undefined;
      if (!list || typeof list.getEntryLength !== 'function') return slow(vector, index);
      if (list.getItemVector(index) === null) {
        spend(4);
        return null;
      }
      const length = list.getEntryLength(index);
      // Every item takes at least two bytes ("1,"), so the length alone can exceed the budget
      // before a single item is read. The reservation is returned and items count themselves.
      spend(2 + length * 2);
      budget.left += length * 2;
      const offset = list.getEntryOffset(index);
      const child = list.childVector;
      const out: Json[] = [];
      for (let k = 0; k < length; k++) {
        spend(1);
        out.push(convert(child, offset + k));
      }
      return out;
    }
    if (typeId === id.STRUCT) {
      const struct = vector as DuckDB.DuckDBStructVector;
      if (!struct.isItemValid(index)) {
        spend(4);
        return null;
      }
      const names = (struct.type as DuckDB.DuckDBStructType).entryNames;
      const out: Record<string, Json> = {};
      names.forEach((name, e) => {
        spend(name.length + 4);
        out[name] = convert(struct.entryVectorAt(e), index);
      });
      return out;
    }
    if (typeId === id.BLOB) {
      const bytes = (vector as DuckDB.DuckDBBlobVector).getItemBytes(index);
      spend(24);
      return bytes === null ? null : `<binary ${bytes.length} bytes>`;
    }
    if (typeId === id.ARRAY) {
      spend(2 + (vector.type as DuckDB.DuckDBArrayType).length * 2);
      return slow(vector, index);
    }
    return slow(vector, index);
  };

  /** Scalars (and types without a cheaper path): read the value, then count its JSON size. */
  const slow = (vector: DuckDB.DuckDBVector, index: number): Json => {
    const value = leaf(vector.getItem(index), vector.type, leaf);
    spend(value === null ? 4 : (JSON.stringify(value)?.length ?? 4));
    return value;
  };

  return {
    row(chunk: DuckDB.DuckDBDataChunk, r: number, left: number): { row: Json[]; used: number } {
      budget.left = left;
      const out: Json[] = [];
      for (let c = 0; c < chunk.columnCount; c++) {
        spend(1);
        out.push(convert(chunk.getColumnVector(c), r));
      }
      return { row: out, used: left - budget.left };
    },
  };
}

/**
 * Run a validated SELECT: one statement as DuckDB itself splits the text, of type SELECT
 * as DuckDB itself prepares it; rows are streamed until rowLimit + 1 rows or the byte
 * budget, whichever comes first.
 */
function read(sql: string, params: unknown[], rowLimit: number, maxBytes: number) {
  return withDb(async (conn) => {
    let stmt: DuckDB.DuckDBPreparedStatement;
    try {
      const extracted = await conn.extractStatements(sql);
      if (extracted.count !== 1) {
        throw new WorkerError(
          `Only one statement is allowed per query (DuckDB read ${extracted.count}).`,
        );
      }
      stmt = await extracted.prepare(0);
    } catch (err) {
      if (err instanceof WorkerError) throw err;
      throw new WorkerError(String((err as Error).message).split('\n')[0] ?? 'DuckDB error');
    }
    const { StatementType } = duck;
    if (stmt.statementType !== StatementType.SELECT) {
      throw new WorkerError(
        `Only SELECT queries are allowed (DuckDB prepared a ${StatementType[stmt.statementType] ?? 'non-SELECT'} statement).`,
      );
    }
    if (params.length > 0) stmt.bind(params as DuckDB.DuckDBValue[]);
    try {
      const result = await stmt.stream();
      const columns = result.columnNames();
      const converter = makeConverter();
      const out: Json[][] = [];
      let left = maxBytes;
      let cut: 'rows' | 'bytes' | undefined;
      while (!cut) {
        const chunk = await result.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        for (let r = 0; r < chunk.rowCount; r++) {
          if (out.length >= rowLimit) {
            cut = 'rows';
            break;
          }
          try {
            const { row, used } = converter.row(chunk, r, left);
            out.push(row);
            left -= used;
          } catch (err) {
            if (!(err instanceof OverBudget)) throw err;
            if (out.length === 0) {
              throw new WorkerError(
                `The first row is larger than the ${maxBytes}-byte response limit, so nothing was returned. Select fewer or smaller columns (for example len(list) instead of the list).`,
                'TOO_LARGE',
              );
            }
            cut = 'bytes';
            break;
          }
        }
      }
      return { columns, rows: out, cut: cut ?? null };
    } catch (err) {
      if (err instanceof WorkerError) throw err;
      if (err instanceof RangeError) {
        throw new WorkerError(
          'A value in the result is too large to return. Select fewer or smaller columns.',
          'TOO_LARGE',
        );
      }
      throw new WorkerError(String((err as Error).message).split('\n')[0] ?? 'DuckDB error');
    }
  });
}

/** DuckDB's parse tree, from an in-memory database that holds no data. */
async function serialize(sql: string): Promise<string> {
  if (!parserConn) {
    const db = await duck.DuckDBInstance.create(':memory:', config.parserSettings);
    parserConn = await db.connect();
  }
  const reader = await parserConn.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR)', [sql]);
  return String(reader.getRowsJS()[0]?.[0] ?? '');
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'tables':
      return tables();
    case 'describe':
      return describe(req.schema, req.name);
    case 'read':
      return read(req.sql, req.params, req.rowLimit, req.maxBytes);
    case 'serialize':
      return serialize(req.sql);
  }
}

try {
  duck = (await import(config.moduleUrl)) as typeof DuckDB;
  send({ type: 'ready', version: duck.version() });
} catch (err) {
  const message = String((err as Error).message ?? err).split('\n')[0];
  process.send?.({ type: 'fatal', message }, () => process.exit(1));
}

const gc = (globalThis as { gc?: () => void }).gc;

process.on('message', (req: Request) => {
  void handle(req)
    .then(
      (result) => send({ id: req.id, ok: true, result }),
      (err: unknown) =>
        send({
          id: req.id,
          ok: false,
          error: String((err as Error).message ?? err),
          code: (err as WorkerError).code,
        }),
    )
    .finally(() => {
      // A result that was not read to the end keeps the closed database (and its file lock)
      // alive until it is garbage collected: collect now, so other programs can write to
      // the file between calls. The parent starts this process with --expose-gc.
      gc?.();
    });
});
