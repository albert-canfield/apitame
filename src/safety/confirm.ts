import { createHash, randomBytes } from 'node:crypto';
import type { ApprovalRound, CallContext, ToolDefinition, ToolResult } from '../types.js';
import type { AuditOutcome } from './guardrails.js';

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

/** Why an id was refused. */
export type RefusalCode = 'unknown' | 'used' | 'expired' | 'mismatch';

export type Consumed = { ok: true } | { ok: false; code: RefusalCode; reason: string };

/**
 * Random ids that can be used once. Each id is bound to one operation and a hash of what it
 * was issued for, and expires after a TTL. A used id is remembered until it would have
 * expired, so a replay is told apart from an id that never existed.
 */
export class OneTimeIds {
  private readonly pending = new Map<string, Pending>();
  private readonly spent = new Map<string, number>();

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number,
    private readonly prefix: string,
    private readonly bytes: number,
    private readonly reasons: Record<RefusalCode, string>,
  ) {}

  issue(id: string, binding: unknown): { token: string; expiresAt: number } {
    this.sweep();
    const token = `${this.prefix}${randomBytes(this.bytes).toString('base64url')}`;
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { fingerprint: fingerprint(id, binding), expiresAt });
    return { token, expiresAt };
  }

  /** Check an id and use it up, whatever the outcome: a failed attempt burns it too. */
  consume(token: string, id: string, binding: unknown): Consumed {
    const entry = this.pending.get(token);
    if (!entry) {
      const code = this.spent.has(token) ? 'used' : 'unknown';
      return { ok: false, code, reason: this.reasons[code] };
    }
    this.pending.delete(token);
    this.spent.set(token, entry.expiresAt);
    if (entry.expiresAt < this.now()) {
      return { ok: false, code: 'expired', reason: this.reasons.expired };
    }
    if (entry.fingerprint !== fingerprint(id, binding)) {
      return { ok: false, code: 'mismatch', reason: this.reasons.mismatch };
    }
    return { ok: true };
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt < t) this.pending.delete(k);
    for (const [k, expiresAt] of this.spent) if (expiresAt < t) this.spent.delete(k);
  }
}

/**
 * One-time confirmation tokens. A token is bound to one operation and what it was issued for
 * (`confirmOrChallenge` binds the exact arguments and the OAuth caller), expires after a TTL and
 * can be used once.
 */
export class ConfirmationStore {
  private readonly tokens: OneTimeIds;
  /**
   * Approval ids for protocol 2026-07-28, sent to the client as `requestState`. They live in
   * their own store with their own prefix, so an approval id never works as a `confirm` token
   * and a token never works as an approval id.
   */
  readonly approvals: OneTimeIds;

  constructor(
    readonly ttlMs: number,
    now: () => number = () => Date.now(),
  ) {
    this.tokens = new OneTimeIds(ttlMs, now, 'confirm_', 12, {
      unknown: 'Unknown or already used confirmation token.',
      used: 'Unknown or already used confirmation token.',
      expired: 'Confirmation token expired.',
      mismatch: 'Confirmation token was issued for a different operation or different arguments.',
    });
    // 256 random bits: the id travels through the client, so it must not be guessable.
    this.approvals = new OneTimeIds(ttlMs, now, 'approval_', 32, {
      unknown: 'Unknown approval.',
      used: 'This approval was already used.',
      expired: 'The approval expired.',
      mismatch:
        'The approval was given for a different operation, different arguments or a different user.',
    });
  }

  issue(id: string, args: unknown): { token: string; expiresAt: number } {
    return this.tokens.issue(id, args);
  }

  consume(token: string, id: string, args: unknown): { ok: true } | { ok: false; reason: string } {
    const check = this.tokens.consume(token, id, args);
    return check.ok ? check : { ok: false, reason: check.reason };
  }
}

/** Whether any of these tools can ask for a human decision (they take a `confirm` token). */
export function asksForConfirmation(tools: ToolDefinition[]): boolean {
  return tools.some((t) => Object.hasOwn(t.inputSchema.properties ?? {}, 'confirm'));
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

/** What to do with the call, and, when it stops here, what the audit log records. */
export type ConfirmOutcome =
  { proceed: true } | { proceed: false; result: ToolResult; audit: AuditOutcome; reason?: string };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
});

type Refusal = Extract<ConfirmOutcome, { proceed: false }>;

/**
 * What a confirm token or an approval id is bound to, next to the operation: the exact arguments
 * and the OAuth client and subject, so one user can never spend what another was given. Without
 * OAuth (stdio, a static token, HTTP without authentication) there is no caller to tell apart.
 */
