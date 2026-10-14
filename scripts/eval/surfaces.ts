import { join, resolve } from 'node:path';
import { loadConfig, parseConfig } from '../../src/config/load.js';
import { ENV_REF, type Config } from '../../src/config/schema.js';
import { createOpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { toToolName } from '../../src/sources/openapi/grouping.js';
import { loadSpec, type LoadedSpec } from '../../src/sources/openapi/load.js';
import type { Operation } from '../../src/sources/openapi/operations.js';
import { checkTaskOperations, loadTaskFile, type Task } from './tasks.js';
import type { SurfaceId } from './types.js';

export const ROOT = resolve(import.meta.dirname, '../..');

/** APIs with a task file. Each one uses the committed example config as its curated surface. */
export const APIS = {
  petstore: { example: 'examples/petstore', tasks: 'scripts/eval/tasks/petstore.yaml' },
  'github-subset': {
    example: 'examples/github-subset',
    tasks: 'scripts/eval/tasks/github-subset.yaml',
  },
} as const;
export type ApiId = keyof typeof APIS;
export const API_IDS = Object.keys(APIS) as ApiId[];

export interface ApiContext {
  id: ApiId;
  /** The example's committed config: the curated surface. */
  config: Config;
  configDir: string;
  spec: LoadedSpec;
  operations: Operation[];
  writeOperations: ReadonlySet<string>;
  /** Placeholder values for every ${VAR} in the config, so auth resolves. The mock ignores them. */
  env: Record<string, string>;
  tasks: Task[];
}

function placeholderEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  const all = new RegExp(ENV_REF.source, 'g');
  for (const m of JSON.stringify(config).matchAll(all)) {
    env[m[1]!] = `eval-placeholder-${m[1]!.toLowerCase()}`;
  }
  return env;
}

export async function loadApi(id: ApiId): Promise<ApiContext> {
  const def = APIS[id];
  const { config, dir } = loadConfig(join(ROOT, def.example, 'apitame.config.yaml'));
  if (config.source.type !== 'openapi') throw new Error(`${id}: the eval needs an OpenAPI example`);
  const spec = await loadSpec(config.source.spec, dir);
  const env = placeholderEnv(config);
  // The runtime classifies operations with the config's own rules (treatAsRead, destructive).
  const rt = await createOpenApiRuntime({ config, configDir: dir, spec, env });
  const operations = rt.operations;
  const { tasks } = loadTaskFile(join(ROOT, def.tasks));
  const problems = checkTaskOperations(tasks, operations);
  if (problems.length > 0) throw new Error(`Task file for ${id}:\n  ${problems.join('\n  ')}`);
  return {
    id,
    config,
    configDir: dir,
    spec,
    operations,
    writeOperations: new Set(operations.filter((o) => o.access !== 'read').map((o) => o.id)),
    env,
    tasks,
  };
}

/**
 * The config for a surface. Everything except `tools` and `longTail` is the
 * example's own config, so mode, allowlist, limits, validation and error
 * messages are identical across surfaces.
 */
export function surfaceConfig(api: ApiContext, surface: SurfaceId): Config {
  switch (surface) {
    case 'curated':
      return api.config;
    case 'per-endpoint': {
      // One group per operation. In read-only mode the runtime drops groups whose only
      // operation is a write, exactly as it does for the curated groups.
      const used = new Set(['search_operations', 'call_operation']);
      const tools = api.operations.map((op) => {
        const base = toToolName(op.id);
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base.slice(0, 44)}_${n}`;
        used.add(name);
        const description = op.description && op.description !== op.summary ? op.description : '';
        return { name, description, operations: [op.id] };
      });
      return parseConfig(
        { ...api.config, tools, longTail: { enabled: false } },
        `${api.id} per-endpoint config`,
      );
    }
    case 'search-only':
      return parseConfig(
        { ...api.config, tools: [], longTail: { enabled: true } },
        `${api.id} search-only config`,
      );
  }
}
