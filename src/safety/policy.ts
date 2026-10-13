import type { Access } from '../types.js';

export type Mode = 'read-only' | 'read-write';

export interface PolicyConfig {
  mode: Mode;
  writes: { allow: string[]; confirm: string[] };
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
  return {
    allowed: true,
    needsConfirmation: access === 'destructive' || matchesAny(id, cfg.writes.confirm),
  };
}

/** True when the operation would be exposed as a callable tool. */
export function isExposed(id: string, access: Access, cfg: PolicyConfig): boolean {
  return decide(id, access, cfg).allowed;
}
