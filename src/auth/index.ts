import type { AuthConfig } from '../config/schema.js';
import { envRefs, envValues, resolveEnv } from '../config/env.js';
import type { Redactor } from '../safety/redact.js';
import { withDeadline } from '../util/deadline.js';

export interface OutgoingRequest {
  url: URL;
  headers: Record<string, string>;
}

export interface AuthProvider {
  readonly type: AuthConfig['type'];
  /** Add credentials to a request. */
  apply(req: OutgoingRequest, opts?: { forceRefresh?: boolean }): Promise<void>;
  /** True if a 401 should trigger one retry with fresh credentials. */
  readonly canRefresh: boolean;
}

type FetchLike = typeof fetch;

const TOKEN_TIMEOUT_MS = 15_000;

/**
 * Resolve a config value and register it as a secret, together with every
 * environment value inside it: an API may echo back the bare token from
 * `SSWS ${OKTA_TOKEN}`, not only the full header value.
 */
export function resolveSecret(
  template: string,
  field: string,
  redactor: Redactor,
  env: NodeJS.ProcessEnv,
): string {
  const value = resolveEnv(template, field, env);
  redactor.addSecret(value);
  for (const v of envValues(template, env)) redactor.addSecret(v);
  return value;
}

/**
 * Build an auth provider from config. Secret values are resolved from the
 * environment here, registered with the redactor, and never stored elsewhere.
 */
export function createAuth(
  cfg: AuthConfig,
  redactor: Redactor,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  /** How long an OAuth2 token request may take, body included. */
  timeoutMs = TOKEN_TIMEOUT_MS,
): AuthProvider {
  switch (cfg.type) {
    case 'none':
      return { type: 'none', canRefresh: false, apply: async () => {} };

    case 'bearer': {
      const token = resolveSecret(cfg.token, 'auth.token', redactor, env);
      return {
        type: 'bearer',
        canRefresh: false,
        apply: async (req) => {
          req.headers['Authorization'] = `Bearer ${token}`;
        },
      };
    }

    case 'apiKey': {
      const value = resolveSecret(cfg.value, 'auth.value', redactor, env);
      if (cfg.in === 'header') redactor.addSensitiveHeader(cfg.name);
      return {
        type: 'apiKey',
        canRefresh: false,
        apply: async (req) => {
          if (cfg.in === 'header') req.headers[cfg.name] = value;
          else if (cfg.in === 'query') req.url.searchParams.set(cfg.name, value);
          else {
            const prev = req.headers['Cookie'];
            const pair = `${cfg.name}=${encodeURIComponent(value)}`;
            req.headers['Cookie'] = prev ? `${prev}; ${pair}` : pair;
          }
        },
      };
    }

    case 'basic': {
      // A username from the environment can be the credential itself (Stripe sends the key as username).
      const username =
        envRefs(cfg.username).length > 0
          ? resolveSecret(cfg.username, 'auth.username', redactor, env)
          : resolveEnv(cfg.username, 'auth.username', env);
      const password = resolveSecret(cfg.password, 'auth.password', redactor, env);
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      redactor.addSecret(encoded);
      return {
        type: 'basic',
        canRefresh: false,
        apply: async (req) => {
          req.headers['Authorization'] = `Basic ${encoded}`;
        },
      };
    }

    case 'oauth2':
      return new ClientCredentials(cfg, redactor, env, fetchImpl, timeoutMs);
  }
}

/**
 * The `client_secret_basic` credentials of an OAuth client (RFC 6749 section 2.3.1): id and
 * secret, each URL-encoded, joined by a colon, in base64.
 */
export function basicCredentials(clientId: string, clientSecret: string): string {
  return Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64');
}

type OAuth2Config = Extract<AuthConfig, { type: 'oauth2' }>;

/** OAuth2 client credentials grant with an in-memory token cache. */
class ClientCredentials implements AuthProvider {
  readonly type = 'oauth2' as const;
  readonly canRefresh = true;
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenUrl: string;

  constructor(
    private readonly cfg: OAuth2Config,
    private readonly redactor: Redactor,
    env: NodeJS.ProcessEnv,
    private readonly fetchImpl: FetchLike,
    private readonly timeoutMs: number,
  ) {
    this.clientId = resolveEnv(cfg.clientId, 'auth.clientId', env);
    this.clientSecret = resolveSecret(cfg.clientSecret, 'auth.clientSecret', redactor, env);
    this.tokenUrl = resolveEnv(cfg.tokenUrl, 'auth.tokenUrl', env);
    redactor.addSecret(basicCredentials(this.clientId, this.clientSecret));
  }

  async apply(req: OutgoingRequest, opts?: { forceRefresh?: boolean }): Promise<void> {
    const token = await this.getToken(opts?.forceRefresh ?? false);
    req.headers['Authorization'] = `Bearer ${token}`;
  }

  private async getToken(force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    // Share one token request between concurrent callers.
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.cfg.scopes.length > 0) body.set('scope', this.cfg.scopes.join(' '));
    if (this.cfg.audience) body.set('audience', this.cfg.audience);
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (this.cfg.clientAuthMethod === 'client_secret_basic') {
      headers['Authorization'] = `Basic ${basicCredentials(this.clientId, this.clientSecret)}`;
    } else {
      body.set('client_id', this.clientId);
      body.set('client_secret', this.clientSecret);
    }

    // One deadline for the request and the body: a token endpoint that sends its headers and then
    // stalls must not hold every API call waiting on the token.
    const { status, ok, raw } = await withDeadline(
      this.timeoutMs,
      () => new Error(`OAuth2 token request timed out after ${this.timeoutMs} ms.`),
      async (signal) => {
        let res: Response;
        try {
          res = await this.fetchImpl(this.tokenUrl, { method: 'POST', headers, body, signal });
        } catch (err) {
          // The original error is not attached as `cause`: it may hold unredacted secrets.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            `OAuth2 token request failed: ${this.redactor.text((err as Error).message)}`,
          );
        }
        return { status: res.status, ok: res.ok, raw: await res.text() };
      },
    );
    if (!ok) {
      throw new Error(
        `OAuth2 token request failed with HTTP ${status}: ${this.redactor.text(raw).slice(0, 300)}`,
      );
    }
    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new Error('OAuth2 token endpoint did not return JSON.');
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      throw new Error('OAuth2 token response has no access_token.');
    }
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3_600;
    this.redactor.addSecret(json.access_token);
    // Refresh 30 seconds early to avoid using a token that expires in flight.
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + Math.max(0, ttl - 30) * 1_000,
    };
    return json.access_token;
  }
}
