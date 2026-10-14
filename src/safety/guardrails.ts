import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config/schema.js';
import type { Logger } from '../log.js';
import type { Access, CallContext } from '../types.js';
import type { Redactor } from './redact.js';

export type AuditOutcome =
  | 'sent'
  | 'error'
  | 'blocked'
  | 'refused'
  | 'dry-run'
  | 'confirmation-requested'
  | 'declined'
  | 'rate-limited';

export interface AuditEntry {
  tool: string;
  operation?: string;
  access: Access;
  outcome: AuditOutcome;
  status?: number;
  durationMs?: number;
  /** Arguments as the agent sent them. Redacted and size-capped before writing. */
  args?: unknown;
  reason?: string;
  /** The OAuth client and subject behind the call, when the HTTP transport checked a token. */
  caller?: CallContext['caller'];
}

/** Sliding one-minute window. A limit of 0 means unlimited. */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when the call may proceed (and counts it), else the milliseconds to wait. */
  take(): number {
    const wait = this.peek();
    if (wait === 0 && this.perMinute > 0) this.hits.push(this.now());
    return wait;
  }

  /** Like {@link take}, without counting the call. */
  peek(): number {
    if (this.perMinute <= 0) return 0;
    const t = this.now();
    while (this.hits.length > 0 && (this.hits[0] as number) <= t - 60_000) this.hits.shift();
    return this.hits.length >= this.perMinute ? (this.hits[0] as number) + 60_000 - t : 0;
  }
}

const MAX_ARGS_CHARS = 2_000;

export interface GuardrailOptions {
  server: string;
  /** Absolute path of the JSON Lines audit file, if auditing is on. */
  auditFile?: string | undefined;
  include: 'writes' | 'all';
  callsPerMinute: number;
  writesPerMinute: number;
  /** Per-tool limits (calls per minute), keyed by tool name. */
  perTool?: Record<string, number>;
  redactor: Redactor;
  logger: Logger;
  now?: () => number;
}

/**
 * Rate limits and the audit trail, shared by the OpenAPI and SQL runtimes so
 * both enforce the same rules.
 */
export class Guardrails {
  private readonly calls: RateLimiter;
  private readonly writes: RateLimiter;
  private readonly tools = new Map<string, RateLimiter>();
  private auditBroken = false;

  constructor(private readonly opts: GuardrailOptions) {
    this.calls = new RateLimiter(opts.callsPerMinute, opts.now);
    this.writes = new RateLimiter(opts.writesPerMinute, opts.now);
  }

  static fromConfig(
    config: Config,
    configDir: string,
    redactor: Redactor,
    logger: Logger,
  ): Guardrails {
    return new Guardrails({
      server: config.name,
      auditFile: config.audit.file ? resolve(configDir, config.audit.file) : undefined,
      include: config.audit.include,
      callsPerMinute: config.limits.maxCallsPerMinute,
      writesPerMinute: config.limits.maxWritesPerMinute,
      perTool: config.limits.perTool,
      redactor,
      logger,
    });
  }

  /** Check the per-minute call budget. Returns an error message when exceeded. */
  checkCall(): string | undefined {
    const wait = this.calls.take();
    return wait > 0
      ? `Rate limit: more than ${this.calls.perMinute} calls per minute. Try again in ${Math.ceil(wait / 1000)} s, and look for a way to do this with fewer calls.`
      : undefined;
  }

  /** Check a tool's own per-minute budget (limits.perTool). Returns an error message when exceeded. */
  checkTool(name: string): string | undefined {
    const limit = this.opts.perTool?.[name];
    if (!limit) return undefined;
    let limiter = this.tools.get(name);
    if (!limiter) {
      limiter = new RateLimiter(limit, this.opts.now);
      this.tools.set(name, limiter);
    }
    const wait = limiter.take();
    return wait > 0
      ? `Rate limit: more than ${limit} calls per minute to "${name}". Try again in ${Math.ceil(wait / 1000)} s.`
      : undefined;
  }

  /** Check the per-minute write budget. Returns an error message when exceeded. */
  checkWrite(): string | undefined {
    return this.writeLimitMessage(this.writes.take());
  }

  /**
   * The write limit, without using up a slot. Checked before asking a human,
   * so a call that would be rate-limited never uses up an approval.
   */
  peekWrite(): string | undefined {
    return this.writeLimitMessage(this.writes.peek());
  }

  private writeLimitMessage(wait: number): string | undefined {
    return wait > 0
      ? `Rate limit: more than ${this.writes.perMinute} writes per minute. Try again in ${Math.ceil(wait / 1000)} s.`
      : undefined;
  }

  get auditing(): boolean {
    return Boolean(this.opts.auditFile);
  }

  /** Append an entry to the audit file. Reads are only written with `include: all`. */
  record(entry: AuditEntry): void {
    if (!this.opts.auditFile || this.auditBroken) return;
    if (entry.access === 'read' && entry.outcome !== 'refused' && this.opts.include !== 'all') {
      return;
    }
    let args: unknown;
    if (entry.args !== undefined) {
      const text = JSON.stringify(this.opts.redactor.value(entry.args)) ?? '';
      args =
        text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}...` : JSON.parse(text);
    }
    const { caller, ...rest } = entry;
    const line = JSON.stringify({
      time: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
      server: this.opts.server,
      ...caller,
      ...rest,
      ...(args !== undefined ? { args } : {}),
      ...(entry.reason ? { reason: this.opts.redactor.text(entry.reason) } : {}),
    });
    try {
      mkdirSync(dirname(this.opts.auditFile), { recursive: true });
      appendFileSync(this.opts.auditFile, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      // Never fail a tool call because the audit file is not writable, but say so once.
      this.auditBroken = true;
      this.opts.logger.error(`Audit log disabled: ${(err as Error).message}`);
    }
  }
}
