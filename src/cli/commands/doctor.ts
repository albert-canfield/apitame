import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { envRefs, loadDotEnv } from '../../config/env.js';
import { loadConfig, withoutGuardrails, type LoadedConfig } from '../../config/load.js';
import { Logger } from '../../log.js';
import { matchesAny } from '../../safety/policy.js';
import { Redactor } from '../../safety/redact.js';
import {
  ALL_SCOPES,
  placeholderEnvironment,
  secretReferences,
  SecretResolver,
  type ReferenceCheck,
} from '../../secrets/index.js';
import { shownReference } from '../../secrets/reference.js';
import type { OpenApiRuntime } from '../../server/openapi-runtime.js';
import { createRuntime, type AnyRuntime } from '../../server/runtime.js';
import type { SqlRuntime } from '../../server/sql-runtime.js';
import type { GeneratedFile } from '../../generator/skills.js';
import { apitameCommand, DUCKDB_PACKAGE, DUCKDB_SPEC } from '../../sources/sql/duckdb-package.js';
import { telemetryFindings } from '../../telemetry/index.js';
import { withDeadline } from '../../util/deadline.js';
import { c } from '../ui.js';
import { claudeDesktopConfigPath } from './add-to.js';
import { checkHttp, wantsHttpChecks } from './doctor-http.js';
import { skillsFor } from './init.js';
import { toolCallFor } from './test.js';

export interface DoctorOptions {
  config?: string;
  json?: boolean;
  offline?: boolean;
  /** Check an HTTP deployment even without HTTP settings in the config or environment. */
  http?: boolean;
  /** The host `serve --transport http` listens on, for the HTTP checks. Implies `http`. */
  host?: string;
}

type Status = 'ok' | 'warn' | 'fail' | 'info';

export interface Finding {
  status: Status;
  check: string;
  detail: string;
}

const MARK: Record<Status, (s: string) => string> = {
  ok: (s) => `${c.green('✔')} ${s}`,
  warn: (s) => `${c.yellow('!')} ${s}`,
  fail: (s) => `${c.red('✖')} ${s}`,
  info: (s) => `${c.dim('·')} ${s}`,
};

function checkNode(add: (s: Status, check: string, detail: string) => void): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 14)) {
    add('fail', 'Node.js', `${process.version}: apitame needs Node.js 22.14 or later`);
  } else add('ok', 'Node.js', process.version);
}

function checkDotEnv(
  loaded: LoadedConfig,
  add: (s: Status, check: string, detail: string) => void,
) {
  const file = join(loaded.dir, '.env');
  if (!existsSync(file)) return;
  const res = spawnSync('git', ['check-ignore', '-q', file], { cwd: loaded.dir });
  if (res.status === 1) {
    add(
      'fail',
      '.env',
      `${file} is not ignored by git. Add ".env" to .gitignore before committing.`,
    );
  } else if (res.status === 0) add('ok', '.env', 'present and ignored by git');
  else add('info', '.env', 'present (not inside a git repository)');
}

function checkEnv(loaded: LoadedConfig, add: (s: Status, check: string, detail: string) => void) {
  const { auth, source } = loaded.config;
  // Token introspection credentials (http.oauth.introspection) come from the environment too.
  const introspection = loaded.config.http.oauth?.introspection ?? {};
  const names = [
    ...new Set([auth, source, introspection].map((x) => JSON.stringify(x)).flatMap(envRefs)),
  ];
  if (names.length === 0) return;
  // Variables with a ${NAME:-default} fallback are optional.
  const optional = new Set(
    [
      ...JSON.stringify([auth, source, introspection]).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-/g),
    ].map((m) => m[1]),
  );
  const missing = names.filter((n) => !process.env[n] && !optional.has(n));
  if (missing.length > 0) {
    add(
      'fail',
      'Environment',
      `missing ${missing.join(', ')}. Set ${missing.length === 1 ? 'it' : 'them'} in your shell, the MCP client config, or .env next to the config.`,
    );
  } else add('ok', 'Environment', `${names.join(', ')} set`);
}

/**
 * Secret manager references (`${op://...}` and the like): each one, whether its CLI is there and,
 * unless offline, whether it reads, as `serve` reads it. Values are never shown. Returns each
 * result, so the checks that need the credentials run only when they were read.
 */
async function checkSecrets(
  loaded: LoadedConfig,
  opts: DoctorOptions,
  secrets: SecretResolver,
  redactor: Redactor,
  add: (s: Status, check: string, detail: string) => void,
): Promise<ReferenceCheck[]> {
  const checks = await secrets.check(loaded.config, ALL_SCOPES, {
    redactor,
    offline: opts.offline === true,
  });
  for (const c of checks) {
    const what = `${shownReference(c.reference)} (${c.fields.join(', ')})`;
    if (c.problem) add('fail', 'Secrets', `${what}: ${c.problem}`);
    else if (c.ok) add('ok', 'Secrets', `${what} read${c.cli ? ` with ${c.cli}` : ''}`);
    else add('info', 'Secrets', `${what}: ${c.cli} found, not read (--offline)`);
  }
  return checks;
}

