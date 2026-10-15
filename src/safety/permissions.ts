import type { Config, PermissionConfig } from '../config/schema.js';
import type { CallerContext } from '../types.js';
import { matchesAny } from './policy.js';

/**
 * Whether an entry whose `tools` are these patterns (undefined: every tool) reaches an operation
 * through one of those tools. Only the runtime knows which tool holds which operation.
 */
export type Reach = (tools: string[] | undefined, id: string) => boolean;

/**
 * What one OAuth caller may do, resolved from `http.oauth.permissions`. It only ever narrows the
 * server config: `decide()` applies it after `mode` and `writes.allow`, and tool lists are
 * filtered with it after the server config has built them.
 */
export interface CallerPermissions {
  /** The entries that applied: `default` first, then `byScope.<scope>` and `byClient.<client>`. Audited. */
  applied: string[];
  /**
   * Whether one of those entries, on its own, allows this write: its `writes` match the id and
   * one of its own `tools` reaches the operation. The server config still has to allow it too.
   */
  writable: (id: string) => boolean;
  /** No entry allows any write. */
  readOnly: boolean;
  /** Tools the caller sees: those any of its entries shows. Undefined means every tool. */
  tools: string[] | undefined;
  /** The same for callers whose entries are the same, so their tool lists can be shared. */
  key: string;
}

/** `permissions.default` when it is not set. */
const READ_ONLY: PermissionConfig = { mode: 'read-only' };

/** The write patterns an entry grants: none when read-only, every write when `writes` is unset. */
const writesOf = (e: PermissionConfig): string[] =>
  e.mode === 'read-only' ? [] : (e.writes ?? ['*']);

/** Whether an entry, on its own, lets a caller write this operation. */
const entryWrites = (e: PermissionConfig, id: string, reach: Reach): boolean =>
  matchesAny(id, writesOf(e)) && reach(e.tools, id);

/**
 * The permissions of the caller behind a request, or undefined when nothing narrows the server
 * config: no OAuth caller (stdio, a static token, unauthenticated HTTP) or no
 * `http.oauth.permissions`.
 *
 * Every OAuth caller gets `permissions.default` (read-only when it is not set), and every entry
 * that matches one of the token's scopes or its client adds to it. Entries add one by one, not
 * field by field: a tool is shown if one entry shows it, but a write runs only if one single
 * entry both allows it in `writes` and reaches it through its own `tools`. So two entries can
 * never combine into a write that neither grants.
 */
export function callerPermissions(
  config: Config,
  who: CallerContext | undefined,
  reach: Reach,
): CallerPermissions | undefined {
  const permissions = config.http.oauth?.permissions;
  if (!permissions || !who?.caller) return undefined;
  const matched: Array<[string, PermissionConfig]> = [
    ['default', permissions.default ?? READ_ONLY],
  ];
  // Object.hasOwn: a scope or client called "constructor" must not find Object's own members.
  for (const scope of [...new Set(who.scopes ?? [])].sort()) {
    const entry = Object.hasOwn(permissions.byScope, scope)
      ? permissions.byScope[scope]
      : undefined;
    if (entry) matched.push([`byScope.${scope}`, entry]);
  }
  const client = who.caller.client;
  const byClient =
    client !== undefined && Object.hasOwn(permissions.byClient, client)
      ? permissions.byClient[client]
      : undefined;
  if (client !== undefined && byClient) matched.push([`byClient.${client}`, byClient]);

  const entries = matched.map(([, e]) => e);
  let tools: Set<string> | undefined = new Set();
  for (const e of entries) {
    if (e.tools === undefined) tools = undefined;
    else if (tools) for (const t of e.tools) tools.add(t);
  }
  const shape = entries.map((e) => [[...writesOf(e)].sort(), e.tools ? [...e.tools].sort() : null]);
  return {
    applied: matched.map(([label]) => label),
    writable: (id) => entries.some((e) => entryWrites(e, id, reach)),
    readOnly: entries.every((e) => writesOf(e).length === 0),
    tools: tools && [...tools].sort(),
    key: JSON.stringify([...new Set(shape.map((x) => JSON.stringify(x)))].sort()),
  };
}

