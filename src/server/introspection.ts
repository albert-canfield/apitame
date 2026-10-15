import { createHash, randomBytes } from 'node:crypto';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import { basicCredentials, resolveSecret } from '../auth/index.js';
import { resolveEnv } from '../config/env.js';
import { verifyMode, type OAuthConfig, type VerifyMode } from '../config/schema.js';
import type { Redactor } from '../safety/redact.js';
import { withDeadline } from '../util/deadline.js';
import {
  accessTokenInfo,
  assertSecureUrl,
  claimRules,
  invalid,
  JwtVerifier,
  looksLikeJwt,
  MAX_TOKEN_CHARS,
  namesOtherTokenType,
  readCapped,
  reason,
  show,
  type ClaimRules,
  type OAuthOptions,
} from './oauth.js';

/**
 * OAuth 2.0 token introspection (RFC 7662) for the HTTP transport: for access tokens apitame
 * cannot check on its own (opaque tokens, or any token under `verify: introspection`), it asks
 * the authorization server whether the token is active and what it allows. The answer then goes
 * through the same checks as the claims of a JWT (`accessTokenInfo`).
 */

/** How apitame reaches the introspection endpoint, with the secrets already resolved. */
export interface IntrospectionSettings {
  /** The authorization server's introspection endpoint. https, except on loopback hosts. */
  url: string;
  clientId: string;
  clientSecret: string;
  /** Default `client_secret_basic`. */
  clientAuthMethod?: 'client_secret_basic' | 'client_secret_post' | undefined;
  /** How long an active answer is reused, at most until the token expires. Default 60. */
  cacheSeconds?: number | undefined;
  /**
   * Most introspections of new tokens in any 60 seconds, and as many again of tokens seen active
   * before. Default 600.
   */
  maxCallsPerMinute?: number | undefined;
}

export interface IntrospectionDeps {
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /**
   * Told about what an operator should fix: a full introspection budget (at most once a minute
   * each), or answers that name no user (once per client).
   */
  warn?: ((message: string) => void) | undefined;
  /** How long one introspection request may take, answer included. Default 5 seconds. */
  timeoutMs?: number | undefined;
}

/** What a verified token allows, without the token itself: the cache never holds a raw token. */
type Verified = Omit<AuthInfo, 'token' | 'resource'>;

interface Cached {
  info: Verified;
  /** Answered from the cache until then (ms), `cacheSeconds` after the answer, unless expired. */
  fresh: number;
  /** When the token expires (ms). Until then, asking about it again uses the re-check budget. */
  expires: number;
}

/** The one description every refused introspected token gets (RFC 7662 section 4). */
export const REFUSED = 'The access token is invalid or inactive.';

const WINDOW_MS = 60_000;
const TIMEOUT_MS = 5_000;
/** Most tokens remembered. The least recently used one makes room. */
export const MAX_CACHED_TOKENS = 10_000;
/** Most clients warned about answers without a user, so the set of names stays small. */
export const MAX_WARNED_CLIENTS = 1_000;
/** RFC 6750 b64token: anything else is not a bearer token and is refused without asking. */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

/** The cache key of a token: its SHA-256, so no raw token is kept as a key. */
const keyOf = (token: string) => createHash('sha256').update(token).digest('base64url');

/**
 * The introspection endpoint said that a random token nobody issued is active: it is not the
 * authorization server's introspection endpoint, or one that accepts anything. `serve` stops.
 */
export class IntrospectionMisconfigured extends Error {}

/** At most `max` introspection requests in any minute, refusing and warning past that. */
class Budget {
  private readonly started: number[] = [];
  private warnedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly max: number,
    private readonly refusal: string,
    private readonly warning: string,
  ) {}

  /**
   * Count one request, or refuse it without asking: random tokens must not turn apitame into a
   * request amplifier against the authorization server. Answered as a server error (500), not
   * as an invalid token, so a client with a good token retries later instead of signing the
   * user in again.
   */
  take(now: number, warn: ((message: string) => void) | undefined): void {
    while (this.started.length > 0 && (this.started[0] as number) <= now - WINDOW_MS) {
      this.started.shift();
    }
    if (this.started.length >= this.max) {
      if (now - this.warnedAt >= WINDOW_MS) {
        this.warnedAt = now;
        warn?.(this.warning);
      }
      throw new OAuthError(OAuthErrorCode.ServerError, this.refusal);
    }
    this.started.push(now);
  }
}

