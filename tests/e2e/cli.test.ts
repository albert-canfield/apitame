import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createSqliteShop, PETSTORE, ROOT, tempDir } from '../helpers.js';

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
