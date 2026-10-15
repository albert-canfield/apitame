import { withSecretValues } from '../config/env.js';
import type { Config, SecretsConfig } from '../config/schema.js';
import type { Redactor } from '../safety/redact.js';
import {
  CliOutputTooLargeError,
  CliTimeoutError,
  findExecutable,
  runCli,
  type CliRunner,
} from './cli.js';
import { checkValue, cliEnvironment, PROVIDERS, SecretValueError } from './providers.js';
import {
  parseSecretReference,
  secretReferencesIn,
  shownReference,
  type SecretProvider,
  type SecretReference,
} from './reference.js';

export { parseSecretReference, type SecretReference } from './reference.js';

/**
 * Where the config reads references: `auth` and `source` for every command that calls the API or
 * the database, `introspection` (`http.oauth.introspection`) only for `serve` over HTTP and the
 * HTTP checks of `doctor`.
 */
export type SecretScope = 'auth' | 'source' | 'introspection';

export const ALL_SCOPES: readonly SecretScope[] = ['auth', 'source', 'introspection'];

/** Most bytes a CLI may print. Secrets are small (64 KB at most in AWS and Google Cloud). */
const MAX_OUTPUT_BYTES = 1_048_576;

/** What a reference reads as when it is not read: for commands that never send credentials. */
export const SECRET_PLACEHOLDER = 'apitame-placeholder';

/**
 * The config fields that read `${...}`, with their values: exactly those that `resolveEnv` is
 * called on. A reference anywhere else is never read.
 */
export function referenceFields(
  config: Config,
  scopes: readonly SecretScope[] = ALL_SCOPES,
): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  const add = (field: string, value: unknown) => {
    if (typeof value === 'string') out.push({ field, value });
  };
  if (scopes.includes('auth')) {
    const auth = config.auth as Record<string, unknown>;
    for (const key of ['token', 'value', 'username', 'password', 'clientId', 'clientSecret'])
      add(`auth.${key}`, auth[key]);
    add('auth.tokenUrl', auth.tokenUrl);
  }
  if (scopes.includes('source')) {
    const src = config.source;
    if (src.type === 'openapi') {
      add('source.baseUrl', src.baseUrl);
      for (const [k, v] of Object.entries(src.headers)) add(`source.headers.${k}`, v);
    } else if (src.type === 'postgres' || src.type === 'mysql') add('source.url', src.url);
    else add('source.path', src.path);
  }
  const introspection = config.http.oauth?.introspection;
  if (scopes.includes('introspection') && introspection) {
    add('http.oauth.introspection.clientId', introspection.clientId);
    add('http.oauth.introspection.clientSecret', introspection.clientSecret);
  }
  return out;
}

/** A secret manager reference and the fields that use it. */
export interface ReferenceUse {
  reference: SecretReference;
  fields: string[];
}

/** Every secret manager reference in these scopes, once each, with the fields that use it. */
export function secretReferences(
  config: Config,
  scopes: readonly SecretScope[] = ALL_SCOPES,
): ReferenceUse[] {
  const uses = new Map<string, ReferenceUse>();
  for (const { field, value } of referenceFields(config, scopes)) {
    for (const text of secretReferencesIn(value)) {
      const parsed = parseSecretReference(text);
      // The config schema refuses these; checked again for configs built in code.
      if ('problem' in parsed) throw new Error(`${field}: ${parsed.problem}`);
      const use = uses.get(text) ?? { reference: parsed, fields: [] };
      use.fields.push(field);
      uses.set(text, use);
    }
  }
  return [...uses.values()];
}

/** One reference, checked or read. Never holds the value. */
export interface ReferenceCheck {
  reference: string;
  provider: SecretProvider;
  fields: string[];
  /** The program that reads it, when it was found. */
  cli?: string;
  /** Read successfully (unset when it was not read, as with `--offline`). */
  ok?: boolean;
  /** Why it cannot be read. */
  problem?: string;
}

