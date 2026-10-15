import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { Logger } from '../../src/log.js';
import { startMockServer, type MockServer } from '../../src/mock/server.js';
import { Guardrails, RateLimiter } from '../../src/safety/guardrails.js';
import { Redactor } from '../../src/safety/redact.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import { extractOperations } from '../../src/sources/openapi/operations.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import { createSqliteShop, petstore, petstoreConfig, tempDir, textOf } from '../helpers.js';

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe('RateLimiter', () => {
  it('allows N per sliding minute and reports the wait', () => {
    let now = 0;
    const rl = new RateLimiter(2, () => now);
    expect(rl.take()).toBe(0);
    now = 10_000;
    expect(rl.take()).toBe(0);
    now = 20_000;
    expect(rl.take()).toBe(40_000);
    now = 60_001;
    expect(rl.take()).toBe(0);
  });

  it('treats 0 as unlimited', () => {
    const rl = new RateLimiter(0);
    for (let i = 0; i < 1_000; i++) expect(rl.take()).toBe(0);
  });
});

describe('Guardrails audit file', () => {
  const t = tempDir();
  afterAll(() => t.cleanup());

  it('writes redacted JSON lines, filters reads unless include is all', () => {
    const redactor = new Redactor();
    redactor.addSecret('super-secret-value');
    const file = join(t.dir, 'audit', 'log.jsonl');
    const g = new Guardrails({
      server: 's',
      auditFile: file,
      include: 'writes',
      callsPerMinute: 0,
      writesPerMinute: 0,
      redactor,
      logger: new Logger(redactor, 'silent'),
    });
    g.record({ tool: 'pet', operation: 'getPetById', access: 'read', outcome: 'sent' });
    g.record({
      tool: 'pet',
      operation: 'deletePet',
      access: 'destructive',
      outcome: 'blocked',
      reason: 'read-only',
      args: { petId: 1, note: 'super-secret-value' },
    });
    g.record({
      tool: 'query',
      access: 'read',
      outcome: 'refused',
      reason: 'DELETE',
      args: { sql: 'DELETE FROM t' },
    });
    const entries = lines(file);
    expect(entries.map((e) => e.outcome)).toEqual(['blocked', 'refused']);
    expect(entries[0]).toMatchObject({
      server: 's',
      tool: 'pet',
      operation: 'deletePet',
      access: 'destructive',
      args: { petId: 1, note: '[REDACTED]' },
    });
    expect(typeof entries[0]!.time).toBe('string');
    expect(readFileSync(file, 'utf8')).not.toContain('super-secret-value');
  });

  it('caps large arguments and survives an unwritable file', () => {
    const redactor = new Redactor();
    const errors: string[] = [];
    const logger = new Logger(redactor, 'error', (l) => errors.push(l));
    const file = join(t.dir, 'big.jsonl');
    const g = new Guardrails({
      server: 's',
      auditFile: file,
      include: 'all',
      callsPerMinute: 0,
      writesPerMinute: 0,
      redactor,
      logger,
    });
    g.record({ tool: 'q', access: 'write', outcome: 'sent', args: { sql: 'x'.repeat(10_000) } });
    expect(String(lines(file)[0]!.args).length).toBeLessThan(2_100);

    const broken = new Guardrails({
      server: 's',
      auditFile: join(t.dir, 'big.jsonl', 'nested.jsonl'),
      include: 'all',
      callsPerMinute: 0,
      writesPerMinute: 0,
      redactor,
      logger,
    });
    broken.record({ tool: 'q', access: 'write', outcome: 'sent' });
    broken.record({ tool: 'q', access: 'write', outcome: 'sent' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Audit log disabled/);
  });
});

describe('guardrails in the OpenAPI runtime', () => {
  let mock: MockServer;
  const t = tempDir();
  beforeAll(async () => {
    mock = await startMockServer(extractOperations((await petstore()).doc));
  });
  afterAll(async () => {
    await mock.close();
    t.cleanup();
  });

  it('limits calls and writes per minute, and audits every write attempt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const config = await petstoreConfig({
        mode: 'read-write',
        writes: { allow: ['addPet'] },
        limits: { maxCallsPerMinute: 4, maxWritesPerMinute: 1 },
        audit: { file: 'audit.jsonl' },
      });
      const rt = await createOpenApiRuntime({
        config,
        configDir: t.dir,
        spec: await petstore(),
        baseUrlOverride: mock.url,
        env: {},
      });
      const add = () =>
        rt.callTool('pet', {
          operation: 'addPet',
          params: { body: { name: 'rex', photoUrls: [] } },
        });

      expect((await add()).isError).toBeUndefined();
      const second = await add();
      expect(textOf(second)).toMatch(/more than 1 writes per minute/);
      expect(
        (await rt.callTool('call_operation', { operationId: 'deletePet', params: { petId: 2 } }))
          .isError,
      ).toBe(true);
      expect(
        (await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } })).isError,
      ).toBeUndefined();
      expect(
        textOf(await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } })),
      ).toMatch(/more than 4 calls per minute/);

      vi.setSystemTime(Date.now() + 61_000);
      expect(
        (await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } })).isError,
      ).toBeUndefined();

      const entries = lines(join(t.dir, 'audit.jsonl'));
      expect(entries.map((e) => `${e.operation}:${e.outcome}`)).toEqual([
        'addPet:sent',
        'addPet:rate-limited',
        'deletePet:blocked',
      ]);
      expect(entries[0]).toMatchObject({ status: 200, access: 'write' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('guardrails in the SQL runtime', () => {
  const t = tempDir();
  afterAll(() => t.cleanup());

  it('audits refused queries and named writes', async () => {
    const db = join(t.dir, 'shop.db');
    createSqliteShop(db);
    const config = parseConfig({
      name: 'shop',
      mode: 'read-write',
      source: { type: 'sqlite', path: db },
      audit: { file: join(t.dir, 'audit.jsonl') },
      writes: { allow: ['cancel_order'] },
      sql: {
        queries: [
          {
            name: 'cancel_order',
            description: 'Cancel',
            write: true,
            sql: "UPDATE orders SET status = 'cancelled' WHERE id = :id",
            params: { id: { type: 'integer' } },
          },
        ],
      },
    });
    const rt = new SqlRuntime(config, new SqliteDriver(db), new Redactor());
    try {
      expect((await rt.callTool('query', { sql: 'DELETE FROM orders' })).isError).toBe(true);
      expect((await rt.callTool('query', { sql: 'SELECT 1' })).isError).toBeUndefined();
      expect((await rt.callTool('cancel_order', { id: 1, dryRun: true })).isError).toBeUndefined();
      expect((await rt.callTool('cancel_order', { id: 1 })).isError).toBeUndefined();
      const entries = lines(join(t.dir, 'audit.jsonl'));
      expect(entries.map((e) => `${e.tool}:${e.outcome}`)).toEqual([
        'query:refused',
        'cancel_order:dry-run',
        'cancel_order:sent',
      ]);
      expect(entries[0]).toMatchObject({ args: { sql: 'DELETE FROM orders' } });
    } finally {
      await rt.close();
    }
  });
});

describe('per-tool rate limits', () => {
  it('limit one tool without affecting the others', async () => {
    const config = await petstoreConfig({ limits: { perTool: { store: 2 } } });
    const rt = await createOpenApiRuntime({
      config,
      configDir: '.',
      spec: await petstore(),
      baseUrlOverride: 'http://127.0.0.1:9',
      env: {},
    });
    const store = () => rt.callTool('store', { operation: 'getInventory' });
    expect(textOf(await store())).not.toMatch(/Rate limit/);
    expect(textOf(await store())).not.toMatch(/Rate limit/);
    expect(textOf(await store())).toMatch(/more than 2 calls per minute to "store"/);
    expect(
      textOf(await rt.callTool('pet', { operation: 'getPetById', params: { petId: 1 } })),
    ).not.toMatch(/Rate limit/);
  });
});

describe('per-caller rate limits', () => {
  const guardrails = (now: () => number) =>
    new Guardrails({
      server: 's',
      include: 'writes',
      callsPerMinute: 0,
      writesPerMinute: 0,
      perCaller: { callsPerMinute: 1, writesPerMinute: 0 },
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
      now,
    });
  const tracked = (g: Guardrails) => (g as unknown as { callers: Map<string, unknown> }).callers;

  it('forget callers whose window is empty once many are tracked', () => {
    let now = 0;
    const g = guardrails(() => now);
    for (let i = 0; i < 1_000; i++) expect(g.checkCall({ subject: `u${i}` })).toBeUndefined();
    expect(tracked(g).size).toBe(1_000);
    // Still within the minute: nobody is forgotten, so nobody gets a fresh budget.
    expect(g.checkCall({ subject: 'late' })).toBeUndefined();
    expect(g.checkCall({ subject: 'u0' })).toMatch(/for this user/);
    now = 61_000;
    expect(g.checkCall({ subject: 'new' })).toBeUndefined();
    expect(tracked(g).size).toBe(1);
  });

  it('do not apply without a caller or with both limits at 0', () => {
    const g = guardrails(() => 0);
    for (let i = 0; i < 5; i++) expect(g.checkCall()).toBeUndefined();
    const off = new Guardrails({
      server: 's',
      include: 'writes',
      callsPerMinute: 0,
      writesPerMinute: 0,
      perCaller: { callsPerMinute: 0, writesPerMinute: 0 },
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
    });
    for (let i = 0; i < 5; i++) expect(off.checkCall({ subject: 'a' })).toBeUndefined();
    expect(tracked(off).size).toBe(0);
  });
});

describe('per-caller write limits', () => {
  it('refuse a caller over its own budget without using up the shared one', () => {
    const g = new Guardrails({
      server: 's',
      include: 'writes',
      callsPerMinute: 0,
      writesPerMinute: 2,
      perCaller: { callsPerMinute: 0, writesPerMinute: 1 },
      redactor: new Redactor(),
      logger: new Logger(new Redactor(), 'silent'),
      now: () => 0,
    });
    expect(g.checkWrite({ subject: 'a' })).toBeUndefined();
    // The write limit can fill up between the check before asking and the send.
    for (let i = 0; i < 3; i++) {
      expect(g.checkWrite({ subject: 'a' })).toMatch(/more than 1 writes per minute for this user/);
    }
    expect(g.checkWrite({ subject: 'b' })).toBeUndefined();
    expect(g.peekWrite({ subject: 'c' })).toMatch(/more than 2 writes per minute\./);
    expect(g.checkWrite({ subject: 'c' })).toMatch(/more than 2 writes per minute\./);
  });
});
