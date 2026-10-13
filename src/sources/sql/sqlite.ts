import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
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

/**
 * SQLite runs in a worker thread because better-sqlite3 is synchronous:
 * the only way to stop a runaway query is to terminate the thread.
 *
 * Reads use a connection opened with { readonly: true }, and every statement
 * is also checked with better-sqlite3's `reader` and `readonly` flags.
 * `prepare()` refuses strings that hold more than one statement.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.modulePath);
const ro = new Database(workerData.file, { readonly: true, fileMustExist: true });
ro.pragma('query_only = ON');
let rw = null;

function cell(v) {
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return '<binary ' + v.length + ' bytes>';
  return v;
}
function bind(stmt, params, fn) {
  const hasParams = params && (Array.isArray(params) ? params.length > 0 : Object.keys(params).length > 0);
  return hasParams ? stmt[fn](params) : stmt[fn]();
}

parentPort.on('message', (msg) => {
  try {
    let result;
    if (msg.op === 'tables') {
      result = ro.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    } else if (msg.op === 'describe') {
      const exists = ro.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?").get(msg.name);
      if (!exists) result = null;
      else {
        const cols = ro.prepare('SELECT * FROM pragma_table_info(?)').all(msg.name);
        const fks = ro.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(msg.name);
        const idx = ro.prepare('SELECT * FROM pragma_index_list(?)').all(msg.name).map((i) => ({
          name: i.name,
          unique: !!i.unique,
          columns: ro.prepare('SELECT name FROM pragma_index_info(?)').all(i.name).map((c) => c.name),
        }));
        result = { type: exists.type, cols, fks, idx };
      }
    } else if (msg.op === 'read') {
      const stmt = ro.prepare(msg.sql);
      if (!stmt.reader) throw new Error('Only queries that return rows are allowed.');
      if (!stmt.readonly) throw new Error('The statement is not read-only.');
      stmt.raw(true);
      const columns = stmt.columns().map((c) => c.name);
      const rows = [];
      let truncated = false;
      for (const row of bind(stmt, msg.params, 'iterate')) {
        if (rows.length >= msg.limit) { truncated = true; break; }
        rows.push(row.map(cell));
      }
      result = { columns, rows, truncated };
    } else if (msg.op === 'write') {
      if (!rw) rw = new Database(workerData.file, { fileMustExist: true });
      const stmt = rw.prepare(msg.sql);
      rw.exec('BEGIN');
      try {
        const info = bind(stmt, msg.params, 'run');
        rw.exec(msg.dryRun ? 'ROLLBACK' : 'COMMIT');
        result = { rowCount: info.changes };
      } catch (e) {
        try { rw.exec('ROLLBACK'); } catch {}
        throw e;
      }
    }
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e), code: e && e.code });
  }
});
`;

interface Pending {
  worker: Worker;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function resolveBetterSqlite(): string {
  try {
    return createRequire(import.meta.url).resolve('better-sqlite3');
  } catch {
    throw new SqlError(
      'SQLite support needs the optional "better-sqlite3" package, which failed to install. ' +
        'Install it next to apitame (npm install better-sqlite3) and try again.',
    );
  }
}

export class SqliteDriver implements SqlDriver {
  readonly dialect = 'sqlite' as const;
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private readonly modulePath: string;

  constructor(private readonly file: string) {
    if (!existsSync(file)) throw new SqlError(`SQLite database not found: ${file}`);
    this.modulePath = resolveBetterSqlite();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { file: this.file, modulePath: this.modulePath },
    });
    w.on(
      'message',
      (msg: { id: number; ok: boolean; result?: unknown; error?: string; code?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new SqlError(msg.error ?? 'SQLite error', msg.code));
      },
    );
    w.on('error', (err) => this.failAll(w, new SqlError(`SQLite worker failed: ${err.message}`)));
    w.on('exit', () => {
      if (this.worker === w) this.worker = undefined;
      this.failAll(w, new SqlError('SQLite worker stopped.'));
    });
    w.unref();
    this.worker = w;
    return w;
  }

  private failAll(worker: Worker, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.worker !== worker) continue;
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private call<T>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The only way to stop a running SQLite statement: kill the thread. A new one starts on the next call.
        this.worker = undefined;
        void worker.terminate();
        reject(
          new SqlError(`Query timed out after ${timeoutMs} ms. Add filters or a LIMIT.`, 'TIMEOUT'),
        );
      }, timeoutMs);
      this.pending.set(id, { worker, resolve: resolve as (v: unknown) => void, reject, timer });
      worker.postMessage({ ...msg, id });
    });
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.call<Array<{ name: string; type: 'table' | 'view' }>>(
      { op: 'tables' },
      10_000,
    );
    return rows.map((r) => ({ schema: null, name: r.name, type: r.type }));
  }

  async describeTable(_schema: string | null, name: string): Promise<TableDetail | undefined> {
    const res = await this.call<{
      type: 'table' | 'view';
      cols: Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;
      fks: Array<{ id: number; seq: number; table: string; from: string; to: string | null }>;
      idx: Array<{ name: string; unique: boolean; columns: string[] }>;
    } | null>({ op: 'describe', name }, 10_000);
    if (!res) return undefined;
    const pk = res.cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    const fkGroups = new Map<number, { table: string; from: string[]; to: string[] }>();
    for (const fk of res.fks) {
      const g = fkGroups.get(fk.id) ?? { table: fk.table, from: [], to: [] };
      g.from.push(fk.from);
      g.to.push(fk.to ?? 'rowid');
      fkGroups.set(fk.id, g);
    }
    return {
      schema: null,
      name,
      type: res.type,
      columns: res.cols.map((c) => ({
        name: c.name,
        type: c.type || 'ANY',
        nullable: c.notnull === 0 && c.pk === 0,
        default: c.dflt_value,
        primaryKey: c.pk > 0,
      })),
      primaryKey: pk,
      foreignKeys: [...fkGroups.values()].map((g) => ({
        columns: g.from,
        references: { table: g.table, columns: g.to },
      })),
      indexes: res.idx,
    };
  }

  async readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult> {
    const started = Date.now();
    const res = await this.call<{ columns: string[]; rows: unknown[][]; truncated: boolean }>(
      { op: 'read', sql, params, limit: opts.rowLimit },
      opts.timeoutMs,
    );
    return { ...res, rowCount: res.rows.length, elapsedMs: Date.now() - started };
  }

  async writeQuery(
    sql: string,
    params: SqlParams,
    opts: WriteOptions,
  ): Promise<{ rowCount: number }> {
    return this.call<{ rowCount: number }>(
      { op: 'write', sql, params, dryRun: opts.dryRun },
      opts.timeoutMs,
    );
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}
