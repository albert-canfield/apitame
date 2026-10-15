import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { loadSpec } from '../../src/sources/openapi/load.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { createSqliteShop, freePort, PETSTORE, ROOT, tempDir } from '../helpers.js';
import { claimsFor, FakeAuthServer, makeKey, signers, signJwt } from '../oauth-fixtures.js';

const CLI = join(ROOT, 'src/cli.ts');
// Run the TypeScript sources directly; resolve the tsx loader from the repo, not from the temp cwd.
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const NODE_ARGS = ['--import', TSX, CLI];

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', APITAME_LOG_LEVEL: 'silent', ...env },
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('CLI: OpenAPI flow', () => {
  const t = tempDir('apitame-cli-');
  beforeAll(() => {
    copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
  });
  afterAll(() => t.cleanup());

  it('init generates a valid config and skills', () => {
    const res = run(['init', 'openapi.yaml'], t.dir);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/19 operations \(8 read, 11 write\)/);
    expect(res.stdout).toMatch(/Read-only mode: 11 write operations blocked/);

    const cfg = parseYaml(readFileSync(join(t.dir, 'apitame.config.yaml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(cfg).toMatchObject({
      name: 'petstore',
      mode: 'read-only',
      source: { type: 'openapi', spec: './openapi.yaml' },
    });

    const skill = readFileSync(join(t.dir, 'skills/petstore-api/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: petstore-api\ndescription: /);
    expect(existsSync(join(t.dir, 'skills/petstore-api/references/operations.md'))).toBe(true);
  });

  it('init refuses to overwrite without --force', () => {
    const res = run(['init', 'openapi.yaml'], t.dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/already exists/);
  });

  it('inspect reports tools, blocked writes and token cost, with a CI budget', () => {
    const res = run(['inspect', '--json'], t.dir);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as {
      tools: unknown[];
      tokens: { total: number; onePerEndpoint: number };
      blocked: Array<{ id: string }>;
    };
    expect(out.tools).toHaveLength(5);
    expect(out.tokens.total).toBeLessThan(out.tokens.onePerEndpoint);
    expect(out.blocked.map((b) => b.id)).toContain('deletePet');

    const budget = run(['inspect', '--max-tokens', '10'], t.dir);
    expect(budget.code).toBe(1);
    expect(budget.stdout).toMatch(/Over budget/);
  });

  it('finds the config through APITAME_CONFIG from another folder', () => {
    const elsewhere = tempDir('apitame-cli-other-');
    try {
      const res = run(['inspect', '--json'], elsewhere.dir, {
        APITAME_CONFIG: join(t.dir, 'apitame.config.yaml'),
      });
      expect(res.code, res.stderr).toBe(0);
      expect((JSON.parse(res.stdout) as { tools: unknown[] }).tools).toHaveLength(5);
      // --config still wins over the variable.
      const missing = run(['inspect', '--config', 'nope.yaml'], elsewhere.dir, {
        APITAME_CONFIG: join(t.dir, 'apitame.config.yaml'),
      });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toMatch(/No config found/);
    } finally {
      elsewhere.cleanup();
    }
  });

  it('test passes against the mock and proves writes are blocked', () => {
    const res = run(['test'], t.dir);
    expect(res.code, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/11 blocked write operations\s+safety\s+pass/);
  });

  it('add-to prints and writes config for each client', () => {
    const claude = run(['add-to', 'claude-code', '--write'], t.dir);
    expect(claude.code, claude.stderr).toBe(0);
    const mcp = JSON.parse(readFileSync(join(t.dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.petstore).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(mcp.mcpServers.petstore.args).toContain('${CLAUDE_PROJECT_DIR:-.}/apitame.config.yaml');
    expect(existsSync(join(t.dir, '.claude/skills/petstore-api/SKILL.md'))).toBe(true);

    expect(run(['add-to', 'cursor', '--write'], t.dir).code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(t.dir, '.cursor/mcp.json'), 'utf8')).mcpServers.petstore.args,
    ).toContain('${workspaceFolder}/apitame.config.yaml');
    expect(existsSync(join(t.dir, '.agents/skills/petstore-api/SKILL.md'))).toBe(true);

    expect(run(['add-to', 'vscode', '--write'], t.dir).code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(t.dir, '.vscode/mcp.json'), 'utf8')).servers.petstore.type,
    ).toBe('stdio');

    const codex = run(['add-to', 'codex', '--write'], t.dir);
    expect(codex.stdout).toMatch(
      /codex mcp add petstore -- npx -y apitame@\d+\.\d+ serve --config/,
    );
    expect(readFileSync(join(t.dir, '.codex/config.toml'), 'utf8')).toMatch(
      /\[mcp_servers\.petstore\]\ncommand = "npx"/,
    );
    // Running it again does not duplicate the section.
    run(['add-to', 'codex', '--write'], t.dir);
    expect(
      readFileSync(join(t.dir, '.codex/config.toml'), 'utf8').match(/\[mcp_servers\.petstore\]/g),
    ).toHaveLength(1);

    expect(run(['add-to', 'gemini', '--write'], t.dir).code).toBe(0);
    const gemini = JSON.parse(readFileSync(join(t.dir, '.gemini/settings.json'), 'utf8'));
    expect(gemini.mcpServers.petstore.args).toContain(
      join(realpathSync(t.dir), 'apitame.config.yaml'),
    );

    const desktopConfig = join(t.dir, 'desktop', 'claude_desktop_config.json');
    const desktop = run(['add-to', 'claude-desktop', '--write'], t.dir, {
      APITAME_CLAUDE_DESKTOP_CONFIG: desktopConfig,
    });
    expect(desktop.code, desktop.stderr).toBe(0);
    const entry = JSON.parse(readFileSync(desktopConfig, 'utf8')).mcpServers.petstore;
    expect(entry.command).toMatch(/npx(\.cmd)?$/);
    expect(entry.args).toContain(join(realpathSync(t.dir), 'apitame.config.yaml'));
    expect(entry.env.PATH).toBeTruthy();
    expect(existsSync(join(t.dir, 'skills/petstore-api.zip'))).toBe(true);
    expect(desktop.stdout).toMatch(/Upload them in Claude Desktop/);

    expect(run(['add-to', 'notepad'], t.dir).code).toBe(1);
  });

  it('skills follow the mode after --skills-only', () => {
    const file = join(t.dir, 'apitame.config.yaml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8')
        .replace('mode: read-only', 'mode: read-write')
        .replace('allow: []', 'allow: [addPet, deletePet]'),
    );
    expect(run(['init', '--skills-only'], t.dir).code).toBe(0);
    const skill = readFileSync(join(t.dir, 'skills/petstore-api/SKILL.md'), 'utf8');
    expect(skill).toMatch(/read-write mode/);
    expect(skill).toMatch(/needs confirmation/);
    expect(skill).toMatch(/"dryRun":true/);
  });

  it('serve speaks MCP over stdio', async () => {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...NODE_ARGS, 'serve'],
      cwd: t.dir,
      env: { ...(process.env as Record<string, string>), APITAME_LOG_LEVEL: 'silent' },
      stderr: 'ignore',
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name)).toEqual(
        expect.arrayContaining(['pet', 'search_operations', 'call_operation']),
      );
      const res = await client.callTool({
        name: 'call_operation',
        arguments: { operationId: 'deleteUser', params: { username: 'x' } },
      });
      expect(res.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('CLI: SQLite flow', () => {
  const t = tempDir('apitame-cli-sql-');
  beforeAll(() => createSqliteShop(join(t.dir, 'shop.db')));
  afterAll(() => t.cleanup());

  it('init, inspect and test a SQLite database', () => {
    const init = run(['init', 'shop.db'], t.dir);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toMatch(/Connected to SQLite: 4 tables/);
    const skill = readFileSync(join(t.dir, 'skills/shop-db/SKILL.md'), 'utf8');
    expect(skill).toMatch(/JOIN customers/);

    const inspect = run(['inspect'], t.dir);
    expect(inspect.code, inspect.stderr).toBe(0);
    expect(inspect.stdout).toMatch(/list_tables/);

    const test = run(['test'], t.dir);
    expect(test.code, test.stdout + test.stderr).toBe(0);
    expect(test.stdout).toMatch(
      /5 write and injection attempts\s+safety\s+pass\s+\d+\s+all refused/,
    );
  });

  it('gives a clear error for unknown sources', () => {
    const res = run(['init', 'missing.yaml'], t.dir);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/Cannot find "missing.yaml"/);
  });
});

