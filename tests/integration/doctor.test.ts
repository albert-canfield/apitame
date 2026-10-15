import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { runDoctor, type Finding } from '../../src/cli/commands/doctor.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { createSqliteShop, PETSTORE, petstore, tempDir } from '../helpers.js';

const find = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);
const statusOf = (findings: Finding[], check: string) => find(findings, check).map((f) => f.status);

let mock: MockServer;
const cwd = process.cwd();
beforeAll(async () => {
  mock = await startMockServer(extractOperations((await petstore()).doc));
});
afterAll(() => mock.close());
afterEach(() => process.chdir(cwd));

function petstoreProject(extra: Record<string, unknown> = {}) {
  const t = tempDir('apitame-doctor-');
  copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
  const config = {
    name: 'petstore',
    source: { type: 'openapi', spec: './openapi.yaml', baseUrl: mock.url },
    tools: [{ name: 'store', operations: ['getInventory', 'getOrderById'] }],
    ...extra,
  };
  writeFileSync(join(t.dir, 'apitame.config.yaml'), stringify(config));
  process.chdir(t.dir);
  return t;
}

describe('apitame doctor', () => {
  it('fails clearly without a config', async () => {
    const t = tempDir();
    try {
      process.chdir(t.dir);
      const f = await runDoctor({});
      expect(statusOf(f, 'Config')).toEqual(['fail']);
    } finally {
      t.cleanup();
    }
  });

  it('checks the API end to end and reports stale skills, typos and missing env vars', async () => {
    const t = petstoreProject({
      auth: { type: 'bearer', token: '${DOCTOR_TEST_TOKEN_UNSET}' },
      mode: 'read-write',
      writes: { allow: ['addPett', 'delete*'] },
    });
    try {
      const f = await runDoctor({});
      expect(statusOf(f, 'Environment')).toEqual(['fail']);
      expect(find(f, 'Environment')[0]!.detail).toMatch(/DOCTOR_TEST_TOKEN_UNSET/);
      expect(find(f, 'writes.allow')[0]).toMatchObject({ status: 'warn' });
      expect(find(f, 'writes.allow')[0]!.detail).toMatch(/"addPett"/);
      expect(find(f, 'writes.allow')[0]!.detail).not.toMatch(/delete\*/);
      expect(statusOf(f, 'Skills')).toEqual(['warn']);
      expect(statusOf(f, 'Clients')).toEqual(['info']);
    } finally {
      t.cleanup();
    }
  });

  it('fails on per-caller permissions that name a tool that does not exist', async () => {
    const oauth = (permissions: unknown) => ({
      mode: 'read-write',
      writes: { allow: ['addPet'] },
      http: {
        oauth: {
          issuer: 'https://login.example.com',
          resource: 'https://mcp.example.com/mcp',
          scopes: ['mcp:tools'],
          permissions,
        },
      },
    });
    let t = petstoreProject(oauth({ byScope: { 'mcp:read': { tools: ['stores'] } } }));
    try {
      const f = await runDoctor({ offline: true });
      expect(statusOf(f, 'Config')).toEqual(['ok', 'fail']);
      expect(find(f, 'Config')[1]!.detail).toMatch(
        /byScope\.mcp:read\.tools: no tool matches "stores"/,
      );
    } finally {
      t.cleanup();
    }
    t = petstoreProject(oauth({ byScope: { 'mcp:write': { writes: ['deletePet'] } } }));
    try {
      const f = await runDoctor({ offline: true });
      expect(find(f, 'Config').map((x) => x.status)).toEqual(['ok', 'warn']);
      expect(find(f, 'Config')[1]!.detail).toMatch(/"deletePet" grants nothing/);
    } finally {
      t.cleanup();
    }
  });

  it('is happy with a complete setup', async () => {
    const t = petstoreProject();
    try {
      spawnSync(
        process.execPath,
        [
          '--import',
          pathToFileURL(join(cwd, 'node_modules/tsx/dist/loader.mjs')).href,
          join(cwd, 'src/cli.ts'),
          'init',
          '--skills-only',
        ],
        {
          cwd: t.dir,
          env: { ...process.env, NO_COLOR: '1' },
        },
      );
      writeFileSync(
        join(t.dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { petstore: { command: 'npx' } } }),
      );
      const f = await runDoctor({});
      expect(f.filter((x) => x.status === 'fail' || x.status === 'warn')).toEqual(
        f.filter((x) => x.check === 'Node.js' && x.status === 'warn'),
      );
      expect(find(f, 'API')[0]!.detail).toMatch(/GET \/store\/inventory answered 200/);
      expect(statusOf(f, 'Skills')).toEqual(['ok']);
      expect(find(f, 'Clients')[0]!.detail).toMatch(/Claude Code/);
    } finally {
      t.cleanup();
    }
  });

  it('flags a .env that git would commit', async () => {
    const t = petstoreProject();
    try {
      spawnSync('git', ['init', '-q'], { cwd: t.dir });
      writeFileSync(join(t.dir, '.env'), 'X=1\n');
      expect(statusOf(await runDoctor({ offline: true }), '.env')).toEqual(['fail']);
      writeFileSync(join(t.dir, '.gitignore'), '.env\n');
      expect(statusOf(await runDoctor({ offline: true }), '.env')).toEqual(['ok']);
    } finally {
      t.cleanup();
    }
  });

  it('warns when the database credentials could write', async () => {
    const t = tempDir('apitame-doctor-sql-');
    try {
      const db = join(t.dir, 'shop.db');
      createSqliteShop(db);
      writeFileSync(
        join(t.dir, 'apitame.config.yaml'),
        stringify({ name: 'shop', source: { type: 'sqlite', path: './shop.db' } }),
      );
      mkdirSync(join(t.dir, 'skills'));
      process.chdir(t.dir);
      let f = await runDoctor({});
      expect(statusOf(f, 'Database')).toEqual(['ok']);
      expect(statusOf(f, 'Database role')).toEqual(['warn']);
      // Windows has no POSIX permission bits to drop write access with.
      if (process.platform !== 'win32') {
        chmodSync(db, 0o444);
        f = await runDoctor({});
        expect(statusOf(f, 'Database role')).toEqual(['ok']);
        chmodSync(db, 0o644);
      }
    } finally {
      t.cleanup();
    }
  });
});
