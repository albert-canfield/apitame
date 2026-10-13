import { resolve } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { Logger } from '../../log.js';
import { decide } from '../../safety/policy.js';
import { Redactor } from '../../safety/redact.js';
import type { OpenApiRuntime } from '../../server/openapi-runtime.js';
import { createRuntime } from '../../server/runtime.js';
import { loadSkills } from '../../server/skills.js';
import type { SqlRuntime } from '../../server/sql-runtime.js';
import { toolListCost } from '../../tokens/estimate.js';
import { accessLabel, c, fail, n, ok, table, warn } from '../ui.js';

export interface InspectOptions {
  config?: string;
  json?: boolean;
  verbose?: boolean;
  maxTokens?: string;
}

export async function inspectCommand(opts: InspectOptions): Promise<void> {
  const loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  const redactor = new Redactor();
  // Missing credentials do not matter for inspection.
  const runtime = await createRuntime(loaded, { redactor, logger: new Logger(redactor, 'silent') });
  try {
    const tools = runtime.listTools();
    const summaries = runtime.summarizeTools();
    const cost = toolListCost(tools, runtime.instructions());
    const skills = loadSkills(resolve(loaded.dir, loaded.config.skills.dir));

    let naive: ReturnType<typeof toolListCost> | undefined;
    let searchOnly: ReturnType<typeof toolListCost> | undefined;
    const blocked: Array<{ id: string; access: string; reason: string }> = [];
    let operationCount = 0;
    if (runtime.sourceType === 'openapi') {
      const rt = runtime as OpenApiRuntime;
      operationCount = rt.operations.length;
      naive = toolListCost(rt.naiveTools());
      searchOnly = toolListCost(
        tools.filter((t) => t.name === 'search_operations' || t.name === 'call_operation'),
      );
      for (const op of rt.operations) {
        const d = decide(op.id, op.access, { mode: rt.config.mode, writes: rt.config.writes });
        if (!d.allowed) blocked.push({ id: op.id, access: op.access, reason: d.reason });
        else if (op.unsupported)
          blocked.push({ id: op.id, access: op.access, reason: op.unsupported });
      }
    } else {
      for (const b of (runtime as SqlRuntime).blockedQueries())
        blocked.push({ id: b.name, access: 'write', reason: b.reason });
    }
    const budget = opts.maxTokens ? Number(opts.maxTokens) : undefined;
    const overBudget = budget !== undefined && cost.total > budget;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            name: runtime.name,
            source: runtime.sourceType,
            mode: runtime.mode,
            tools: summaries.map((s) => ({
              ...s,
              tokens: cost.tools.find((t) => t.name === s.name)?.tokens ?? 0,
            })),
            tokens: {
              total: cost.total,
              instructions: cost.instructions,
              ...(naive ? { onePerEndpoint: naive.total } : {}),
              ...(searchOnly ? { searchOnly: searchOnly.total } : {}),
              estimate: true,
            },
            operations: operationCount,
            blocked,
            skills: skills.map((s) => s.name),
            warnings: runtime.warnings,
            ...(budget !== undefined ? { budget, overBudget } : {}),
          },
          null,
          2,
        ),
      );
      if (overBudget) process.exitCode = 1;
      return;
    }

    const src = loaded.config.source;
    const where = src.type === 'openapi' ? src.spec : src.type === 'sqlite' ? src.path : src.url;
    console.log(
      `${c.bold(runtime.name)}  ${c.dim(`${runtime.sourceType} · ${runtime.mode} · ${redactor.text(where)}`)}`,
    );
    console.log('');
    const rows = summaries.map((s) => [
      s.name,
      s.kind === 'search' ? '-' : s.kind === 'call' ? 'any' : String(s.operations.length || '-'),
      accessLabel(s.access),
      n(cost.tools.find((t) => t.name === s.name)?.tokens ?? 0),
    ]);
    console.log(table(['TOOL', 'OPS', 'ACCESS', 'TOKENS'], rows));
    console.log('');
    console.log(
      `${c.bold(`${tools.length} tools, ~${n(cost.total)} tokens`)} ${c.dim(`(includes ${n(cost.instructions)} for server instructions; estimate)`)}`,
    );
    if (naive && operationCount > 0) {
      const saved = Math.round((1 - cost.total / naive.total) * 100);
      console.log(
        c.dim(
          `  one tool per endpoint (${n(operationCount)} tools): ~${n(naive.total)} tokens${saved > 0 ? `, apitame saves ${saved}%` : ''}`,
        ),
      );
      if (searchOnly && searchOnly.total > 0)
        console.log(
          c.dim(
            `  search + call only: ~${n(searchOnly.total)} tokens (smallest, but every task needs extra round trips)`,
          ),
        );
    }

    if (opts.verbose && runtime.sourceType === 'openapi') {
      const rt = runtime as OpenApiRuntime;
      for (const s of summaries.filter((x) => x.kind === 'group' || x.kind === 'operation')) {
        console.log('');
        console.log(c.bold(s.name));
        for (const id of s.operations) {
          const op = rt.byId.get(id)!;
          console.log(
            `  ${id.padEnd(32)} ${op.method.toUpperCase().padEnd(6)} ${op.path} ${op.access === 'read' ? '' : accessLabel(op.access)}`,
          );
        }
      }
    }

    if (blocked.length > 0) {
      console.log('');
      const label = runtime.mode === 'read-only' ? 'blocked by read-only mode' : 'not exposed';
      console.log(
        warn(
          `${blocked.length} operation${blocked.length === 1 ? '' : 's'} ${label}: ${blocked
            .slice(0, 8)
            .map((b) => b.id)
            .join(', ')}${blocked.length > 8 ? ', ...' : ''}`,
        ),
      );
    }
    if (skills.length > 0) console.log(ok(`Skills: ${skills.map((s) => s.name).join(', ')}`));
    for (const w of runtime.warnings) console.log(warn(w));
    if (budget !== undefined) {
      console.log(
        overBudget
          ? fail(`Over budget: ${n(cost.total)} > ${n(budget)} tokens`)
          : ok(`Within budget: ${n(cost.total)} <= ${n(budget)} tokens`),
      );
      if (overBudget) process.exitCode = 1;
    }
  } finally {
    await runtime.close();
  }
}
