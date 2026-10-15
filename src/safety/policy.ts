import type { Access } from '../types.js';
import type { CallerPermissions } from './permissions.js';

export type Mode = 'read-only' | 'read-write';

export interface PolicyConfig {
  mode: Mode;
  writes: { allow: string[]; confirm: string[] };
  /** An OAuth caller's permissions (`http.oauth.permissions`). They only narrow the rules above. */
  caller?: CallerPermissions | undefined;
}

export type Decision =
  { allowed: true; needsConfirmation: boolean } | { allowed: false; reason: string; hint: string };

/**
 * Glob match supporting `*` only: `*` matches any run of characters (none included), everything
 * else matches itself, case-sensitively, and the whole id must match.
 *
 * No regular expression: ids can come from clients (a tool name, an operation id), and a
 * backtracking engine can take quadratic or worse time on `*a*b*` patterns. This is the classic
 * two-pointer matcher, which returns to the last `*` at most once per character of the id, so it
 * takes time linear in the id for a given pattern.
 */
export function matchesAny(id: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.includes('*') ? globMatch(id, p) : p === id));
}

function globMatch(id: string, pattern: string): boolean {
  let i = 0;
  let p = 0;
  let star = -1;
  let resume = 0;
  while (i < id.length) {
    if (p < pattern.length && pattern[p] === '*') {
      // Let the star match nothing for now; on a mismatch it takes one more character.
      star = p++;
      resume = i;
    } else if (p < pattern.length && pattern[p] === id[i]) {
      p++;
      i++;
    } else if (star >= 0) {
      p = star + 1;
      i = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * The single place that decides whether an operation may run.
 *
 * - reads always run
 * - writes need read-write mode AND an allowlist entry
 * - for an OAuth caller with permissions, writes also need the caller's permissions
 * - destructive writes (and anything in writes.confirm) also need confirmation
 */
export function decide(id: string, access: Access, cfg: PolicyConfig): Decision {
  if (access === 'read') return { allowed: true, needsConfirmation: false };

  if (cfg.mode === 'read-only') {
    return {
      allowed: false,
      reason: `"${id}" is a ${access} operation and the server runs in read-only mode.`,
      hint: `To enable it, set "mode: read-write" and add "${id}" to writes.allow in apitame.config.yaml. Ask the user before suggesting this.`,
    };
  }
  if (!matchesAny(id, cfg.writes.allow)) {
    return {
      allowed: false,
      reason: `"${id}" is a ${access} operation that is not in writes.allow.`,
      hint: `Add "${id}" to writes.allow in apitame.config.yaml to enable it. Ask the user before suggesting this.`,
    };
  }
  const caller = cfg.caller;
  if (caller && !caller.writable(id)) {
    return {
      allowed: false,
      reason: caller.readOnly
        ? `"${id}" is a ${access} operation and your access token allows read-only access.`
        : `"${id}" is a ${access} operation that your access token does not allow.`,
      hint: `What a token may do depends on its scopes and client (${describeApplied(caller)}). If the user needs this, tell them: only whoever runs this server can grant it.`,
    };
  }
  return {
    allowed: true,
    needsConfirmation: access === 'destructive' || matchesAny(id, cfg.writes.confirm),
  };
}

/** The caller's own matching permission entries in words, for refusals. Never names anyone else's. */
export function describeApplied(caller: CallerPermissions): string {
  if (caller.applied.length === 1) {
    return 'only the default: no entry in http.oauth.permissions matches them';
  }
  return caller.applied
    .map((label) =>
      label === 'default'
        ? 'the default'
        : label.startsWith('byScope.')
          ? `scope ${label.slice('byScope.'.length)}`
          : `client ${label.slice('byClient.'.length)}`,
    )
    .join(', ');
}

/** True when the operation would be exposed as a callable tool. */
export function isExposed(id: string, access: Access, cfg: PolicyConfig): boolean {
  return decide(id, access, cfg).allowed;
}