describe('CLI: serve over HTTP with OAuth', () => {
  const t = tempDir('apitame-cli-oauth-');
  const resource = 'https://mcp.example.com/mcp';
  let as: FakeAuthServer;
  beforeAll(async () => {
    as = await FakeAuthServer.start();
    copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
    writeFileSync(
      join(t.dir, 'apitame.config.yaml'),
      [
        'name: petstore',
        'source: { type: openapi, spec: ./openapi.yaml }',
        'http:',
        '  oauth:',
        `    issuer: ${as.issuer}`,
        `    resource: ${resource}`,
        '    scopes: [mcp:tools]',
        '',
      ].join('\n'),
    );
  });
  afterAll(async () => {
    await as.close();
    t.cleanup();
  });

  it('refuses to start with APITAME_HTTP_TOKEN set as well', () => {
    const res = run(['serve', '--transport', 'http'], t.dir, { APITAME_HTTP_TOKEN: 'static' });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/APITAME_HTTP_TOKEN and http\.oauth cannot be used together/);
  });

  it('loads the signing keys at startup and accepts access tokens', async () => {
    const key = makeKey('ec', 'ec-1');
    as.publish(key);
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [...NODE_ARGS, 'serve', '--transport', 'http', '--port', String(port)],
      {
        cwd: t.dir,
        env: { ...process.env, NO_COLOR: '1', APITAME_LOG_LEVEL: 'info', APITAME_HTTP_TOKEN: '' },
      },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no startup line:\n${stderr}`)), 30_000);
        child.stderr.on('data', () => {
          if (/serving .*\/mcp/.test(stderr)) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}:\n${stderr}`)));
      });
      expect(stderr).toContain(`OAuth: 1 signing key from ${as.issuer}`);
      expect(stderr).toContain(`(OAuth from ${as.issuer})`);

      const token = signJwt(
        { alg: 'ES256', kid: 'ec-1' },
        claimsFor(as.issuer, resource),
        signers.es(key.privateKey),
      );
      const client = new Client({ name: 'e2e-oauth', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      expect((await client.listTools()).tools.map((x) => x.name)).toContain('call_operation');
      await client.close();
      const anonymous = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
      expect(anonymous.status).toBe(401);
    } finally {
      child.kill();
    }
  });
});

