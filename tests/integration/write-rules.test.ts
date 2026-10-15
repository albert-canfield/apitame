import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { inspectCommand } from '../../src/cli/commands/inspect.js';
import { parseConfig } from '../../src/config/load.js';
import { generateOpenApiSkill } from '../../src/generator/skills.js';
import { skillsFor } from '../../src/cli/commands/init.js';
import { Redactor } from '../../src/safety/redact.js';
import { SqlRuntime } from '../../src/server/sql-runtime.js';
import type { SqlDriver } from '../../src/sources/sql/driver.js';
import { SqliteDriver } from '../../src/sources/sql/sqlite.js';
import type { CallContext } from '../../src/types.js';
import {
  callOperation,
  createSqliteShop,
  fakeApi,
  jsonOf,
  PETSTORE,
  tempDir,
  textOf,
} from '../helpers.js';

const t = tempDir('apitame-rules-');
afterAll(() => t.cleanup());
afterEach(() => {
  vi.useRealTimers();
});

let auditCount = 0;
/** A fresh audit file per runtime, so each test reads only its own entries. */
const newAuditFile = () => join(t.dir, `audit-${++auditCount}.jsonl`);
const auditOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

const tokenIn = (out: string) => /"confirm": "([^"]+)"/.exec(out)?.[1];

const ok = { '200': { description: 'ok' } };
const pathParam = (name: string, type = 'string') => ({
  name,
  in: 'path',
  required: true,
  schema: { type },
});

const paths = {
  '/refunds': {
    post: {
      operationId: 'createRefund',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['charge'],
              properties: {
                charge: { type: 'string' },
                amount: { type: 'integer' },
                items: {
                  type: 'array',
                  items: { type: 'object', properties: { price: { type: 'number' } } },
                },
              },
            },
          },
        },
      },
      responses: ok,
    },
  },
  '/repos/{owner}/{repo}/issues/{number}': {
    parameters: [pathParam('owner'), pathParam('repo'), pathParam('number', 'integer')],
    patch: {
      operationId: 'updateIssue',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { state: { type: 'string' }, title: { type: 'string' } },
            },
          },
        },
      },
      responses: ok,
    },
    delete: { operationId: 'deleteIssue', responses: ok },
  },
  '/repos/{owner}/{repo}': {
    parameters: [pathParam('owner'), pathParam('repo')],
    get: { operationId: 'getRepo', responses: ok },
  },
};

const rules = {
  createRefund: {
    'body.amount': { max: 5000 },
    'body.items[].price': { optional: true, max: 100 },
  },
  updateIssue: {
    owner: { in: ['acme'] },
    repo: { pattern: '^(web|api)$' },
    number: { max: 1000 },
    'body.state': { optional: true, in: ['open', 'closed'] },
  },
  deleteIssue: { owner: { in: ['acme'] } },
  getRepo: { owner: { in: ['acme'] } },
};

function api(config: Record<string, unknown> = {}) {
  const audit = newAuditFile();
  const made = fakeApi({
    paths,
    config: {
      mode: 'read-write',
      writes: { allow: ['createRefund', 'updateIssue', 'deleteIssue'], rules },
      confirmation: { method: 'token' },
      audit: { file: audit },
      tools: [
        { name: 'refunds', operations: ['createRefund'] },
        { name: 'issues', operations: ['updateIssue', 'deleteIssue', 'getRepo'] },
      ],
      ...config,
    },
  });
  return { ...made, audit: () => auditOf(audit) };
}

const goodIssue = { owner: 'acme', repo: 'web', number: 7, body: { state: 'closed' } };

