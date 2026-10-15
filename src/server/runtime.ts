import { loadDotEnv } from '../config/env.js';
import type { LoadedConfig } from '../config/load.js';
import { Logger } from '../log.js';
import { Guardrails } from '../safety/guardrails.js';
import { Redactor } from '../safety/redact.js';
import { placeholderEnvironment, SecretResolver } from '../secrets/index.js';
import { createOpenApiRuntime, type OpenApiRuntime } from './openapi-runtime.js';
import type { SqlRuntime } from './sql-runtime.js';

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  redactor?: Redactor;
  baseUrlOverride?: string;
  /** Load .env next to the config file (default true). */
  dotenv?: boolean;
  /**
   * Secret manager references in `auth` and `source` (`${op://...}` and the like): read through
   * their CLIs before anything is built, with this resolver or a new one (the default), or
   * `placeholder` to put a placeholder in their place without running anything, for commands
   * that never send credentials.
   */
  secrets?: SecretResolver | 'placeholder';
}

export type AnyRuntime = OpenApiRuntime | SqlRuntime;

/** Build the runtime for a loaded config: OpenAPI proxy or SQL tools. */
export async function createRuntime(
  loaded: LoadedConfig,
  opts: RuntimeOptions = {},
): Promise<AnyRuntime> {
  const base = opts.env ?? process.env;
  if (opts.dotenv !== false) loadDotEnv(loaded.dir, base);
  const redactor = opts.redactor ?? new Redactor();
  const logger = opts.logger ?? new Logger(redactor);
  const { config } = loaded;
  // All or nothing: a reference that cannot be read stops here, before anything is built.
  const env =
    opts.secrets === 'placeholder'
      ? placeholderEnvironment(config, ['auth', 'source'], base)
      : await (opts.secrets ?? new SecretResolver()).environment(config, ['auth', 'source'], {
          redactor,
          env: base,
        });

  if (config.source.type === 'openapi') {
    return createOpenApiRuntime({
      config,
      configDir: loaded.dir,
      env,
      redactor,
      logger,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.baseUrlOverride ? { baseUrlOverride: opts.baseUrlOverride } : {}),
    });
  }

  // SQL support (parsers and drivers) is loaded on demand, so OpenAPI users never pay for it.
  const { resolveSqlTarget, SqlRuntime } = await import('./sql-runtime.js');
  const target = resolveSqlTarget(config, loaded.dir, redactor, env);
  const driver =
    target.kind === 'postgres'
      ? new (await import('../sources/sql/postgres.js')).PostgresDriver(
          target.url,
          target.schemas,
          config.limits.timeoutMs,
        )
      : target.kind === 'mysql'
        ? new (await import('../sources/sql/mysql.js')).MysqlDriver(target.url)
        : target.kind === 'duckdb'
          ? await (
              await import('../sources/sql/duckdb.js')
            ).DuckdbDriver.open(target.file, {
              memoryLimit: config.sql.duckdb?.memoryLimit,
              threads: config.sql.duckdb?.threads,
              timeoutMs: config.limits.timeoutMs,
              warn: (message) => logger.warn(message),
            })
          : new (await import('../sources/sql/sqlite.js')).SqliteDriver(target.file);
  return new SqlRuntime(
    config,
    driver,
    redactor,
    logger,
    Guardrails.fromConfig(config, loaded.dir, redactor, logger),
  );
}