describe('CLI: serve for protocol 2026-07-28 clients', () => {
  const t = tempDir('apitame-cli-mrtr-');
  let mock: MockServer;
  const writeConfig = (operations: string[], extra: string[] = []) =>
    writeFileSync(
      join(t.dir, 'apitame.config.yaml'),
      [
        'name: petstore',
        `source: { type: openapi, spec: ./openapi.yaml, baseUrl: "${mock.url}" }`,
        'mode: read-write',
        'writes: { allow: [deletePet] }',
        `tools: [{ name: pet, operations: [${operations.join(', ')}] }]`,
        ...extra,
        '',
      ].join('\n'),
    );
  /** `serve --transport http` on a free port, once it says it is serving. */
  const serveHttpCli = async (args: string[] = []) => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [...NODE_ARGS, 'serve', '--transport', 'http', '--port', String(port), ...args],
      { cwd: t.dir, env: { ...process.env, NO_COLOR: '1', APITAME_LOG_LEVEL: 'debug' } },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no startup line:\n${stderr}`)), 30_000);
      child.stderr.on('data', () => {
        if (/serving .*\/mcp/.test(stderr)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`exited with ${code}:\n${stderr}`)));
    });
    return {
      url: new URL(`http://127.0.0.1:${port}/mcp`),
      log: () => stderr,
      stop: () => child.kill(),
    };
  };
  beforeAll(async () => {
    copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
    mock = await startMockServer(extractOperations((await loadSpec(PETSTORE)).doc));
  });
  afterAll(async () => {
    await mock.close();
    t.cleanup();
  });

  const modern = (onChanged?: () => void) => {
    const prompts: string[] = [];
    const client = new Client(
      { name: 'e2e-2026', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        ...(onChanged ? { listChanged: { tools: { onChanged } } } : {}),
      },
    );
    client.setRequestHandler('elicitation/create', async (req) => {
      prompts.push(String(req.params.message));
      return { action: 'accept', content: { approve: true } };
    });
    return { client, prompts };
  };
  const deletes = () => mock.requests.filter((r) => r.operationId === 'deletePet').length;

  const subscribed = async (client: Client) => {
    const until = Date.now() + 10_000;
    while (!client.autoOpenedSubscription) {
      if (Date.now() > until) throw new Error('no subscriptions/listen stream');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const within = (heard: Promise<void>, what: () => string) =>
    Promise.race([
      heard,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`no list change:\n${what()}`)), 10_000),
      ),
    ]);

  it('asks the human in two rounds over stdio, and tells the client about reloads', async () => {
    writeConfig(['getPetById', 'deletePet']);
    let changed!: () => void;
    const heard = new Promise<void>((r) => (changed = r));
    const { client, prompts } = modern(() => changed());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...NODE_ARGS, 'serve', '--watch'],
        cwd: t.dir,
        env: { ...(process.env as Record<string, string>), APITAME_LOG_LEVEL: 'silent' },
        stderr: 'ignore',
      }),
    );
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      const before = deletes();
      const res = await client.callTool({
        name: 'pet',
        arguments: { operation: 'deletePet', params: { petId: 7 } },
      });
      expect(res.isError).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('/pet/7');
      expect(deletes()).toBe(before + 1);

      await subscribed(client);
      writeConfig(['getPetById', 'findPetsByStatus', 'deletePet']);
      await within(heard, () => 'stdio');
    } finally {
      await client.close();
    }
  });

  it('serves stateless HTTP and tells clients about reloads with --watch', async () => {
    writeConfig(['getPetById', 'deletePet']);
    const server = await serveHttpCli(['--watch']);
    try {
      // Nothing asks for a token here, so any local process could answer the approvals.
      expect(server.log()).toContain('warn: HTTP without authentication: any local process');
      let changed!: () => void;
      const heard = new Promise<void>((r) => (changed = r));
      const { client, prompts } = modern(() => changed());
      await client.connect(new StreamableHTTPClientTransport(server.url));
      try {
        const before = deletes();
        const res = await client.callTool({
          name: 'pet',
          arguments: { operation: 'deletePet', params: { petId: 8 } },
        });
        expect(res.isError).toBeFalsy();
        expect(prompts).toHaveLength(1);
        expect(deletes()).toBe(before + 1);
        expect(server.log()).toContain('debug: HTTP POST: protocol 2026-07-28 request');

        await subscribed(client);
        writeConfig(['getPetById', 'findPetsByStatus', 'deletePet']);
        await within(heard, server.log);
      } finally {
        await client.close();
      }
    } finally {
      server.stop();
    }
  });

  it('under confirmation.method: elicitation, refuses approvals over HTTP without authentication', async () => {
    writeConfig(['getPetById', 'deletePet'], ['confirmation: { method: elicitation }']);
    const server = await serveHttpCli();
    try {
      expect(server.log()).toContain(
        'Under confirmation.method: elicitation, approvals from clients on protocol 2026-07-28 are refused',
      );
      const { client, prompts } = modern();
      await client.connect(new StreamableHTTPClientTransport(server.url));
      try {
        const before = deletes();
        const res = await client.callTool({
          name: 'pet',
          arguments: { operation: 'deletePet', params: { petId: 9 } },
        });
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res.content)).toContain('HTTP without authentication');
        expect(prompts).toHaveLength(0);
        expect(deletes()).toBe(before);
      } finally {
        await client.close();
      }
    } finally {
      server.stop();
    }
  });
});