const bindingOf = (req: ConfirmRequest) => ({ args: req.args, caller: req.ctx?.caller ?? null });

const notApproved = (id: string): Refusal => ({
  proceed: false,
  result: text(`The user did not approve "${id}". Nothing was changed.`, true),
  audit: 'declined',
});

const cannotElicit = (id: string, unauthenticated = false): Refusal => ({
  proceed: false,
  result: text(
    unauthenticated
      ? `"${id}" needs human confirmation but this MCP client does not support elicitation over ` +
          'this connection: apitame serves HTTP without authentication, so any local process that ' +
          'can reach it could answer the approval form itself. Set APITAME_HTTP_TOKEN or ' +
          'http.oauth and give the credentials only to the MCP client, serve over stdio, or set ' +
          'confirmation.method to "auto" or "token" in apitame.config.yaml.'
      : `"${id}" needs human confirmation but this MCP client does not support elicitation. ` +
          'Set confirmation.method to "auto" or "token" in apitame.config.yaml.',
    true,
  ),
  audit: 'declined',
  ...(unauthenticated ? { reason: 'unauthenticated HTTP' } : {}),
});

/**
 * The two rounds of an approval on protocol 2026-07-28. The first call stores a one-time
 * approval id bound to the operation, the exact arguments and the caller, and asks the client
 * to show the form (`inputRequired`). The client calls again with the answer and the id as
 * `requestState`. The call runs only if the id is known, unused and unexpired, matches this
 * operation, these arguments and this caller, and the human approved. Any other second round is
 * refused with nothing sent, and the id is used up.
 */
function approvalRound(
  req: ConfirmRequest,
  round: ApprovalRound,
  message: string,
): ConfirmOutcome | undefined {
  const binding = bindingOf(req);
  if (round.state !== undefined) {
    const check = req.store.approvals.consume(round.state, req.id, binding);
    if (!check.ok) {
      return {
        proceed: false,
        result: text(`${check.reason} Nothing was changed.`, true),
        audit: 'approval-refused',
        reason: check.code,
      };
    }
    return round.answer === 'accept' ? { proceed: true } : notApproved(req.id);
  }
  if (!round.canAsk) return undefined;
  const { token } = req.store.approvals.issue(req.id, binding);
  return {
    proceed: false,
    result: {
      ...text(`Waiting for the user to approve "${req.id}". Nothing has been changed yet.`),
      inputRequired: { message, requestState: token },
    },
    audit: 'confirmation-requested',
  };
}

/**
 * Gate a risky call behind a human decision.
 *
 * With `auto`, MCP elicitation is used when the client supports it (the
 * client shows the prompt to the human directly). Otherwise a one-time token
 * is returned and the agent must show the preview to the user and call again.
 *
 * On protocol 2026-07-28 (`ctx.approval`) the prompt is not sent in the middle of the call:
 * the call returns it, and the client calls again with the answer (see `approvalRound`).
 */
export async function confirmOrChallenge(req: ConfirmRequest): Promise<ConfirmOutcome> {
  // Under `elicitation` the answer must come from the client the human uses. Over HTTP without
  // authentication nothing tells that client apart from any other local process, in either
  // protocol era, so nobody is asked.
  if (req.method === 'elicitation' && req.ctx?.anyoneCanAnswer) return cannotElicit(req.id, true);
  if (req.method !== 'token') {
    const message = `Confirm a destructive action requested by the agent:\n\n${req.preview}\n\nApprove only if you expect this.`;
    const round = req.ctx?.approval;
    if (round) {
      const settled = approvalRound(req, round, message);
      if (settled) return settled;
    }
    const outcome = round
      ? 'unsupported'
      : req.ctx?.elicit
        ? await req.ctx.elicit(message)
        : 'unsupported';
    if (outcome === 'accept') return { proceed: true };
    if (outcome === 'decline' || outcome === 'cancel') return notApproved(req.id);
    if (req.method === 'elicitation') return cannotElicit(req.id);
  }

  if (req.confirmToken) {
    const check = req.store.consume(req.confirmToken, req.id, bindingOf(req));
    if (check.ok) return { proceed: true };
    return {
      proceed: false,
      result: text(`${check.reason} Nothing was changed.`, true),
      audit: 'declined',
    };
  }

  const { token } = req.store.issue(req.id, bindingOf(req));
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
    audit: 'confirmation-requested',
  };
}
