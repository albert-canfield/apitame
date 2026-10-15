import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { REFERENCE_SOURCE, shownReference } from '../secrets/reference.js';

/** `${VAR}`, `${VAR:-default}` and `${op://...}`-style secret manager references. */
const REFERENCES = new RegExp(REFERENCE_SOURCE, 'g');

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

/**
 * A secret manager reference that was not read before the value was needed. Commands read every
 * reference before they build anything (see src/secrets), so this means a command that never
 * sends credentials (`diff`) or a config built in code.
 */
export class UnreadSecretError extends Error {
  constructor(
    readonly references: string[],
    readonly field: string,
  ) {
    super(
      `Secret reference${references.length > 1 ? 's' : ''} ${references.map(shownReference).join(', ')} (used by ${field}) ${references.length > 1 ? 'were' : 'was'} not read.`,
    );
    this.name = 'UnreadSecretError';
  }
}

/**
 * Values read from secret managers, by the environment object they were attached to (see
 * {@link withSecretValues}). Kept out of the environment itself, so they never reach a child
 * process and a variable that happens to be named `op://...` is never taken for one.
 */
const SECRET_VALUES = new WeakMap<object, ReadonlyMap<string, string>>();

/**
 * An environment that reads like `env` and also answers the secret manager references in
 * `values` (reference text such as `op://vault/item/field`, without `${` and `}`).
 */
export function withSecretValues(
  env: NodeJS.ProcessEnv,
  values: ReadonlyMap<string, string>,
): NodeJS.ProcessEnv {
  const merged = new Map([...(SECRET_VALUES.get(env) ?? []), ...values]);
  // A proxy without traps reads and writes through to `env`, but is an object of its own.
  const out = new Proxy(env, {});
  SECRET_VALUES.set(out, merged);
  return out;
}

/** Names of the env vars referenced by a string. */
export function envRefs(value: string): string[] {
  return [...value.matchAll(REFERENCES)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * The values of the env vars a string references, skipping unset and empty ones, and of the
 * secret manager references read into `env`.
 */
export function envValues(value: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = SECRET_VALUES.get(env);
  return [...value.matchAll(REFERENCES)]
    .map((m) => (m[1] !== undefined ? env[m[1]] : secrets?.get(m[3] as string)))
    .filter((v): v is string => v !== undefined && v !== '');
}

/**
 * Replace `${VAR}` and `${VAR:-default}` references, and secret manager references read into
 * `env` (see {@link withSecretValues}), in one pass: a value is never searched for references.
 * Throws {@link MissingEnvError} when a variable without default is unset or empty, and
 * {@link UnreadSecretError} when a secret manager reference was not read.
 */
export function resolveEnv(
  value: string,
  field: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const missing: string[] = [];
  const unread: string[] = [];
  const secrets = SECRET_VALUES.get(env);
  const out = value.replace(
    REFERENCES,
    (_m, name: string | undefined, fallback: string | undefined, secret: string | undefined) => {
      if (name === undefined) {
        const v = secrets?.get(secret as string);
        if (v !== undefined) return v;
        unread.push(secret as string);
        return '';
      }
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return '';
    },
  );
  if (missing.length > 0) throw new MissingEnvError(missing, field);
  if (unread.length > 0) throw new UnreadSecretError(unread, field);
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
