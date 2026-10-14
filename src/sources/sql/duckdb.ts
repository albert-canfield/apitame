import { accessSync, constants, existsSync } from 'node:fs';
import type * as DuckDB from '@duckdb/node-api';
import {
  SqlError,
  type PrivilegeInfo,
  type QueryResult,
  type ReadOptions,
  type SqlDriver,
  type SqlParams,
  type TableDetail,
  type TableInfo,
} from './driver.js';
import { DUCKDB_NPX, DUCKDB_PACKAGE, duckdbMissingMessage } from './duckdb-package.js';

export { DUCKDB_NPX, DUCKDB_PACKAGE, duckdbMissingMessage };

export type DuckdbModule = typeof DuckDB;
export type DuckdbImporter = () => Promise<unknown>;

/** Oldest DuckDB release whose parse tree and settings apitame has been checked against. */
const MIN_VERSION: [number, number] = [1, 4];

/**
 * Settings for the user's database file, applied when it is opened:
 * - READ_ONLY: DuckDB refuses every write to the file.
 * - enable_external_access=false: no other files (read_csv, `FROM 'x.csv'`, COPY,
 *   EXPORT, ATTACH, INSTALL), no network.
 * - extension autoloading and autoinstalling off, persistent secrets off.
 * - lock_configuration=true: SET and RESET cannot change any of the above.
 */
export const DUCKDB_READ_ONLY_SETTINGS: Record<string, string> = {
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoload_known_extensions: 'false',
  autoinstall_known_extensions: 'false',
  allow_community_extensions: 'false',
  allow_unsigned_extensions: 'false',
  allow_persistent_secrets: 'false',
  lock_configuration: 'true',
};
/** The parser database is in memory (it holds no data) and gets the same restrictions. */
const PARSER_SETTINGS: Record<string, string> = Object.fromEntries(
  Object.entries(DUCKDB_READ_ONLY_SETTINGS).filter(([k]) => k !== 'access_mode'),
);
/** What the settings must read back as, or the driver refuses to run anything. */
const EXPECTED_SETTINGS: Record<string, string> = {
  access_mode: 'read_only',
  enable_external_access: 'false',
  autoload_known_extensions: 'false',
  autoinstall_known_extensions: 'false',
  lock_configuration: 'true',
};

let cachedModule: Promise<DuckdbModule> | undefined;

/**
 * Load `@duckdb/node-api` on demand. When it is missing, or its native binary does not
 * load on this platform, the error says exactly how to run apitame with it.
 */
export function loadDuckdb(importer?: DuckdbImporter): Promise<DuckdbModule> {
  if (!importer && cachedModule) return cachedModule;
  const load = (async () => {
    let mod: DuckdbModule;
    try {
      mod = (await (importer ?? (() => import('@duckdb/node-api')))()) as DuckdbModule;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const missing =
        (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND') &&
        String(e.message).includes(DUCKDB_PACKAGE);
      throw new SqlError(
        duckdbMissingMessage(missing ? undefined : String(e.message ?? err).split('\n')[0]),
        'DUCKDB_MISSING',
      );
    }
    const version = typeof mod.version === 'function' ? mod.version() : '';
    const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
    if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1])) {
      throw new SqlError(
        `apitame needs DuckDB ${MIN_VERSION.join('.')} or later, but ${DUCKDB_PACKAGE} provides ${version || 'an unknown version'}. Run with the latest: ${DUCKDB_NPX} <command>`,
        'DUCKDB_VERSION',
      );
    }
    return mod;
  })();
  if (!importer) {
    cachedModule = load;
    load.catch(() => {
      cachedModule = undefined;
    });
  }
  return load;
}

