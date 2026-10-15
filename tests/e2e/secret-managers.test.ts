import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { PETSTORE, ROOT, startPostgresShop, tempDir } from '../helpers.js';
import { fails, fakeCli, gone, hangs, prints } from '../secret-fixtures.js';

const CLI = join(ROOT, 'src/cli.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const NODE_ARGS = ['--import', TSX, CLI];

// Fake CLIs are shell scripts; on Windows apitame only runs .exe files, without a shell.
const POSIX = process.platform !== 'win32';

/** Every file under a folder, as text. */
function filesUnder(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

describe.skipIf(!POSIX)('CLI: secret manager references', () => {
  const t = tempDir('apitame-cli-secrets-');
  const bin = join(t.dir, 'bin');
  const value = 'fake-op-api-token-0123456789';
  let api: Server;
  let apiUrl = '';
  const seen: string[] = [];
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    NO_COLOR: '1',
    APITAME_LOG_LEVEL: 'silent',
    PATH: `${bin}:${process.env.PATH}`,
    ...extra,
  });
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const res = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
      cwd: t.dir,
      encoding: 'utf8',
      env: env(extra),
      timeout: 60_000,
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const writeConfig = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(t.dir, 'apitame.config.yaml'),
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml', baseUrl: apiUrl },
        auth: { type: 'bearer', token: '${op://Dev Vault/Petstore/api token}' },
        ...extra,
      }),
    );

  beforeAll(async () => {
    mkdirSync(bin);
    copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
    // The API echoes the Authorization header it received.
    api = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: 1, authorization: req.headers.authorization }));
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}/v2`;
  });
  afterAll(async () => {
    await new Promise((r) => api.close(r));
    t.cleanup();
  });

  it('serve reads the token from 1Password at startup, sends it, and never shows it', async () => {
    const op = fakeCli(bin, 'op', prints(value));
    writeConfig();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, 'serve'],
      cwd: t.dir,
      env: env({ APITAME_LOG_LEVEL: 'debug' }) as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: 'e2e-secrets', version: '1.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({
        name: 'call_operation',
        arguments: { operationId: 'getInventory', params: {} },
      });
      const text = JSON.stringify(res.content);
      expect(seen).toContain(`Bearer ${value}`);
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain(value);
    } finally {
      await client.close();
    }
    expect(op.calls().map((c) => c.argv)).toEqual([
      ['read', '--no-newline', 'op://Dev Vault/Petstore/api token'],
    ]);
    expect(stderr).toContain(
      `read secret reference "\${op://Dev Vault/Petstore/api token}" for auth.token with ${join(bin, 'op')}`,
    );
    expect(stderr).not.toContain(value);
  });

  it('serve refuses to start when a reference cannot be read, without what the CLI printed', () => {
    fakeCli(bin, 'op', fails(1, `[ERROR] You are not currently signed in. ${value}`));
    writeConfig();
    const res = run(['serve'], { APITAME_LOG_LEVEL: 'info' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain(
      'Could not read the secret reference "${op://Dev Vault/Petstore/api token}" (used by auth.token): 1Password CLI (op) exited with code 1: not signed in to 1Password.',
    );
    expect(res.stderr).not.toContain(value);
    expect(res.stderr).not.toMatch(/serving /);
  });

  it('inspect, test against the mock and init --skills-only never ask the secret manager', () => {
    const op = fakeCli(bin, 'op', prints('fake-op-never-asked'));
    writeConfig();
    const before = op.calls().length;
    const where = { APITAME_OP_CLI: join(bin, 'op') };
    expect(run(['inspect'], where).code).toBe(0);
    const test = run(['test'], where);
    expect(test.code, test.stdout + test.stderr).toBe(0);
    const init = run(['init', '--skills-only'], where);
    expect(init.code, init.stderr).toBe(0);
    expect(op.calls().length).toBe(before);
    expect(filesUnder(join(t.dir, 'skills'))).not.toContain('fake-op-never-asked');
  });

  it('test against the mock sends no credentials, and asks no OAuth2 token endpoint', async () => {
    const op = fakeCli(bin, 'op', prints('fake-op-client-secret'));
    const tokenRequests: string[] = [];
    const tokens = createServer((req, res) => {
      tokenRequests.push(String(req.url));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fake-issued-token', expires_in: 3600 }));
    });
    await new Promise<void>((r) => tokens.listen(0, '127.0.0.1', r));
    const tokenUrl = `http://127.0.0.1:${(tokens.address() as { port: number }).port}/token`;
    try {
      const before = op.calls().length;
      for (const clientSecret of ['${op://Dev Vault/Petstore/client secret}', '${CLIENT_SECRET}']) {
        writeConfig({
          source: {
            type: 'openapi',
            spec: './openapi.yaml',
            baseUrl: apiUrl,
            headers: { 'X-Tenant': '${TENANT_KEY}' },
          },
          auth: { type: 'oauth2', tokenUrl, clientId: 'apitame', clientSecret },
        });
        const res = spawnSync(process.execPath, [...NODE_ARGS, 'test', '--json'], {
          cwd: t.dir,
          encoding: 'utf8',
          env: env({
            CLIENT_SECRET: 'fake-real-client-secret',
            TENANT_KEY: 'fake-real-tenant-key',
          }),
          timeout: 60_000,
        });
        expect(res.status, res.stdout + res.stderr).toBe(0);
        expect(res.stdout + res.stderr).not.toContain('fake-real-tenant-key');
      }
      expect(tokenRequests).toEqual([]);
      expect(op.calls().length).toBe(before);
    } finally {
      await new Promise((r) => tokens.close(r));
    }
  });

  it('serve stops a CLI that is still running when it gets SIGTERM during startup', async () => {
    const pids = join(t.dir, 'serve-pids.json');
    fakeCli(bin, 'op', hangs(pids));
    writeConfig({ secrets: { timeoutSeconds: 60 } });
    const child = spawn(process.execPath, [...NODE_ARGS, 'serve'], {
      cwd: t.dir,
      env: env(),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const ended = new Promise<NodeJS.Signals | null>((r) => child.on('close', (_c, sig) => r(sig)));
    for (let i = 0; i < 300 && !existsSync(pids); i++) await new Promise((r) => setTimeout(r, 50));
    const [cli, grandchild] = JSON.parse(readFileSync(pids, 'utf8')) as [number, number];
    child.kill('SIGTERM');
    expect(await ended).toBe('SIGTERM');
    expect(await gone([cli, grandchild])).toEqual([]);
  });

  it('init --skills-only reads a database URL from 1Password and writes no part of it', async () => {
    const pg = await startPostgresShop();
    const dir = join(t.dir, 'db');
    mkdirSync(dir);
    try {
      const op = fakeCli(bin, 'op', prints(pg.url));
      const config = stringify({
        name: 'shop',
        source: { type: 'postgres', url: '${op://Dev Vault/Shop database/url}' },
      });
      writeFileSync(join(dir, 'apitame.config.yaml'), config);
      // Not spawnSync: PGlite answers from this process, which must keep running meanwhile.
      const res = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(process.execPath, [...NODE_ARGS, 'init', '--skills-only'], {
            cwd: dir,
            env: env(),
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          child.on('close', (status) => resolve({ status, stdout, stderr }));
        },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(op.calls().at(-1)?.argv).toEqual([
        'read',
        '--no-newline',
        'op://Dev Vault/Shop database/url',
      ]);
      const written = filesUnder(dir);
      expect(written).toContain('orders');
      expect(written).not.toContain('secret-pg-password');
      expect(written).not.toContain(pg.url);
      expect(res.stdout + res.stderr).not.toContain('secret-pg-password');
      expect(readFileSync(join(dir, 'apitame.config.yaml'), 'utf8')).toBe(config);
    } finally {
      await pg.close();
    }
  });
});
