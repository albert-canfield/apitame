import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type SourceKind =
  | { kind: 'openapi'; location: string }
  | { kind: 'postgres'; url: string; fromEnv?: string }
  | { kind: 'mysql'; url: string; fromEnv?: string }
  | { kind: 'sqlite'; file: string }
  | { kind: 'duckdb'; file: string };

const SQLITE_MAGIC = 'SQLite format 3\u0000';
/** DuckDB files start with an 8-byte checksum followed by "DUCK". */
const DUCKDB_MAGIC = 'DUCK';

function header(path: string): Buffer | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    return buf;
  } catch {
    return undefined;
  }
}

function isSqliteFile(path: string): boolean {
  return header(path)?.toString('latin1') === SQLITE_MAGIC;
}

function isDuckdbFile(path: string): boolean {
  return header(path)?.subarray(8, 12).toString('latin1') === DUCKDB_MAGIC;
}

/** Work out what kind of source the user passed to `init`. */
export function detectSource(
  input: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): SourceKind {
  const s = input.trim();
  if (/^postgres(ql)?:\/\//i.test(s)) return { kind: 'postgres', url: s };
  if (/^(mysql|mariadb):\/\//i.test(s))
    return { kind: 'mysql', url: s.replace(/^mariadb:/i, 'mysql:') };

  const envMatch =
    /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(s) ?? /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(s);
  if (envMatch) {
    const name = envMatch[1] as string;
    const value = env[name];
    if (!value) throw new Error(`Environment variable ${name} is not set.`);
    if (/^postgres(ql)?:\/\//i.test(value)) return { kind: 'postgres', url: value, fromEnv: name };
    if (/^(mysql|mariadb):\/\//i.test(value)) return { kind: 'mysql', url: value, fromEnv: name };
    return detectSource(value, cwd, env);
  }

  if (/^sqlite:/i.test(s))
    return { kind: 'sqlite', file: resolve(cwd, s.replace(/^sqlite:(\/\/)?/i, '')) };
  if (/^duckdb:/i.test(s)) {
    const file = resolve(cwd, s.replace(/^duckdb:(\/\/)?/i, ''));
    if (!existsSync(file)) throw new Error(`DuckDB file not found: ${file}`);
    return { kind: 'duckdb', file };
  }
  if (/^https?:\/\//i.test(s)) return { kind: 'openapi', location: s };

  const abs = resolve(cwd, s);
  if (/\.(duckdb|ddb)$/i.test(s)) {
    if (!existsSync(abs)) throw new Error(`DuckDB file not found: ${abs}`);
    return { kind: 'duckdb', file: abs };
  }
  if (/\.(db|sqlite|sqlite3|db3)$/i.test(s)) {
    if (!existsSync(abs)) throw new Error(`SQLite file not found: ${abs}`);
    // A .db file can be a DuckDB database too: the header decides.
    return isDuckdbFile(abs) ? { kind: 'duckdb', file: abs } : { kind: 'sqlite', file: abs };
  }
  if (!existsSync(abs)) {
    throw new Error(
      `Cannot find "${input}". Pass an OpenAPI file or URL, a postgres:// or mysql:// connection string, or a SQLite or DuckDB file.`,
    );
  }
  if (isSqliteFile(abs)) return { kind: 'sqlite', file: abs };
  if (isDuckdbFile(abs)) return { kind: 'duckdb', file: abs };
  return { kind: 'openapi', location: abs };
}

/** Database name from a Postgres URL, for naming. */
export function databaseName(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\//, '')) || u.hostname || 'database';
  } catch {
    return 'database';
  }
}
