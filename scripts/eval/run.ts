/**
 * Tool-selection eval: the same tasks on three tool surfaces built from the same
 * spec and runtime. Run with `pnpm eval --help`. Development only: nothing here
 * is part of the published package.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { VERSION } from '../../src/version.js';
import { describeSurface, runOnce, type RunRecord, type SurfaceInfo } from './harness.js';
import { priceFor } from './pricing.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { FakeProvider } from './providers/fake.js';
import { renderSummary, surfaceStats, taskStats, type RunMeta } from './report.js';
import { API_IDS, loadApi, ROOT, type ApiContext, type ApiId } from './surfaces.js';
import type { Task } from './tasks.js';
import { FatalProviderError, SURFACES, type Provider, type SurfaceId } from './types.js';

const HELP = `Usage: pnpm eval [options]

Runs every task on every tool surface (curated, per-endpoint, search-only) through
a real MCP client, against apitame's mock API, and writes JSONL transcripts plus a
markdown summary. See docs/eval.md.

Options:
  --provider <name>     anthropic (default) or fake (the scripted model, no key needed)
  --model <id>          Model id, for example claude-sonnet-5 (required for anthropic)
  --api <ids>           ${API_IDS.join(', ')} or all (default: all), comma separated
  --surface <ids>       ${SURFACES.join(', ')} (default: all), comma separated
  --task <ids>          Only these task ids, comma separated
  --runs <n>            Runs per task and surface (default: 1; published results use 5)
  --concurrency <n>     Runs in parallel (default: 1)
  --max-turns <n>       Model requests per run before it counts as a failure (default: 12)
  --max-tokens <n>      max_tokens per model request (default: 16000)
  --effort <level>      output_config.effort, for models that support it (default: model default)
  --no-cache            Turn prompt caching off
  --price-input <usd>   Input price per million tokens, for a model without a known price
  --price-output <usd>  Output price per million tokens
  --out <dir>           Output folder (default: eval-results/<date>-<provider>-<model>)
  -h, --help            Show this help

The Anthropic API key is read from ANTHROPIC_API_KEY and never written anywhere.`;

class UsageError extends Error {}

function list<T extends string>(value: string | undefined, all: readonly T[], what: string): T[] {
  if (!value || value === 'all') return [...all];
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    if (!all.includes(item as T)) {
      throw new UsageError(`Unknown ${what} "${item}". Use one of: ${all.join(', ')}.`);
    }
  }
  return items as T[];
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer.`);
  return n;
}

function price(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a number of dollars.`);
  return n;
}

function gitCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

interface Job {
  api: ApiContext;
  task: Task;
  surface: SurfaceId;
  run: number;
}

function parseCommandLine() {
  try {
    return parseArgs({
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        api: { type: 'string' },
        surface: { type: 'string' },
        task: { type: 'string' },
        runs: { type: 'string' },
        concurrency: { type: 'string' },
        'max-turns': { type: 'string' },
        'max-tokens': { type: 'string' },
        effort: { type: 'string' },
        'no-cache': { type: 'boolean' },
        'price-input': { type: 'string' },
        'price-output': { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    // Unknown options and missing values: a usage error, not a crash.
    throw new UsageError(`${(err as Error).message}. See pnpm eval --help.`);
  }
}

async function main(): Promise<number> {
  const { values } = parseCommandLine();
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const apiIds = list<ApiId>(values.api, API_IDS, 'API');
  const surfaces = list<SurfaceId>(values.surface, SURFACES, 'surface');
  const runs = positive(values.runs, 1, 'runs');
  const concurrency = positive(values.concurrency, 1, 'concurrency');
  const maxTurns = positive(values['max-turns'], 12, 'max-turns');
  const maxTokens = positive(values['max-tokens'], 16_000, 'max-tokens');
  const cache = !values['no-cache'];
  const priceOverride = {
    input: price(values['price-input'], 'price-input'),
    output: price(values['price-output'], 'price-output'),
  };

  let provider: Provider;
  const providerName = values.provider ?? 'anthropic';
  if (providerName === 'fake') {
    provider = new FakeProvider(values.model ?? 'scripted');
  } else if (providerName === 'anthropic') {
    if (!values.model)
      throw new UsageError('--model is required, for example --model claude-sonnet-5.');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new UsageError(
        'Set ANTHROPIC_API_KEY to run against Claude, or use --provider fake to check the harness without a key.',
      );
    }
    provider = new AnthropicProvider(values.model, {
      apiKey,
      ...(process.env.ANTHROPIC_BASE_URL ? { baseUrl: process.env.ANTHROPIC_BASE_URL } : {}),
      maxTokens,
      ...(values.effort ? { effort: values.effort } : {}),
      cache,
    });
  } else {
    throw new UsageError(`Unknown provider "${providerName}". Use anthropic or fake.`);
  }
  const unitPrice = priceFor(provider.model, priceOverride);

  const apis: ApiContext[] = [];
  for (const id of apiIds) apis.push(await loadApi(id));
  const wanted = values.task ? new Set(values.task.split(',').map((s) => s.trim())) : undefined;
  if (wanted) {
    const known = new Set(apis.flatMap((a) => a.tasks.map((t) => t.id)));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new UsageError(`Unknown task id: ${unknown.join(', ')}.`);
  }

  // Run-major order: every task and surface gets its first run before any second run,
  // so a slow or rate-limited period does not land on one surface.
  const jobs: Job[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const api of apis) {
      for (const task of api.tasks) {
        if (wanted && !wanted.has(task.id)) continue;
        for (const surface of surfaces) jobs.push({ api, task, surface, run });
      }
    }
  }

  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(
    values.out ?? join(ROOT, 'eval-results', `${stamp}-${provider.name}-${provider.model}`),
  );
  mkdirSync(out, { recursive: true });
  const secret = process.env.ANTHROPIC_API_KEY;
  const scrub = (s: string) => (secret ? s.split(secret).join('[REDACTED]') : s);

  const surfaceInfo: SurfaceInfo[] = [];
  for (const api of apis) for (const s of surfaces) surfaceInfo.push(await describeSurface(api, s));
  writeFileSync(join(out, 'surfaces.json'), scrub(`${JSON.stringify(surfaceInfo, null, 2)}\n`));

  const meta: RunMeta = {
    date: started.toISOString(),
    provider: provider.name,
    model: provider.model,
    estimatedUsage: provider.estimatedUsage,
    apitameVersion: VERSION,
    commit: gitCommit(),
    command: `pnpm eval ${process.argv.slice(2).join(' ')}`.trim(),
    runs,
    maxTurns,
    cache,
    ...(unitPrice ? { price: unitPrice } : {}),
  };
  writeFileSync(join(out, 'meta.json'), scrub(`${JSON.stringify(meta, null, 2)}\n`));

  console.log(
    `Running ${jobs.length} runs (${provider.name} ${provider.model}) into ${relative(process.cwd(), out) || '.'}`,
  );
  const transcripts = join(out, 'transcripts.jsonl');
  writeFileSync(transcripts, '');
  const records: RunRecord[] = [];
  let next = 0;
  let fatal: Error | undefined;
  const width = String(jobs.length).length;

  const worker = async () => {
    while (!fatal && next < jobs.length) {
      const job = jobs[next++]!;
      try {
        const rec = await runOnce({
          api: job.api,
          surface: job.surface,
          task: job.task,
          provider,
          run: job.run,
          maxTurns,
          ...(unitPrice ? { price: unitPrice } : {}),
        });
        records.push(rec);
        appendFileSync(transcripts, `${scrub(JSON.stringify(rec))}\n`);
        const status = rec.success
          ? 'pass'
          : `FAIL (${rec.error ?? rec.failures[0] ?? rec.endReason})`;
        console.log(
          scrub(
            `[${String(records.length).padStart(width)}/${jobs.length}] ${job.api.id} ${job.surface} ${job.task.id} run ${job.run}: ${status}, ${rec.metrics.toolCalls} calls, ${(rec.metrics.wallMs / 1000).toFixed(1)} s`,
          ),
        );
      } catch (err) {
        if (err instanceof FatalProviderError) fatal = err;
        else throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const order = new Map(jobs.map((j, i) => [`${j.api.id}/${j.task.id}/${j.surface}/${j.run}`, i]));
  records.sort(
    (a, b) =>
      (order.get(`${a.api}/${a.task}/${a.surface}/${a.run}`) ?? 0) -
      (order.get(`${b.api}/${b.task}/${b.surface}/${b.run}`) ?? 0),
  );
  const summary = renderSummary(meta, records, surfaceInfo);
  writeFileSync(join(out, 'summary.md'), scrub(summary));
  writeFileSync(
    join(out, 'summary.json'),
    scrub(
      `${JSON.stringify({ meta, surfaces: surfaceStats(records, surfaceInfo), tasks: taskStats(records) }, null, 2)}\n`,
    ),
  );

  console.log(`\n${scrub(summary)}`);
  console.log(
    `Wrote ${['summary.md', 'summary.json', 'transcripts.jsonl', 'surfaces.json', 'meta.json'].join(', ')} to ${out}`,
  );
  if (fatal) {
    console.error(scrub(`\nStopped early: ${fatal.message}`));
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const secret = process.env.ANTHROPIC_API_KEY;
    const message = err instanceof Error ? err.message : String(err);
    console.error(secret ? message.split(secret).join('[REDACTED]') : message);
    if (!(err instanceof UsageError) && err instanceof Error && err.stack && !secret) {
      console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
    process.exitCode = err instanceof UsageError ? 2 : 1;
  },
);
