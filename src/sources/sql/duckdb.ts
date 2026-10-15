import { fork, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import {
  DUCKDB_NPX,
  DUCKDB_PACKAGE,
  DUCKDB_SPEC,
  DUCKDB_TESTED_VERSION,
  duckdbMissingMessage,
} from './duckdb-package.js';

export { DUCKDB_NPX, DUCKDB_PACKAGE, DUCKDB_SPEC, DUCKDB_TESTED_VERSION, duckdbMissingMessage };

export type DuckdbModule = typeof DuckDB;

/** Oldest DuckDB release whose parse tree and settings apitame has been checked against. */
const MIN_VERSION: [number, number] = [1, 4];
/** Newer minor releases than the tested one load, with a warning. */
const TESTED_MINOR = DUCKDB_TESTED_VERSION.split('.').slice(0, 2).map(Number) as [number, number];

export const DUCKDB_DEFAULT_MEMORY_LIMIT = '1GB';
export const DUCKDB_DEFAULT_THREADS = 2;
/** V8 heap of the DuckDB child process: result conversion never takes the server down. */
const WORKER_HEAP_MB = 512;
const WORKER_STARTUP_MS = 30_000;
/** Response budget when a caller gives none (the runtime passes limits.maxResponseBytes). */
const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Settings for the user's database file, applied in this order when it is opened:
 * - temp_directory '' and max_temp_directory_size 0: no spill files next to the database
 *   (temp_directory must be set before external access is turned off).
 * - READ_ONLY: DuckDB refuses every write to the file.
 * - enable_external_access=false: no other files (read_csv, `FROM 'x.csv'`, COPY,
 *   EXPORT, ATTACH, INSTALL), no network. DuckDB still allows the database file and its
 *   WAL; the lexer and parser layers refuse readers of those by name.
 * - extensions: no autoloading or autoinstalling, no community or unsigned extensions.
 * - no persistent secrets, and http_proxy set explicitly so DuckDB does not copy a proxy
 *   (and its password) from the environment.
 * - memory_limit and threads: bounded resources per call.
 * - lock_configuration=true: SET and RESET cannot change any of the above.
 */
export function duckdbSettings(
  memoryLimit = DUCKDB_DEFAULT_MEMORY_LIMIT,
  threads = DUCKDB_DEFAULT_THREADS,
): Record<string, string> {
  return {
    temp_directory: '',
    access_mode: 'READ_ONLY',
    enable_external_access: 'false',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_community_extensions: 'false',
    allow_unsigned_extensions: 'false',
    allow_persistent_secrets: 'false',
    http_proxy: 'none',
    memory_limit: memoryLimit,
    threads: String(threads),
    max_temp_directory_size: '0B',
    lock_configuration: 'true',
  };
}

/** The settings with the defaults (exported for tests and tooling). */
export const DUCKDB_READ_ONLY_SETTINGS = duckdbSettings();

/** What every setting must read back as; the child refuses to run anything otherwise. */
function expectedSettings(memoryLimit: string, threads: number): Record<string, string> {
  return {
    access_mode: 'read_only',
    enable_external_access: 'false',
    autoload_known_extensions: 'false',
    autoinstall_known_extensions: 'false',
    allow_community_extensions: 'false',
    allow_unsigned_extensions: 'false',
    allow_persistent_secrets: 'false',
    lock_configuration: 'true',
    temp_directory: '',
    max_temp_directory_size: '0 bytes',
    http_proxy: 'none',
    threads: String(threads),
    memory_limit: memoryLimit,
  };
}

/** The parser database is in memory (it holds no data) and gets the same restrictions. */
function parserSettings(): Record<string, string> {
  const s = duckdbSettings('256MB', 1);
  delete s.access_mode;
  return s;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND') &&
    String(e.message).includes(DUCKDB_PACKAGE)
  );
}

/** Where `@duckdb/node-api` is installed next to apitame, as a file URL. */
function defaultResolve(): string {
  // import.meta.resolve follows module customization hooks; createRequire covers runtimes
  // (such as test transforms) that do not provide it.
  try {
    if (typeof import.meta.resolve === 'function') return import.meta.resolve(DUCKDB_PACKAGE);
  } catch (err) {
    if (isNotFound(err)) throw err;
  }
  return pathToFileURL(createRequire(import.meta.url).resolve(DUCKDB_PACKAGE)).href;
}

/**
 * Find the driver package without loading it in this process. When it is missing, the
 * error says exactly how to run apitame with it.
 */
