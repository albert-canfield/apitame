import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';

/**
 * OAuth 2.1 resource server support for the HTTP transport: apitame accepts
 * JWT access tokens (RFC 9068) issued by an external authorization server and
 * checks them locally against the server's published keys (JWKS). apitame
 * never issues tokens itself.
 */
export interface OAuthOptions {
  /** Authorization server issuer, exactly as it appears in the tokens' `iss` claim. */
  issuer: string;
  /** Public URL of this MCP endpoint. Tokens must name it (or one of `audiences`) in `aud`. */
  resource: string;
  /** Scopes every token must carry. */
  scopes: string[];
  /** Accepted `aud` values when the authorization server does not use the resource URL. */
  audiences: string[];
  /** JWKS location, when it cannot be discovered from the issuer's metadata. */
  jwksUri?: string | undefined;
}

type FetchLike = typeof fetch;
type Jwk = Record<string, unknown>;
interface KeyEntry {
  key: KeyObject;
  jwk: Jwk;
}

/** Signature algorithms accepted for access tokens, with the key type and parameters each needs. */
const ALGORITHMS: Record<
  string,
  { kty: string; crv?: string[]; hash: string | null; pss?: boolean; ecdsa?: boolean }
> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', crv: ['P-256'], hash: 'sha256', ecdsa: true },
  ES384: { kty: 'EC', crv: ['P-384'], hash: 'sha384', ecdsa: true },
  ES512: { kty: 'EC', crv: ['P-521'], hash: 'sha512', ecdsa: true },
  EdDSA: { kty: 'OKP', crv: ['Ed25519', 'Ed448'], hash: null },
};

/** Clock skew tolerated for `nbf` and `iat`. `exp` is strict, as the SDK's bearer check is. */
const LEEWAY_S = 60;
/** Tokens larger than this are refused before any parsing. */
const MAX_TOKEN_CHARS = 16_384;
/** RSA keys shorter than this are ignored (RFC 7518 requires 2048 bits). */
const MIN_RSA_BITS = 2048;
/** The key set is fetched again at most this often, whatever the tokens say. */
const MIN_REFRESH_MS = 60_000;
/** Until a key set has been loaded, a new attempt may happen this often. */
const EMPTY_RETRY_MS = 5_000;
/** Keys are refreshed after this long even when every key id is known. */
const MAX_KEY_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

/** The accepted algorithm, ignoring names inherited from Object (`constructor` and the like). */
const algorithm = (alg: string) => (Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg] : undefined);

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw invalid(`The token ${what} is not valid JSON.`);
}

/** Whether a published key may verify a token signed with `alg`. */
function keyFits(jwk: Jwk, alg: string): boolean {
  const spec = algorithm(alg);
  if (!spec || jwk.kty !== spec.kty) return false;
  if (spec.crv && !spec.crv.includes(String(jwk.crv))) return false;
  // A key pinned to one algorithm must not be used with another.
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  return jwk.use === undefined || jwk.use === 'sig';
}

