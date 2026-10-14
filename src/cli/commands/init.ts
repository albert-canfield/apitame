import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_CONFIG_FILE,
  loadConfig,
  parseConfig,
  type LoadedConfig,
} from '../../config/load.js';
import {
  renderOpenApiConfig,
  renderSqlConfig,
  slugify,
  suggestAuth,
} from '../../generator/config.js';
import {
  generateOpenApiSkill,
  generateSqlSkill,
  type GeneratedFile,
} from '../../generator/skills.js';
import { Redactor } from '../../safety/redact.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../server/openapi-runtime.js';
import { createRuntime } from '../../server/runtime.js';
import type { SqlRuntime } from '../../server/sql-runtime.js';
import { groupOperations } from '../../sources/openapi/grouping.js';
import { discoverSpecUrl, isUrl, loadSpec, resolveBaseUrl } from '../../sources/openapi/load.js';
import { extractOperations } from '../../sources/openapi/operations.js';
import type { TableDetail } from '../../sources/sql/driver.js';
import { toolListCost } from '../../tokens/estimate.js';
import { databaseName, detectSource } from '../detect.js';
import { c, n, ok, warn } from '../ui.js';

export interface InitOptions {
  out?: string;
  name?: string;
  baseUrl?: string;
  maxTools?: string;
  envVar?: string;
  schema?: string[];
  force?: boolean;
  skillsOnly?: boolean;
  config?: string;
}

const MAX_DESCRIBED_TABLES = 40;

