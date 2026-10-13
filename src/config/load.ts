import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodError } from 'zod';
import { ConfigSchema, type Config } from './schema.js';

export const DEFAULT_CONFIG_FILE = 'apitame.config.yaml';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file. */
  path: string;
  /** Folder of the config file. Relative paths in the config resolve from here. */
  dir: string;
}

function formatIssues(err: ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

/** Validate a raw object against the config schema. */
export function parseConfig(raw: unknown, source = 'config'): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid ${source}:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Read and validate `apitame.config.yaml` (or the given path). */
export function loadConfig(path = DEFAULT_CONFIG_FILE, cwd = process.cwd()): LoadedConfig {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new ConfigError(
      `No config found at ${abs}.\nRun "npx apitame init <openapi-file|url|database-url>" first, or pass --config <path>.`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not parse ${abs}: ${(err as Error).message}`);
  }
  return { config: parseConfig(raw, abs), path: abs, dir: dirname(abs) };
}
