import { envRefs } from '../../config/env.js';
import { loadConfig, withoutGuardrails, type LoadedConfig } from '../../config/load.js';
import { Logger } from '../../log.js';
import { sampleFromSchema } from '../../mock/sample.js';
import { startMockServer } from '../../mock/server.js';
import { decide } from '../../safety/policy.js';
import { Redactor } from '../../safety/redact.js';
import type { OpenApiRuntime } from '../../server/openapi-runtime.js';
import { createRuntime } from '../../server/runtime.js';
import type { SqlRuntime } from '../../server/sql-runtime.js';
import { ArgValidator } from '../../server/validate.js';
import type { Operation } from '../../sources/openapi/operations.js';
import type { ToolResult } from '../../types.js';
import { c, fail, n, ok, table, warn } from '../ui.js';

export interface TestOptions {
  config?: string;
  live?: boolean;
  json?: boolean;
}

interface Check {
  name: string;
  tool: string;
  outcome: 'pass' | 'warn' | 'fail';
  detail: string;
  ms: number;
}

const text = (r: ToolResult) => r.content.map((x) => x.text).join('\n');

function parse(r: ToolResult): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text(r)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** How to reach an operation through the exposed tools. */
export function toolCallFor(
  rt: OpenApiRuntime,
  op: Operation,
  params: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } | undefined {
  for (const s of rt.summarizeTools()) {
    if (!s.operations.includes(op.id)) continue;
    if (s.kind === 'group') return { tool: s.name, args: { operation: op.id, params } };
    if (s.kind === 'operation') return { tool: s.name, args: params };
  }
  if (rt.listTools().some((t) => t.name === 'call_operation'))
    return { tool: 'call_operation', args: { operationId: op.id, params } };
  return undefined;
}

function sampleParams(op: Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of op.params)
    if (p.required) out[p.key] = sampleFromSchema(p.rawSchema ?? p.schema, p.name);
  if (op.body?.required) out.body = sampleFromSchema(op.body.rawSchema ?? op.body.schema, 'body');
  return out;
}

/** For mock runs: fill credentials that are not set with a placeholder (the mock accepts anything). */
function mockEnv(loaded: LoadedConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const fields = [JSON.stringify(loaded.config.auth), JSON.stringify(loaded.config.source)];
  for (const name of fields.flatMap(envRefs)) if (!env[name]) env[name] = 'apitame-mock-credential';
  return env;
}

