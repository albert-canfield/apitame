import type { RunRecord, SurfaceInfo } from './harness.js';
import type { Price } from './pricing.js';
import { SURFACES, SURFACE_LABELS, type SurfaceId } from './types.js';

export interface RunMeta {
  /** ISO timestamp of the start of the eval. */
  date: string;
  provider: string;
  model: string;
  estimatedUsage: boolean;
  apitameVersion: string;
  commit: string;
  command: string;
  runs: number;
  maxTurns: number;
  cache: boolean;
  price?: Price;
}

export interface SurfaceStats {
  api: string;
  surface: SurfaceId;
  tools: number | null;
  toolListTokens: number | null;
  runs: number;
  successes: number;
  /** Runs that ended in a provider or harness error (counted as failures). */
  errors: number;
  avgToolCalls: number;
  avgFailedToolCalls: number;
  /** Everything the model read: uncached input plus cache reads and writes. */
  avgPromptTokens: number;
  avgInputTokens: number;
  avgCacheReadTokens: number;
  avgCacheWriteTokens: number;
  avgOutputTokens: number;
  avgWallMs: number;
  totalCostUsd: number | null;
}

export interface TaskStats {
  api: string;
  task: string;
  kind: string;
  surfaces: Partial<Record<SurfaceId, { runs: number; successes: number }>>;
}

const avg = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function surfaceStats(records: RunRecord[], surfaces: SurfaceInfo[] = []): SurfaceStats[] {
  const out: SurfaceStats[] = [];
  const apis = [...new Set(records.map((r) => r.api))];
  for (const api of apis) {
    for (const surface of SURFACES) {
      const rs = records.filter((r) => r.api === api && r.surface === surface);
      if (rs.length === 0) continue;
      const info = surfaces.find((s) => s.api === api && s.surface === surface);
      const m = rs.map((r) => r.metrics);
      const costs = m.map((x) => x.costUsd);
      out.push({
        api,
        surface,
        tools: info ? info.tools.length : null,
        toolListTokens: info ? info.estimatedTokens : null,
        runs: rs.length,
        successes: rs.filter((r) => r.success).length,
        errors: rs.filter((r) => r.endReason === 'error').length,
        avgToolCalls: avg(m.map((x) => x.toolCalls)),
        avgFailedToolCalls: avg(m.map((x) => x.failedToolCalls)),
        avgPromptTokens: avg(m.map((x) => x.inputTokens + x.cacheReadTokens + x.cacheWriteTokens)),
        avgInputTokens: avg(m.map((x) => x.inputTokens)),
        avgCacheReadTokens: avg(m.map((x) => x.cacheReadTokens)),
        avgCacheWriteTokens: avg(m.map((x) => x.cacheWriteTokens)),
        avgOutputTokens: avg(m.map((x) => x.outputTokens)),
        avgWallMs: avg(m.map((x) => x.wallMs)),
        totalCostUsd: costs.some((c) => c === null)
          ? null
          : costs.reduce<number>((a, b) => a + (b ?? 0), 0),
      });
    }
  }
  return out;
}

export function taskStats(records: RunRecord[]): TaskStats[] {
  const out = new Map<string, TaskStats>();
  for (const r of records) {
    const key = `${r.api}\u0000${r.task}`;
    const t = out.get(key) ?? { api: r.api, task: r.task, kind: r.kind, surfaces: {} };
    const s = t.surfaces[r.surface] ?? { runs: 0, successes: 0 };
    s.runs++;
    if (r.success) s.successes++;
    t.surfaces[r.surface] = s;
    out.set(key, t);
  }
  return [...out.values()];
}

const int = (n: number) => Math.round(n).toLocaleString('en-US');
const one = (n: number) => n.toFixed(1);
const pct = (a: number, b: number) =>
  b === 0 ? 'n/a' : `${a}/${b} (${Math.round((a / b) * 100)}%)`;
const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const SHORT: Record<SurfaceId, string> = {
  curated: 'Curated',
  'per-endpoint': 'Per endpoint',
  'search-only': 'Search only',
};

