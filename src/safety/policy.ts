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

/** Glob match supporting `*` only. Ids are matched case-sensitively. */
export function matchesAny(id: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (!p.includes('*')) return p === id;
    const re = new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`);
    return re.test(id);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
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
  if (caller && !matchesAny(id, caller.writes)) {
    return {
      allowed: false,
      reason:
        caller.writes.length === 0
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
  if (caller.applied.length === 1 && caller.applied[0] === 'default') {
    return 'no entry in http.oauth.permissions matches them, so the default applies';
  }
  return caller.applied
    .map((label) =>
      label.startsWith('byScope.')
        ? `scope ${label.slice('byScope.'.length)}`
        : `client ${label.slice('byClient.'.length)}`,
    )
    .join(', ');
}

/** True when the operation would be exposed as a callable tool. */
export function isExposed(id: string, access: Access, cfg: PolicyConfig): boolean {
  return decide(id, access, cfg).allowed;
}