/** Turn an error from opening the file into a message that says what to do. */
function openError(err: unknown, file: string): SqlError {
  const message = String((err as Error).message ?? err);
  // Unix: "Could not set lock on file ... Conflicting lock is held in <program> (PID n)".
  // Windows can also report a sharing violation ("being used by another process").
  const lock = /Could not set lock on file|used by another process/i.test(message);
  if (lock) {
    const holder = /Conflicting lock is held in ([^.]*?\(PID \d+\))/.exec(message)?.[1];
    return new SqlError(
      `The DuckDB file ${file} is open for writing in another process${holder ? ` (${holder})` : ''}. ` +
        'DuckDB lets one process write to a file or several read it, not both: close the other program ' +
        '(a DuckDB shell, a notebook or a data job), or point apitame at a copy of the file.',
      'DUCKDB_LOCKED',
    );
  }
  if (/not a valid DuckDB database file/i.test(message)) {
    return new SqlError(`${file} is not a DuckDB database file.`);
  }
  if (/database does not exist/i.test(message)) {
    return new SqlError(`DuckDB database not found: ${file}`);
  }
  return new SqlError(`Could not open the DuckDB file ${file}: ${message.split('\n')[0]}`);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * DuckDB on a single file, read-only.
 *
 * Every call opens the file in its own DuckDB instance with DUCKDB_READ_ONLY_SETTINGS and
 * closes it afterwards. Opening costs a few milliseconds, and in exchange nothing a
 * query changes in the engine (logging, profiling, parser choice) outlives the call,
 * other programs can write to the file between calls, and every call sees the latest
 * data. Free-form queries must be one statement (DuckDB's own `extractStatements`)
 * of type SELECT (`prepare`), results are streamed and cut at the row limit, and the
 * timeout calls `interrupt()`.
 */
export class DuckdbDriver implements SqlDriver {
  readonly dialect = 'duckdb' as const;
  private parserConn: Promise<DuckDB.DuckDBConnection> | undefined;
  private parserDb: DuckDB.DuckDBInstance | undefined;
  private parserQueue: Promise<unknown> = Promise.resolve();
  private readonly convert: DuckDB.DuckDBValueConverter<DuckDB.Json>;

  constructor(
    private readonly file: string,
    private readonly duck: DuckdbModule,
  ) {
    if (!existsSync(file)) throw new SqlError(`DuckDB database not found: ${file}`);
    const { JsonDuckDBValueConverter: json, DuckDBTypeId: id } = duck;
    const wide = new Set<number>([id.BIGINT, id.UBIGINT, id.HUGEINT, id.UHUGEINT]);
    const convert: DuckDB.DuckDBValueConverter<DuckDB.Json> = (value, type) => {
      if (value === null) return null;
      if (type.typeId === id.BLOB) {
        return `<binary ${(value as DuckDB.DuckDBBlobValue).bytes.length} bytes>`;
      }
      if (wide.has(type.typeId) && typeof value === 'bigint') {
        return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
      }
      try {
        return json(value, type, convert);
      } catch {
        return String(value);
      }
    };
    this.convert = convert;
  }

  /** Load the driver package (with a clear error when it is missing) and check the file exists. */
  static async open(file: string, importer?: DuckdbImporter): Promise<DuckdbDriver> {
    if (!existsSync(file)) throw new SqlError(`DuckDB database not found: ${file}`);
    return new DuckdbDriver(file, await loadDuckdb(importer));
  }

  /** The DuckDB version of the loaded driver, for example "v1.5.6". */
  get version(): string {
    return this.duck.version();
  }

  private async withDb<T>(fn: (conn: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    let db: DuckDB.DuckDBInstance;
    try {
      db = await this.duck.DuckDBInstance.create(this.file, DUCKDB_READ_ONLY_SETTINGS);
    } catch (err) {
      throw openError(err, this.file);
    }
    let conn: DuckDB.DuckDBConnection | undefined;
    let abandoned = false;
    try {
      conn = await db.connect();
      await this.checkSettings(conn);
      return await fn(conn);
    } catch (err) {
      if ((err as { abandoned?: boolean }).abandoned) abandoned = true;
      throw err;
    } finally {
      // A query that ignored interrupt() is left to finish on its own; closing under it is unsafe.
      if (!abandoned) {
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
  }

  /** Refuse to run anything if DuckDB did not apply the read-only settings. */
  private async checkSettings(conn: DuckDB.DuckDBConnection): Promise<void> {
    const names = Object.keys(EXPECTED_SETTINGS);
    const reader = await conn.runAndReadAll(
      `SELECT ${names.map((n) => `current_setting('${n}')`).join(', ')}`,
    );
    const row = reader.getRowsJS()[0] ?? [];
    const wrong = names.filter((n, i) => String(row[i]).toLowerCase() !== EXPECTED_SETTINGS[n]);
    if (wrong.length > 0) {
      throw new SqlError(
        `DuckDB did not apply apitame's read-only settings (${wrong.join(', ')}), so no query was run.`,
      );
    }
  }

  private async rows(
    conn: DuckDB.DuckDBConnection,
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const reader = await conn.runAndReadAll(sql, params as DuckDB.DuckDBValue[]);
    return reader.getRowObjectsJson() as Array<Record<string, unknown>>;
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.withDb((conn) =>
      this.rows(
        conn,
        `SELECT schema_name AS schema, table_name AS name, 'table' AS type, estimated_size AS estimate, comment
           FROM duckdb_tables() WHERE database_name = current_database() AND NOT internal AND NOT temporary
         UNION ALL
         SELECT schema_name, view_name, 'view', NULL, comment
           FROM duckdb_views() WHERE database_name = current_database() AND NOT internal AND NOT temporary
         ORDER BY 1, 2`,
      ),
    );
    return rows.map((r) => ({
      schema: String(r.schema),
      name: String(r.name),
      type: r.type === 'view' ? 'view' : 'table',
      rowEstimate: r.estimate === null || r.estimate === undefined ? null : Number(r.estimate),
      comment: typeof r.comment === 'string' && r.comment ? r.comment : null,
    }));
  }

  async describeTable(schema: string | null, name: string): Promise<TableDetail | undefined> {
    return this.withDb(async (conn) => {
      const found = await this.rows(
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
      if (!t) return undefined;
      const where = [String(t.schema), String(t.name)];
      const [cols, cons, idx] = [
        await this.rows(
          conn,
          `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS dflt, comment
             FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
            ORDER BY column_index`,
          where,
        ),
        await this.rows(
          conn,
          `SELECT constraint_type AS kind, constraint_column_names AS columns,
                  referenced_table AS ref_table, referenced_column_names AS ref_columns
             FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
              AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`,
          where,
        ),
        await this.rows(
          conn,
          `SELECT index_name AS name, is_unique AS uniq, expressions
             FROM duckdb_indexes() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2
            ORDER BY index_name`,
          where,
        ),
      ];
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      const pk = list(cons.find((c) => c.kind === 'PRIMARY KEY')?.columns);
      return {
        schema: String(t.schema),
        name: String(t.name),
        type: t.type === 'view' ? 'view' : 'table',
        comment: typeof t.comment === 'string' && t.comment ? t.comment : null,
        columns: cols.map((c) => ({
          name: String(c.name),
          type: String(c.type),
          nullable: c.nullable !== false && !pk.includes(String(c.name)),
          default: c.dflt === null || c.dflt === undefined ? null : String(c.dflt),
          primaryKey: pk.includes(String(c.name)),
          comment: typeof c.comment === 'string' && c.comment ? c.comment : null,
        })),
        primaryKey: pk,
        foreignKeys: cons
          .filter((c) => c.kind === 'FOREIGN KEY')
          .map((c) => ({
            columns: list(c.columns),
            references: { table: String(c.ref_table ?? ''), columns: list(c.ref_columns) },
          })),
        indexes: idx.map((i) => ({
          name: String(i.name),
          unique: i.uniq === true,
          columns: String(i.expressions ?? '')
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        })),
      };
    });
  }

  /**
   * Run a validated SELECT: one statement as DuckDB itself splits the text, of type SELECT
   * as DuckDB itself prepares it, on a read-only database with file access off; results
   * are streamed until rowLimit + 1 rows, and the timeout interrupts the query.
   */
  async readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult> {
    const started = Date.now();
    const { StatementType } = this.duck;
    return this.withDb(async (conn) => {
      let stmt: DuckDB.DuckDBPreparedStatement;
      try {
        const extracted = await conn.extractStatements(sql);
        if (extracted.count !== 1) {
          throw new SqlError(
            `Only one statement is allowed per query (DuckDB read ${extracted.count}).`,
          );
        }
        stmt = await extracted.prepare(0);
      } catch (err) {
        if (err instanceof SqlError) throw err;
        throw new SqlError(String((err as Error).message).split('\n')[0] ?? 'DuckDB error');
      }
      if (stmt.statementType !== StatementType.SELECT) {
        throw new SqlError(
          `Only SELECT queries are allowed (DuckDB prepared a ${StatementType[stmt.statementType] ?? 'non-SELECT'} statement).`,
        );
      }
      if (Array.isArray(params) && params.length > 0) stmt.bind(params as DuckDB.DuckDBValue[]);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        conn.interrupt();
      }, opts.timeoutMs);
      let backstop: NodeJS.Timeout | undefined;
      const work = (async () => {
        const result = await stmt.stream();
        const columns = result.columnNames();
        const rows: unknown[][] = [];
        while (rows.length <= opts.rowLimit) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          for (const row of chunk.convertRows(this.convert)) {
            rows.push(row);
            if (rows.length > opts.rowLimit) break;
          }
        }
        return { columns, rows };
      })();
      // If DuckDB ever ignored interrupt(), still answer the agent instead of hanging.
      const giveUp = new Promise<never>((_, reject) => {
        backstop = setTimeout(
          () =>
            reject(
              Object.assign(new SqlError('Query timed out and could not be stopped.', 'TIMEOUT'), {
                abandoned: true,
              }),
            ),
          opts.timeoutMs + 5_000,
        );
      });
      try {
        const { columns, rows } = await Promise.race([work, giveUp]);
        const truncated = rows.length > opts.rowLimit;
        const kept = truncated ? rows.slice(0, opts.rowLimit) : rows;
        return {
          columns,
          rows: kept,
          rowCount: kept.length,
          truncated,
          elapsedMs: Date.now() - started,
        };
      } catch (err) {
        if (err instanceof SqlError) throw err;
        if (timedOut || /interrupt/i.test(String((err as Error).message))) {
          throw new SqlError(
            `Query timed out after ${opts.timeoutMs} ms. Add filters or a LIMIT.`,
            'TIMEOUT',
          );
        }
        throw new SqlError(String((err as Error).message).split('\n')[0] ?? 'DuckDB error');
      } finally {
        clearTimeout(timer);
        clearTimeout(backstop);
        work.catch(() => {});
      }
    });
  }

  async writeQuery(): Promise<{ rowCount: number }> {
    throw new SqlError(
      'Named write queries are not supported for DuckDB: apitame opens DuckDB files read-only.',
    );
  }

  async privileges(): Promise<PrivilegeInfo> {
    try {
      accessSync(this.file, constants.W_OK);
      return {
        canWrite: true,
        detail: 'the database file is writable by this user (apitame still opens it read-only)',
      };
    } catch {
      return { canWrite: false, detail: 'the database file is read-only for this user' };
    }
  }

  /**
   * DuckDB's parse tree of a query (`json_serialize_sql`), for the parser layer. It runs
   * on a separate in-memory database that holds no data, with the query bound as a
   * parameter, so the query is parsed there but never run.
   */
  async serializeSelect(sql: string): Promise<string> {
    const run = async () => {
      this.parserConn ??= (async () => {
        const db = await this.duck.DuckDBInstance.create(':memory:', PARSER_SETTINGS);
        this.parserDb = db;
        return db.connect();
      })();
      const conn = await this.parserConn;
      const reader = await conn.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR)', [sql]);
      return String(reader.getRowsJS()[0]?.[0] ?? '');
    };
    // One parse at a time on the shared connection.
    const next = this.parserQueue.then(run, run);
    this.parserQueue = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    const conn = await this.parserConn?.catch(() => undefined);
    this.parserConn = undefined;
    try {
      conn?.closeSync();
      this.parserDb?.closeSync();
    } catch {
      // already closed
    }
    this.parserDb = undefined;
  }
}