/** The markdown summary: one table per API, then per-task success and failed runs. */
export function renderSummary(
  meta: RunMeta,
  records: RunRecord[],
  surfaces: SurfaceInfo[] = [],
): string {
  const lines: string[] = [];
  lines.push('# apitame tool-selection eval', '');
  lines.push('| | |', '| --- | --- |');
  lines.push(`| Date | ${meta.date.slice(0, 10)} |`);
  lines.push(`| Provider | ${meta.provider} |`);
  lines.push(`| Model | ${meta.model} |`);
  lines.push(`| apitame | ${meta.apitameVersion} (commit ${meta.commit}) |`);
  lines.push(`| Command | \`${meta.command}\` |`);
  lines.push(`| Runs per task and surface | ${meta.runs} |`);
  lines.push(`| Max turns per run | ${meta.maxTurns} |`);
  lines.push(`| Prompt caching | ${meta.cache ? 'on' : 'off'} |`, '');

  if (meta.estimatedUsage) {
    lines.push(
      'This run used the scripted fake model. It replays the minimum calls written in the task files, so it checks the harness and graders, not a model. Token counts are apitame estimates of what it was sent.',
      '',
    );
  } else {
    lines.push('Token counts come from the provider usage report.');
  }
  if (meta.price) {
    lines.push(
      `Costs are estimates from list prices: $${meta.price.input} input and $${meta.price.output} output per million tokens, cache reads $${meta.price.cacheRead.toFixed(2)}, cache writes $${meta.price.cacheWrite.toFixed(2)}. Check the bill for the real figure.`,
      '',
    );
  } else if (!meta.estimatedUsage) {
    lines.push('No list price is known for this model, so no cost estimate is shown.', '');
  }

  const stats = surfaceStats(records, surfaces);
  const tasks = taskStats(records);
  for (const api of [...new Set(records.map((r) => r.api))]) {
    lines.push(`## ${api}`, '');
    lines.push(
      '| Surface | Tools | Tool list tokens | Success | Tool calls | Failed calls | Prompt tokens | Cache reads | Output tokens | Time | Est. cost |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const s of stats.filter((x) => x.api === api)) {
      lines.push(
        `| ${SURFACE_LABELS[s.surface]} | ${s.tools ?? 'n/a'} | ${s.toolListTokens === null ? 'n/a' : `~${int(s.toolListTokens)}`} | ${pct(s.successes, s.runs)} | ${one(s.avgToolCalls)} | ${one(s.avgFailedToolCalls)} | ${int(s.avgPromptTokens)} | ${int(s.avgCacheReadTokens)} | ${int(s.avgOutputTokens)} | ${secs(s.avgWallMs)} | ${usd(s.totalCostUsd)} |`,
      );
    }
    lines.push(
      '',
      'Tool calls, tokens and time are averages per run. Prompt tokens count everything the model read, including cache reads and writes. Tool list tokens are apitame estimates for the tools/list result plus server instructions. Cost is the total for all runs on the surface.',
      '',
    );

    const present = SURFACES.filter((s) => stats.some((x) => x.api === api && x.surface === s));
    lines.push(`### ${api}: success by task`, '');
    lines.push(
      `| Task | Kind | ${present.map((s) => SHORT[s]).join(' | ')} |`,
      `| --- | --- | ${present.map(() => '---:').join(' | ')} |`,
    );
    for (const t of tasks.filter((x) => x.api === api)) {
      const cells = present.map((s) => {
        const c = t.surfaces[s];
        return c ? `${c.successes}/${c.runs}` : 'n/a';
      });
      lines.push(`| ${t.task} | ${t.kind} | ${cells.join(' | ')} |`);
    }
    lines.push('');

    const failed = records.filter((r) => r.api === api && !r.success);
    if (failed.length > 0) {
      lines.push(`### ${api}: failed runs`, '');
      for (const r of failed.slice(0, 60)) {
        const why = r.error ? `error: ${r.error}` : r.failures.join('; ');
        lines.push(`- \`${r.task}\` on ${SHORT[r.surface].toLowerCase()}, run ${r.run}: ${why}`);
      }
      if (failed.length > 60)
        lines.push(`- ... and ${failed.length - 60} more (see transcripts.jsonl)`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
