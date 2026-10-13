import pg from 'pg';
import {
  SqlError,
  type QueryResult,
  type ReadOptions,
  type SqlDriver,
  type SqlParams,
  type TableDetail,
  type TableInfo,
  type WriteOptions,
} from './driver.js';

const TIMEOUT_CODE = '57014';

function wrap(err: unknown, timeoutMs: number): SqlError {
  const e = err as { message?: string; code?: string; position?: string; hint?: string };
  if (e.code === TIMEOUT_CODE || /timeout/i.test(e.message ?? '')) {
    return new SqlError(
      `Query timed out after ${timeoutMs} ms. Add filters or a LIMIT.`,
      TIMEOUT_CODE,
    );
  }
  const parts = [e.message ?? String(err)];
  if (e.hint) parts.push(`Hint: ${e.hint}`);
  return new SqlError(parts.join(' '), e.code);
}

export class PostgresDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly schemas: string[],
    defaultTimeoutMs = 15_000,
  ) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: 'apitame',
      // Client-side backstop in case the server ignores statement_timeout.
      query_timeout: defaultTimeoutMs + 2_000,
    });
    // Connection errors (a restarted server, a protocol hiccup) must never crash the MCP server.
    // Failed queries still reject normally; this only catches errors with nobody waiting for them.
    this.pool.on('error', () => {});
    this.pool.on('connect', (client) => client.on('error', () => {}));
  }

  async listTables(): Promise<TableInfo[]> {
    const res = await this.pool.query<{
      schema: string;
      name: string;
      type: 'table' | 'view';
      row_estimate: string | null;
      comment: string | null;
    }>(
      `SELECT n.nspname AS schema, c.relname AS name,
              CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS type,
              CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS row_estimate,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
          AND n.nspname = ANY($1)
          AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY 1, 2`,
      [this.schemas],
    );
    return res.rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      type: r.type,
      rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate),
      comment: r.comment,
    }));
  }

  async describeTable(schema: string | null, name: string): Promise<TableDetail | undefined> {
    const found = await this.pool.query<{
      oid: number;
      schema: string;
      kind: string;
      comment: string | null;
    }>(
      `SELECT c.oid, n.nspname AS schema, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = ANY($2) AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
          AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY array_position($2, n.nspname)
        LIMIT 1`,
      [name, schema ? [schema] : this.schemas],
    );
    const t = found.rows[0];
    if (!t) return undefined;

    const [cols, cons, idx] = await Promise.all([
      this.pool.query<{
        name: string;
        type: string;
        nullable: boolean;
        default: string | null;
        comment: string | null;
      }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default, col_description(a.attrelid, a.attnum) AS comment
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [t.oid],
      ),
      this.pool.query<{
        type: string;
        columns: string[];
        ref_table: string | null;
        ref_columns: string[];
      }>(
        `SELECT con.contype AS type,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, ord)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY ord) AS columns,
                CASE WHEN con.contype = 'f' THEN con.confrelid::regclass::text END AS ref_table,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, ord)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY ord) AS ref_columns
           FROM pg_constraint con
          WHERE con.conrelid = $1 AND con.contype IN ('p', 'f')`,
        [t.oid],
      ),
      this.pool.query<{ name: string; unique: boolean; columns: string[] }>(
        `SELECT i.relname AS name, ix.indisunique AS unique,
                ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                        FROM generate_subscripts(ix.indkey, 1) k ORDER BY k) AS columns
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = $1
          ORDER BY i.relname`,
        [t.oid],
      ),
    ]);

    const pk = cons.rows.find((c) => c.type === 'p')?.columns ?? [];
    return {
      schema: t.schema,
      name,
      type: t.kind === 'v' || t.kind === 'm' ? 'view' : 'table',
      comment: t.comment,
      columns: cols.rows.map((c) => ({ ...c, primaryKey: pk.includes(c.name) })),
      primaryKey: pk,
      foreignKeys: cons.rows
        .filter((c) => c.type === 'f')
        .map((c) => ({
          columns: c.columns,
          references: { table: c.ref_table ?? '', columns: c.ref_columns },
        })),
      indexes: idx.rows,
    };
  }

  /**
   * Run a validated SELECT:
   * - inside BEGIN READ ONLY, so the database refuses any write
   * - with SET LOCAL statement_timeout
   * - through the extended protocol, which refuses more than one statement
   * - through a cursor, so at most rowLimit + 1 rows ever leave the server
   */
  /**
   * Check out a connection that cannot crash the process: socket-level errors
   * are absorbed while it is in use, and a connection that saw an error is
   * destroyed instead of going back to the pool.
   */
  private async checkout(): Promise<{ client: pg.PoolClient; done: (failed: boolean) => void }> {
    const client = await this.pool.connect();
    let broken = false;
    const onError = () => {
      broken = true;
    };
    client.on('error', onError);
    return {
      client,
      done: (failed) => {
        client.off('error', onError);
        client.release(failed || broken ? true : undefined);
      },
    };
  }

  async readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult> {
    const started = Date.now();
    const { client, done } = await this.checkout();
    let failed = false;
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(
        `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`,
      );
      await client.query('SET LOCAL standard_conforming_strings = on');
      await client.query({
        text: `DECLARE apitame_cursor NO SCROLL CURSOR FOR ${sql}`,
        values: Array.isArray(params) ? params : [],
        queryMode: 'extended',
      } as pg.QueryConfig);
      const res = await client.query({
        text: `FETCH FORWARD ${Math.floor(opts.rowLimit) + 1} FROM apitame_cursor`,
        rowMode: 'array',
      });
      const truncated = res.rows.length > opts.rowLimit;
      const rows = (truncated ? res.rows.slice(0, opts.rowLimit) : res.rows) as unknown[][];
      return {
        columns: res.fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      failed = true;
      throw wrap(err, opts.timeoutMs);
    } finally {
      if (!failed) await client.query('ROLLBACK').catch(() => (failed = true));
      done(failed);
    }
  }

  async writeQuery(
    sql: string,
    params: SqlParams,
    opts: WriteOptions,
  ): Promise<{ rowCount: number }> {
    const { client, done } = await this.checkout();
    let open = false;
    let failed = false;
    try {
      await client.query('BEGIN');
      open = true;
      await client.query(
        `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`,
      );
      await client.query('SET LOCAL standard_conforming_strings = on');
      const res = await client.query({
        text: sql,
        values: Array.isArray(params) ? params : [],
        queryMode: 'extended',
      } as pg.QueryConfig);
      await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
      open = false;
      return { rowCount: res.rowCount ?? 0 };
    } catch (err) {
      failed = true;
      throw wrap(err, opts.timeoutMs);
    } finally {
      // A failed connection is destroyed (done(true)); the server rolls back the open transaction.
      if (open && !failed) await client.query('ROLLBACK').catch(() => (failed = true));
      done(failed);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
