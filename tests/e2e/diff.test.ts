import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ROOT, tempDir } from '../helpers.js';

const CLI = join(ROOT, 'src/cli.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
const FIXTURES = join(ROOT, 'tests/fixtures/diff');

function run(args: string[], cwd: string) {
  const { APITAME_CONFIG: _ignored, ...env } = process.env;
  const res = spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1' },
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const CATEGORIES = [
  'new-writes',
  'access-changes',
  'added',
  'removed',
  'renamed',
  'stale-config',
  'write-changes',
  'base-url',
  'any',
];

describe('CLI: diff', () => {
  const t = tempDir('apitame-diff-');
  beforeAll(() => {
    for (const f of ['shop-v1.yaml', 'shop-v2.yaml'])
      copyFileSync(join(FIXTURES, f), join(t.dir, f));
    // The config as it is on the branch: reviewed with shop-v1.yaml, now pointing at shop-v2.yaml.
    writeFileSync(
      join(t.dir, 'apitame.config.yaml'),
      readFileSync(join(FIXTURES, 'apitame.config.yaml'), 'utf8').replace(
        'spec: ./shop-v1.yaml',
        'spec: ./shop-v2.yaml',
      ),
    );
    // shop-v2 plus one read operation, as JSON: only `added` (and `any`) find something.
    const plusRead = parseYaml(readFileSync(join(FIXTURES, 'shop-v2.yaml'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    plusRead.paths['/customers'] = {
      get: { operationId: 'listCustomers', responses: { '200': { description: 'OK' } } },
    };
    writeFileSync(join(t.dir, 'shop-v2-plus-read.json'), JSON.stringify(plusRead));
  });
  afterAll(() => t.cleanup());

  it('reports what changed for the agent in plain text, and exits 0 without --fail-on', () => {
    const res = run(['diff', 'shop-v1.yaml', 'shop-v2.yaml'], t.dir);
    expect(res.code, res.stderr).toBe(0);
    const out = res.stdout;
    expect(out).toMatch(/^shop {2}read-write · shop-v1\.yaml -> shop-v2\.yaml$/m);
    expect(out).toMatch(/^Operations: 7 -> 8 \(2 added, 1 removed, 2 renamed\)$/m);
    expect(out).toMatch(
      /^ {2}createBulkRefund +destructive +POST \/refunds\/bulk +call_operation \(asks for approval\)$/m,
    );
    expect(out).toMatch(/^ {2}listOrderNotes +read +GET \/orders\/\{orderId\}\/notes +orders$/m);
    expect(out).toMatch(/^ {2}createRefund +createOrderRefund +POST \/orders\/\{id\}\/refunds/m);
    expect(out).toMatch(
      /^ {2}exportReport +POST \/reports\/export +read -> write +reports -> blocked: not in writes\.allow$/m,
    );
    expect(out).toMatch(/New writes that the config allows without naming them \(2\)/);
    expect(out).toMatch(
      /^ {2}createOrderRefund +write +writes\.allow create\* +call_operation +renamed from createRefund$/m,
    );
    expect(out).toMatch(
      /^ {2}writes\.rules +createRefund +createRefund +renamed to createOrderRefund$/m,
    );
    expect(out).toMatch(/^ {4}added: body\.items, body\.currency \(required\)$/m);
    expect(out).toMatch(/^ {4}removed: body\.quantity$/m);
    expect(out).toMatch(
      /! writes\.rules\.createOrder\.body\.quantity: there is no field "quantity" in body/,
    );
    expect(out).toMatch(
      /! Base URL: https:\/\/api\.shop\.test\/v1 -> https:\/\/api\.shop\.test\/v2/,
    );
    expect(out).toMatch(/^Tool list: ~[\d,]+ -> ~[\d,]+ tokens \(-[\d,]+; estimate\)$/m);
    expect(out).toMatch(/^ {2}reports +\d+ +-$/m);
  });

  it('prints JSON for CI', () => {
    const res = run(['diff', 'shop-v1.yaml', 'shop-v2.yaml', '--json'], t.dir);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout) as Record<string, unknown> & {
      added: Array<{ id: string }>;
      removed: Array<{ id: string }>;
      renamed: Array<{ kind: string; before: { id: string }; after: { id: string } }>;
      accessChanges: Array<{ after: { id: string; access: string }; escalation: boolean }>;
      newWrites: Array<{ id: string; why: string; allowedBy: string[]; confirm: boolean }>;
      staleConfig: Array<{ where: string; ref: string }>;
      writeChanges: Array<{ id: string; rules: string[] }>;
      tokens: { before: number; after: number; estimate: boolean };
    };
    expect(out).toMatchObject({
      name: 'shop',
      mode: 'read-write',
      before: { spec: 'shop-v1.yaml', operations: 7 },
      after: { spec: 'shop-v2.yaml', operations: 8 },
      baseUrl: { before: 'https://api.shop.test/v1', after: 'https://api.shop.test/v2' },
      failOn: [],
      failed: [],
    });
    expect(out.added.map((o) => o.id)).toEqual(['createBulkRefund', 'listInvoices']);
    expect(out.removed.map((o) => o.id)).toEqual(['listOrderNotes']);
    expect(out.renamed.map((r) => [r.kind, r.before.id, r.after.id])).toEqual([
      ['id', 'createRefund', 'createOrderRefund'],
      ['endpoint', 'exportReport', 'exportReport'],
    ]);
    expect(out.accessChanges).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ id: 'exportReport', access: 'write' }),
        escalation: true,
      }),
    ]);
    expect(out.newWrites.map((w) => [w.id, w.why, w.allowedBy, w.confirm])).toEqual([
      ['createOrderRefund', 'renamed', ['create*'], false],
      ['createBulkRefund', 'added', ['create*'], true],
    ]);
    expect(out.staleConfig.map((s) => `${s.where} ${s.ref}`)).toEqual([
      'writes.confirm createRefund',
      'writes.rules createRefund',
      'tools.orders listOrderNotes',
      'tools.orders createRefund',
    ]);
    expect(out.writeChanges.map((w) => w.id)).toEqual(['createOrder']);
    expect(out.tokens.estimate).toBe(true);
    expect(out.tokens.after).toBeLessThan(out.tokens.before);
  });

  it('compares with the spec the config points to when the new spec is left out', () => {
    const explicit = JSON.parse(
      run(['diff', 'shop-v1.yaml', 'shop-v2.yaml', '--json'], t.dir).stdout,
    ) as Record<string, unknown>;
    const res = run(['diff', 'shop-v1.yaml', '--json'], t.dir);
    expect(res.code, res.stderr).toBe(0);
    const implicit = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(implicit.after).toEqual({ spec: './shop-v2.yaml', operations: 8 });
    expect({ ...implicit, after: undefined }).toEqual({ ...explicit, after: undefined });

    const same = run(['diff', 'shop-v2.yaml'], t.dir);
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toMatch(
      /No changes to operations, access levels, allowed writes or config references/,
    );
  });

  it.each(CATEGORIES)(
    '--fail-on %s exits 1 when it has findings, and 0 when it has none',
    (category) => {
      const changed = run(['diff', 'shop-v1.yaml', 'shop-v2.yaml', '--fail-on', category], t.dir);
      expect(changed.code, changed.stderr).toBe(1);
      expect(changed.stdout).toMatch(new RegExp(`✖ --fail-on ${category}: \\d+ found`));
      const same = run(['diff', 'shop-v2.yaml', 'shop-v2.yaml', '--fail-on', category], t.dir);
      expect(same.code, same.stderr).toBe(0);
      expect(same.stdout).toMatch(new RegExp(`✔ --fail-on ${category}: nothing found`));
    },
  );

  it('checks only the listed categories', () => {
    const plusRead = (failOn: string) =>
      run(['diff', 'shop-v2.yaml', 'shop-v2-plus-read.json', '--fail-on', failOn], t.dir).code;
    expect(plusRead('new-writes')).toBe(0);
    expect(plusRead('removed,access-changes,renamed')).toBe(0);
    expect(plusRead('added')).toBe(1);
    expect(plusRead('any')).toBe(1);
    expect(plusRead('removed,added')).toBe(1);
  });

  it('--fail-on without a value means new-writes', () => {
    const json = run(['diff', 'shop-v1.yaml', '--fail-on', '--json'], t.dir);
    expect(json.code).toBe(1);
    const out = JSON.parse(json.stdout) as { failOn: string[]; failed: string[] };
    expect(out).toMatchObject({ failOn: ['new-writes'], failed: ['new-writes'] });

    const text = run(['diff', 'shop-v1.yaml', '--fail-on'], t.dir);
    expect(text.code).toBe(1);
    expect(text.stdout).toMatch(/✖ --fail-on new-writes: 2 found/);
    expect(run(['diff', 'shop-v2-plus-read.json', '--fail-on'], t.dir).code).toBe(0);
  });

  it('accepts repeated --fail-on options and refuses unknown categories', () => {
    const repeated = run(
      [
        'diff',
        'shop-v2.yaml',
        'shop-v2-plus-read.json',
        '--fail-on',
        'removed',
        '--fail-on',
        'added',
        '--json',
      ],
      t.dir,
    );
    expect(repeated.code).toBe(1);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      failOn: ['removed', 'added'],
      failed: ['added'],
    });

    const unknown = run(['diff', 'shop-v1.yaml', '--fail-on', 'new-write'], t.dir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown category "new-write"/);
    // A spec file right after --fail-on is not a category.
    const misplaced = run(['diff', '--fail-on', 'shop-v1.yaml', 'shop-v2.yaml'], t.dir);
    expect(misplaced.code).toBe(1);
    expect(misplaced.stderr).toMatch(/spec files go before --fail-on/);
  });

  it('reads Swagger 2.0 specs, and fails clearly on missing specs and SQL configs', () => {
    copyFileSync(
      join(ROOT, 'tests/fixtures/petstore-swagger2.json'),
      join(t.dir, 'petstore-swagger2.json'),
    );
    writeFileSync(
      join(t.dir, 'swagger.config.yaml'),
      'name: petstore\nsource:\n  type: openapi\n  spec: ./petstore-swagger2.json\n',
    );
    const swagger = run(['diff', 'petstore-swagger2.json', '-c', 'swagger.config.yaml'], t.dir);
    expect(swagger.code, swagger.stderr).toBe(0);
    expect(swagger.stdout).toMatch(/No changes to operations/);

    const missing = run(['diff', 'nope.yaml'], t.dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/OpenAPI file not found/);

    writeFileSync(
      join(t.dir, 'sql.config.yaml'),
      'name: shop-db\nsource:\n  type: sqlite\n  path: ./shop.db\n',
    );
    const sql = run(['diff', 'shop-v1.yaml', '-c', 'sql.config.yaml'], t.dir);
    expect(sql.code).toBe(1);
    expect(sql.stderr).toMatch(
      /apitame diff compares OpenAPI specs; this config's source is sqlite/,
    );
  });
});
