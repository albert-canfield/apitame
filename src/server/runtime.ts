import { loadDotEnv } from '../config/env.js';
import type { LoadedConfig } from '../config/load.js';
import { Logger } from '../log.js';
import { Guardrails } from '../safety/guardrails.js';
import { Redactor } from '../safety/redact.js';
import { PostgresDriver } from '../sources/sql/postgres.js';
import { SqliteDriver } from '../sources/sql/sqlite.js';
import { createOpenApiRuntime, type OpenApiRuntime } from './openapi-runtime.js';
import { resolveSqlTarget, SqlRuntime } from './sql-runtime.js';

export interface RuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  redactor?: Redactor;
  baseUrlOverride?: string;
  /** Load .env next to the config file (default true). */
  dotenv?: boolean;
}

export type AnyRuntime = OpenApiRuntime | SqlRuntime;

/** Build the runtime for a loaded config: OpenAPI proxy or SQL tools. */
export async function createRuntime(
  loaded: LoadedConfig,
  opts: RuntimeOptions = {},
): Promise<AnyRuntime> {
  const env = opts.env ?? process.env;
  if (opts.dotenv !== false) loadDotEnv(loaded.dir, env);
  const redactor = opts.redactor ?? new Redactor();
  const logger = opts.logger ?? new Logger(redactor);
  const { config } = loaded;

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

  const target = resolveSqlTarget(config, loaded.dir, redactor, env);
  const driver =
    target.kind === 'postgres'
      ? new PostgresDriver(target.url, target.schemas, config.limits.timeoutMs)
      : new SqliteDriver(target.file);
  return new SqlRuntime(
    config,
    driver,
    redactor,
    logger,
    Guardrails.fromConfig(config, loaded.dir, redactor, logger),
  );
}