function checkPatterns(
  rt: AnyRuntime,
  add: (s: Status, check: string, detail: string) => void,
): void {
  const { writes } = rt.config;
  const ids =
    rt.sourceType === 'openapi'
      ? (rt as OpenApiRuntime).operations.map((o) => o.id)
      : rt.config.sql.queries.map((q) => q.name);
  const lists = {
    allow: writes.allow,
    confirm: writes.confirm,
    treatAsRead: writes.treatAsRead,
    destructive: writes.destructive,
  };
  for (const [key, patterns] of Object.entries(lists)) {
    const unknown = patterns.filter((p) => !ids.some((id) => matchesAny(id, [p])));
    if (unknown.length > 0) {
      add(
        'warn',
        `writes.${key}`,
        `no operation matches ${unknown.map((u) => `"${u}"`).join(', ')} (typo?)`,
      );
    }
  }
}

/** How long the API reachability check may take. */
const API_TIMEOUT_MS = 10_000;

async function checkApi(
  rt: OpenApiRuntime,
  add: (s: Status, check: string, detail: string) => void,
) {
  if (!rt.baseUrl) {
    add('fail', 'API', 'no base URL: set source.baseUrl in the config');
    return;
  }
  // A read with no required input is the cheapest end-to-end check (DNS, TLS, auth).
  const probe = rt.operations.find(
    (o) =>
      o.access === 'read' &&
      o.method === 'get' &&
      !o.unsupported &&
      !o.params.some((p) => p.required) &&
      !o.body?.required,
  );
  const call = probe ? toolCallFor(rt, probe, {}) : undefined;
  if (probe && call) {
    const res = await rt.callTool(call.tool, call.args);
    const text = res.content.map((x) => x.text).join('');
    let status: number | undefined;
    try {
      status = (JSON.parse(text) as { status?: number }).status;
    } catch {
      // not JSON: an error message
    }
    const label = `GET ${probe.path}`;
    if (status === undefined) add('fail', 'API', `${label}: ${text.split('\n')[0]}`);
    else if (status >= 200 && status < 300)
      add('ok', 'API', `${label} answered ${status} at ${rt.baseUrl}`);
    else if (status === 401 || status === 403) {
      add('fail', 'API', `${label} answered ${status}: the credentials were rejected`);
    } else add('warn', 'API', `${label} answered ${status}; the API is reachable`);
    return;
  }
  try {
    const baseUrl = rt.baseUrl;
    // The deadline covers the whole exchange, held by a timer (see withDeadline).
    const status = await withDeadline(
      API_TIMEOUT_MS,
      () => new Error(`no answer within ${API_TIMEOUT_MS / 1000} seconds`),
      async (signal) => {
        const res = await fetch(baseUrl, { method: 'GET', redirect: 'manual', signal });
        await res.body?.cancel().catch(() => {});
        return res.status;
      },
    );
    add(
      'ok',
      'API',
      `${rt.baseUrl} is reachable (HTTP ${status}); no parameterless read to test auth with`,
    );
  } catch (err) {
    add('fail', 'API', `${rt.baseUrl} is not reachable: ${(err as Error).message}`);
  }
}

async function checkDatabase(
  rt: SqlRuntime,
  add: (s: Status, check: string, detail: string) => void,
): Promise<boolean> {
  try {
    const tables = await rt.tables();
    add('ok', 'Database', `connected, ${tables.length} tables and views visible`);
  } catch (err) {
    add('fail', 'Database', (err as Error).message);
    return false;
  }
  try {
    const p = await rt.driver.privileges();
    if (p.canWrite) {
      add(
        'warn',
        'Database role',
        rt.sourceType === 'sqlite' || rt.sourceType === 'duckdb'
          ? `${p.detail}. apitame enforces read-only access itself; a read-only file adds a layer nothing can bypass.`
          : `${p.detail}. apitame enforces read-only access itself, but a read-only role is the layer nothing can bypass: https://github.com/albert-canfield/apitame/blob/main/docs/sql.md#a-read-only-role`,
      );
    } else add('ok', 'Database role', p.detail);
  } catch (err) {
    add('info', 'Database role', `could not check privileges: ${(err as Error).message}`);
  }
  return true;
}

