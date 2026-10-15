import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runDoctor, type Finding } from '../../src/cli/commands/doctor.js';
import { resolveEnv } from '../../src/config/env.js';
import { loadConfig, parseConfig } from '../../src/config/load.js';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { REDACTED, Redactor } from '../../src/safety/redact.js';
import { findExecutable, runCli } from '../../src/secrets/cli.js';
import { SecretReferenceError, SecretResolver } from '../../src/secrets/index.js';
import type { OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { createRuntime } from '../../src/server/runtime.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { PETSTORE, petstore, ROOT, tempDir, textOf } from '../helpers.js';
import { alive, fails, fakeCli, gone, hangs, prints } from '../secret-fixtures.js';

// Fake CLIs are shell scripts; on Windows apitame only runs .exe files, without a shell.
const POSIX = process.platform !== 'win32';

const t = tempDir('apitame-secret-managers-');
afterAll(() => t.cleanup());
let n = 0;
/** A folder of its own for each test's fake CLIs. */
function bin(): string {
  const dir = join(t.dir, `bin-${++n}`);
  mkdirSync(dir);
  return dir;
}

/** What apitame's own environment holds besides the CLIs' variables: none of it may reach them. */
const UNRELATED = {
  APITAME_HTTP_TOKEN: 'fake-http-token-not-for-clis',
  APITAME_CONFIG: '/x/apitame.config.yaml',
  DATABASE_URL: 'postgres://app:fake-db-password@db/shop',
  GITHUB_TOKEN: 'fake-github-token',
  NODE_OPTIONS: '--max-old-space-size=64',
};

function parentEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: dir,
    HOME: t.dir,
    ...UNRELATED,
    OP_SERVICE_ACCOUNT_TOKEN: 'fake-op-service-account',
    AWS_PROFILE: 'fake-profile',
    AWS_PAGER: 'less',
    CLOUDSDK_CONFIG: join(t.dir, 'gcloud'),
  };
}

const config = (extra: Record<string, unknown>) =>
  parseConfig({ name: 'demo', source: { type: 'openapi', spec: './openapi.yaml' }, ...extra });

const read = (text: string, extra: Record<string, unknown>, env: NodeJS.ProcessEnv) =>
  new SecretResolver()
    .environment(config({ auth: { type: 'bearer', token: `\${${text}}` }, ...extra }), ['auth'], {
      redactor: new Redactor(),
      env,
    })
    .then((out) => resolveEnv(`\${${text}}`, 'auth.token', out));