/** Whether a caller with these permissions may see and call the tool. */
export function toolAllowed(name: string, perm: CallerPermissions | undefined): boolean {
  return !perm?.tools || matchesAny(name, perm.tools);
}

/** What the permissions can refer to, as the runtime knows it. */
export interface PermissionTargets {
  /** Every tool the config defines, whether the server config lists it or not. */
  tools: string[];
  /** Every operation (or named query), and whether it writes. */
  operations: Array<{ id: string; write: boolean }>;
  /** What an operation is called in messages: "operation" or "named query". */
  noun: string;
  reach: Reach;
}

/**
 * Check `http.oauth.permissions` against the tools and operations the source defines, and
 * return warnings for `serve` (at startup and on reload), `doctor` and `inspect`.
 *
 * Everything reported here can only fail to grant, never widen access, so none of it is an
 * error: an error would stop `serve` when a spec loaded from a URL drops an operation that an
 * entry names. Reported: names that match nothing (typos), write patterns that grant nothing
 * (outside `writes.allow`, or out of reach of the entry's own `tools`), and entries that add
 * nothing to `default` (entries cannot take anything away from it).
 */
export function checkPermissions(config: Config, targets: PermissionTargets): string[] {
  const permissions = config.http.oauth?.permissions;
  if (!permissions) return [];
  const base = permissions.default ?? READ_ONLY;
  const entries: Array<[string, PermissionConfig]> = [
    ...(permissions.default
      ? [['default', permissions.default] as [string, PermissionConfig]]
      : []),
    ...Object.entries(permissions.byScope).map(([k, v]): [string, PermissionConfig] => [
      `byScope.${k}`,
      v,
    ]),
    ...Object.entries(permissions.byClient).map(([k, v]): [string, PermissionConfig] => [
      `byClient.${k}`,
      v,
    ]),
  ];
  const writes = targets.operations.filter((o) => o.write);
  const shows = (e: PermissionConfig) =>
    targets.tools.filter((t) => e.tools === undefined || matchesAny(t, e.tools));
  const grants = (e: PermissionConfig) =>
    writes.filter((o) => entryWrites(e, o.id, targets.reach)).map((o) => o.id);
  const baseShows = new Set(shows(base));
  const baseGrants = new Set(grants(base));
  const allowed = (id: string) =>
    config.mode === 'read-write' && matchesAny(id, config.writes.allow);

  const warnings: string[] = [];
  for (const [label, entry] of entries) {
    const path = `http.oauth.permissions.${label}`;
    for (const p of entry.tools ?? []) {
      if (!targets.tools.some((t) => matchesAny(t, [p]))) {
        warnings.push(
          `${path}.tools: no tool matches "${p}" (typo?), so it shows nothing. Tools: ${targets.tools.join(', ')}.`,
        );
      }
    }
    for (const p of entry.writes ?? []) {
      const matching = targets.operations.filter((o) => matchesAny(o.id, [p]));
      const candidates = matching.filter((o) => o.write && allowed(o.id));
      if (matching.length === 0) {
        warnings.push(
          `${path}.writes: no ${targets.noun} matches "${p}" (typo?), so it grants nothing.`,
        );
      } else if (config.mode === 'read-write' && candidates.length === 0) {
        warnings.push(
          `${path}.writes: "${p}" grants nothing, because no write it matches is in writes.allow (permissions only narrow writes.allow).`,
        );
      } else if (
        candidates.length > 0 &&
        !candidates.some((o) => targets.reach(entry.tools, o.id))
      ) {
        warnings.push(
          `${path}.writes: "${p}" grants nothing, because no write it matches is in a tool this entry shows (${(entry.tools ?? []).join(', ')}).`,
        );
      }
    }
    if (label === 'default') continue;
    const addsTools = shows(entry).some((t) => !baseShows.has(t));
    const addsWrites = grants(entry).some((id) => !baseGrants.has(id));
    if (!addsTools && !addsWrites) {
      warnings.push(
        `${path}: adds nothing to permissions.default, so it has no effect. Every caller gets default, and entries can only add to it: to restrict callers, narrow default and grant more in entries.`,
      );
    }
  }
  return warnings;
}
