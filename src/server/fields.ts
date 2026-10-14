/**
 * Response field selection. Agents pass dot paths such as
 * ["total_count", "items.full_name", "items.owner.login"]; arrays are mapped
 * transparently, so "items.full_name" keeps that field in every item.
 */

/** Accept an array of paths or a comma-separated string. Returns undefined when empty. */
export function parseFields(input: unknown): string[] | undefined {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const fields = raw
    .filter((f): f is string => typeof f === 'string')
    .map((f) => f.trim().replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function project(value: unknown, paths: string[][]): unknown {
  if (Array.isArray(value)) return value.map((v) => project(v, paths));
  if (!isPlainObject(value)) return value;
  const groups = new Map<string, string[][]>();
  for (const [head, ...rest] of paths) {
    if (!head) continue;
    groups.set(head, [...(groups.get(head) ?? []), rest]);
  }
  const out: Record<string, unknown> = {};
  for (const [key, rests] of groups) {
    if (!(key in value)) continue;
    out[key] = rests.some((r) => r.length === 0) ? value[key] : project(value[key], rests);
  }
  return out;
}

/** Keep only the given fields. Paths that match nothing are ignored. */
export function projectFields(value: unknown, fields: string[]): unknown {
  return project(
    value,
    fields.map((f) => f.split('.')),
  );
}