function writeFiles(root: string, files: GeneratedFile[]): string[] {
  const written: string[] = [];
  for (const f of files) {
    const target = join(root, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    written.push(target);
  }
  return written;
}

function rel(from: string, to: string): string {
  const r = relative(from, to) || '.';
  return r.startsWith('.') ? r : `./${r}`;
}

function ensureEnvExample(dir: string, vars: string[]): void {
  if (vars.length === 0) return;
  const file = join(dir, '.env.example');
  const current = existsSync(file)
    ? readFileSync(file, 'utf8')
    : '# Environment variables used by apitame. Copy to .env and fill in. Never commit .env.\n';
  const missing = vars.filter((v) => !new RegExp(`^#?\\s*${v}=`, 'm').test(current));
  if (missing.length === 0 && existsSync(file)) return;
  writeFileSync(file, current + missing.map((v) => `${v}=\n`).join(''));
}

async function skillsFor(runtime: OpenApiRuntime | SqlRuntime): Promise<GeneratedFile[]> {
  if (runtime.sourceType === 'openapi') return generateOpenApiSkill(runtime as OpenApiRuntime);
  const sql = runtime as SqlRuntime;
  const tables = await sql.tables();
  const details: TableDetail[] = [];
  for (const t of tables.slice(0, MAX_DESCRIBED_TABLES)) {
    const d = await sql.driver.describeTable(t.schema, t.name);
    if (d) details.push({ ...d, rowEstimate: t.rowEstimate ?? null });
  }
  return generateSqlSkill({
    name: sql.name,
    engine: sql.sourceType,
    description: sql.config.description,
    tables,
    details,
    namedQueries: sql
      .listTools()
      .filter((t) => !['list_tables', 'describe_table', 'query'].includes(t.name))
      .map((t) => ({ name: t.name, description: t.description })),
    rowLimit: sql.config.limits.rowLimit,
  });
}

/** `apitame init --skills-only`: regenerate skills from an existing config. */
async function regenerateSkills(loaded: LoadedConfig): Promise<void> {
  const runtime = await createRuntime(loaded);
  try {
    const files = await skillsFor(runtime);
    const dir = resolve(loaded.dir, loaded.config.skills.dir);
    writeFiles(dir, files);
    console.log(ok(`Regenerated ${files.length} skill files in ${rel(process.cwd(), dir)}`));
  } finally {
    await runtime.close();
  }
}

export async function initCommand(source: string | undefined, opts: InitOptions): Promise<void> {
  const outDir = resolve(opts.out ?? '.');
  const configPath = join(outDir, DEFAULT_CONFIG_FILE);

  if (opts.skillsOnly) {
    await regenerateSkills(loadConfig(opts.config ?? configPath));
    return;
  }
  if (!source)
    throw new Error('Pass a source: an OpenAPI file or URL, a postgres:// URL, or a SQLite file.');
  const detected = detectSource(source);
  if (existsSync(configPath) && !opts.force) {
    throw new Error(
      `${rel(process.cwd(), configPath)} already exists. Use --force to overwrite it, or --out <dir>.`,
    );
  }
  mkdirSync(outDir, { recursive: true });

  if (detected.kind === 'openapi') await initOpenApi(detected.location, outDir, configPath, opts);
  else await initSql(detected, outDir, configPath, opts);
}

async function initOpenApi(
  location: string,
  outDir: string,
  configPath: string,
  opts: InitOptions,
): Promise<void> {
  const specLocation = isUrl(location) ? await discoverSpecUrl(location) : location;
  if (specLocation !== location) console.log(ok(`Found the OpenAPI document at ${specLocation}`));
  const spec = await loadSpec(specLocation);
  if (spec.convertedFrom) {
    console.log(
      ok(`Converted ${spec.convertedFrom} to OpenAPI 3 in memory (the file is not changed)`),
    );
  }
  const title = spec.doc.info?.title ?? basename(location);
  const name = opts.name
    ? slugify(opts.name)
    : slugify(title.replace(/\b(api|openapi|swagger|spec|v?\d+(\.\d+)*)\b/gi, ''), 'api');
  const maxTools = opts.maxTools ? Number(opts.maxTools) : 12;
  if (!Number.isInteger(maxTools) || maxTools < 1)
    throw new Error('--max-tools must be a positive integer.');

  const ops = extractOperations(spec.doc);
  if (ops.length === 0) throw new Error('The spec has no operations under "paths".');
  const grouping = groupOperations(spec.doc, ops, {
    maxTools,
    maxOperationsPerTool: 15,
    longTail: true,
  });
  const auth = suggestAuth(spec.doc, name);

  const resolvedBase = resolveBaseUrl(spec.doc, spec.location, opts.baseUrl);
  const specServer = spec.doc.servers?.[0]?.url ?? '';
  // Store baseUrl only when it is not obvious from the spec (override, or a relative server resolved against the spec URL).
  const storeBase =
    opts.baseUrl ?? (resolvedBase && !/^https?:\/\//i.test(specServer) ? resolvedBase : undefined);

  const yaml = renderOpenApiConfig({
    name,
    description:
      (spec.doc.info?.description ?? '')
        .split(/\n\s*\n/)[0]
        ?.trim()
        .slice(0, 300) ?? '',
    spec: spec.isUrl ? spec.location : rel(outDir, spec.location),
    ...(storeBase ? { baseUrl: storeBase } : {}),
    groups: grouping.groups,
    ops,
    auth,
    maxTools,
    maxOperationsPerTool: 15,
    generatedFrom: spec.isUrl ? spec.location : basename(spec.location),
  });
  writeFileSync(configPath, yaml);
  ensureEnvExample(outDir, auth.env);

  const config = parseConfig(parseYaml(yaml), configPath);
  const runtime = await createOpenApiRuntime({
    config,
    configDir: outDir,
    spec,
    env: {
      ...process.env,
      ...Object.fromEntries(auth.env.map((v) => [v, process.env[v] ?? 'placeholder'])),
    },
  });
  const files = generateOpenApiSkill(runtime);
  const skillsDir = resolve(outDir, config.skills.dir);
  writeFiles(skillsDir, files);

  const reads = ops.filter((o) => o.access === 'read').length;
  const writes = ops.length - reads;
  const curated = toolListCost(runtime.listTools(), runtime.instructions());
  const naive = toolListCost(runtime.naiveTools());
  const tools = runtime.summarizeTools();

  console.log('');
  console.log(
    ok(`Read ${c.bold(title)}: ${n(ops.length)} operations (${n(reads)} read, ${n(writes)} write)`),
  );
  console.log(
    ok(
      `Grouped into ${c.bold(String(tools.length))} tools: ${tools.map((t) => t.name).join(', ')}`,
    ),
  );
  if (grouping.longTail.length > 0) {
    const tail = grouping.longTail.length;
    console.log(
      ok(
        `${n(tail)} more operation${tail === 1 ? '' : 's'} reachable through search_operations + call_operation`,
      ),
    );
  }
  console.log(ok(`Read-only mode: ${n(writes)} write operations blocked until you allow them`));
  const saved = naive.total > 0 ? Math.round((1 - curated.total / naive.total) * 100) : 0;
  console.log(
    ok(
      `Tool list costs ~${n(curated.total)} tokens ${c.dim(`(one tool per endpoint: ~${n(naive.total)}${saved > 0 ? `, ${saved}% saved` : ''})`)}`,
    ),
  );
  console.log(
    ok(
      `Wrote ${rel(process.cwd(), configPath)} and ${files.length} skill files in ${rel(process.cwd(), skillsDir)}`,
    ),
  );
  if (!resolvedBase)
    console.log(
      warn(
        'The spec has no absolute server URL. Set source.baseUrl in the config (or pass --base-url).',
      ),
    );
  const unset = auth.env.filter((v) => !process.env[v]);
  if (unset.length > 0)
    console.log(
      warn(
        `Set ${unset.join(', ')} in your environment or in ${rel(process.cwd(), join(outDir, '.env'))}`,
      ),
    );
  if (auth.note) console.log(warn(auth.note));
  for (const w of runtime.warnings.filter((x) => !/Missing environment variable/.test(x)))
    console.log(warn(w));
  printNext(outDir);
}

async function initSql(
  detected: { kind: 'postgres'; url: string; fromEnv?: string } | { kind: 'sqlite'; file: string },
  outDir: string,
  configPath: string,
  opts: InitOptions,
): Promise<void> {
  const redactor = new Redactor();
  let yaml: string;
  let driverLabel: string;

  if (detected.kind === 'postgres') {
    const envVar = opts.envVar ?? detected.fromEnv ?? 'DATABASE_URL';
    const name = opts.name ? slugify(opts.name) : slugify(databaseName(detected.url), 'db');
    const schemas = opts.schema && opts.schema.length > 0 ? opts.schema : ['public'];
    redactor.addSecret(detected.url);
    yaml = renderSqlConfig({
      name,
      description: '',
      type: 'postgres',
      target: `\${${envVar}}`,
      schemas,
      generatedFrom: `the PostgreSQL database "${databaseName(detected.url)}"`,
    });
    driverLabel = 'PostgreSQL';
    if (!detected.fromEnv) {
      // The connection string goes to .env (never into the config file).
      const envFile = join(outDir, '.env');
      const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      if (!new RegExp(`^${envVar}=`, 'm').test(current)) {
        appendFileSync(
          envFile,
          `${current && !current.endsWith('\n') ? '\n' : ''}${envVar}=${detected.url}\n`,
        );
        console.log(
          ok(
            `Saved the connection string to ${rel(process.cwd(), envFile)} as ${envVar} ${c.dim('(keep .env out of git)')}`,
          ),
        );
      }
      process.env[envVar] ??= detected.url;
    }
    ensureEnvExample(outDir, [envVar]);
  } else {
    const name = opts.name
      ? slugify(opts.name)
      : slugify(basename(detected.file).replace(/\.[^.]+$/, ''), 'db');
    yaml = renderSqlConfig({
      name,
      description: '',
      type: 'sqlite',
      target: rel(outDir, detected.file),
      generatedFrom: basename(detected.file),
    });
    driverLabel = 'SQLite';
  }

  writeFileSync(configPath, yaml);
  const loaded = loadConfig(configPath);
  const runtime = (await createRuntime(loaded, { redactor })) as SqlRuntime;
  try {
    const files = await skillsFor(runtime);
    const tables = await runtime.tables();
    const skillsDir = resolve(outDir, loaded.config.skills.dir);
    writeFiles(skillsDir, files);
    const cost = toolListCost(runtime.listTools(), runtime.instructions());
    console.log('');
    console.log(ok(`Connected to ${driverLabel}: ${n(tables.length)} tables and views`));
    console.log(
      ok(
        'Tools: list_tables, describe_table, query (single SELECT, read-only transaction, row limit, timeout)',
      ),
    );
    console.log(ok(`Tool list costs ~${n(cost.total)} tokens`));
    console.log(
      ok(
        `Wrote ${rel(process.cwd(), configPath)} and ${files.length} skill files in ${rel(process.cwd(), skillsDir)}`,
      ),
    );
    if (detected.kind === 'postgres') {
      console.log(
        warn(
          'Use a read-only database role for the connection. See docs/sql.md in the apitame repository for a two-line setup.',
        ),
      );
    }
  } catch (err) {
    // The original error is not attached as `cause`: it may hold the connection string.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redactor.text((err as Error).message));
  } finally {
    await runtime.close();
  }
  printNext(outDir);
}

function printNext(outDir: string): void {
  const cfg = rel(process.cwd(), join(outDir, DEFAULT_CONFIG_FILE));
  const flag = cfg === `./${DEFAULT_CONFIG_FILE}` ? '' : ` --config ${cfg}`;
  console.log('');
  console.log(c.bold('Next:'));
  const steps: Array<[string, string]> = [
    [`npx apitame inspect${flag}`, 'tools, modes and token cost'],
    [`npx apitame test${flag}`, 'check every read tool and the safety rules'],
    [`npx apitame add-to claude-code${flag}`, 'or codex, cursor, vscode'],
    [`npx apitame serve${flag}`, 'run the MCP server (stdio)'],
  ];
  const width = Math.max(...steps.map(([cmd]) => cmd.length));
  for (const [cmd, note] of steps) console.log(`  ${cmd.padEnd(width)}  ${c.dim(`# ${note}`)}`);
}