/** Asks the authorization server about each access token (RFC 7662), with a short cache. */
export class IntrospectionVerifier implements OAuthTokenVerifier {
  private readonly rules: ClaimRules;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  /** `client_id` and `client_secret` in the form body, for `client_secret_post`. */
  private readonly formCredentials: Record<string, string>;
  private readonly cacheMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /**
   * Tokens the authorization server said were active, by hash, least recently used first, kept
   * until they expire. Only a fresh entry answers a request; a stale one only tells that the
   * token was seen active, so checking it again draws from `rechecks`.
   */
  private readonly cache = new Map<string, Cached>();
  /** Introspection requests under way, by token hash, so concurrent requests share one. */
  private readonly inflight = new Map<string, Promise<Verified>>();
  /** Requests for tokens never seen active: anyone can make those up. */
  private readonly newTokens: Budget;
  /**
   * Requests for tokens seen active before, apart from `newTokens`: a flood of made-up tokens
   * must not lock out users who are already signed in once their cached answers go stale.
   * Only real tokens get here, so this is bounded by real users; it is capped all the same.
   */
  private readonly rechecks: Budget;
  /** Clients already warned about answers without a user (`sub`). */
  private readonly warnedNoSubject = new Set<string>();

  constructor(
    opts: OAuthOptions,
    settings: IntrospectionSettings,
    private readonly deps: IntrospectionDeps = {},
  ) {
    this.rules = claimRules(opts);
    const url = assertSecureUrl(settings.url, 'http.oauth.introspection.url');
    if (url.username || url.password) {
      throw new Error(
        'http.oauth.introspection.url must not contain credentials: use clientId and clientSecret.',
      );
    }
    this.url = settings.url;
    this.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    this.formCredentials = {};
    if ((settings.clientAuthMethod ?? 'client_secret_basic') === 'client_secret_basic') {
      this.headers.Authorization = `Basic ${basicCredentials(settings.clientId, settings.clientSecret)}`;
    } else {
      this.formCredentials = { client_id: settings.clientId, client_secret: settings.clientSecret };
    }
    this.cacheMs = (settings.cacheSeconds ?? 60) * 1000;
    const max = settings.maxCallsPerMinute ?? 600;
    const setting = 'http.oauth.introspection.maxCallsPerMinute';
    this.newTokens = new Budget(
      max,
      'Too many new tokens to check right now. Try again in a minute.',
      `OAuth: ${max} new tokens were introspected in the last minute (${setting}). Other new tokens are refused until the minute passes. Tokens already seen active are checked again within a budget of their own, so users who are signed in keep working.`,
    );
    this.rechecks = new Budget(
      max,
      'Too many tokens to check again right now. Try again in a minute.',
      `OAuth: ${max} tokens already seen active were introspected again in the last minute (${setting}, counted apart from new tokens). Their requests are refused until the minute passes: raise maxCallsPerMinute or cacheSeconds for this many active users.`,
    );
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * Ask about a random token that no authorization server has issued, so a wrong URL or
   * rejected credentials show up at startup. Throws when the endpoint does not answer as
   * RFC 7662 says, and {@link IntrospectionMisconfigured} when it calls that token active.
   */
  async warmUp(): Promise<void> {
    this.newTokens.take(this.now(), this.deps.warn);
    const answer = await this.introspect(`apitame-check-${randomBytes(16).toString('hex')}`);
    if (answer.active === true) {
      throw new IntrospectionMisconfigured(
        `${this.url} says that a random token nobody issued is active, so it would accept any token. Point http.oauth.introspection.url at the authorization server's introspection endpoint.`,
      );
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.length > MAX_TOKEN_CHARS) throw invalid('The token is too large.');
    if (!BEARER_TOKEN.test(token)) throw invalid('The token is not a valid bearer token.');
    const key = keyOf(token);
    const now = this.now();
    const seen = this.cache.get(key);
    let known = false;
    if (seen) {
      this.cache.delete(key);
      if (seen.expires > now) {
        this.cache.set(key, seen); // most recently used
        if (seen.fresh > now) return this.authInfo(token, seen.info);
        // Stale: never answered from the cache, so a revocation counts within cacheSeconds.
        known = true;
      }
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      (known ? this.rechecks : this.newTokens).take(now, this.deps.warn);
      pending = this.introspect(token)
        .then((answer) => this.remember(key, token, answer))
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return this.authInfo(token, await pending);
  }

  /** A fresh copy for each request, so nothing a request does can change a cached answer. */
  private authInfo(token: string, info: Verified): AuthInfo {
    return {
      token,
      ...info,
      scopes: [...info.scopes],
      extra: { ...info.extra },
      resource: new URL(this.rules.resource),
    };
  }

  /**
   * POST the token to the introspection endpoint. Any failure (network, a redirect, a status
   * other than 200, more than 1 MB, an answer that is not RFC 7662, or `timeoutMs` passing before
   * the whole answer arrived) throws a plain error, which the transport logs and answers with a
   * 500: the token is refused, never let through.
   */
  private introspect(token: string): Promise<Record<string, unknown>> {
    return withDeadline(
      this.timeoutMs,
      () => new Error(`Token introspection at ${this.url} timed out after ${this.timeoutMs} ms.`),
      async (signal) => {
        const body = new URLSearchParams({
          token,
          token_type_hint: 'access_token',
          ...this.formCredentials,
        });
        let res: Response;
        try {
          res = await this.fetchImpl(this.url, {
            method: 'POST',
            headers: this.headers,
            body,
            redirect: 'error',
            signal,
          });
        } catch (err) {
          const why = reason(err);
          const hint = /redirect/i.test(why)
            ? ' Redirects are not followed: use the final URL.'
            : '';
          // The original error is not attached as `cause`: nothing from the request should travel.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(`Token introspection at ${this.url} failed (${why}).${hint}`);
        }
        if (res.status !== 200) {
          // The body is not read: an error page may echo the request, credentials included.
          await res.body?.cancel().catch(() => {});
          const hint =
            res.status === 401 || res.status === 403
              ? ' Check http.oauth.introspection.clientId and clientSecret.'
              : '';
          throw new Error(
            `Token introspection at ${this.url} failed with HTTP ${res.status}.${hint}`,
          );
        }
        let text: string;
        try {
          text = await readCapped(res, this.url);
        } catch (err) {
          // eslint-disable-next-line preserve-caught-error
          throw new Error(`Token introspection at ${this.url} failed: ${reason(err)}`);
        }
        let answer: unknown;
        try {
          answer = JSON.parse(text);
        } catch {
          throw new Error(`Token introspection at ${this.url} did not answer with JSON.`);
        }
        if (
          !answer ||
          typeof answer !== 'object' ||
          Array.isArray(answer) ||
          typeof (answer as { active?: unknown }).active !== 'boolean'
        ) {
          throw new Error(
            `Token introspection at ${this.url} did not answer as RFC 7662 says (no "active" true or false).`,
          );
        }
        return answer as Record<string, unknown>;
      },
    );
  }

  /**
   * Check an answer, and remember the token while it is good. A refused token is forgotten, so
   * a revoked one counts as new from then on. Every refusal gets the same description, so
   * nobody learns from it what the authorization server knows about a token they made up or
   * found; the reason is attached as `cause`, which the transport writes to the debug log.
   */
  private remember(key: string, token: string, answer: Record<string, unknown>): Verified {
    const now = this.now();
    let checked: AuthInfo;
    try {
      checked = this.check(token, answer, now);
    } catch (err) {
      this.cache.delete(key);
      if (!(err instanceof OAuthError)) throw err;
      const refused = invalid(REFUSED);
      refused.cause = err;
      throw refused;
    }
    const { token: _token, resource: _resource, ...info } = checked;
    const expires = (info.expiresAt ?? 0) * 1000;
    if (expires > now) {
      this.cache.delete(key);
      while (this.cache.size >= MAX_CACHED_TOKENS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      this.cache.set(key, { info, fresh: now + this.cacheMs, expires });
    }
    if (typeof answer.sub !== 'string' || answer.sub === '') this.noSubject(info);
    return info;
  }

  /**
   * Without `sub`, every user of a client looks the same: one session owner, one per-caller
   * budget, one name in the audit log. Worth fixing at the authorization server, so say it once
   * per client. `username` is not taken instead: RFC 7662 makes it a human-readable name, not
   * a stable identifier.
   */
  private noSubject(info: Verified): void {
    const client = typeof info.extra?.client === 'string' ? info.extra.client : '';
    if (this.warnedNoSubject.has(client) || this.warnedNoSubject.size >= MAX_WARNED_CLIENTS) return;
    this.warnedNoSubject.add(client);
    this.deps.warn?.(
      client
        ? `OAuth: introspection answers for client ${show(client)} name no user (sub), so all its users count as one caller: one session owner, one limits.perCaller budget, one subject in the audit log. Have the authorization server return sub.`
        : 'OAuth: an introspection answer names neither a client nor a user (sub), so all such tokens count as one caller. Have the authorization server return sub.',
    );
  }

  private check(token: string, answer: Record<string, unknown>, now: number): AuthInfo {
    if (answer.active !== true) {
      throw invalid(
        'The authorization server says the token is not active (expired, revoked or unknown).',
      );
    }
    for (const field of ['token_type', 'token_use']) {
      const value = answer[field];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw invalid(`The token's ${field} is not text.`);
      if (namesOtherTokenType(value)) {
        throw invalid(`The token is not an access token (${field} ${show(value)}).`);
      }
      // A DPoP-bound token is only good with a proof of the client's key, which apitame does
      // not check: accepting it as a plain bearer token would undo the binding.
      if (value.trim().toLowerCase() === 'dpop') throw this.bound();
    }
    // The same goes for certificate-bound (RFC 8705) and other key-bound tokens.
    if (answer.cnf !== undefined) throw this.bound();
    return accessTokenInfo(token, answer, this.rules, Math.floor(now / 1000), true);
  }

  private bound(): OAuthError {
    return invalid(
      'The token is bound to a key or certificate of the client (DPoP or cnf), which apitame cannot check.',
    );
  }
}

/** `verify: auto`: JWTs are checked locally, every other token by introspection. */
export class AutoVerifier implements OAuthTokenVerifier {
  constructor(
    readonly jwt: JwtVerifier,
    readonly introspection: IntrospectionVerifier,
  ) {}

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return looksLikeJwt(token)
      ? this.jwt.verifyAccessToken(token)
      : this.introspection.verifyAccessToken(token);
  }
}

/** The verifiers `http.oauth` asks for. */
export interface OAuthVerifiers {
  mode: VerifyMode;
  /** What the transport calls for each token. */
  verifier: OAuthTokenVerifier;
  /** Set when JWTs are checked locally (`verify: jwt` or `auto`). */
  jwt?: JwtVerifier;
  /** Set when tokens are introspected (`verify: introspection` or `auto`). */
  introspection?: IntrospectionVerifier;
}

/**
 * Build the token verifiers for `http.oauth`. The introspection credentials are resolved from
 * the environment here and registered with the redactor (the secret, every variable inside it
 * and the Basic credentials made from it), so they never reach a log line.
 */
export function createOAuthVerifiers(
  cfg: OAuthConfig,
  deps: {
    redactor: Redactor;
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    warn?: (message: string) => void;
  },
): OAuthVerifiers {
  const mode = verifyMode(cfg);
  const jwt = mode === 'introspection' ? undefined : new JwtVerifier(cfg, deps.fetch);
  let introspection: IntrospectionVerifier | undefined;
  if (mode !== 'jwt') {
    const settings = cfg.introspection;
    // The config schema refuses this; checked again for configs built in code.
    if (!settings) throw new Error(`http.oauth.verify: ${mode} needs http.oauth.introspection.`);
    const env = deps.env ?? process.env;
    const clientId = resolveEnv(settings.clientId, 'http.oauth.introspection.clientId', env);
    const clientSecret = resolveSecret(
      settings.clientSecret,
      'http.oauth.introspection.clientSecret',
      deps.redactor,
      env,
    );
    deps.redactor.addSecret(basicCredentials(clientId, clientSecret));
    introspection = new IntrospectionVerifier(
      cfg,
      { ...settings, clientId, clientSecret },
      { fetch: deps.fetch, warn: deps.warn },
    );
  }
  if (jwt && introspection)
    return { mode, verifier: new AutoVerifier(jwt, introspection), jwt, introspection };
  if (jwt) return { mode, verifier: jwt, jwt };
  if (introspection) return { mode, verifier: introspection, introspection };
  throw new Error('http.oauth: no token verifier.');
}