function compareFiles(root: string, files: GeneratedFile[]): 'missing' | 'stale' | 'current' {
  let missing = false;
  for (const f of files) {
    const path = join(root, f.path);
    if (!existsSync(path)) missing = true;
    else if (readFileSync(path, 'utf8') !== f.content) return 'stale';
  }
  return missing ? 'missing' : 'current';
}

function checkSkills(
  loaded: LoadedConfig,
  files: GeneratedFile[],
  add: (s: Status, check: string, detail: string) => void,
) {
  const dir = resolve(loaded.dir, loaded.config.skills.dir);
  const state = compareFiles(dir, files);
  const names = [...new Set(files.map((f) => f.path.split('/')[0]))].join(', ');
  if (state === 'current') add('ok', 'Skills', `${names} up to date`);
  else if (state === 'missing')
    add(
      'warn',
      'Skills',
      `${names} not generated. Run: ${apitameCommand(loaded.config.source.type)} init --skills-only`,
    );
  else
    add(
      'warn',
      'Skills',
      `${names} out of date (mode, tools or schema changed). Run: ${apitameCommand(loaded.config.source.type)} init --skills-only`,
    );

  for (const installed of ['.claude/skills', '.agents/skills']) {
    const target = resolve(process.cwd(), installed);
    if (!files.some((f) => existsSync(join(target, f.path.split('/')[0] ?? '')))) continue;
    const s = compareFiles(target, files);
    if (s !== 'current') {
      add(
        'warn',
        'Installed skills',
        `${installed} has an older copy. Run "${apitameCommand(loaded.config.source.type)} add-to <client> --write" again.`,
      );
    }
  }
}

function checkClients(
  loaded: LoadedConfig,
  add: (s: Status, check: string, detail: string) => void,
) {
  const name = loaded.config.name;
  const cwd = process.cwd();
  // A DuckDB server must be started with the optional driver next to apitame.
  const needsDuckdb = loaded.config.source.type === 'duckdb';
  const withoutDriver: string[] = [];
  const unpinned: string[] = [];
  const entry = (file: string, key: string) => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      return data[key]?.[name];
    } catch {
      return undefined;
    }
  };
  const found: string[] = [];
  const check = (label: string, value: unknown) => {
    if (!value) return;
    found.push(label);
    const text = JSON.stringify(value);
    if (needsDuckdb && !text.includes(DUCKDB_PACKAGE)) withoutDriver.push(label);
    else if (needsDuckdb && !text.includes(DUCKDB_SPEC)) unpinned.push(label);
  };
  check('Claude Code (.mcp.json)', entry(join(cwd, '.mcp.json'), 'mcpServers'));
  check('Cursor', entry(join(cwd, '.cursor/mcp.json'), 'mcpServers'));
  check('VS Code', entry(join(cwd, '.vscode/mcp.json'), 'servers'));
  check('Gemini CLI', entry(join(cwd, '.gemini/settings.json'), 'mcpServers'));
  check('Claude Desktop', entry(claudeDesktopConfigPath(), 'mcpServers'));
  try {
    const toml = readFileSync(join(cwd, '.codex/config.toml'), 'utf8');
    const start = toml.indexOf(`[mcp_servers.${name}]`);
    if (start >= 0) {
      const next = toml.indexOf('\n[', start + 1);
      check('Codex (.codex/config.toml)', toml.slice(start, next < 0 ? undefined : next));
    }
  } catch {
    // no Codex project config
  }
  if (withoutDriver.length > 0) {
    add(
      'warn',
      'Clients',
      `${withoutDriver.join(', ')} start${withoutDriver.length === 1 ? 's' : ''} "${name}" without ${DUCKDB_PACKAGE}, so the server cannot open the DuckDB file. Run "add-to <client> --write" again.`,
    );
  }
  if (unpinned.length > 0) {
    add(
      'warn',
      'Clients',
      `${unpinned.join(', ')} start${unpinned.length === 1 ? 's' : ''} "${name}" with a ${DUCKDB_PACKAGE} version other than the tested ${DUCKDB_SPEC}. Run "add-to <client> --write" again to pin it.`,
    );
  }
  if (found.length > 0) add('ok', 'Clients', `"${name}" configured for ${found.join(', ')}`);
  else {
    add(
      'info',
      'Clients',
      `no client config for "${name}" in this folder. Run: ${apitameCommand(loaded.config.source.type)} add-to claude-code --write`,
    );
  }
}

