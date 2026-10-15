import { InvalidArgumentError } from 'commander';
import { loadConfig } from '../../config/load.js';
import {
  countFindings,
  diffSpecs,
  FAIL_ON_VALUES,
  type DiffCategory,
  type NewWrite,
  type OperationRef,
  type SpecDiff,
} from '../../diff/compare.js';
import { Redactor } from '../../safety/redact.js';
import { loadSpec } from '../../sources/openapi/load.js';
import { c, fail, n, ok, table, warn } from '../ui.js';

export interface DiffOptions {
  config?: string;
  json?: boolean;
  failOn?: DiffCategory[];
}

/** What each `--fail-on` category counts, for the report. */
const FOUND: Record<DiffCategory, string> = {
  'new-writes': 'new writes the config allows without naming them',
  'access-changes': 'access level changes',
  added: 'operations added',
  removed: 'operations removed',
  renamed: 'operations renamed',
  'stale-config': 'config references that match nothing now',
  'write-changes': 'allowed writes with changed arguments',
  'base-url': 'base URL changes',
  any: 'findings in all categories',
};

/** `--fail-on`: categories separated by commas; the option can be repeated. */
export function parseFailOn(value: string, previous: DiffCategory[] = []): DiffCategory[] {
  const out = [...previous];
  const values = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0)
    throw new InvalidArgumentError(`Name a category: ${FAIL_ON_VALUES.join(', ')}.`);
  for (const v of values) {
    if (!(FAIL_ON_VALUES as string[]).includes(v))
      throw new InvalidArgumentError(
        `Unknown category "${v}". Use ${FAIL_ON_VALUES.join(', ')}, separated by commas (spec files go before --fail-on).`,
      );
    if (!out.includes(v as DiffCategory)) out.push(v as DiffCategory);
  }
  return out;
}

export async function diffCommand(
  oldSpec: string,
  newSpec: string | undefined,
  opts: DiffOptions,
): Promise<void> {
  const loaded = loadConfig(opts.config ?? process.env.APITAME_CONFIG ?? undefined);
  const { config } = loaded;
  if (config.source.type !== 'openapi')
    throw new Error(
      `apitame diff compares OpenAPI specs; this config's source is ${config.source.type}.`,
    );
  const before = await loadSpec(oldSpec, process.cwd());
  const after = newSpec
    ? await loadSpec(newSpec, process.cwd())
    : await loadSpec(config.source.spec, loaded.dir);
  const diff = diffSpecs(config, before, after, loaded.dir);

  const redactor = new Redactor();
  const labels = {
    before: redactor.text(oldSpec),
    after: redactor.text(newSpec ?? config.source.spec),
  };
  const failOn = opts.failOn ?? [];
  const failed = failOn.filter((cat) => countFindings(diff, cat) > 0);
  if (failed.length > 0) process.exitCode = 1;

  if (opts.json) {
    const { operations, tokens, baseUrl, ...findings } = diff;
    console.log(
      JSON.stringify(
        {
          name: config.name,
          mode: config.mode,
          before: { spec: labels.before, operations: operations.before },
          after: { spec: labels.after, operations: operations.after },
          ...findings,
          baseUrl: baseUrl && redactor.value(baseUrl),
          tokens: { ...tokens, estimate: true },
          failOn,
          failed,
        },
        null,
        2,
      ),
    );
    return;
  }
  printReport(diff, config.name, config.mode, labels, redactor);
  if (failOn.length > 0) {
    console.log('');
    for (const cat of failOn) {
      const count = countFindings(diff, cat);
      if (count > 0) console.log(fail(`--fail-on ${cat}: ${count} found (${FOUND[cat]})`));
    }
    if (failed.length === 0) console.log(ok(`--fail-on ${failOn.join(',')}: nothing found`));
  }
}

const endpoint = (r: OperationRef) => `${r.method} ${r.path}`;

/** Where the agent finds an operation, or why it cannot call it. */
function reach(r: OperationRef): string {
  if (r.blocked) return `blocked: ${r.blocked}`;
  return `${r.tools.join(', ')}${r.confirm ? ' (asks for approval)' : ''}`;
}

function allowedBy(w: NewWrite): string {
  return w.via === 'x-apitame-access'
    ? 'x-apitame-access: read (spec)'
    : `${w.via} ${w.allowedBy.join(', ')}`;
}

function why(w: NewWrite): string {
  if (w.why === 'added') return 'added';
  if (w.why === 'renamed') return `renamed from ${w.before?.id ?? '?'}`;
  return w.before?.access === 'read' ? 'was a read' : 'could not be called before';
}

const indent = (text: string, by = '  ') =>
  text
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');

