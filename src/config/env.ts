import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const ENV_REF_GLOBAL = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class MissingEnvError extends Error {
  constructor(
    readonly variables: string[],
    readonly field: string,
  ) {
    super(
      `Missing environment variable${variables.length > 1 ? 's' : ''} ${variables.join(', ')} (used by ${field}). ` +
        'Set it in your shell, in the MCP client config, or in a .env file next to apitame.config.yaml.',
    );
    this.name = 'MissingEnvError';
  }
}

/** Names of the env vars referenced by a string. */
export function envRefs(value: string): string[] {
  return [...value.matchAll(ENV_REF_GLOBAL)].map((m) => m[1] as string);
}

/**
 * Replace `${VAR}` and `${VAR:-default}` references.
 * Throws {@link MissingEnvError} when a variable without default is unset or empty.
 */
export function resolveEnv(
  value: string,
  field: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const missing: string[] = [];
  const out = value.replace(ENV_REF_GLOBAL, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return '';
  });
  if (missing.length > 0) throw new MissingEnvError(missing, field);
  return out;
}

/**
 * Load `.env` from a directory into process.env without overriding variables
 * that are already set. Returns the names of the variables it set.
 */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = join(dir, '.env');
  if (!existsSync(file)) return [];
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const set: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined && v !== undefined) {
      env[k] = v;
      set.push(k);
    }
  }
  return set;
}