async function testOpenApi(
  loaded: LoadedConfig,
  opts: TestOptions,
  redactor: Redactor,
): Promise<Check[]> {
  const checks: Check[] = [];
  const logger = new Logger(redactor, 'silent');
  const env = opts.live ? process.env : mockEnv(loaded);
  // The mock accepts any credentials, so secret managers are only asked with --live.
  const secrets = opts.live ? undefined : 'placeholder';
  const probe = (await createRuntime(loaded, { redactor, logger, env, secrets })) as OpenApiRuntime;
  const mock = opts.live ? undefined : await startMockServer(probe.operations);
  const rt = mock
    ? ((await createRuntime(loaded, {
        redactor,
        logger,
        env,
        secrets,
        baseUrlOverride: mock.url,
      })) as OpenApiRuntime)
    : probe;
  const validator = new ArgValidator();

  try {
    for (const op of rt.operations.filter((o) => o.access === 'read' && !o.unsupported)) {
      const call = toolCallFor(rt, op, sampleParams(op));
      if (!call) {
        checks.push({
          name: op.id,
          tool: '-',
          outcome: 'warn',
          detail: 'not reachable (not in a tool and long tail disabled)',
          ms: 0,
        });
        continue;
      }
      const started = Date.now();
      const res = await rt.callTool(call.tool, call.args);
      const ms = Date.now() - started;
      const body = parse(res);
      const status = typeof body?.status === 'number' ? body.status : undefined;
      if (status === undefined && !opts.live && /^Invalid arguments for /.test(text(res))) {
        // The sample generator could not satisfy the schema (an unusual pattern, for example).
        checks.push({
          name: op.id,
          tool: call.tool,
          outcome: 'warn',
          detail: 'could not build sample arguments for this operation',
          ms,
        });
      } else if (status === undefined) {
        checks.push({
          name: op.id,
          tool: call.tool,
          outcome: 'fail',
          detail: text(res).split('\n')[0]?.slice(0, 120) ?? 'error',
          ms,
        });
      } else if (status >= 200 && status < 300) {
        // Against the mock, responses are generated from the spec, so validating them would only
        // test the sample generator (and compiling huge schemas is slow). Live runs check for drift.
        const problems =
          opts.live && op.response && body?.note === undefined
            ? validator.check(`resp:${op.id}`, op.response.schema, body?.data)
            : [];
        checks.push(
          problems.length > 0
            ? {
                name: op.id,
                tool: call.tool,
                outcome: 'fail',
                detail: `response does not match the spec: ${problems[0]}`,
                ms,
              }
            : { name: op.id, tool: call.tool, outcome: 'pass', detail: `HTTP ${status}`, ms },
        );
      } else if (status === 401 || status === 403) {
        checks.push({
          name: op.id,
          tool: call.tool,
          outcome: 'fail',
          detail: `HTTP ${status}: check auth`,
          ms,
        });
      } else if (status >= 500) {
        checks.push({
          name: op.id,
          tool: call.tool,
          outcome: 'fail',
          detail: `HTTP ${status}`,
          ms,
        });
      } else {
        checks.push({
          name: op.id,
          tool: call.tool,
          outcome: 'warn',
          detail: `HTTP ${status} with sample arguments`,
          ms,
        });
      }
    }

    // Safety: blocked writes must never reach the API.
    const before = mock?.requests.length ?? 0;
    const policy = { mode: rt.config.mode, writes: rt.config.writes };
    const blockedWrites = rt.operations.filter(
      (o) => o.access !== 'read' && !decide(o.id, o.access, policy).allowed,
    );
    let leaked = 0;
    for (const op of blockedWrites) {
      const res = await rt.callTool('call_operation', {
        operationId: op.id,
        params: sampleParams(op),
      });
      if (!res.isError) leaked++;
    }
    const sent = (mock?.requests.length ?? 0) - before;
    if (blockedWrites.length > 0 && rt.listTools().some((t) => t.name === 'call_operation')) {
      checks.push({
        name: `${blockedWrites.length} blocked write operations`,
        tool: 'safety',
        outcome: leaked === 0 && sent === 0 ? 'pass' : 'fail',
        detail:
          leaked === 0 && sent === 0
            ? 'refused, nothing sent'
            : `${leaked} not refused, ${sent} requests sent`,
        ms: 0,
      });
    }
  } finally {
    await mock?.close();
  }
  return checks;
}

function quoteIdent(name: string, mysql = false): string {
  const q = mysql ? '`' : '"';
  return name
    .split('.')
    .map((p) => `${q}${p.split(q).join(q + q)}${q}`)
    .join('.');
}