export function resolveDuckdb(resolve: () => string = defaultResolve): string {
  try {
    return resolve();
  } catch (err) {
    throw new SqlError(
      duckdbMissingMessage(
        isNotFound(err) ? undefined : String((err as Error).message ?? err).split('\n')[0],
      ),
      'DUCKDB_MISSING',
    );
  }
}

/** Refuse versions older than apitame supports; describe newer, untested minors. */
export function checkDuckdbVersion(version: string): { warning?: string } {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1])) {
    throw new SqlError(
      `apitame needs DuckDB ${MIN_VERSION.join('.')} or later, but ${DUCKDB_PACKAGE} provides ${version || 'an unknown version'}. Run with the tested release: ${DUCKDB_NPX} <command>`,
      'DUCKDB_VERSION',
    );
  }
  if (major > TESTED_MINOR[0] || (major === TESTED_MINOR[0] && minor > TESTED_MINOR[1])) {
    return {
      warning: `DuckDB ${version} is newer than the release apitame is tested with (${DUCKDB_TESTED_VERSION}). It runs, but the parse tree checks may refuse queries; ${DUCKDB_SPEC} is the tested version.`,
    };
  }
  return {};
}

/**
 * Load `@duckdb/node-api` in this process. The driver never does this (DuckDB runs in a
 * child process); it is for tooling and tests that create DuckDB files.
 */
export async function loadDuckdb(resolve?: () => string): Promise<DuckdbModule> {
  const url = resolveDuckdb(resolve);
  let mod: DuckdbModule;
  try {
    mod = (await import(url)) as DuckdbModule;
  } catch (err) {
    throw new SqlError(
      duckdbMissingMessage(String((err as Error).message ?? err).split('\n')[0]),
      'DUCKDB_MISSING',
    );
  }
  checkDuckdbVersion(mod.version());
  return mod;
}

/** The worker module next to this one: built JavaScript, or TypeScript run with type stripping. */
function workerEntry(heapMb: number): { file: string; execArgv: string[] } {
  const here = fileURLToPath(import.meta.url);
  const fromSource = here.endsWith('.ts');
  return {
    file: join(dirname(here), fromSource ? 'duckdb-worker.ts' : 'duckdb-worker.js'),
    execArgv: [
      `--max-old-space-size=${heapMb}`,
      '--expose-gc',
      ...(fromSource
        ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
        : []),
    ],
  };
}

/**
 * The child gets a minimal environment: nothing from the user's shell (no proxy settings,
 * no credentials, no NODE_OPTIONS), only what Node needs to start on Windows.
 */
