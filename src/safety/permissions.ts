import type { Config, PermissionConfig } from '../config/schema.js';
import type { CallerContext } from '../types.js';
import { matchesAny } from './policy.js';

/**
 * What one OAuth caller may do, resolved from `http.oauth.permissions`. It only ever narrows the
 * server config: `decide()` applies it after `mode` and `writes.allow`, and tool lists are
 * filtered with it after the server config has built them.
 */
export interface CallerPermissions {
  /** The entries that applied: `byScope.<scope>`, `byClient.<client>` or `default`. Audited. */
  applied: string[];
  /** Write patterns from those entries. Empty means read-only. A write must also be in writes.allow. */
  writes: string[];
  /** Tool name patterns from those entries. Undefined means every tool. */
  tools: string[] | undefined;
  /** The same for callers who may use the same tools and writes, so their tool lists can be shared. */
  key: string;
}

/** For callers that no entry matches, when `permissions.default` is not set. */
const READ_ONLY: PermissionConfig = { mode: 'read-only' };

/**
 * The permissions of the caller behind a request, or undefined when nothing narrows the server
 * config: no OAuth caller (stdio, a static token, unauthenticated HTTP) or no
 * `http.oauth.permissions`.
 *
 * Every entry that matches one of the token's scopes or its client applies, and the caller gets
 * the union of what they allow. A caller that no entry matches gets `permissions.default`, or
 * read-only access when that is not set.
 */
export function callerPermissions(
  config: Config,
  who: CallerContext | undefined,
): CallerPermissions | undefined {
  const permissions = config.http.oauth?.permissions;
  if (!permissions || !who?.caller) return undefined;
  const matched: Array<[string, PermissionConfig]> = [];
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
  if (matched.length === 0) matched.push(['default', permissions.default ?? READ_ONLY]);

  const writes = new Set<string>();
  let tools: Set<string> | undefined = new Set();
  for (const [, entry] of matched) {
    // An entry without `writes` allows every write the server allows, unless it is read-only.
    if (entry.mode !== 'read-only') for (const w of entry.writes ?? ['*']) writes.add(w);
    if (entry.tools === undefined) tools = undefined;
    else if (tools) for (const t of entry.tools) tools.add(t);
  }
  const w = [...writes].sort();
  const t = tools && [...tools].sort();
  return {
    applied: matched.map(([label]) => label),
    writes: w,
    tools: t,
    key: JSON.stringify([w, t ?? null]),
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
}

/**
 * Check `http.oauth.permissions` against the tools and operations the source defines, and
 * return warnings for `serve` (at startup and on reload), `doctor` and `inspect`.
 *
 * A tool or write pattern that matches nothing is probably a typo, and a write pattern that only
 * matches operations the server never lets anyone write grants nothing (permissions only narrow
 * `writes.allow`). Neither can widen access, so neither is an error: an error would stop `serve`
 * when a spec loaded from a URL drops an operation that an entry names.
 */
export function checkPermissions(config: Config, targets: PermissionTargets): string[] {
  const permissions = config.http.oauth?.permissions;
  if (!permissions) return [];
  const entries: Array<[string, PermissionConfig]> = [
    ...Object.entries(permissions.byScope).map(([k, v]): [string, PermissionConfig] => [
      `byScope.${k}`,
      v,
    ]),
    ...Object.entries(permissions.byClient).map(([k, v]): [string, PermissionConfig] => [
      `byClient.${k}`,
      v,
    ]),
    ...(permissions.default
      ? [['default', permissions.default] as [string, PermissionConfig]]
      : []),
  ];
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
      if (matching.length === 0) {
        warnings.push(
          `${path}.writes: no ${targets.noun} matches "${p}" (typo?), so it grants nothing.`,
        );
      } else if (
        config.mode === 'read-write' &&
        !matching.some((o) => o.write && matchesAny(o.id, config.writes.allow))
      ) {
        warnings.push(
          `${path}.writes: "${p}" grants nothing, because no write it matches is in writes.allow (permissions only narrow writes.allow).`,
        );
      }
    }
  }
  return warnings;
}