function printReport(
  diff: SpecDiff,
  name: string,
  mode: string,
  labels: { before: string; after: string },
  redactor: Redactor,
): void {
  const heading = (title: string, count: number, flagged: boolean) => {
    console.log('');
    const text = c.bold(`${title} (${count})`);
    console.log(flagged ? warn(text) : text);
  };

  console.log(`${c.bold(name)}  ${c.dim(`${mode} · ${labels.before} -> ${labels.after}`)}`);
  const ops = diff.operations;
  const counts = [
    diff.added.length ? `${n(diff.added.length)} added` : '',
    diff.removed.length ? `${n(diff.removed.length)} removed` : '',
    diff.renamed.length ? `${n(diff.renamed.length)} renamed` : '',
  ].filter(Boolean);
  console.log(
    `Operations: ${n(ops.before)} -> ${n(ops.after)}${counts.length ? ` (${counts.join(', ')})` : ''}`,
  );

  if (diff.added.length > 0) {
    heading('Added', diff.added.length, false);
    console.log(
      indent(
        table(
          ['OPERATION', 'ACCESS', 'ENDPOINT', 'AGENT'],
          diff.added.map((r) => [r.id, r.access, endpoint(r), reach(r)]),
        ),
      ),
    );
  }
  if (diff.removed.length > 0) {
    heading('Removed', diff.removed.length, false);
    console.log(
      indent(
        table(
          ['OPERATION', 'ACCESS', 'ENDPOINT', 'WAS IN'],
          diff.removed.map((r) => [r.id, r.access, endpoint(r), reach(r)]),
        ),
      ),
    );
  }
  if (diff.renamed.length > 0) {
    heading('Renamed', diff.renamed.length, false);
    console.log(
      indent(
        table(
          ['BEFORE', 'AFTER', 'ENDPOINT', 'AGENT'],
          diff.renamed.map((r) => [
            r.before.id,
            r.after.id,
            r.kind === 'id' ? endpoint(r.after) : `${endpoint(r.before)} -> ${endpoint(r.after)}`,
            reach(r.after),
          ]),
        ),
      ),
    );
  }
  if (diff.accessChanges.length > 0) {
    heading('Access level changes', diff.accessChanges.length, true);
    console.log(
      indent(
        table(
          ['OPERATION', 'ENDPOINT', 'ACCESS', 'AGENT'],
          diff.accessChanges.map((a) => [
            a.before.id === a.after.id ? a.after.id : `${a.before.id} -> ${a.after.id}`,
            endpoint(a.after),
            `${a.before.access} -> ${a.after.access}`,
            `${reach(a.before)} -> ${reach(a.after)}`,
          ]),
        ),
      ),
    );
  }
  if (diff.newWrites.length > 0) {
    heading('New writes that the config allows without naming them', diff.newWrites.length, true);
    console.log(
      indent(
        table(
          ['OPERATION', 'ACCESS', 'ALLOWED BY', 'AGENT', 'WHY'],
          diff.newWrites.map((w) => [w.id, w.access, allowedBy(w), reach(w), why(w)]),
        ),
      ),
    );
  }
  if (diff.staleConfig.length > 0) {
    heading('Config references that match no operation now', diff.staleConfig.length, true);
    console.log(
      indent(
        table(
          ['WHERE', 'REFERENCE', 'MATCHED BEFORE', 'NOW'],
          diff.staleConfig.map((s) => [
            s.where,
            s.ref,
            s.matched.length > 3
              ? `${s.matched.slice(0, 3).join(', ')}, ...`
              : s.matched.join(', '),
            s.renamedTo.length > 0 ? `renamed to ${s.renamedTo.join(', ')}` : 'removed',
          ]),
        ),
      ),
    );
  }
  if (diff.writeChanges.length > 0) {
    heading('Argument changes on allowed writes', diff.writeChanges.length, true);
    for (const w of diff.writeChanges) {
      console.log(`  ${w.id} ${c.dim(`(${endpoint(w)}, ${reach(w)})`)}`);
      if (w.added.length > 0)
        console.log(
          `    added: ${w.added.map((a) => `${a.path}${a.required ? ' (required)' : ''}`).join(', ')}`,
        );
      if (w.nowRequired.length > 0) console.log(`    now required: ${w.nowRequired.join(', ')}`);
      if (w.removed.length > 0) console.log(`    removed: ${w.removed.join(', ')}`);
      for (const r of w.rules) console.log(`    ${warn(r)}`);
    }
  }
  if (diff.baseUrl) {
    console.log('');
    const { before, after } = redactor.value(diff.baseUrl);
    console.log(warn(`Base URL: ${before ?? '(none)'} -> ${after ?? '(none)'}`));
  }

  const findings = countFindings(diff, 'any');
  if (findings === 0) {
    console.log('');
    console.log(
      ok('No changes to operations, access levels, allowed writes or config references.'),
    );
  }

  const t = diff.tokens;
  const delta = t.after - t.before;
  console.log('');
  console.log(
    `Tool list: ~${n(t.before)} -> ~${n(t.after)} tokens ${c.dim(`(${delta >= 0 ? '+' : ''}${n(delta)}; estimate)`)}`,
  );
  if (t.tools.length > 0) {
    const cell = (v: number | null) => (v === null ? '-' : n(v));
    console.log(
      indent(
        table(
          ['TOOL', 'BEFORE', 'AFTER'],
          t.tools.map((x) => [x.name, cell(x.before), cell(x.after)]),
        ),
      ),
    );
  }
  if (mode === 'read-only' && findings > 0)
    console.log(c.dim('Read-only mode: every write stays blocked, whatever the spec adds.'));
}
