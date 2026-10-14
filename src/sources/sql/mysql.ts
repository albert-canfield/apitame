import mysql from 'mysql2/promise';
import { analyzeWrite } from './guard.js';
import {
  SqlError,
  type PrivilegeInfo,
  type QueryResult,
  type ReadOptions,
  type SqlDriver,
  type SqlParams,
  type TableDetail,
  type TableInfo,
  type WriteOptions,
} from './driver.js';

/** Statements MySQL commits implicitly, so they can never run inside a rolled-back transaction. */
const DDL_KINDS = new Set(['CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'RENAME']);
const WRITE_GRANTS = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|SUPER)\b/i;

function wrap(err: unknown, timeoutMs: number): SqlError {
  const e = err as { message?: string; code?: string };
  if (
    e.code === 'ER_QUERY_TIMEOUT' ||
    e.code === 'PROTOCOL_SEQUENCE_TIMEOUT' ||
    /timeout/i.test(e.message ?? '')
  ) {
    return new SqlError(
      `Query timed out after ${timeoutMs} ms. Add filters or a LIMIT.`,
      'TIMEOUT',
    );
  }
  return new SqlError(e.message ?? String(err), e.code);
}

function cell(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `<binary ${v.length} bytes>`;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * MySQL and MariaDB. Reads run in START TRANSACTION READ ONLY with a server
 * side execution limit and sql_select_limit; multi-statement queries are
 * refused by the protocol (multipleStatements stays off); parameters are bound
 * with server-side prepared statements, so no value is ever escaped into SQL.
 */
export class MysqlDriver implements SqlDriver {
  readonly dialect = 'mysql' as const;
  private readonly pool: mysql.Pool;
  private flavor: 'mysql' | 'mariadb' | undefined;

  constructor(connectionString: string) {
    this.pool = mysql.createPool({
      uri: connectionString,
      connectionLimit: 4,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      connectTimeout: 10_000,
      enableKeepAlive: true,
    });
  }

  private async detectFlavor(conn: mysql.PoolConnection): Promise<'mysql' | 'mariadb'> {
    if (!this.flavor) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v');
      this.flavor = /mariadb/i.test(String(rows[0]?.v ?? '')) ? 'mariadb' : 'mysql';
    }
    return this.flavor;
  }

  /** Check out a connection; destroy it instead of reusing it after a failure. */
  private async withConnection<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    let failed = false;
    try {
      return await fn(conn);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      if (failed) conn.destroy();
      else conn.release();
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est, TABLE_COMMENT AS comment
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME`,
    );
    return rows.map((r) => ({
      schema: null,
      name: String(r.name),
      type: /VIEW/i.test(String(r.type)) ? 'view' : 'table',
      rowEstimate: r.est === null || r.est === undefined ? null : Number(r.est),
      comment: r.comment ? String(r.comment) : null,
    }));
  }

  async describeTable(schema: string | null, name: string): Promise<TableDetail | undefined> {
    const db = schema ?? null;
    const [tables] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_TYPE AS type, TABLE_COMMENT AS comment FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?`,
      [db, name],
    );
    const table = tables[0];
    if (!table) return undefined;
    const [[cols], [keys], [idx]] = await Promise.all([
      this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey, COLUMN_COMMENT AS comment
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [db, name],
      ),
      this.pool.query<mysql.RowDataPacket[]>(
        `SELECT CONSTRAINT_NAME AS cname, COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS rtable,
                REFERENCED_COLUMN_NAME AS rcol
           FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
        [db, name],
      ),
      this.pool.query<mysql.RowDataPacket[]>(
        `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db, name],
      ),
    ]);
    const pk = keys.filter((k) => k.cname === 'PRIMARY').map((k) => String(k.col));
    const fks = new Map<string, { columns: string[]; table: string; refs: string[] }>();
    for (const k of keys.filter((x) => x.rtable)) {
      const g = fks.get(String(k.cname)) ?? { columns: [], table: String(k.rtable), refs: [] };
      g.columns.push(String(k.col));
      g.refs.push(String(k.rcol));
      fks.set(String(k.cname), g);
    }
    const indexes = new Map<string, { unique: boolean; columns: string[] }>();
    for (const i of idx) {
      const g = indexes.get(String(i.name)) ?? { unique: Number(i.nonUnique) === 0, columns: [] };
      g.columns.push(String(i.col));
      indexes.set(String(i.name), g);
    }
    return {
      schema: null,
      name,
      type: /VIEW/i.test(String(table.type)) ? 'view' : 'table',
      comment: table.comment ? String(table.comment) : null,
      columns: cols.map((c) => ({
        name: String(c.name),
        type: String(c.type),
        nullable: c.nullable === 'YES',
        default: c.dflt === null || c.dflt === undefined ? null : String(c.dflt),
        primaryKey: c.ckey === 'PRI',
        comment: c.comment ? String(c.comment) : null,
      })),
      primaryKey: pk,
      foreignKeys: [...fks.values()].map((f) => ({
        columns: f.columns,
        references: { table: f.table, columns: f.refs },
      })),
      indexes: [...indexes.entries()].map(([n, g]) => ({ name: n, ...g })),
    };
  }

  async readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult> {
    const started = Date.now();
    const values = Array.isArray(params) ? params : [];
    try {
      return await this.withConnection(async (conn) => {
        const flavor = await this.detectFlavor(conn);
        const ms = Math.max(1, Math.floor(opts.timeoutMs));
        await conn.query(
          flavor === 'mariadb'
            ? `SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)}`
            : `SET SESSION max_execution_time = ${ms}`,
        );
        await conn.query(`SET SESSION sql_select_limit = ${Math.floor(opts.rowLimit) + 1}`);
        await conn.query('START TRANSACTION READ ONLY');
        try {
          const options = { sql, rowsAsArray: true, timeout: ms + 2_000 };
          const [rows, fields] =
            values.length > 0
              ? await conn.execute<mysql.RowDataPacket[]>({ ...options, values: values as never })
              : await conn.query<mysql.RowDataPacket[]>(options);
          const all = (rows as unknown as unknown[][]).map((r) => r.map(cell));
          const truncated = all.length > opts.rowLimit;
          const out = truncated ? all.slice(0, opts.rowLimit) : all;
          return {
            columns: (fields ?? []).map((f) => f.name),
            rows: out,
            rowCount: out.length,
            truncated,
            elapsedMs: Date.now() - started,
          };
        } finally {
          await conn.query('ROLLBACK');
          await conn.query('SET SESSION sql_select_limit = DEFAULT');
        }
      });
    } catch (err) {
      throw wrap(err, opts.timeoutMs);
    }
  }

  async writeQuery(
    sql: string,
    params: SqlParams,
    opts: WriteOptions,
  ): Promise<{ rowCount: number }> {
    // Classify with the lexer, not a regex: a leading comment or CTE must not hide a DROP.
    const analysis = analyzeWrite(sql, 'mysql');
    if (opts.dryRun && (!analysis.ok || DDL_KINDS.has(analysis.kind ?? ''))) {
      // MySQL commits DDL implicitly, so it cannot run inside a transaction that is rolled back.
      throw new SqlError('A dry run is not possible for DDL on MySQL: DDL commits implicitly.');
    }
    const values = Array.isArray(params) ? params : [];
    try {
      return await this.withConnection(async (conn) => {
        await conn.query('START TRANSACTION');
        try {
          const [res] = await conn.execute<mysql.ResultSetHeader>({
            sql,
            values: values as never,
            timeout: Math.max(1, Math.floor(opts.timeoutMs)),
          });
          await conn.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
          return { rowCount: res.affectedRows ?? 0 };
        } catch (err) {
          await conn.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    } catch (err) {
      throw wrap(err, opts.timeoutMs);
    }
  }

  async privileges(): Promise<PrivilegeInfo> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>('SHOW GRANTS');
    const grants = rows.map((r) => String(Object.values(r)[0] ?? ''));
    const [who] = await this.pool.query<mysql.RowDataPacket[]>('SELECT CURRENT_USER() AS u');
    const user = String(who[0]?.u ?? '?');
    const writing = grants.filter((g) => WRITE_GRANTS.test(g.replace(/GRANT OPTION/gi, '')));
    return writing.length > 0
      ? {
          canWrite: true,
          detail: `user ${user} has write grants (${writing.length} grant line${writing.length === 1 ? '' : 's'})`,
        }
      : { canWrite: false, detail: `user ${user} has no write grants` };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