async function testSql(loaded: LoadedConfig, redactor: Redactor): Promise<Check[]> {
  const checks: Check[] = [];
  const rt = (await createRuntime(loaded, {
    redactor,
    logger: new Logger(redactor, 'silent'),
  })) as SqlRuntime;
  const timed = async (fn: () => Promise<ToolResult>) => {
    const t = Date.now();
    const r = await fn();
    return { r, ms: Date.now() - t };
  };
  try {
    const { r: listed, ms } = await timed(() => rt.callTool('list_tables', {}));
    const tables = ((parse(listed)?.tables as Array<{ name: string }> | undefined) ?? []).map(
      (t) => t.name,
    );
    checks.push({
      name: 'list_tables',
      tool: 'list_tables',
      outcome: listed.isError ? 'fail' : 'pass',
      detail: listed.isError ? text(listed).slice(0, 120) : `${tables.length} tables`,
      ms,
    });
    if (listed.isError) return checks;

    for (const t of tables.slice(0, 100)) {
      const d = await timed(() => rt.callTool('describe_table', { table: t }));
      const q = await timed(() =>
        rt.callTool('query', {
          sql: `SELECT * FROM ${quoteIdent(t, rt.sourceType === 'mysql')} LIMIT 1`,
          limit: 1,
        }),
      );
      const failed = [d, q].find((x) => x.r.isError);
      checks.push({
        name: t,
        tool: 'describe + query',
        outcome: failed ? 'fail' : 'pass',
        detail: failed ? text(failed.r).slice(0, 120) : 'ok',
        ms: d.ms + q.ms,
      });
    }

    for (const tool of rt
      .listTools()
      .filter(
        (x) =>
          !['list_tables', 'describe_table', 'query'].includes(x.name) &&
          x.annotations?.readOnlyHint,
      )) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
      const args = Object.fromEntries(
        Object.entries(props).map(([k, s]) => [k, sampleFromSchema(s, k)]),
      );
      const { r, ms: qms } = await timed(() => rt.callTool(tool.name, args));
      checks.push({
        name: tool.name,
        tool: 'named query',
        outcome: r.isError ? 'fail' : 'pass',
        detail: r.isError ? text(r).slice(0, 120) : 'ok',
        ms: qms,
      });
    }

    // Safety: these must all be refused.
    const target = tables[0] ? quoteIdent(tables[0], rt.sourceType === 'mysql') : 'x';
    const attacks = [
      `DELETE FROM ${target}`,
      `COMMIT; DROP SCHEMA public CASCADE;`,
      `SELECT 1; DELETE FROM ${target}`,
      `WITH d AS (DELETE FROM ${target} RETURNING *) SELECT * FROM d`,
      ...(rt.sourceType === 'mysql'
        ? [
            // MySQL runs the contents of executable comments, and "--" needs a space to be a comment.
            `SELECT 1 /*!50000 , (SELECT COUNT(*) FROM ${target}) */`,
            `SELECT 1 --; DELETE FROM ${target}`,
          ]
        : [
            // A backslash is just a character in standard SQL strings: two statements, not one.
            `SELECT '\\'; DELETE FROM ${target}; --'`,
          ]),
      ...(rt.sourceType === 'duckdb'
        ? [
            // DuckDB reads files, installs extensions and runs SQL strings unless it is stopped.
            `SELECT * FROM read_text('/etc/hosts')`,
            `SELECT * FROM '/etc/hosts'`,
            `SELECT * FROM query('DELETE FROM ${target.replace(/'/g, "''")}')`,
            'INSTALL httpfs',
          ]
        : []),
    ];
    let refused = 0;
    for (const sql of attacks) if ((await rt.callTool('query', { sql })).isError) refused++;
    checks.push({
      name: `${attacks.length} write and injection attempts`,
      tool: 'safety',
      outcome: refused === attacks.length ? 'pass' : 'fail',
      detail:
        refused === attacks.length ? 'all refused' : `${attacks.length - refused} not refused`,
      ms: 0,
    });
  } finally {
    await rt.close();
  }
  return checks;
}

export async function testCommand(opts: TestOptions): Promise<void> {
  const loaded = withoutGuardrails(
    loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined),
  );
  const redactor = new Redactor();
  const isApi = loaded.config.source.type === 'openapi';
  if (!opts.json) {
    console.log(
      c.dim(
        isApi
          ? opts.live
            ? 'Calling every read operation against the live API (writes are never sent)...'
            : 'Calling every read operation against a local mock built from the spec (use --live for the real API)...'
          : 'Checking every table against the configured database...',
      ),
    );
  }
  const checks = isApi
    ? await testOpenApi(loaded, opts, redactor)
    : await testSql(loaded, redactor);
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const ch of checks) counts[ch.outcome]++;

  if (opts.json) {
    console.log(JSON.stringify({ checks, ...counts }, null, 2));
  } else {
    const mark = (o: Check['outcome']) =>
      o === 'pass' ? c.green('pass') : o === 'warn' ? c.yellow('warn') : c.red('FAIL');
    console.log('');
    console.log(
      table(
        ['CHECK', 'TOOL', 'RESULT', 'MS', 'DETAIL'],
        checks.map((ch) => [
          ch.name,
          ch.tool,
          mark(ch.outcome),
          String(ch.ms),
          redactor.text(ch.detail),
        ]),
      ),
    );
    console.log('');
    const line = `${n(counts.pass)} passed, ${n(counts.warn)} warnings, ${n(counts.fail)} failed`;
    console.log(counts.fail > 0 ? fail(line) : counts.warn > 0 ? warn(line) : ok(line));
  }
  if (counts.fail > 0) process.exitCode = 1;
}
