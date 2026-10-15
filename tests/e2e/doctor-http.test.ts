import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { PETSTORE, ROOT, tempDir } from '../helpers.js';

const CLI = join(ROOT, 'src/cli.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;

function doctor(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete base.APITAME_HTTP_TOKEN;
  const res = spawnSync(process.execPath, ['--import', TSX, CLI, 'doctor', '--json', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env },
    timeout: 60_000,
  });
  const out = JSON.parse(res.stdout) as {
    findings: Array<{ check: string; status: string; detail: string }>;
  };
  return { code: res.status, http: out.findings.filter((f) => f.check === 'HTTP auth') };
}

describe('CLI: doctor for HTTP deployments', () => {
  const t = tempDir('apitame-cli-doctor-http-');
  beforeAll(() => {
    copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
    writeFileSync(
      join(t.dir, 'apitame.config.yaml'),
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml', baseUrl: 'http://127.0.0.1:9' },
      }),
    );
  });
  afterAll(() => t.cleanup());

  it('--host checks authentication where serve will listen, and fails without it', () => {
    expect(doctor(['--offline'], t.dir).http).toEqual([]);
    const open = doctor(['--offline', '--host', '0.0.0.0'], t.dir);
    expect(open.code).toBe(1);
    expect(open.http).toMatchObject([{ status: 'fail' }]);
    const local = doctor(['--offline', '--http'], t.dir);
    expect(local.http).toMatchObject([{ status: 'info' }]);
    const token = doctor(['--offline', '--host', '0.0.0.0'], t.dir, {
      APITAME_HTTP_TOKEN: 'fake-key-0123456789abcdef0123456789abcdef',
    });
    expect(token.code).toBe(0);
    expect(token.http).toMatchObject([{ status: 'ok' }]);
  });
});