/** `http` is only accepted for loopback hosts (local development and tests). */
export function assertSecureUrl(value: string, what: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${what} must use https: ${value}`);
  }
  return url;
}

/**
 * Where the authorization server publishes its metadata, in the order the MCP
 * specification gives: RFC 8414 first, then OpenID Connect discovery. For an
 * issuer with a path, the well-known segment goes before the path, and OpenID
 * Connect also gets the classic form with the segment after it.
 */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Checks JWT access tokens against an authorization server's published keys. */
export class JwtVerifier {
  private keys = new Map<string, KeyEntry>();
  /** When the key set was last loaded successfully. */
  private fetchedAt = Number.NEGATIVE_INFINITY;
  /** When the last load started, successful or not. */
  private triedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  private lastError: unknown;
  private jwksUri: string | undefined;
  private readonly accepted: Set<string>;

  constructor(
    private readonly opts: OAuthOptions,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const issuer = assertSecureUrl(opts.issuer, 'http.oauth.issuer');
    if (issuer.search || issuer.hash) {
      throw new Error(`http.oauth.issuer must not have a query or fragment: ${opts.issuer}`);
    }
    if (assertSecureUrl(opts.resource, 'http.oauth.resource').hash) {
      throw new Error(`http.oauth.resource must not have a fragment: ${opts.resource}`);
    }
    if (opts.jwksUri) assertSecureUrl(opts.jwksUri, 'http.oauth.jwksUri');
    this.jwksUri = opts.jwksUri;
    this.accepted = new Set([comparable(opts.resource), ...opts.audiences.map(comparable)]);
  }

  /** Fetch the key set now, so a misconfigured issuer shows up at startup. Returns the key count. */
  async warmUp(): Promise<number> {
    await this.refresh();
    if (this.lastError) throw this.lastError;
    return this.keys.size;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.length > MAX_TOKEN_CHARS) throw invalid('The token is too large.');
    const parts = token.split('.');
    if (parts.length !== 3) throw invalid('The token is not a signed JWT.');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeSegment(h, 'header');
    const alg = typeof header.alg === 'string' ? header.alg : '';
    const spec = algorithm(alg);
    if (!spec) throw invalid(`Token algorithm "${alg || 'none'}" is not accepted.`);
    // RFC 7515: extensions marked critical must be understood, and none are.
    if (header.crit !== undefined) throw invalid('The token uses unsupported critical headers.');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;

    const entry = await this.keyFor(kid, alg);
    // The key must fit the algorithm the token claims, or an attacker could pick an algorithm
    // that interprets the key differently.
    if (!keyFits(entry.jwk, alg)) throw invalid('The signing key does not match the algorithm.');

    let ok = false;
    try {
      ok = verify(
        spec.hash,
        Buffer.from(`${h}.${p}`),
        spec.pss
          ? {
              key: entry.key,
              padding: constants.RSA_PKCS1_PSS_PADDING,
              saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
            }
          : spec.ecdsa
            ? { key: entry.key, dsaEncoding: 'ieee-p1363' }
            : entry.key,
        Buffer.from(s, 'base64url'),
      );
    } catch {
      // A malformed signature is just an invalid one.
    }
    if (!ok) throw invalid('The token signature is not valid.');

    const claims = decodeSegment(p, 'payload');
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.opts.issuer) throw invalid('The token was issued by another server.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === 'string' && this.accepted.has(comparable(a)))) {
      throw invalid('The token is not meant for this server (audience).');
    }
    if (typeof claims.exp !== 'number') throw invalid('The token has no expiry.');
    if (claims.exp <= nowS) throw invalid('The token has expired.');
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > nowS)
      throw invalid('The token is not valid yet.');
    if (typeof claims.iat === 'number' && claims.iat - LEEWAY_S > nowS)
      throw invalid('The token was issued in the future.');

    const scopes =
      typeof claims.scope === 'string'
        ? claims.scope.split(' ').filter(Boolean)
        : Array.isArray(claims.scp)
          ? claims.scp.filter((x): x is string => typeof x === 'string')
          : typeof claims.scp === 'string'
            ? claims.scp.split(' ').filter(Boolean)
            : [];
    const clientId = [claims.client_id, claims.azp, claims.sub].find(
      (x): x is string => typeof x === 'string',
    );
    return {
      token,
      clientId: clientId ?? 'unknown',
      scopes,
      expiresAt: claims.exp,
      // Checked above against the accepted audiences; reported as this server's URL.
      resource: new URL(this.opts.resource),
      extra: { ...(typeof claims.sub === 'string' ? { subject: claims.sub } : {}) },
    };
  }

  private async keyFor(kid: string | undefined, alg: string): Promise<KeyEntry> {
    if (this.loading) await this.loading;
    if (this.now() - this.fetchedAt > MAX_KEY_AGE_MS && this.mayRefresh()) await this.refresh();
    let entry = this.find(kid, alg);
    // An unknown key id usually means the server rotated its keys. Refresh, but not on every
    // request: random key ids must not turn this server into a request amplifier.
    if (!entry && this.mayRefresh()) {
      await this.refresh();
      entry = this.find(kid, alg);
    }
    if (!entry) throw invalid('The token was signed with an unknown key.');
    return entry;
  }

  private mayRefresh(): boolean {
    const gap = this.keys.size > 0 ? MIN_REFRESH_MS : EMPTY_RETRY_MS;
    return this.now() - this.triedAt >= gap;
  }

  private find(kid: string | undefined, alg: string): KeyEntry | undefined {
    if (kid) return this.keys.get(kid);
    // Without a key id, accept only an unambiguous match.
    const candidates = [...this.keys.values()].filter((e) => keyFits(e.jwk, alg));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** Load the key set once, however many requests ask at the same time. Never rejects. */
  private refresh(): Promise<void> {
    this.loading ??= (async () => {
      this.triedAt = this.now();
      try {
        await this.load();
        this.fetchedAt = this.now();
        this.lastError = undefined;
      } catch (err) {
        // Keep the old keys: a temporary outage of the authorization server must not
        // reject tokens signed with keys we already know.
        this.lastError = err;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  private async load(): Promise<void> {
    this.jwksUri ??= await this.discoverJwksUri();
    const res = await this.fetchImpl(this.jwksUri, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Fetching ${this.jwksUri} failed with HTTP ${res.status}.`);
    const body = (await res.json().catch(() => ({}))) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error(`${this.jwksUri} is not a JWK set.`);
    const keys = new Map<string, KeyEntry>();
    let anonymous = 0;
    for (const raw of body.keys) {
      if (!raw || typeof raw !== 'object') continue;
      const jwk = raw as Jwk;
      if (jwk.d !== undefined || jwk.k !== undefined) continue; // private or symmetric: never
      try {
        const key = createPublicKey({ key: jwk as never, format: 'jwk' });
        const bits = key.asymmetricKeyDetails?.modulusLength;
        if (key.asymmetricKeyType === 'rsa' && (bits ?? 0) < MIN_RSA_BITS) continue;
        keys.set(typeof jwk.kid === 'string' ? jwk.kid : `#${anonymous++}`, { key, jwk });
      } catch {
        // A key type Node cannot read is skipped.
      }
    }
    this.keys = keys;
  }

  private async discoverJwksUri(): Promise<string> {
    for (const url of metadataUrls(this.opts.issuer)) {
      const res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => undefined);
      if (!res?.ok) continue;
      const meta = (await res.json().catch(() => ({}))) as { issuer?: unknown; jwks_uri?: unknown };
      // RFC 8414 section 3.3: metadata that names another issuer must not be used.
      if (meta.issuer !== this.opts.issuer) {
        throw new Error(
          `The metadata at ${url} names issuer "${String(meta.issuer)}", expected "${this.opts.issuer}".`,
        );
      }
      if (typeof meta.jwks_uri !== 'string')
        throw new Error(`The metadata at ${url} has no jwks_uri.`);
      assertSecureUrl(meta.jwks_uri, 'jwks_uri');
      return meta.jwks_uri;
    }
    throw new Error(
      `Could not read the authorization server metadata of ${this.opts.issuer}. Set http.oauth.jwksUri.`,
    );
  }
}

/** Resource identifiers compare without a fragment and one trailing slash, as the SDK does. */
function comparable(s: string): string {
  return s.replace(/#.*$/, '').replace(/\/$/, '');
}

/** The RFC 9728 Protected Resource Metadata document for this server. */
export function protectedResourceMetadata(opts: OAuthOptions, name: string) {
  return {
    resource: opts.resource,
    authorization_servers: [opts.issuer],
    bearer_methods_supported: ['header'],
    ...(opts.scopes.length > 0 ? { scopes_supported: opts.scopes } : {}),
    resource_name: name,
  };
}

/** Where RFC 9728 says the metadata lives: the well-known prefix, then the resource path. */
export function protectedResourceMetadataPath(resource: string): string {
  const path = new URL(resource).pathname.replace(/\/+$/, '');
  return `/.well-known/oauth-protected-resource${path}`;
}

/** The absolute metadata URL, advertised in `WWW-Authenticate` challenges. */
export function protectedResourceMetadataUrl(resource: string): string {
  return new URL(protectedResourceMetadataPath(resource), resource).href;
}
