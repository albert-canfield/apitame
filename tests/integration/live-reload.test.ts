import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Logger } from '../../src/log.js';
import { Redactor } from '../../src/safety/redact.js';
import { LiveRuntime } from '../../src/server/live.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { PETSTORE, tempDir } from '../helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function project(extra: Record<string, unknown> = {}) {
  const t = tempDir('apitame-live-');
  copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
  const file = join(t.dir, 'apitame.config.yaml');
  const write = (cfg: Record<string, unknown>) =>
    writeFileSync(
      file,
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml' },
        tools: [{ name: 'pet', operations: ['getPetById', 'findPetsByStatus', 'addPet'] }],
        ...extra,
        ...cfg,
      }),
    );
  write({});
  cleanups.push(() => t.cleanup());
  return { dir: t.dir, file, write };
}

const operations = (tools: Array<{ name: string; inputSchema: Record<string, unknown> }>) =>
  (tools.find((t) => t.name === 'pet')!.inputSchema.properties as { operation: { enum: string[] } })
    .operation.enum;

const waitFor = <T>(promise: Promise<T>, ms = 5_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out waiting')), ms)),
  ]);

describe('serve --watch', () => {
  it('reloads the config and tells the client that the tools changed', async () => {
    const p = project();
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
      debounceMs: 50,
    });
    cleanups.push(() => live.close());
    const server = createMcpServer(() => live.runtime, {
      skills: () => live.skills,
      listChanged: true,
    });
    live.onReload(({ toolsChanged }) => {
      if (toolsChanged) void server.sendToolListChanged();
    });
    live.watch();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'watch-test', version: '1.0.0' });
    let notify!: () => void;
    const changed = new Promise<void>((r) => (notify = r));
    client.setNotificationHandler('notifications/tools/list_changed', () => notify());
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(() => client.close());

    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(operations((await client.listTools()).tools)).toEqual([
      'getPetById',
      'findPetsByStatus',
    ]);

    p.write({ mode: 'read-write', writes: { allow: ['addPet'] } });
    await waitFor(changed);
    expect(operations((await client.listTools()).tools)).toEqual([
      'getPetById',
      'findPetsByStatus',
      'addPet',
    ]);
  });

  it('counts a change of per-caller permissions as a tool list change', async () => {
    const oauth = (permissions: unknown) => ({
      http: {
        oauth: {
          issuer: 'https://login.example.com',
          resource: 'https://mcp.example.com/mcp',
          scopes: ['mcp:tools'],
          permissions,
        },
      },
    });
    const p = project({ mode: 'read-write', writes: { allow: ['addPet'] } });
    p.write(oauth({ byScope: { 'mcp:write': {} } }));
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
    });
    cleanups.push(() => live.close());
    const changes: boolean[] = [];
    live.onReload(({ toolsChanged }) => changes.push(toolsChanged));
    const writer = { caller: { subject: 'w' }, scopes: ['mcp:tools', 'mcp:write'] };
    expect(operations(live.runtime.listTools(writer))).toContain('addPet');

    p.write(oauth({ byScope: { 'mcp:write': { mode: 'read-only' } } }));
    expect(await live.reload()).toBe(true);
    // The server's own list is the same, but this caller's changed.
    expect(operations(live.runtime.listTools())).toContain('addPet');
    expect(operations(live.runtime.listTools(writer))).not.toContain('addPet');
    expect(await live.reload()).toBe(true);
    expect(changes).toEqual([true, false]);
  });

  it('keeps serving the previous config when the new one is invalid', async () => {
    const p = project();
    const errors: string[] = [];
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'error', (l) => errors.push(l)),
    });
    cleanups.push(() => live.close());
    const before = live.runtime;
    writeFileSync(p.file, 'name: petstore\nsource: [this is not valid\n');
    expect(await live.reload()).toBe(false);
    expect(live.runtime).toBe(before);
    expect(errors.join()).toMatch(/reload failed, still serving the previous config/);
    expect(live.runtime.listTools().length).toBeGreaterThan(0);
  });

  it('re-reads .env values on reload', async () => {
    const p = project({ auth: { type: 'bearer', token: '${LIVE_TEST_TOKEN}' } });
    writeFileSync(join(p.dir, '.env'), 'LIVE_TEST_TOKEN=first-value-123\n');
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
    });
    cleanups.push(async () => {
      await live.close();
      delete process.env.LIVE_TEST_TOKEN;
    });
    expect(process.env.LIVE_TEST_TOKEN).toBe('first-value-123');
    writeFileSync(join(p.dir, '.env'), 'LIVE_TEST_TOKEN=second-value-456\n');
    expect(await live.reload()).toBe(true);
    expect(process.env.LIVE_TEST_TOKEN).toBe('second-value-456');
  });

  it('watches the config folder, a local spec and the skills folder', async () => {
    const p = project();
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
    });
    cleanups.push(() => live.close());
    const paths = live.watchedPaths();
    expect(paths[0]).toMatchObject({ names: ['apitame.config.yaml', '.env'] });
    expect(paths.some((x) => x.names?.includes('openapi.yaml'))).toBe(true);
  });

  it('forgets .env values a failed reload had loaded', async () => {
    const p = project();
    writeFileSync(join(p.dir, '.env'), 'LIVE_A=1\n');
    const live = await LiveRuntime.start(p.file, {
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
    });
    cleanups.push(async () => {
      await live.close();
      delete process.env.LIVE_A;
      delete process.env.LIVE_B;
    });
    // .env gains LIVE_B, and the spec is missing: the config and .env load, the runtime does not.
    writeFileSync(join(p.dir, '.env'), 'LIVE_A=1\nLIVE_B=old-value\n');
    p.write({ source: { type: 'openapi', spec: './missing.yaml' } });
    expect(await live.reload()).toBe(false);
    expect(process.env.LIVE_B).toBeUndefined();
    writeFileSync(join(p.dir, '.env'), 'LIVE_A=1\nLIVE_B=new-value\n');
    p.write({});
    expect(await live.reload()).toBe(true);
    expect(process.env.LIVE_B).toBe('new-value');
  });

  it('skips a broken skill with a warning, and ignores the audit log in the skills folder', async () => {
    const p = project({ audit: { file: './skills/audit.jsonl' } });
    const skills = join(p.dir, 'skills');
    mkdirSync(join(skills, 'broken'), { recursive: true });
    writeFileSync(join(skills, 'broken', 'SKILL.md'), '---\nname: [unclosed\n---\n');
    const logs: string[] = [];
    const redactor = new Redactor();
    const live = await LiveRuntime.start(p.file, {
      redactor,
      logger: new Logger(redactor, 'warn', (l) => logs.push(l)),
    });
    cleanups.push(() => live.close());
    expect(live.skills).toEqual([]);
    expect(logs.join('')).toContain('skill "broken" skipped');
    const watched = live.watchedPaths().find((x) => x.dir === skills);
    expect(watched?.ignore).toEqual([join(skills, 'audit.jsonl')]);
  });
});