function workerEnv(): NodeJS.ProcessEnv {
  const keep =
    process.platform === 'win32'
      ? ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']
      : ['PATH'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

interface WorkerConfig {
  file: string;
  moduleUrl: string;
  settings: Record<string, string>;
  expected: Record<string, string>;
  parserSettings: Record<string, string>;
}

type WorkerRequest =
  | { op: 'tables' }
  | { op: 'describe'; schema: string | null; name: string }
  | { op: 'read'; sql: string; params: unknown[]; rowLimit: number; maxBytes: number }
  | { op: 'serialize'; sql: string };

interface Pending {
  /** The process serving the request: only its own exit fails it. */
  child: ChildProcess;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Turn the end of a child process into a message for the agent. */
function exitError(code: number | null, signal: string | null, stderr: string): SqlError {
  const oom =
    /heap out of memory|Allocation failed|Reached heap limit|Out of Memory|bad_alloc/i.test(
      stderr,
    ) ||
    code === 134 ||
    signal === 'SIGABRT';
  if (oom) {
    return new SqlError(
      'The query used too much memory and was stopped. Return fewer rows or smaller values (for example len(list) instead of the list), or add filters.',
      'OUT_OF_MEMORY',
    );
  }
  if (signal === 'SIGKILL') {
    return new SqlError(
      'The DuckDB process was stopped by the operating system, most likely because the query used too much memory. Add filters or return less data.',
      'OUT_OF_MEMORY',
    );
  }
  return new SqlError(
    `The DuckDB process stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`}). It starts again on the next call.`,
    'DUCKDB_CRASHED',
  );
}

/**
 * One DuckDB child process, serving one request at a time. Every request has its own
 * deadline, armed before the request is sent: when it passes, or when a result would not
 * fit, the child is killed (it cannot be trusted to stop: DuckDB ignores interrupt()
 * while planning) and a new one starts on the next request.
 */
class DuckdbWorker {
  private child: ChildProcess | undefined;
  private starting: Promise<ChildProcess> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private warned = false;
  version: string | undefined;

  constructor(
    private readonly config: WorkerConfig,
    private readonly warn?: (message: string) => void,
    private readonly heapMb = WORKER_HEAP_MB,
  ) {}

  call<T>(request: WorkerRequest, timeoutMs: number): Promise<T> {
    const turn = this.queue.then(() => this.dispatch<T>(request, timeoutMs));
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** Start the child (if needed) and return the DuckDB version it loaded. */
  async ready(): Promise<string> {
    await this.start();
    return this.version ?? '';
  }

  private async dispatch<T>(request: WorkerRequest, timeoutMs: number): Promise<T> {
    const child = await this.start();
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill(child);
        reject(
          new SqlError(
            `Query timed out: it took longer than ${timeoutMs} ms and was stopped. Add filters or a LIMIT.`,
            'TIMEOUT',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        child,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        child.send({ ...request, id });
      } catch (err) {
        this.pending.get(id)?.reject(new SqlError(`DuckDB process unavailable: ${String(err)}`));
        this.pending.delete(id);
      }
    });
  }

  private start(): Promise<ChildProcess> {
    if (this.starting) return this.starting;
    const entry = workerEntry(this.heapMb);
    let stderr = '';
    const child = fork(entry.file, [JSON.stringify(this.config)], {
      execArgv: entry.execArgv,
      env: workerEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'json',
      windowsHide: true,
    });
    // The child never keeps the server alive on its own; a pending request's timer does.
    child.unref();
    child.channel?.unref();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr = (stderr + d).slice(-4_000);
    });
    this.child = child;

    const starting = new Promise<ChildProcess>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill(child);
        reject(new SqlError('The DuckDB process did not start in time.'));
      }, WORKER_STARTUP_MS);
      child.on('message', (m: Record<string, unknown>) => {
        if (m.type === 'ready') {
          clearTimeout(timer);
          const version = String(m.version ?? '');
          try {
            const { warning } = checkDuckdbVersion(version);
            if (warning && !this.warned) {
              this.warned = true;
              this.warn?.(warning);
            }
          } catch (err) {
            this.kill(child);
            reject(err as Error);
            return;
          }
          this.version = version;
          resolve(child);
        } else if (m.type === 'fatal') {
          clearTimeout(timer);
          this.kill(child);
          reject(new SqlError(duckdbMissingMessage(String(m.message)), 'DUCKDB_MISSING'));
        } else if (typeof m.id === 'number') {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.ok) p.resolve(m.result);
          else p.reject(new SqlError(String(m.error), m.code as string | undefined));
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new SqlError(`Could not start the DuckDB process: ${err.message}`));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.forget();
        const err = exitError(code, signal, stderr);
        reject(err);
        for (const [id, p] of this.pending) {
          if (p.child !== child) continue;
          this.pending.delete(id);
          p.reject(err);
        }
      });
    });
    this.starting = starting;
    // A failed start is retried on the next request.
    starting.catch(() => {
      if (this.child === child) this.forget();
    });
    return starting;
  }

  private forget(): void {
    this.child = undefined;
    this.starting = undefined;
  }

  private kill(child: ChildProcess): void {
    if (this.child === child) this.forget();
    // On Windows any signal terminates the process; elsewhere SIGKILL cannot be ignored.
    child.kill('SIGKILL');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.forget();
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Wait for the exit (the file is released when the process is gone; Windows keeps open
    // files locked), keeping the event loop alive until then, but never more than 2 s.
    child.ref();
    let cap: NodeJS.Timeout | undefined;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      cap = setTimeout(resolve, 2_000);
      child.kill('SIGKILL');
    });
    clearTimeout(cap);
    child.unref();
  }
}

export interface DuckdbDriverOptions {
  /** DuckDB memory_limit per call (sql.duckdb.memoryLimit), default 1GB. */
  memoryLimit?: string;
  /** DuckDB threads per call (sql.duckdb.threads), default 2. */
  threads?: number;
  /** Deadline for listing, describing and parsing (queries pass their own). */
  timeoutMs?: number;
  /** Where to report a DuckDB version newer than the tested one. */
  warn?: (message: string) => void;
  /** Where the driver package is, as a file URL (tests simulate a missing package). */
  resolve?: () => string;
  /** V8 heap of the child process in MB (default 512; tests use less to force a crash). */
  heapMb?: number;
}

/**
 * DuckDB on a single file, read-only, in a child process.
 *
 * Every request runs in a child process (`duckdb-worker`), one at a time, with a deadline
 * that covers opening, parsing, planning, running and converting. A query that runs too
 * long, uses too much memory or crashes DuckDB stops only that process, and the agent
 * gets an error. Inside the child each call opens the file in its own DuckDB instance
 * (READ_ONLY, external access off, bounded memory and threads, no spill, configuration
 * locked) and closes it afterwards, so nothing a query changes in the engine outlives
 * the call and other programs can write to the file between calls.
 */
export class DuckdbDriver implements SqlDriver {
  readonly dialect = 'duckdb' as const;
  private readonly worker: DuckdbWorker;
  private readonly timeoutMs: number;

  constructor(
    private readonly file: string,
    opts: DuckdbDriverOptions = {},
  ) {
    if (!existsSync(file)) throw new SqlError(`DuckDB database not found: ${file}`);
    const memoryLimit =
      typeof opts.memoryLimit === 'string' ? opts.memoryLimit : DUCKDB_DEFAULT_MEMORY_LIMIT;
    const threads = typeof opts.threads === 'number' ? opts.threads : DUCKDB_DEFAULT_THREADS;
    this.timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10_000;
    const resolve = typeof opts.resolve === 'function' ? opts.resolve : undefined;
    this.worker = new DuckdbWorker(
      {
        file,
        moduleUrl: resolveDuckdb(resolve),
        settings: duckdbSettings(memoryLimit, threads),
        expected: expectedSettings(memoryLimit, threads),
        parserSettings: parserSettings(),
      },
      typeof opts.warn === 'function' ? opts.warn : undefined,
      typeof opts.heapMb === 'number' ? opts.heapMb : WORKER_HEAP_MB,
    );
  }

  /** Check the file and the driver package (with a clear error when it is missing). */
  static async open(file: string, opts: DuckdbDriverOptions = {}): Promise<DuckdbDriver> {
    return new DuckdbDriver(file, opts);
  }

  /** The DuckDB version the child process loaded, for example "v1.5.6". */
  version(): Promise<string> {
    return this.worker.ready();
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.worker.call<Array<Record<string, unknown>>>(
      { op: 'tables' },
      this.timeoutMs,
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
    const res = await this.worker.call<{
      table: Record<string, unknown>;
      cols: Array<Record<string, unknown>>;
      cons: Array<Record<string, unknown>>;
      idx: Array<Record<string, unknown>>;
    } | null>({ op: 'describe', schema, name }, this.timeoutMs);
    if (!res) return undefined;
    const { table: t, cols, cons, idx } = res;
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
  }

  /**
   * Run a validated SELECT in the child: one statement as DuckDB splits the text, of type
   * SELECT as DuckDB prepares it, rows streamed until the row limit or the byte budget.
   * The deadline covers parsing and planning too, which interrupt() cannot stop.
   */
  async readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult> {
    const started = Date.now();
    const res = await this.worker.call<{
      columns: string[];
      rows: unknown[][];
      cut: 'rows' | 'bytes' | null;
    }>(
      {
        op: 'read',
        sql,
        params: Array.isArray(params) ? params : [],
        rowLimit: opts.rowLimit,
        maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      },
      opts.timeoutMs,
    );
    return {
      columns: res.columns,
      rows: res.rows,
      rowCount: res.rows.length,
      truncated: res.cut !== null,
      elapsedMs: Date.now() - started,
    };
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
   * in the child on a separate in-memory database that holds no data, with the query bound
   * as a parameter, so the query is parsed there but never run.
   */
  serializeSelect(sql: string): Promise<string> {
    return this.worker.call<string>({ op: 'serialize', sql }, this.timeoutMs);
  }

  async close(): Promise<void> {
    await this.worker.stop();
  }
}

/**
 * Start a DuckDB child process once and return the version it loaded (doctor and init use
 * this to check the driver before doing anything else).
 */
export async function probeDuckdb(opts: { resolve?: () => string } = {}): Promise<{
  version: string;
  warning?: string;
}> {
  const worker = new DuckdbWorker({
    file: '',
    moduleUrl: resolveDuckdb(opts.resolve),
    settings: {},
    expected: {},
    parserSettings: {},
  });
  try {
    const version = await worker.ready();
    return { version, ...checkDuckdbVersion(version) };
  } finally {
    await worker.stop();
  }
}
