import { createHash, randomBytes } from 'node:crypto';
import type { CallContext, ToolResult } from '../types.js';

/** JSON.stringify with sorted keys, so equal objects hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function fingerprint(id: string, args: unknown): string {
  return createHash('sha256').update(id).update('\0').update(stableStringify(args)).digest('hex');
}

interface Pending {
  fingerprint: string;
  expiresAt: number;
}

/**
 * One-time confirmation tokens. A token is bound to one operation and the
 * exact arguments it was issued for, expires after a TTL and can be used once.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(id: string, args: unknown): { token: string; expiresAt: number } {
    this.sweep();
    const token = `confirm_${randomBytes(12).toString('base64url')}`;
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { fingerprint: fingerprint(id, args), expiresAt });
    return { token, expiresAt };
  }

  consume(token: string, id: string, args: unknown): { ok: true } | { ok: false; reason: string } {
    const entry = this.pending.get(token);
    if (!entry) return { ok: false, reason: 'Unknown or already used confirmation token.' };
    this.pending.delete(token);
    if (entry.expiresAt < this.now()) return { ok: false, reason: 'Confirmation token expired.' };
    if (entry.fingerprint !== fingerprint(id, args)) {
      return {
        ok: false,
        reason: 'Confirmation token was issued for a different operation or different arguments.',
      };
    }
    return { ok: true };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
  }
}

export type ConfirmationMethod = 'auto' | 'elicitation' | 'token';

export interface ConfirmRequest {
  id: string;
  /** Human readable description of exactly what will happen. */
  preview: string;
  /** Arguments the token is bound to (without the `confirm` and `dryRun` flags). */
  args: unknown;
  confirmToken: string | undefined;
  method: ConfirmationMethod;
  store: ConfirmationStore;
  ctx: CallContext | undefined;
}

export type ConfirmOutcome = { proceed: true } | { proceed: false; result: ToolResult };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Gate a risky call behind a human decision.
 *
 * With `auto`, MCP elicitation is used when the client supports it (the
 * client shows the prompt to the human directly). Otherwise a one-time token
 * is returned and the agent must show the preview to the user and call again.
 */
export async function confirmOrChallenge(req: ConfirmRequest): Promise<ConfirmOutcome> {
  if (req.method !== 'token') {
    const outcome = req.ctx?.elicit
      ? await req.ctx.elicit(
          `Confirm a destructive action requested by the agent:\n\n${req.preview}\n\nApprove only if you expect this.`,
        )
      : 'unsupported';
    if (outcome === 'accept') return { proceed: true };
    if (outcome === 'decline' || outcome === 'cancel') {
      return {
        proceed: false,
        result: text(`The user did not approve "${req.id}". Nothing was changed.`, true),
      };
    }
    if (req.method === 'elicitation') {
      return {
        proceed: false,
        result: text(
          `"${req.id}" needs human confirmation but this MCP client does not support elicitation. ` +
            'Set confirmation.method to "auto" or "token" in apitame.config.yaml.',
          true,
        ),
      };
    }
  }

  if (req.confirmToken) {
    const check = req.store.consume(req.confirmToken, req.id, req.args);
    if (check.ok) return { proceed: true };
    return { proceed: false, result: text(`${check.reason} Nothing was changed.`, true) };
  }

  const { token } = req.store.issue(req.id, req.args);
  const minutes = Math.max(1, Math.round(req.store.ttlMs / 60_000));
  return {
    proceed: false,
    result: text(
      [
        `CONFIRMATION REQUIRED. Nothing has been changed yet.`,
        ``,
        req.preview,
        ``,
        `Show this to the user and ask for explicit approval. Only if they approve, call the same tool again`,
        `with exactly the same arguments plus "confirm": "${token}". The token works once and expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      ].join('\n'),
    ),
  };
}
