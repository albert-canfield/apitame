import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type SourceKind =
  | { kind: 'openapi'; location: string }
  | { kind: 'postgres'; url: string; fromEnv?: string }
  | { kind: 'mysql'; url: string; fromEnv?: string }
  | { kind: 'sqlite'; file: string };

const SQLITE_MAGIC = 'SQLite format 3\u0000';

function isSqliteFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const fd = openSync(path, 'r');
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    closeSync(fd);
    return buf.toString('latin1') === SQLITE_MAGIC;
  } catch {
    return false;
  }
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
  if (/^https?:\/\//i.test(s)) return { kind: 'openapi', location: s };

  const abs = resolve(cwd, s);
  if (/\.(db|sqlite|sqlite3|db3)$/i.test(s)) {
    if (!existsSync(abs)) throw new Error(`SQLite file not found: ${abs}`);
    return { kind: 'sqlite', file: abs };
  }
  if (!existsSync(abs)) {
    throw new Error(
      `Cannot find "${input}". Pass an OpenAPI file or URL, a postgres:// connection string, or a SQLite file.`,
    );
  }
  if (isSqliteFile(abs)) return { kind: 'sqlite', file: abs };
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