describe('writes.rules in the OpenAPI runtime', () => {
  it('refuses a call that breaks a rule, sends nothing and records the rule in the audit log', async () => {
    const { rt, sent, audit } = api();
    const res = await rt.callTool('refunds', { body: { charge: 'ch_1', amount: 6000 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Refused by writes.rules for "createRefund". Nothing was sent.');
    expect(textOf(res)).toContain(
      '- body.amount: must be at most 5000, got 6000 [rule body.amount max: 5000]',
    );
    expect(sent).toHaveLength(0);
    expect(audit()).toEqual([
      expect.objectContaining({
        tool: 'refunds',
        operation: 'createRefund',
        outcome: 'blocked',
        reason:
          'writes.rules.createRefund.body.amount (max: 5000): body.amount must be at most 5000, got 6000',
      }),
    ]);
  });

  it('refuses a call that leaves out a value a rule checks, unless the rule is optional', async () => {
    const { rt, sent, audit } = api();
    // A refund without an amount would refund the whole charge.
    const missing = await rt.callTool('refunds', { body: { charge: 'ch_1' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain(
      '- body.amount: is missing; the rule requires it, mark it optional: true if leaving it out is safe [rule body.amount max: 5000]',
    );
    expect(sent).toHaveLength(0);
    expect(audit()[0]).toMatchObject({
      outcome: 'blocked',
      reason:
        'writes.rules.createRefund.body.amount (max: 5000): body.amount is missing; the rule requires it, mark it optional: true if leaving it out is safe',
    });
    // body.items[].price and body.state are optional: leaving them out is fine.
    await rt.callTool('refunds', { body: { charge: 'ch_1', amount: 10 } });
    await callOperation(rt, 'updateIssue', { ...goodIssue, body: { title: 'renamed' } });
    expect(sent).toHaveLength(2);
  });

  it('checks every item of a list', async () => {
    const { rt, sent } = api();
    const items = await rt.callTool('refunds', {
      body: { charge: 'ch_1', amount: 10, items: [{ price: 5 }, { price: 500 }] },
    });
    expect(textOf(items)).toContain('- body.items[1].price: must be at most 100, got 500');
    expect(sent).toHaveLength(0);
  });

  it('applies the same rules through grouped tools and call_operation', async () => {
    const { rt, sent } = api();
    const grouped = await rt.callTool('issues', {
      operation: 'updateIssue',
      params: { ...goodIssue, owner: 'evil-corp' },
    });
    expect(textOf(grouped)).toContain('- owner: must be "acme", got "evil-corp"');
    const viaCall = await callOperation(rt, 'updateIssue', { ...goodIssue, repo: 'secrets' });
    expect(textOf(viaCall)).toContain('- repo: must match ^(web|api)$, got "secrets"');
    const caseInsensitiveId = await callOperation(rt, 'UPDATEISSUE', {
      ...goodIssue,
      body: { state: 'locked' },
    });
    expect(textOf(caseInsensitiveId)).toContain('- body.state: must be one of "open", "closed"');
    expect(sent).toHaveLength(0);
  });

  it('checks coerced values, so "1500" for an integer is compared as 1500', async () => {
    const { rt, sent } = api();
    const res = await callOperation(rt, 'updateIssue', { ...goodIssue, number: '1500' });
    expect(textOf(res)).toContain('- number: must be at most 1000, got 1500');
    expect(sent).toHaveLength(0);
    await callOperation(rt, 'updateIssue', { ...goodIssue, number: '12' });
    expect(sent).toHaveLength(1);
  });

  it('refuses before a dry run preview', async () => {
    const { rt, sent, audit } = api();
    const res = await callOperation(
      rt,
      'updateIssue',
      { ...goodIssue, owner: 'evil-corp' },
      { dryRun: true },
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain('"dryRun": true');
    expect(sent).toHaveLength(0);
    expect(audit().map((e) => e.outcome)).toEqual(['blocked']);
  });

  it('never asks a human to approve a call that breaks a rule', async () => {
    const elicit = vi.fn<NonNullable<CallContext['elicit']>>(async () => 'accept');
    const { rt, sent } = api({ confirmation: { method: 'auto' } });
    const res = await rt.callTool(
      'issues',
      { operation: 'deleteIssue', params: { owner: 'evil', repo: 'web', number: 1 } },
      { elicit },
    );
    expect(textOf(res)).toContain('Refused by writes.rules for "deleteIssue"');
    expect(elicit).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    const { rt: tokenRt } = api();
    const challenge = await callOperation(tokenRt, 'deleteIssue', {
      owner: 'evil',
      repo: 'web',
      number: 1,
    });
    expect(textOf(challenge)).not.toContain('CONFIRMATION REQUIRED');
    expect(tokenIn(textOf(challenge))).toBeUndefined();
  });

  it('does not use up the write rate limit on refused calls', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { rt, sent, audit } = api({ limits: { maxWritesPerMinute: 1 } });
    for (let i = 0; i < 3; i++)
      await callOperation(rt, 'updateIssue', { ...goodIssue, owner: 'evil' });
    const res = await callOperation(rt, 'updateIssue', goodIssue);
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(audit().map((e) => e.outcome)).toEqual(['blocked', 'blocked', 'blocked', 'sent']);
  });

  it('lets valid calls through and says the rules passed in dry runs and confirmations', async () => {
    const { rt, sent } = api();
    const dry = jsonOf<{ dryRun: boolean; rulesPassed: string }>(
      await callOperation(rt, 'updateIssue', goodIssue, { dryRun: true }),
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.rulesPassed).toBe(
      'owner: required, must be "acme"; repo: required, must match ^(web|api)$; number: required, at most 1000; body.state: if set, one of "open", "closed"',
    );

    await callOperation(rt, 'updateIssue', goodIssue);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(String(sent[0]!.body))).toEqual({ state: 'closed' });

    const args = { owner: 'acme', repo: 'web', number: 3 };
    const challenge = textOf(await callOperation(rt, 'deleteIssue', args));
    expect(challenge).toContain('CONFIRMATION REQUIRED');
    expect(challenge).toContain('Rules passed: owner: required, must be "acme".');
    await callOperation(rt, 'deleteIssue', args, { confirm: tokenIn(challenge) });
    expect(sent).toHaveLength(2);

    const elicit = vi.fn<NonNullable<CallContext['elicit']>>(async () => 'accept');
    const { rt: auto, sent: autoSent } = api({ confirmation: { method: 'auto' } });
    await auto.callTool('issues', { operation: 'deleteIssue', params: args }, { elicit });
    expect(elicit.mock.calls[0]?.[0]).toContain('Rules passed: owner: required, must be "acme".');
    expect(autoSent).toHaveLength(1);
  });

  it('never allows anything: a rule for an operation outside writes.allow stays blocked', async () => {
    const { rt, sent } = api({
      writes: { allow: ['createRefund'], rules },
    });
    const res = await callOperation(rt, 'deleteIssue', { owner: 'acme', repo: 'web', number: 1 });
    expect(textOf(res)).toContain('is not in writes.allow');
    const readOnly = api({ mode: 'read-only' });
    const blocked = await readOnly.rt.callTool('refunds', { body: { charge: 'c', amount: 1 } });
    expect(textOf(blocked)).toContain('Unknown tool');
    expect(
      textOf(await callOperation(readOnly.rt, 'createRefund', { body: { charge: 'c' } })),
    ).toContain('read-only mode');
    expect(sent).toHaveLength(0);
    expect(readOnly.sent).toHaveLength(0);
  });

  it('leaves reads alone and warns about rules on them', async () => {
    const { rt, sent } = api();
    const res = await rt.callTool('issues', {
      operation: 'getRepo',
      params: { owner: 'anyone', repo: 'anything' },
    });
    expect(res.isError).toBeFalsy();
    expect(sent).toHaveLength(1);
    expect(rt.warnings).toContain(
      'writes.rules.getRepo: "getRepo" is a read operation; rules only apply to writes, so these are ignored.',
    );
  });

  it('warns about rules for operations and fields that do not exist', () => {
    const { rt } = api({
      writes: {
        allow: ['createRefund'],
        rules: { createRefnd: { amount: { max: 1 } }, createRefund: { 'body.amout': { max: 1 } } },
      },
    });
    expect(rt.warnings).toEqual([
      'writes.rules.createRefnd: no operation has this id (typo?). Rules take exact ids.',
      'writes.rules.createRefund.body.amout: there is no field "amout" in body',
    ]);
  });

  it('lists the rules in tool descriptions and search results', async () => {
    const { rt } = api();
    const tools = rt.listTools();
    expect(tools.find((x) => x.name === 'refunds')?.description).toContain(
      'Rules: body.amount: required, at most 5000; body.items[].price: if set, at most 100.',
    );
    const issues = tools.find((x) => x.name === 'issues')!.description;
    expect(issues).toMatch(
      /- updateIssue\(.*\n {2}Rules: owner: required, must be "acme"; repo: required, must match \^\(web\|api\)\$; number: required, at most 1000; body.state: if set, one of "open", "closed"\.\n- deleteIssue\(.*\n {2}Rules: owner: required, must be "acme"\.\n- getRepo\([^\n]*$/,
    );
    const found = jsonOf<{ results: Array<{ operationId: string; rules?: string }> }>(
      await rt.callTool('search_operations', { query: 'refund' }),
    );
    expect(found.results.find((r) => r.operationId === 'createRefund')?.rules).toBe(
      'body.amount: required, at most 5000; body.items[].price: if set, at most 100',
    );
    const repo = jsonOf<{ results: Array<{ operationId: string; rules?: string }> }>(
      await rt.callTool('search_operations', { query: 'get repo' }),
    );
    expect(repo.results.find((r) => r.operationId === 'getRepo')).not.toHaveProperty('rules');
  });

  it('lists the rules in the generated skill, and its examples follow them', () => {
    const { rt } = api();
    const files = generateOpenApiSkill(rt);
    const skill = files.find((f) => f.path.endsWith('SKILL.md'))!.content;
    const reference = files.find((f) => f.path.endsWith('operations.md'))!.content;
    expect(skill).toContain('- Some writes have argument rules.');
    expect(skill).toContain(
      '  - `createRefund`: `body.amount`: required, at most 5000; `body.items[].price`: if set, at most 100',
    );
    expect(skill).toContain(
      '  - `updateIssue`: `owner`: required, must be "acme"; `repo`: required, must match `^(web|api)$`;',
    );
    expect(skill).not.toContain('`getRepo`:');
    // The sample owner would be "octocat"; the rule only allows "acme".
    expect(skill).toContain(
      '`issues` with `{"operation":"deleteIssue","params":{"owner":"acme","repo":"hello-world","number":1}}`',
    );
    const section = (id: string) => {
      const from = reference.indexOf(`### ${id}\n`);
      const to = reference.slice(from + 4).search(/\n##+ /);
      return reference.slice(from, to < 0 ? undefined : from + 4 + to);
    };
    expect(section('updateIssue')).toContain(
      'Rules, checked by the server before anything is sent:\n\n- `owner`: required, must be "acme"\n- `repo`: required, must match `^(web|api)$`\n- `number`: required, at most 1000\n- `body.state`: if set, one of "open", "closed"\n',
    );
    expect(section('createRefund')).toContain('- `body.amount`: required, at most 5000');
    expect(section('getRepo')).toContain('Signature: `getRepo(');
    expect(section('getRepo')).not.toContain('Rules, checked');

    const without = fakeApi({ paths, config: { mode: 'read-write', writes: { allow: ['*'] } } });
    const plain = generateOpenApiSkill(without.rt)
      .map((f) => f.content)
      .join('\n');
    expect(plain).not.toContain('argument rules');
    expect(plain).not.toContain('Rules, checked');
    expect(plain).toContain('"owner":"octocat"');
  });
});

describe('writes.rules for SQL named queries', () => {
  const db = join(t.dir, 'shop.db');
  beforeAll(() => createSqliteShop(db));

  const statusOf = (id: number) => {
    const conn = new Database(db, { readonly: true });
    try {
      return (conn.prepare('SELECT status FROM orders WHERE id = ?').get(id) as { status: string })
        .status;
    } finally {
      conn.close();
    }
  };

  function runtime(extra: Record<string, unknown> = {}) {
    const audit = newAuditFile();
    const config = parseConfig({
      name: 'shop',
      mode: 'read-write',
      source: { type: 'sqlite', path: db },
      audit: { file: audit },
      writes: {
        allow: ['set_status', 'delete_order'],
        rules: {
          set_status: { status: { in: ['paid', 'shipped'] }, id: { max: 3 } },
          delete_order: { id: { max: 3 } },
          orders_of: { customer_id: { max: 1 } },
        },
      },
      confirmation: { method: 'token' },
      sql: {
        queries: [
          {
            name: 'set_status',
            description: 'Set the status of one order',
            write: true,
            sql: 'UPDATE orders SET status = :status WHERE id = :id',
            params: { id: { type: 'integer' }, status: { type: 'string' } },
          },
          {
            name: 'delete_order',
            description: 'Delete one order',
            write: true,
            sql: 'DELETE FROM order_items WHERE order_id = :id',
            params: { id: { type: 'integer' } },
          },
          {
            name: 'orders_of',
            description: 'Orders of one customer',
            sql: 'SELECT id FROM orders WHERE customer_id = :customer_id',
            params: { customer_id: { type: 'integer' } },
          },
        ],
      },
      ...extra,
    });
    const rt = new SqlRuntime(config, new SqliteDriver(db), new Redactor());
    return { rt, audit: () => auditOf(audit) };
  }

  it('refuses a named write that breaks a rule, changes nothing and records the rule', async () => {
    const { rt, audit } = runtime();
    try {
      const before = statusOf(1);
      const res = await rt.callTool('set_status', { id: 1, status: 'cancelled' });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Refused by writes.rules for "set_status". Nothing was sent.');
      expect(textOf(res)).toContain('- status: must be one of "paid", "shipped", got "cancelled"');
      expect(statusOf(1)).toBe(before);
      // Coerced first: "5" is the integer 5.
      expect(textOf(await rt.callTool('set_status', { id: '5', status: 'paid' }))).toContain(
        '- id: must be at most 3, got 5',
      );
      expect(audit()).toEqual([
        expect.objectContaining({
          tool: 'set_status',
          outcome: 'blocked',
          reason: expect.stringContaining(
            'writes.rules.set_status.status (in: ["paid","shipped"])',
          ),
        }),
        expect.objectContaining({ outcome: 'blocked' }),
      ]);
    } finally {
      await rt.close();
    }
  });

  it('refuses a named write without a parameter a rule checks, unless the rule is optional', async () => {
    const totalOf = (id: number) => {
      const conn = new Database(db, { readonly: true });
      try {
        return (conn.prepare('SELECT total FROM orders WHERE id = ?').get(id) as { total: number })
          .total;
      } finally {
        conn.close();
      }
    };
    const query = {
      name: 'raise_total',
      description: 'Raise the total of one order',
      write: true,
      sql: 'UPDATE orders SET total = total + coalesce(:amount, 0) WHERE id = :id',
      params: { id: { type: 'integer' }, amount: { type: 'number', required: false } },
    };
    const make = (amount: Record<string, unknown>) =>
      runtime({
        writes: { allow: ['raise_total'], rules: { raise_total: { amount } } },
        sql: { queries: [query] },
      });
    const before = totalOf(4);

    const strict = make({ max: 10 });
    try {
      const res = await strict.rt.callTool('raise_total', { id: 4 });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain(
        '- amount: is missing; the rule requires it, mark it optional: true if leaving it out is safe [rule amount max: 10]',
      );
      expect(totalOf(4)).toBe(before);
    } finally {
      await strict.rt.close();
    }

    const relaxed = make({ optional: true, max: 10 });
    try {
      const done = jsonOf<{ affectedRows: number }>(
        await relaxed.rt.callTool('raise_total', { id: 4 }),
      );
      expect(done.affectedRows).toBe(1);
      expect(totalOf(4)).toBe(before);
      const big = await relaxed.rt.callTool('raise_total', { id: 4, amount: 50 });
      expect(textOf(big)).toContain('- amount: must be at most 10, got 50');
      expect(totalOf(4)).toBe(before);
    } finally {
      await relaxed.rt.close();
    }
  });

  it('refuses before a dry run and before asking for confirmation', async () => {
    const { rt } = runtime();
    try {
      const dry = await rt.callTool('set_status', { id: 1, status: 'cancelled', dryRun: true });
      expect(dry.isError).toBe(true);
      expect(textOf(dry)).not.toContain('wouldAffectRows');
      const destructive = await rt.callTool('delete_order', { id: 9 });
      expect(textOf(destructive)).toContain('- id: must be at most 3, got 9');
      expect(textOf(destructive)).not.toContain('CONFIRMATION REQUIRED');
    } finally {
      await rt.close();
    }
  });

  it('runs valid calls and says the rules passed', async () => {
    const { rt, audit } = runtime();
    try {
      const dry = jsonOf<{ wouldAffectRows: number; rulesPassed: string }>(
        await rt.callTool('set_status', { id: 2, status: 'shipped', dryRun: true }),
      );
      expect(dry).toMatchObject({
        wouldAffectRows: 1,
        rulesPassed: 'status: required, one of "paid", "shipped"; id: required, at most 3',
      });
      const done = jsonOf<{ affectedRows: number }>(
        await rt.callTool('set_status', { id: 2, status: 'shipped' }),
      );
      expect(done.affectedRows).toBe(1);
      expect(statusOf(2)).toBe('shipped');
      const challenge = textOf(await rt.callTool('delete_order', { id: 3 }));
      expect(challenge).toContain('CONFIRMATION REQUIRED');
      expect(challenge).toContain('Rules passed: id: required, at most 3.');
      expect(audit().map((e) => e.outcome)).toEqual(['dry-run', 'sent', 'confirmation-requested']);
    } finally {
      await rt.close();
    }
  });

  it('describes the rules, and ignores rules on read queries with a warning', async () => {
    const { rt } = runtime();
    try {
      const tool = rt.listTools().find((x) => x.name === 'set_status');
      expect(tool?.description).toBe(
        'Set the status of one order [write] Rules: status: required, one of "paid", "shipped"; id: required, at most 3.',
      );
      expect(rt.warnings).toContain(
        'writes.rules.orders_of: "orders_of" is a read named query; rules only apply to writes, so these are ignored.',
      );
      const read = jsonOf<{ rows: unknown[] }>(await rt.callTool('orders_of', { customer_id: 17 }));
      expect(read.rows.length).toBeGreaterThan(0);
      const skill = (await skillsFor(rt)).find((f) => f.path.endsWith('SKILL.md'))!.content;
      expect(skill).toContain(
        'Rules: status: required, one of "paid", "shipped"; id: required, at most 3.',
      );
    } finally {
      await rt.close();
    }
  });

  it('warns about rules for named queries and parameters that do not exist', async () => {
    const { rt } = runtime({
      writes: {
        allow: ['set_status'],
        rules: { set_stats: { id: { max: 1 } }, set_status: { statuss: { in: ['paid'] } } },
      },
    });
    try {
      expect(rt.warnings).toEqual([
        'writes.rules.set_stats: no named query has this id (typo?). Rules take exact ids.',
        'writes.rules.set_status.statuss: there is no argument "statuss"',
      ]);
    } finally {
      await rt.close();
    }
  });
});

describe('writes.rules on DuckDB sources', () => {
  it('warns that rules never apply, since DuckDB sources cannot write', async () => {
    const config = parseConfig({
      name: 'lake',
      source: { type: 'duckdb', path: './lake.duckdb' },
      writes: {
        rules: { top_customers: { limit: { max: 10 } }, nothing: { id: { max: 1 } } },
      },
      sql: {
        queries: [
          {
            name: 'top_customers',
            description: 'Top customers',
            sql: 'SELECT name FROM customers LIMIT :limit',
            params: { limit: { type: 'integer' } },
          },
        ],
      },
    });
    // Only the dialect is used when the tools are built, so no DuckDB package is needed.
    const driver = { dialect: 'duckdb', close: async () => {} } as unknown as SqlDriver;
    const rt = new SqlRuntime(config, driver, new Redactor());
    try {
      expect(rt.warnings).toEqual([
        'writes.rules.top_customers: DuckDB sources are read-only, so argument rules never apply.',
        'writes.rules.nothing: DuckDB sources are read-only, so argument rules never apply.',
      ]);
      expect(rt.rules.list()).toEqual([]);
      expect(rt.listTools().find((x) => x.name === 'top_customers')?.description).toBe(
        'Top customers',
      );
    } finally {
      await rt.close();
    }
  });
});

describe('writes.rules in inspect and doctor', () => {
  const dir = join(t.dir, 'petstore');
  const config = join(dir, 'apitame.config.yaml');
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(PETSTORE, join(dir, 'openapi.yaml'));
    writeFileSync(
      config,
      stringify({
        name: 'petstore',
        source: { type: 'openapi', spec: './openapi.yaml', baseUrl: 'http://127.0.0.1:9' },
        mode: 'read-write',
        writes: {
          allow: ['addPet', 'placeOrder'],
          rules: {
            addPet: {
              'body.status': { in: ['available', 'pending'] },
              'body.nmae': { maxLength: 9 },
            },
            placeOrder: { 'body.quantity': { required: true, min: 1, max: 5 } },
            getPetById: { petId: { max: 5 } },
            updatePett: { 'body.name': { required: true } },
          },
        },
      }),
    );
  });

  async function output(run: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('inspect lists the rules per operation and warns about the ones that do nothing', async () => {
    const json = JSON.parse(await output(() => inspectCommand({ config, json: true }))) as {
      rules: Record<string, Array<{ path: string; rule: unknown; text: string }>>;
      warnings: string[];
    };
    expect(json.rules).toEqual({
      addPet: [
        {
          path: 'body.status',
          rule: { in: ['available', 'pending'] },
          text: 'required, one of "available", "pending"',
        },
        {
          path: 'body.nmae',
          rule: { maxLength: 9 },
          text: 'required, at most 9 characters or items',
        },
      ],
      placeOrder: [
        {
          path: 'body.quantity',
          rule: { required: true, min: 1, max: 5 },
          text: 'required, between 1 and 5',
        },
      ],
    });
    expect(json.warnings).toEqual([
      'writes.rules.addPet.body.nmae: there is no field "nmae" in body',
      'writes.rules.getPetById: "getPetById" is a read operation; rules only apply to writes, so these are ignored.',
      'writes.rules.updatePett: no operation has this id (typo?). Rules take exact ids.',
    ]);

    const text = await output(() => inspectCommand({ config }));
    expect(text).toContain('Argument rules for 2 writes, checked before anything is sent');
    expect(text).toMatch(/placeOrder +body\.quantity +required, between 1 and 5/);
    expect(text).toContain('writes.rules.updatePett: no operation has this id');
  });

  it('doctor warns about rules for ids, fields and reads that do not fit', async () => {
    const findings = (await runDoctor({ config, offline: true })).filter(
      (f) => f.check === 'writes.rules',
    );
    expect(findings.map((f) => [f.status, f.detail])).toEqual([
      ['warn', 'writes.rules.addPet.body.nmae: there is no field "nmae" in body'],
      [
        'warn',
        'writes.rules.getPetById: "getPetById" is a read operation; rules only apply to writes, so these are ignored.',
      ],
      ['warn', 'writes.rules.updatePett: no operation has this id (typo?). Rules take exact ids.'],
    ]);
  });
});
