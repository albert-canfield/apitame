export const REDACTED = '[REDACTED]';

/** Header names whose values are always hidden, whatever they contain. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
]);

/** Object keys whose values are hidden in structured output. */
const SENSITIVE_KEY =
  /^(password|passwd|secret|client_secret|access_token|refresh_token|id_token|api_key|apikey|token|private_key)$/i;

const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** Other spellings (`bearer`, `BEARER`) only when the value looks like a credential, not prose. */
const BEARER_ANY_CASE =
  /\b(bearer|basic|token)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=])[A-Za-z0-9._~+/=-]{8,}/gi;
/** An `Authorization: <scheme> <value>` pair echoed in text (logs, error messages, debug endpoints). */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization["']?\s{0,8}[:=]\s{0,8}["']?(?:[A-Za-z]{1,16}\s{1,8})?)[^\s"',;]{4,}/gi;
// The scheme is bounded: an unbounded `[a-z0-9+.-]*` backtracks quadratically on long dotted text.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;

/**
 * Removes secrets from anything that leaves the process: tool results,
 * error messages and logs. Known secret values are replaced wherever they
 * appear, and common credential shapes are masked even when unknown.
 */
export class Redactor {
  private readonly secrets = new Set<string>();
  private sorted: string[] = [];
  private readonly headerNames = new Set(SENSITIVE_HEADERS);

  /** Register a secret value. Very short values are ignored to avoid mangling output. */
  addSecret(value: string | undefined | null): void {
    if (!value || value.length < 4) return;
    // Also catch the encoded forms that end up in URLs: path segments and cookies use
    // encodeURIComponent, query strings use form encoding (space as +, and ! ' ( ) ~ escaped).
    const forms = [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
    ];
    for (const f of forms) this.secrets.add(f);
    // Longest first so a secret that contains another is fully replaced.
    this.sorted = [...this.secrets].sort((a, b) => b.length - a.length);
  }

  /** Treat a header (for example a custom API key header) as sensitive. */
  addSensitiveHeader(name: string): void {
    this.headerNames.add(name.toLowerCase());
  }

  isSensitiveHeader(name: string): boolean {
    return this.headerNames.has(name.toLowerCase());
  }

  /** Redact a string. */
  text(input: string): string {
    let out = input;
    for (const s of this.sorted) {
      if (out.includes(s)) out = out.split(s).join(REDACTED);
    }
    out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
    out = out.replace(BEARER_ANY_CASE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
    out = out.replace(AUTH_HEADER, (_m, pre: string) => `${pre}${REDACTED}`);
    out = out.replace(
      URL_PASSWORD,
      (_m, pre: string, _pw: string, at: string) => `${pre}${REDACTED}${at}`,
    );
    return out;
  }

  /** Redact a header map, hiding sensitive header values entirely. */
  headers(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = this.isSensitiveHeader(k) ? REDACTED : this.text(v);
    }
    return out;
  }

  /** Deep-redact a JSON-like value. */
  value<T>(input: T): T {
    return this.walk(input, new WeakSet()) as T;
  }

  private walk(input: unknown, seen: WeakSet<object>): unknown {
    if (typeof input === 'string') return this.text(input);
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((v) => this.walk(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      // Keys are redacted too: some APIs key maps by token or by API key.
      out[this.text(k)] =
        (SENSITIVE_KEY.test(k) || this.isSensitiveHeader(k)) && v !== null && v !== ''
          ? REDACTED
          : this.walk(v, seen);
    }
    return out;
  }
}
