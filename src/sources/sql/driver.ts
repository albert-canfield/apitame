import type { Dialect } from './lexer.js';

export interface TableInfo {
  schema: string | null;
  name: string;
  type: 'table' | 'view';
  rowEstimate?: number | null;
  comment?: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
  primaryKey: boolean;
  comment?: string | null;
}

export interface ForeignKey {
  columns: string[];
  references: { table: string; columns: string[] };
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableDetail extends TableInfo {
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface ReadOptions {
  rowLimit: number;
  timeoutMs: number;
}

export interface WriteOptions {
  timeoutMs: number;
  dryRun: boolean;
}

export type SqlParams = unknown[] | Record<string, unknown>;

/** Whether the connection could write, independently of apitame's own checks. */
export interface PrivilegeInfo {
  canWrite: boolean;
  detail: string;
}

/** What the SQL runtime needs from a database. Every read runs in read-only mode at the database level. */
export interface SqlDriver {
  readonly dialect: Dialect;
  listTables(): Promise<TableInfo[]>;
  describeTable(schema: string | null, name: string): Promise<TableDetail | undefined>;
  readQuery(sql: string, params: SqlParams, opts: ReadOptions): Promise<QueryResult>;
  /** Run a named write query in a transaction. With dryRun the transaction is rolled back. */
  writeQuery(sql: string, params: SqlParams, opts: WriteOptions): Promise<{ rowCount: number }>;
  /** Check what the underlying credentials allow (used by `apitame doctor`). */
  privileges(): Promise<PrivilegeInfo>;
  /**
   * The engine's own parse tree of a query, for engines that no bundled parser reads
   * (DuckDB: `json_serialize_sql`, run on a separate in-memory database).
   */
  serializeSelect?(sql: string): Promise<string>;
  close(): Promise<void>;
}

export class SqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}