/** Secret manager references that could not be read. Names fields and references, never values. */
export class SecretReferenceError extends Error {
  constructor(readonly failures: ReferenceCheck[]) {
    const line = (f: ReferenceCheck) =>
      `${shownReference(f.reference)} (used by ${f.fields.join(', ')}): ${f.problem}`;
    super(
      failures.length === 1
        ? `Could not read the secret reference ${line(failures[0] as ReferenceCheck)}`
        : `Could not read ${failures.length} secret references:\n${failures.map((f) => `  - ${line(f)}`).join('\n')}`,
    );
    this.name = 'SecretReferenceError';
  }
}

/** The command line as someone would type it, to see the CLI's own message. */
function commandLine(file: string, args: string[]): string {
  const quote = (a: string) => (/^[\w./:=@+#~\\-]+$/.test(a) ? a : `'${a}'`);
  return [file, ...args].map(quote).join(' ');
}

/** Run `fn` on every item, at most `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface SecretResolverOptions {
  /** Runs the CLIs (tests pass a fake). */
  run?: CliRunner;
  /** Told how many references were read, and with which CLIs. */
  log?: (message: string) => void;
}

/**
 * Reads secret manager references through their CLIs, once: values are kept for the life of the
 * resolver (a `serve` process), so a `--watch` reload only reads references it has not seen.
 * Every value is registered with the redactor of each command that uses it, together with its
 * encoded forms (see Redactor.addSecret).
 */
export class SecretResolver {
  private readonly values = new Map<string, string>();
  private readonly run: CliRunner;

  constructor(private readonly opts: SecretResolverOptions = {}) {
    this.run = opts.run ?? runCli;
  }

  /**
   * Read every reference in these scopes and return an environment that answers them (see
   * withSecretValues). All or nothing: if one cannot be read, this throws a
   * {@link SecretReferenceError} that lists each failure, and nothing is built from the config.
   */
  async environment(
    config: Config,
    scopes: readonly SecretScope[],
    deps: { redactor: Redactor; env?: NodeJS.ProcessEnv },
  ): Promise<NodeJS.ProcessEnv> {
    const env = deps.env ?? process.env;
    const uses = secretReferences(config, scopes);
    if (uses.length === 0) return env;
    const checks = await this.read(config.secrets, uses, env, deps.redactor, true);
    const failures = checks.filter((c) => !c.ok);
    if (failures.length > 0) throw new SecretReferenceError(failures);
    const values = new Map(
      uses.map((u) => [u.reference.text, this.values.get(this.key(config.secrets, u.reference))]),
    ) as Map<string, string>;
    const fresh = checks.filter((c) => c.cli !== undefined && c.ok);
    if (fresh.length > 0 && this.opts.log) {
      const clis = [...new Set(fresh.map((c) => PROVIDERS[c.provider].label))].join(', ');
      this.opts.log(
        `read ${fresh.length} secret reference${fresh.length === 1 ? '' : 's'} with ${clis}`,
      );
    }
    return withSecretValues(env, values);
  }

  /**
   * Check every reference in these scopes, one result each: whether its CLI is there and,
   * unless `offline`, whether it reads. For `doctor`; values are registered with the redactor,
   * never returned.
   */
  async check(
    config: Config,
    scopes: readonly SecretScope[],
    deps: { redactor: Redactor; env?: NodeJS.ProcessEnv; offline?: boolean },
  ): Promise<ReferenceCheck[]> {
    const env = deps.env ?? process.env;
    return this.read(
      config.secrets,
      secretReferences(config, scopes),
      env,
      deps.redactor,
      !deps.offline,
    );
  }

  /** Cache key: the provider's settings and the reference, so a new region reads again. */
  private key(settings: SecretsConfig, ref: SecretReference): string {
    return `${JSON.stringify(settings[PROVIDERS[ref.provider].key])}\n${ref.text}`;
  }

  private async read(
    settings: SecretsConfig,
    uses: ReferenceUse[],
    env: NodeJS.ProcessEnv,
    redactor: Redactor,
    readValues: boolean,
  ): Promise<ReferenceCheck[]> {
    const results = new Map<ReferenceUse, ReferenceCheck>();
    const byProvider = new Map<SecretProvider, ReferenceUse[]>();
    for (const use of uses) {
      const provider = use.reference.provider;
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), use]);
    }
    await Promise.all(
      [...byProvider].map(([provider, list]) =>
        eachLimited(list, PROVIDERS[provider].concurrency, async (use) => {
          results.set(use, await this.readOne(settings, use, env, redactor, readValues));
        }),
      ),
    );
    return uses.map((u) => results.get(u) as ReferenceCheck);
  }

  private async readOne(
    settings: SecretsConfig,
    use: ReferenceUse,
    env: NodeJS.ProcessEnv,
    redactor: Redactor,
    readValue: boolean,
  ): Promise<ReferenceCheck> {
    const ref = use.reference;
    const provider = PROVIDERS[ref.provider];
    const base: ReferenceCheck = {
      reference: ref.text,
      provider: ref.provider,
      fields: use.fields,
    };
    const key = this.key(settings, ref);
    const known = this.values.get(key);
    if (known !== undefined) {
      redactor.addSecret(known);
      return { ...base, ok: true };
    }
    const configured = settings[provider.key].cli;
    const file = findExecutable(configured, env);
    if (!file) {
      return {
        ...base,
        problem: `${configured} ${configured.includes('/') || configured.includes('\\') ? 'is not an executable file' : 'was not found on PATH'}. ${provider.install}.`,
      };
    }
    const found = { ...base, cli: file };
    if (!readValue) return found;
    const args = provider.args(ref, settings);
    const timeoutMs = settings.timeoutSeconds * 1_000;
    const by = provider.label;
    const seconds = `${settings.timeoutSeconds} second${settings.timeoutSeconds === 1 ? '' : 's'}`;
    const yourself = `Run ${commandLine(file, args)} to see its own message.`;
    let result;
    try {
      result = await this.run(file, args, {
        env: cliEnvironment(provider, env),
        timeoutMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    } catch (err) {
      if (err instanceof CliTimeoutError) {
        return {
          ...found,
          problem: `${by} did not answer within ${seconds} and was stopped. It may be waiting for a sign-in it cannot ask for here; sign in first, or raise secrets.timeoutSeconds.`,
        };
      }
      if (err instanceof CliOutputTooLargeError) {
        return { ...found, problem: `${by} printed more than 1 MB and was stopped.` };
      }
      const code = (err as NodeJS.ErrnoException).code;
      return {
        ...found,
        problem: `${by} could not be started${code ? ` (${code})` : ''}. ${yourself}`,
      };
    }
    if (result.code !== 0) {
      // stderr only picks the explanation: it is never shown, since apitame cannot know whether
      // it holds part of a secret.
      const why = provider.explain(result.stderr);
      const ended = result.signal
        ? `was stopped by ${result.signal}`
        : `exited with code ${result.code}`;
      return { ...found, problem: `${by} ${ended}${why ? `: ${why}` : ''}. ${yourself}` };
    }
    let value: string;
    try {
      value = provider.value(result.stdout, ref);
      checkValue(value);
    } catch (err) {
      if (err instanceof SecretValueError) return { ...found, problem: err.message };
      throw err;
    }
    this.values.set(key, value);
    redactor.addSecret(value);
    return { ...found, ok: true };
  }
}

/**
 * An environment where every reference in these scopes reads as a placeholder, without running
 * anything: for commands that build a runtime but never send credentials (`inspect`, `test`
 * against the mock, `doctor --offline`). A reference that is a whole database URL becomes a URL,
 * so the driver can still be set up.
 */
export function placeholderEnvironment(
  config: Config,
  scopes: readonly SecretScope[],
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const uses = secretReferences(config, scopes);
  if (uses.length === 0) return env;
  const src = config.source;
  const wholeUrl = (text: string) =>
    (src.type === 'postgres' || src.type === 'mysql') && src.url.trim() === `\${${text}}`
      ? `${src.type}://apitame:${SECRET_PLACEHOLDER}@127.0.0.1/apitame`
      : undefined;
  return withSecretValues(
    env,
    new Map(uses.map((u) => [u.reference.text, wholeUrl(u.reference.text) ?? SECRET_PLACEHOLDER])),
  );
}