/** Run every check and return the findings. */
export async function runDoctor(opts: DoctorOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (status: Status, check: string, detail: string) =>
    findings.push({ status, check, detail });

  checkNode(add);
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  } catch (err) {
    add('fail', 'Config', (err as Error).message);
    return findings;
  }
  const where = relative(process.cwd(), loaded.path) || loaded.path;
  add('ok', 'Config', `${where} (${loaded.config.source.type}, ${loaded.config.mode})`);

  checkDotEnv(loaded, add);
  loadDotEnv(loaded.dir);
  checkEnv(loaded, add);
  // One redactor for everything doctor says, which learns each secret as it is read.
  const redactor = new Redactor();
  const secrets = new SecretResolver();
  const secretChecks = await checkSecrets(loaded, opts, secrets, redactor, add);
  const read = (scopes: Parameters<typeof secretReferences>[1]) =>
    secretReferences(loaded.config, scopes).every(
      (u) => secretChecks.find((c) => c.reference === u.reference.text)?.ok,
    );
  const secretsRead = read(['auth', 'source']);
  // Loads the OpenTelemetry packages when an OTLP endpoint is set; never contacts the collector.
  for (const f of await telemetryFindings()) add(f.status, 'Telemetry', f.detail);
  // Before the source: an HTTP deployment can be checked even when the API or database is down.
  const httpToken = process.env.APITAME_HTTP_TOKEN;
  if (wantsHttpChecks(loaded.config.http, opts, httpToken)) {
    const host = opts.host ?? '127.0.0.1';
    // The values just read (no second call), or placeholders when they could not be read.
    const introspectionRead = read(['introspection']);
    const env = introspectionRead
      ? await secrets.environment(loaded.config, ['introspection'], { redactor })
      : placeholderEnvironment(loaded.config, ['introspection']);
    await checkHttp(
      loaded.config.http,
      {
        host,
        token: httpToken,
        offline: opts.offline,
        env,
        introspectionSecretUnread: !introspectionRead,
      },
      add,
    );
  }

  if (loaded.config.source.type === 'duckdb') {
    try {
      const probe = await (await import('../../sources/sql/duckdb.js')).probeDuckdb();
      if (probe.warning) add('warn', 'DuckDB driver', probe.warning);
      else add('ok', 'DuckDB driver', `${DUCKDB_PACKAGE} (DuckDB ${probe.version})`);
    } catch (err) {
      add('fail', 'DuckDB driver', (err as Error).message.replace(/\n/g, ' '));
      checkClients(loaded, add);
      return findings.map((f) => ({ ...f, detail: redactor.text(f.detail) }));
    }
  }

  let rt: AnyRuntime;
  try {
    rt = await createRuntime(withoutGuardrails(loaded), {
      redactor,
      logger: new Logger(redactor, 'silent'),
      dotenv: false,
      // The values read above, or placeholders: the config is still checked when they are not.
      secrets: secretsRead ? secrets : 'placeholder',
    });
  } catch (err) {
    add('fail', 'Source', redactor.text((err as Error).message));
    return findings.map((f) => ({ ...f, detail: redactor.text(f.detail) }));
  }
  try {
    for (const w of rt.warnings.filter((x) => !/Missing environment variable/.test(x)))
      add('warn', w.startsWith('writes.rules') ? 'writes.rules' : 'Config', w);
    checkPatterns(rt, add);

    const skipped = opts.offline
      ? 'skipped (--offline)'
      : secretsRead
        ? undefined
        : 'skipped: a secret reference could not be read (see Secrets)';
    let canGenerate = true;
    if (rt.sourceType === 'openapi') {
      if (skipped) add('info', 'API', skipped);
      else await checkApi(rt as OpenApiRuntime, add);
    } else if (skipped) {
      add('info', 'Database', skipped);
      canGenerate = false;
    } else canGenerate = await checkDatabase(rt as SqlRuntime, add);

    if (canGenerate) checkSkills(loaded, await skillsFor(rt), add);
    checkClients(loaded, add);
  } finally {
    await rt.close();
  }
  return findings.map((f) => ({ ...f, detail: redactor.text(f.detail) }));
}

export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  const findings = await runDoctor(opts);
  const failed = findings.filter((f) => f.status === 'fail').length;
  const warned = findings.filter((f) => f.status === 'warn').length;
  if (opts.json) {
    console.log(JSON.stringify({ findings, failed, warnings: warned }, null, 2));
  } else {
    const width = Math.max(...findings.map((f) => f.check.length));
    for (const f of findings) console.log(MARK[f.status](`${f.check.padEnd(width)}  ${f.detail}`));
    console.log('');
    console.log(
      failed > 0
        ? c.red(
            `${failed} problem${failed === 1 ? '' : 's'} to fix${warned > 0 ? `, ${warned} warning${warned === 1 ? '' : 's'}` : ''}.`,
          )
        : warned > 0
          ? c.yellow(`No problems, ${warned} warning${warned === 1 ? '' : 's'}.`)
          : c.green('Everything looks good.'),
    );
  }
  if (failed > 0) process.exitCode = 1;
}
