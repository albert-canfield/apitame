import type { ToolGroupConfig } from '../../config/schema.js';
import type { OpenApiDocument } from './load.js';
import { operationTitle, type Operation } from './operations.js';
import { truncate } from './schema.js';

export interface GroupingOptions {
  /** Max tools in total, including search_operations and call_operation. */
  maxTools: number;
  maxOperationsPerTool: number;
  longTail: boolean;
}

export interface GroupingResult {
  groups: ToolGroupConfig[];
  /** Operations not placed in any group: reachable through call_operation only. */
  longTail: string[];
}

const SKIP_SEGMENTS = /^(api|rest|v\d+(\.\d+)*|\d+(\.\d+)*|latest|public|internal)$/i;

/** Lowercase snake_case tool name, max 48 chars, starting with a letter. */
export function toToolName(input: string): string {
  let name = input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
    .replace(/_+$/g, '');
  if (!/^[a-z]/.test(name)) name = `op_${name}`.slice(0, 48);
  return name || 'default';
}

/** Group key for an operation: first tag, else first meaningful path segment. */
export function groupKey(op: Operation): string {
  if (op.tags[0]) return op.tags[0];
  const seg = op.path
    .split('/')
    .filter((s) => s && !s.startsWith('{') && !SKIP_SEGMENTS.test(s))[0];
  return seg ?? 'default';
}

/** Number of meaningful (non-parameter, non-version) path segments. */
function pathDepth(op: Operation): number {
  return op.path.split('/').filter((s) => s && !s.startsWith('{') && !SKIP_SEGMENTS.test(s)).length;
}

/** Reads first, then by how "central" an operation is (shorter paths first). */
function operationRank(op: Operation): number {
  const accessRank = op.access === 'read' ? 0 : op.access === 'write' ? 1 : 2;
  return accessRank * 1_000 + op.path.split('/').length * 10 + (op.deprecated ? 500 : 0);
}

/**
 * Group operations into task-level tools.
 *
 * Every tag (or top-level path segment) becomes one tool. When there are more
 * groups than the tool budget allows, the biggest groups win and everything
 * else lands in the long tail, still reachable through search_operations and
 * call_operation. Deprecated and unsupported operations always go to the long tail.
 */
export function groupOperations(
  doc: OpenApiDocument,
  ops: Operation[],
  opts: GroupingOptions,
): GroupingResult {
  const budget = Math.max(1, opts.maxTools - (opts.longTail ? 2 : 0));
  const tagDescriptions = new Map((doc.tags ?? []).map((t) => [t.name, t.description ?? '']));

  const buckets = new Map<string, Operation[]>();
  const longTail: string[] = [];
  for (const op of ops) {
    if (op.deprecated || op.unsupported) {
      longTail.push(op.id);
      continue;
    }
    const key = groupKey(op);
    const list = buckets.get(key) ?? [];
    list.push(op);
    buckets.set(key, list);
  }

  // Tags are deliberate, so tagged groups count as top level. Path-derived groups rank by how
  // close to the root they start: /v1/customers before /v1/treasury/financial_accounts.
  const depthOf = (list: Operation[]) =>
    list.some((o) => o.tags[0]) ? 1 : Math.min(...list.map(pathDepth));
  const ordered = [...buckets.entries()].sort((a, b) => {
    const readsA = a[1].filter((o) => o.access === 'read').length;
    const readsB = b[1].filter((o) => o.access === 'read').length;
    return (
      depthOf(a[1]) - depthOf(b[1]) ||
      readsB - readsA ||
      b[1].length - a[1].length ||
      a[0].localeCompare(b[0])
    );
  });

  const groups: ToolGroupConfig[] = [];
  const usedNames = new Set(['search_operations', 'call_operation']);
  for (const [key, list] of ordered) {
    if (groups.length >= budget) {
      longTail.push(...list.map((o) => o.id));
      continue;
    }
    const sorted = [...list].sort((a, b) => operationRank(a) - operationRank(b));
    const kept = sorted.slice(0, opts.maxOperationsPerTool);
    longTail.push(...sorted.slice(opts.maxOperationsPerTool).map((o) => o.id));

    let name = toToolName(key);
    let n = 2;
    while (usedNames.has(name)) name = `${toToolName(key)}_${n++}`;
    usedNames.add(name);

    groups.push({
      name,
      description: groupDescription(key, tagDescriptions.get(key), kept),
      operations: kept.map((o) => o.id),
    });
  }

  return { groups, longTail };
}

function groupDescription(
  key: string,
  tagDescription: string | undefined,
  ops: Operation[],
): string {
  if (tagDescription?.trim()) return truncate(tagDescription, 160);
  const titles = ops.slice(0, 3).map((o) => operationTitle(o).replace(/\.$/, '').toLowerCase());
  return truncate(`${key}: ${titles.join('; ')}${ops.length > 3 ? '; and more' : ''}`, 160);
}