describe.skipIf(!POSIX)('secret manager CLIs, run for real', () => {
  it('1Password: op read --no-newline <reference>, with its own variables only', async () => {
    const dir = bin();
    const op = fakeCli(dir, 'op', prints('fake-op-value-123'));
    expect(await read('op://Dev Vault/Petstore/api key', {}, parentEnv(dir))).toBe(
      'fake-op-value-123',
    );
    const [call] = op.calls();
    expect(call?.argv).toEqual(['read', '--no-newline', 'op://Dev Vault/Petstore/api key']);
    expect(call?.env.OP_SERVICE_ACCOUNT_TOKEN).toBe('fake-op-service-account');
    expect(call?.env.PATH).toBe(dir);
    expect(call?.env.HOME).toBe(t.dir);
    for (const name of [...Object.keys(UNRELATED), 'AWS_PROFILE', 'CLOUDSDK_CONFIG'])
      expect(call?.env).not.toHaveProperty(name);
  });

  it('AWS: get-secret-value with a fixed command line, a key read by apitame, its variables only', async () => {
    const dir = bin();
    const secret = JSON.stringify({ username: 'app', password: 'fake-aws-db-password' });
    const aws = fakeCli(dir, 'aws', prints(`${JSON.stringify(secret)}\n`));
    expect(
      await read(
        'aws-sm://prod/db#password',
        { secrets: { aws: { region: 'eu-west-1', profile: 'apitame' } } },
        parentEnv(dir),
      ),
    ).toBe('fake-aws-db-password');
    const [call] = aws.calls();
    expect(call?.argv).toEqual([
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      'prod/db',
      '--query',
      'SecretString',
      '--output',
      'json',
      '--region',
      'eu-west-1',
      '--profile',
      'apitame',
    ]);
    expect(call?.env.AWS_PROFILE).toBe('fake-profile');
    expect(call?.env.AWS_PAGER).toBe('');
    for (const name of [...Object.keys(UNRELATED), 'OP_SERVICE_ACCOUNT_TOKEN', 'CLOUDSDK_CONFIG'])
      expect(call?.env).not.toHaveProperty(name);
  });

  it('Google Cloud: gcloud secrets versions access, the payload decoded by apitame', async () => {
    const dir = bin();
    const data = Buffer.from('fake-gcp-value').toString('base64url');
    const gcloud = fakeCli(
      dir,
      'gcloud',
      prints(JSON.stringify({ name: 'projects/1/secrets/s/versions/3', payload: { data } })),
    );
    expect(
      await read('gcp-sm://projects/my-project/secrets/api-key/versions/3', {}, parentEnv(dir)),
    ).toBe('fake-gcp-value');
    const [call] = gcloud.calls();
    expect(call?.argv).toEqual([
      'secrets',
      'versions',
      'access',
      '3',
      '--secret=api-key',
      '--project=my-project',
      '--format=json',
      '--quiet',
    ]);
    expect(call?.env.CLOUDSDK_CONFIG).toBe(join(t.dir, 'gcloud'));
    expect(call?.env.CLOUDSDK_CORE_DISABLE_PROMPTS).toBe('1');
    for (const name of [...Object.keys(UNRELATED), 'OP_SERVICE_ACCOUNT_TOKEN', 'AWS_PROFILE'])
      expect(call?.env).not.toHaveProperty(name);
  });

  it('kills a CLI that never answers at the deadline, with what it started, and leaves nothing behind', async () => {
    const dir = bin();
    const pids = join(dir, 'pids.json');
    fakeCli(dir, 'op', hangs(pids));
    const started = Date.now();
    const err = await read(
      'op://vault/item/field',
      { secrets: { timeoutSeconds: 1 } },
      parentEnv(dir),
    ).catch((e: Error) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(SecretReferenceError);
    expect((err as Error).message).toMatch(/did not answer within 1 second and was stopped/);
    const [cli, child] = JSON.parse(readFileSync(pids, 'utf8')) as [number, number];
    // Both gone, not even a zombie: the CLI was reaped, and the program it started (as gcloud's
    // shell script starts Python) went with its process group.
    expect(await gone([cli, child])).toEqual([]);
  });

  it('kills a CLI that is still running when apitame exits', async () => {
    // In a process group of its own, a CLI would not get the Ctrl+C that stops apitame.
    const dir = bin();
    const pids = join(dir, 'pids.json');
    fakeCli(dir, 'op', hangs(pids));
    const script = join(dir, 'exits.mjs');
    writeFileSync(
      script,
      [
        "import { existsSync } from 'node:fs';",
        `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/secrets/cli.ts')).href)});`,
        `runCli(${JSON.stringify(join(dir, 'op'))}, ['read'], { env: { PATH: ${JSON.stringify(dir)} }, timeoutMs: 60000, maxOutputBytes: 1000 }).catch(() => {});`,
        `while (!existsSync(${JSON.stringify(pids)})) await new Promise((r) => setTimeout(r, 20));`,
        'process.exit(0);',
      ].join('\n'),
    );
    const res = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, script],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(res.status, res.stderr).toBe(0);
    const [cli, child] = JSON.parse(readFileSync(pids, 'utf8')) as [number, number];
    expect(await gone([cli, child])).toEqual([]);
  });

  /** A script that reads a reference with a CLI that never answers, and reports when it waits. */
  function waiter(dir: string, pids: string, setup = '') {
    const script = join(dir, 'waits.mjs');
    writeFileSync(
      script,
      [
        `const { runCli } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/secrets/cli.ts')).href)});`,
        setup,
        `runCli(${JSON.stringify(join(dir, 'op'))}, ['read'], { env: { PATH: ${JSON.stringify(dir)} }, timeoutMs: 60000, maxOutputBytes: 1000 }).catch(() => {});`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href, script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      child.on('close', (code, signal) => r({ code, signal })),
    );
    const started = (async () => {
      for (let i = 0; i < 300 && !existsSync(pids); i++)
        await new Promise((r) => setTimeout(r, 20));
      return JSON.parse(readFileSync(pids, 'utf8')) as [number, number];
    })();
    return { child, ended, started, out: () => out };
  }

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'stops a running CLI when apitame gets %s, then ends as the signal would',
    async (signal) => {
      const dir = bin();
      const pids = join(dir, 'pids.json');
      fakeCli(dir, 'op', hangs(pids));
      const w = waiter(dir, pids);
      const [cli, grandchild] = await w.started;
      w.child.kill(signal);
      // Nothing else handles the signal: apitame ends by it, as without a CLI running.
      expect(await w.ended).toEqual({ code: null, signal });
      expect(await gone([cli, grandchild])).toEqual([]);
    },
  );

  it('stops a running CLI on a signal and leaves the shutdown to the handler that is there', async () => {
    const dir = bin();
    const pids = join(dir, 'pids.json');
    fakeCli(dir, 'op', hangs(pids));
    // As serve does: its own handler shuts down when a signal arrives.
    const w = waiter(
      dir,
      pids,
      "process.on('SIGTERM', () => { console.log('own handler'); setTimeout(() => process.exit(3), 50); });",
    );
    const [cli, grandchild] = await w.started;
    w.child.kill('SIGTERM');
    expect(await w.ended).toEqual({ code: 3, signal: null });
    expect(w.out()).toContain('own handler');
    expect(await gone([cli, grandchild])).toEqual([]);
  });

  it('kills a CLI that prints more than 1 MB', async () => {
    const dir = bin();
    const pids = join(dir, 'pids.json');
    fakeCli(
      dir,
      'op',
      `fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid])); const chunk = 'a'.repeat(65536); const write = () => { while (process.stdout.write(chunk)); }; process.stdout.on('drain', write); write(); setInterval(() => {}, 1000);`,
    );
    const err = await read('op://vault/item/field', {}, parentEnv(dir)).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/printed more than 1 MB and was stopped/);
    const [pid] = JSON.parse(readFileSync(pids, 'utf8')) as [number];
    expect(await gone([pid])).toEqual([]);
  });

  it('never shows what a failing CLI printed, on stderr or stdout', async () => {
    const dir = bin();
    fakeCli(
      dir,
      'aws',
      fails(
        255,
        'An error occurred (AccessDeniedException) when calling the GetSecretValue operation: fake-secret-in-stderr\n',
        'fake-partial-secret-on-stdout',
      ),
    );
    const err = (await read('aws-sm://prod/api', {}, parentEnv(dir)).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toMatch(
      /AWS CLI \(aws\) exited with code 255: access denied: the credentials need secretsmanager:GetSecretValue/,
    );
    expect(err.message).not.toContain('fake-secret-in-stderr');
    expect(err.message).not.toContain('fake-partial-secret-on-stdout');
  });

  it('runs only an executable found in an absolute PATH folder, or the one APITAME_OP_CLI names', async () => {
    const dir = bin();
    fakeCli(dir, 'op', prints('fake-op-value'));
    const env = (PATH: string, extra: NodeJS.ProcessEnv = {}) => ({
      ...parentEnv(dir),
      PATH,
      ...extra,
    });
    const cwd = process.cwd();
    // Run from a folder that holds an executable op: a relative PATH entry would pick it up.
    process.chdir(dir);
    try {
      for (const PATH of ['.', './', '', `.:bin`, `relative-${n}`]) {
        expect(findExecutable('op', env(PATH))).toBeUndefined();
        expect(
          await read('op://vault/item/field', {}, env(PATH)).catch((e: Error) => e.message),
        ).toMatch(/op was not found on PATH/);
      }
    } finally {
      process.chdir(cwd);
    }
    expect(findExecutable('op', env(`relative:${dir}`))).toBe(join(dir, 'op'));
    expect(findExecutable(join(dir, 'op'), env(''))).toBe(join(dir, 'op'));
    writeFileSync(join(dir, 'aws'), 'not executable');
    expect(findExecutable('aws', env(dir))).toBeUndefined();
    expect(
      await read('op://vault/item/field', {}, env('', { APITAME_OP_CLI: join(dir, 'op') })),
    ).toBe('fake-op-value');
  });

  it('passes arguments as they are, with no shell to read them', async () => {
    const dir = bin();
    const marker = join(dir, 'pwned');
    // A file named like an expansion is just a name to execFile-style spawning.
    const echo = fakeCli(dir, 'op', `process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    const result = await runCli(
      join(dir, 'op'),
      ['read', `$(touch ${marker})`, '`touch x`', '; touch y', '--flag value'],
      { env: { PATH: dir }, timeoutMs: 5_000, maxOutputBytes: 1_000 },
    );
    expect(JSON.parse(result.stdout.toString())).toEqual([
      'read',
      `$(touch ${marker})`,
      '`touch x`',
      '; touch y',
      '--flag value',
    ]);
    expect(echo.calls()).toHaveLength(1);
    expect(alive(echo.calls()[0]!.pid)).toBe(false);
  });
});

describe.skipIf(!POSIX)('secret manager references in a runtime', () => {
  const project = tempDir('apitame-secret-runtime-');
  afterAll(() => project.cleanup());
  beforeAll(() => copyFileSync(PETSTORE, join(project.dir, 'openapi.yaml')));

  function loaded(extra: Record<string, unknown>) {
    writeFileSync(
      join(project.dir, 'apitame.config.yaml'),
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml', baseUrl: 'https://petstore.test/v2' },
        ...extra,
      }),
    );
    return loadConfig(join(project.dir, 'apitame.config.yaml'));
  }

  it('sends the value to the API and hides it from results, errors and logs', async () => {
    const dir = bin();
    const value = 'fake-op-bearer-value-123';
    fakeCli(dir, 'op', prints(value));
    const logs: string[] = [];
    const redactor = new Redactor();
    const sent: string[] = [];
    let fail = false;
    const rt = (await createRuntime(
      loaded({ auth: { type: 'bearer', token: '${op://vault/petstore/token}' } }),
      {
        env: parentEnv(dir),
        dotenv: false,
        redactor,
        logger: new Logger(redactor, 'debug', (l) => logs.push(l)),
        fetchImpl: (async (_url: string, init: RequestInit = {}) => {
          const auth = (init.headers as Record<string, string>).Authorization ?? '';
          sent.push(auth);
          if (fail) throw new Error(`connect ECONNREFUSED while sending ${auth}`);
          return new Response(JSON.stringify({ echoed: auth, raw: value.split('').join('') }), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    )) as OpenApiRuntime;
    try {
      const ok = await rt.callTool('call_operation', { operationId: 'getInventory', params: {} });
      expect(sent).toEqual([`Bearer ${value}`]);
      expect(textOf(ok)).not.toContain(value);
      expect(textOf(ok)).toContain(REDACTED);
      fail = true;
      const error = await rt.callTool('call_operation', {
        operationId: 'getInventory',
        params: {},
      });
      expect(error.isError).toBe(true);
      expect(textOf(error)).not.toContain(value);
      // Whatever logs it, through the logger every command uses: the value is a known secret.
      const logger = new Logger(redactor, 'debug', (l) => logs.push(l));
      logger.error(`the API said: unknown token ${value}`);
      expect(logs.at(-1)).toBe(`[apitame] error: the API said: unknown token ${REDACTED}\n`);
      expect(logs.join('\n')).not.toContain(value);
    } finally {
      await rt.close();
    }
  });

  it('builds nothing when one reference cannot be read', async () => {
    const dir = bin();
    fakeCli(
      dir,
      'op',
      `const ref = process.argv[4]; if (ref.endsWith('/token')) process.stdout.write('fake-op-ok-value'); else { process.stderr.write('[ERROR] You are not currently signed in. fake-leak'); process.exitCode = 1; }`,
    );
    let fetched = 0;
    const err = await createRuntime(
      loaded({
        auth: { type: 'bearer', token: '${op://vault/petstore/token}' },
        source: {
          type: 'openapi',
          spec: './openapi.yaml',
          headers: { 'X-Tenant': '${op://vault/petstore/tenant}' },
        },
      }),
      {
        env: parentEnv(dir),
        dotenv: false,
        fetchImpl: (async () => {
          fetched++;
          return new Response('{}');
        }) as unknown as typeof fetch,
      },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SecretReferenceError);
    expect((err as Error).message).toBe(
      `Could not read the secret reference "\${op://vault/petstore/tenant}" (used by source.headers.X-Tenant): 1Password CLI (op) exited with code 1: not signed in to 1Password. Sign in (op signin), turn on the 1Password app integration, or set OP_SERVICE_ACCOUNT_TOKEN. Run ${join(dir, 'op')} read --no-newline op://vault/petstore/tenant to see its own message.`,
    );
    expect(fetched).toBe(0);
  });

  it('asks no secret manager for a placeholder build', async () => {
    const dir = bin();
    const op = fakeCli(dir, 'op', prints('fake-op-value'));
    const rt = await createRuntime(
      loaded({ auth: { type: 'bearer', token: '${op://vault/petstore/token}' } }),
      { env: parentEnv(dir), dotenv: false, secrets: 'placeholder' },
    );
    await rt.close();
    expect(op.calls()).toEqual([]);
  });
});

describe.skipIf(!POSIX)('apitame doctor with secret manager references', () => {
  const find = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);
  const cwd = process.cwd();
  const path = process.env.PATH;
  let mock: MockServer;
  beforeAll(async () => {
    mock = await startMockServer(extractOperations((await petstore()).doc));
  });
  afterAll(() => mock.close());
  afterEach(() => {
    process.chdir(cwd);
    process.env.PATH = path;
  });

  /** A petstore project whose token comes from 1Password, with a fake op first on PATH. */
  function project(body: string, extra: Record<string, unknown> = {}) {
    const p = tempDir('apitame-doctor-secrets-');
    copyFileSync(PETSTORE, join(p.dir, 'openapi.yaml'));
    writeFileSync(
      join(p.dir, 'apitame.config.yaml'),
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml', baseUrl: mock.url },
        auth: { type: 'bearer', token: '${op://vault/petstore/token}' },
        ...extra,
      }),
    );
    const dir = bin();
    const op = fakeCli(dir, 'op', body);
    process.env.PATH = `${dir}:${path}`;
    process.chdir(p.dir);
    return { ...p, op, binDir: dir };
  }

  it('reads each reference as serve does and never prints the value', async () => {
    const p = project(prints('fake-op-doctor-value'));
    try {
      const f = await runDoctor({});
      expect(find(f, 'Secrets')).toEqual([
        {
          status: 'ok',
          check: 'Secrets',
          detail: `"\${op://vault/petstore/token}" (auth.token) read with ${join(p.binDir, 'op')}`,
        },
      ]);
      expect(find(f, 'API')[0]).toMatchObject({ status: 'ok' });
      expect(JSON.stringify(f)).not.toContain('fake-op-doctor-value');
      expect(p.op.calls()).toHaveLength(1);
    } finally {
      p.cleanup();
    }
  });

  it('reports a failure without what the CLI printed, and skips what needs the credentials', async () => {
    const p = project(fails(1, '[ERROR] "vault" isn\'t a vault in this account. fake-doctor-leak'));
    try {
      const f = await runDoctor({});
      const [secret] = find(f, 'Secrets');
      expect(secret?.status).toBe('fail');
      expect(secret?.detail).toMatch(/vault not found, or not shared with this account/);
      expect(JSON.stringify(f)).not.toContain('fake-doctor-leak');
      expect(find(f, 'API')).toEqual([
        {
          status: 'info',
          check: 'API',
          detail: 'skipped: a secret reference could not be read (see Secrets)',
        },
      ]);
      // Read once: the runtime is built with a placeholder instead of asking again.
      expect(p.op.calls()).toHaveLength(1);
    } finally {
      p.cleanup();
    }
  });

  it('only looks for the CLI with --offline, and says when it is missing', async () => {
    const p = project(prints('fake-op-value'));
    try {
      const f = await runDoctor({ offline: true });
      expect(find(f, 'Secrets')[0]).toMatchObject({
        status: 'info',
        detail: expect.stringMatching(/\/op found, not read \(--offline\)$/),
      });
      expect(p.op.calls()).toEqual([]);
      process.env.PATH = '/nonexistent-apitame-path';
      const missing = await runDoctor({ offline: true });
      expect(find(missing, 'Secrets')[0]).toMatchObject({
        status: 'fail',
        detail: expect.stringMatching(/op was not found on PATH\. Install the 1Password CLI/),
      });
    } finally {
      p.cleanup();
    }
  });
});
