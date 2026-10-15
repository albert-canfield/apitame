import { constants, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { AUDIENCES_NEED_A_FILTER } from '../config/schema.js';

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
  /** Other accepted `aud` values. Needs `scopes` or `clients` next to it. */
  audiences: string[];
  /** When not empty, only tokens issued to these clients (client_id, azp, cid or appid). */
  clients?: string[] | undefined;
  /** Require the RFC 9068 header `typ: at+jwt`, for servers that set it. */
  requireAccessTokenType?: boolean | undefined;
  /** JWKS location, when it cannot be discovered from the issuer's metadata. */
  jwksUri?: string | undefined;
}

/** Who a verified token speaks for, kept in `AuthInfo.extra`. Either may be missing. */
export interface TokenIdentity {
  client?: string;
  subject?: string;
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

/** Header `typ` values of an access token (RFC 9068), compared without case. */
const ACCESS_TOKEN_TYPES = new Set(['at+jwt', 'application/at+jwt']);
/** Payload claims that only ID tokens carry (OpenID Connect Core 2 and 3.3.2.11). */
const ID_TOKEN_CLAIMS = ['nonce', 'at_hash', 'c_hash'];
/** Payload `typ` values of tokens that are not access tokens (Keycloak), compared without case. */
const OTHER_TOKEN_TYPES = new Set(['id', 'refresh', 'offline']);
/** Claims that name the client a token was issued to, in order of preference. */
const CLIENT_CLAIMS = ['client_id', 'azp', 'cid', 'appid'];

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
/** Keys are refreshed in the background after this long, even when every key id is known. */
const MAX_KEY_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Metadata documents and key sets larger than this are refused. */
const MAX_BODY_BYTES = 1_000_000;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

const invalid = (message: string) => new OAuthError(OAuthErrorCode.InvalidToken, message);

/**
 * A value from a token or a remote document, safe to put in an error message or a log line:
 * JSON-encoded, printable ASCII only, at most 40 characters.
 */
export function show(value: unknown): string {
  const text = (JSON.stringify(value) ?? String(value)).replace(/[^\x20-\x7e]/g, '?');
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

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
  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) return false;
  return jwk.use === undefined || jwk.use === 'sig';
}

/** A NumericDate claim: absent, or a finite number. */
function numericDate(claims: Record<string, unknown>, name: string): number | undefined {
  const value = claims[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`The token's ${name} claim is not a number of seconds.`);
  return value;
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

/** Why a fetch failed, in a few words (fetch hides the reason, such as a redirect, in `cause`). */
function reason(err: unknown): string {
  const e = err as Error & { cause?: { message?: string } };
  return e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
}

/** Read a response body up to `limit` bytes. */
async function readCapped(res: Response, url: string): Promise<string> {
  const tooLarge = () => new Error(`${url} sent more than ${MAX_BODY_BYTES / 1_000_000} MB.`);
  if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) throw tooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Checks JWT access tokens against an authorization server's published keys. */
export class JwtVerifier {
  /** Published keys by key id. A key id may appear more than once (for example sig and enc). */
  private named = new Map<string, KeyEntry[]>();
  /** Published keys without a key id. */
  private anonymous: KeyEntry[] = [];
  /** When the key set was last loaded successfully. */
  private fetchedAt = Number.NEGATIVE_INFINITY;
  /** When the last load started, successful or not. */
  private triedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  private lastError: unknown;
  private jwksUri: string | undefined;
  private readonly accepted: Set<string>;
  private readonly clients: string[];

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
    this.clients = opts.clients ?? [];
    if (opts.audiences.length > 0 && opts.scopes.length === 0 && this.clients.length === 0) {
      throw new Error(`http.oauth.${AUDIENCES_NEED_A_FILTER}`);
    }
    this.jwksUri = opts.jwksUri;
    this.accepted = new Set([comparable(opts.resource), ...opts.audiences.map(comparable)]);
  }

  /** Fetch the key set now, so a misconfigured issuer shows up at startup. Returns the key count. */
  async warmUp(): Promise<number> {
    await this.refresh();
    if (this.lastError) throw this.lastError;
    return this.keyCount();
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (token.length > MAX_TOKEN_CHARS) throw invalid('The token is too large.');
    const parts = token.split('.');
    // Canonical base64url only, so one token has exactly one spelling.
    if (parts.length !== 3 || !parts.every((x) => BASE64URL.test(x)) || !parts[0] || !parts[1])
      throw invalid('The token is not a signed JWT.');
    const [h, p, s] = parts as [string, string, string];
    const header = decodeSegment(h, 'header');
    const alg = typeof header.alg === 'string' ? header.alg : undefined;
    const spec = alg === undefined ? undefined : algorithm(alg);
    if (!spec || alg === undefined)
      throw invalid(
        `Token algorithm ${header.alg === undefined ? 'missing' : show(header.alg)} is not accepted.`,
      );
    // RFC 7515: extensions marked critical must be understood, and none are.
    if (header.crit !== undefined) throw invalid('The token uses unsupported critical headers.');
    this.checkHeaderType(header.typ);
    const kid = typeof header.kid === 'string' ? header.kid : undefined;

    const candidates = await this.keysFor(kid, alg);
    // The key must fit the algorithm the token claims, or an attacker could pick an algorithm
    // that interprets the key differently.
    if (candidates.length === 0) throw invalid('The signing key does not match the algorithm.');
    const data = Buffer.from(`${h}.${p}`);
    const signature = Buffer.from(s, 'base64url');
    if (!candidates.some((entry) => signatureValid(spec, entry.key, data, signature)))
      throw invalid('The token signature is not valid.');

    const claims = decodeSegment(p, 'payload');
    const nowS = Math.floor(this.now() / 1000);
    if (claims.iss !== this.opts.issuer) throw invalid('The token was issued by another server.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((a) => typeof a === 'string' && this.accepted.has(comparable(a)))) {
      throw invalid('The token is not meant for this server (audience).');
    }
    // An ID token or a refresh token signed by the same server is not an access token, even
    // when its audience happens to be accepted.
    const payloadType = typeof claims.typ === 'string' ? claims.typ.toLowerCase() : undefined;
    if (
      ID_TOKEN_CLAIMS.some((c) => claims[c] !== undefined) ||
      (payloadType && OTHER_TOKEN_TYPES.has(payloadType))
    ) {
      throw invalid('The token is an ID or refresh token, not an access token.');
    }
    const exp = numericDate(claims, 'exp');
    if (exp === undefined) throw invalid('The token has no expiry.');
    if (exp <= nowS) throw invalid('The token has expired.');
    const nbf = numericDate(claims, 'nbf');
    if (nbf !== undefined && nbf - LEEWAY_S > nowS) throw invalid('The token is not valid yet.');
    const iat = numericDate(claims, 'iat');
    if (iat !== undefined && iat - LEEWAY_S > nowS)
      throw invalid('The token was issued in the future.');

    const scopes =
      typeof claims.scope === 'string'
        ? claims.scope.split(' ').filter(Boolean)
        : Array.isArray(claims.scp)
          ? claims.scp.filter((x): x is string => typeof x === 'string')
          : typeof claims.scp === 'string'
            ? claims.scp.split(' ').filter(Boolean)
            : [];
    const identity: TokenIdentity = {};
    const client = CLIENT_CLAIMS.map((c) => claims[c]).find(
      (x): x is string => typeof x === 'string' && x !== '',
    );
    if (client) identity.client = client;
    if (typeof claims.sub === 'string' && claims.sub !== '') identity.subject = claims.sub;
    if (this.clients.length > 0 && !(client && this.clients.includes(client))) {
      throw invalid('The token was issued to a client that http.oauth.clients does not list.');
    }
    return {
      token,
      // Required by the SDK type; apitame itself reads the client from `extra`.
      clientId: client ?? '',
      scopes,
      expiresAt: exp,
      // Checked above against the accepted audiences; reported as this server's URL.
      resource: new URL(this.opts.resource),
      extra: { ...identity },
    };
  }

  private checkHeaderType(typ: unknown): void {
    if (typ === undefined) {
      if (this.opts.requireAccessTokenType) throw this.untyped();
      return;
    }
    const value = typeof typ === 'string' ? typ.toLowerCase() : undefined;
    if (value && ACCESS_TOKEN_TYPES.has(value)) return;
    if (value === 'jwt' && !this.opts.requireAccessTokenType) return;
    if (value === 'jwt') throw this.untyped();
    throw invalid(`Token type ${show(typ)} is not an access token type.`);
  }

  private untyped(): OAuthError {
    return invalid(
      'The token is not typed as an access token (typ at+jwt), which http.oauth.requireAccessTokenType requires.',
    );
  }

  /**
   * The published keys that may verify this token. A known key id is answered from the cache at
   * once, even when a background refresh is due; only an unknown one waits for a refresh.
   */
  private async keysFor(kid: string | undefined, alg: string): Promise<KeyEntry[]> {
    let found = this.lookup(kid, alg);
    if (found) {
      if (this.now() - this.fetchedAt > MAX_KEY_AGE_MS && this.mayRefresh()) void this.refresh();
      return found;
    }
    if (this.loading) {
      await this.loading;
      found = this.lookup(kid, alg);
    }
    // An unknown key id usually means the server rotated its keys. Refresh, but not on every
    // request: random key ids must not turn this server into a request amplifier.
    if (!found && this.mayRefresh()) {
      await this.refresh();
      found = this.lookup(kid, alg);
    }
    if (!found) throw invalid('The token was signed with an unknown key.');
    return found;
  }

  /** Keys for a known key id that fit the algorithm (maybe none), or undefined when unknown. */
  private lookup(kid: string | undefined, alg: string): KeyEntry[] | undefined {
    if (kid !== undefined) return this.named.get(kid)?.filter((e) => keyFits(e.jwk, alg));
    // Without a key id, accept only an unambiguous match.
    const candidates = [...[...this.named.values()].flat(), ...this.anonymous].filter((e) =>
      keyFits(e.jwk, alg),
    );
    return candidates.length === 1 ? candidates : undefined;
  }

  private keyCount(): number {
    return [...this.named.values()].reduce((n, list) => n + list.length, this.anonymous.length);
  }

  private mayRefresh(): boolean {
    const gap = this.keyCount() > 0 ? MIN_REFRESH_MS : EMPTY_RETRY_MS;
    return this.now() - this.triedAt >= gap;
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

  /** GET a JSON document: no redirects (the configured URLs must be final), at most 1 MB. */
  private async getJson(url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const why = reason(err);
      const hint = /redirect/i.test(why) ? ' Redirects are not followed: use the final URL.' : '';
      throw new Error(`Fetching ${url} failed (${why}).${hint}`, { cause: err });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Fetching ${url} failed with HTTP ${res.status}.`);
    }
    const text = await readCapped(res, url);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${url} did not answer with JSON.`);
    }
  }

  private async load(): Promise<void> {
    this.jwksUri ??= await this.discoverJwksUri();
    const body = (await this.getJson(this.jwksUri)) as { keys?: unknown } | null;
    if (!Array.isArray(body?.keys)) throw new Error(`${this.jwksUri} is not a JWK set.`);
    const named = new Map<string, KeyEntry[]>();
    const anonymous: KeyEntry[] = [];
    for (const raw of body.keys) {
      if (!raw || typeof raw !== 'object') continue;
      const jwk = raw as Jwk;
      if (jwk.d !== undefined || jwk.k !== undefined) continue; // private or symmetric: never
      try {
        const key = createPublicKey({ key: jwk as never, format: 'jwk' });
        const bits = key.asymmetricKeyDetails?.modulusLength;
        if (key.asymmetricKeyType === 'rsa' && (bits ?? 0) < MIN_RSA_BITS) continue;
        if (typeof jwk.kid === 'string')
          named.set(jwk.kid, [...(named.get(jwk.kid) ?? []), { key, jwk }]);
        else anonymous.push({ key, jwk });
      } catch {
        // A key type Node cannot read is skipped.
      }
    }
    this.named = named;
    this.anonymous = anonymous;
  }

  private async discoverJwksUri(): Promise<string> {
    const problems: string[] = [];
    for (const url of metadataUrls(this.opts.issuer)) {
      let meta: { issuer?: unknown; jwks_uri?: unknown } | null;
      try {
        meta = (await this.getJson(url)) as typeof meta;
      } catch (err) {
        problems.push((err as Error).message);
        continue;
      }
      // Something that is not metadata (a catch-all page, an empty object) is not a verdict
      // on the issuer: try the next location.
      if (!meta || typeof meta !== 'object' || typeof meta.jwks_uri !== 'string') {
        problems.push(`${url} is not authorization server metadata.`);
        continue;
      }
      // RFC 8414 section 3.3: metadata that names another issuer must not be used.
      if (meta.issuer !== this.opts.issuer) {
        throw new Error(
          `The metadata at ${url} names issuer ${show(meta.issuer)}, expected "${this.opts.issuer}".`,
        );
      }
      assertSecureUrl(meta.jwks_uri, 'jwks_uri');
      return meta.jwks_uri;
    }
    throw new Error(
      `Could not read the authorization server metadata of ${this.opts.issuer}: ${problems.join(' ')} Set http.oauth.jwksUri.`,
    );
  }
}

function signatureValid(
  spec: NonNullable<ReturnType<typeof algorithm>>,
  key: KeyObject,
  data: Buffer,
  signature: Buffer,
): boolean {
  try {
    return verify(
      spec.hash,
      data,
      spec.pss
        ? {
            key,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
          }
        : spec.ecdsa
          ? { key, dsaEncoding: 'ieee-p1363' }
          : key,
      signature,
    );
  } catch {
    // A malformed signature is just an invalid one.
    return false;
  }
}

/** Resource identifiers compare without a fragment and one trailing slash, as the SDK does. */
function comparable(s: string): string {
  return s.replace(/#.*$/, '').replace(/\/$/, '');
}

/** The client and subject of a verified token (see {@link JwtVerifier.verifyAccessToken}). */
export function identityOf(auth: AuthInfo | undefined): TokenIdentity {
  const extra = auth?.extra ?? {};
  return {
    ...(typeof extra.client === 'string' ? { client: extra.client } : {}),
    ...(typeof extra.subject === 'string' ? { subject: extra.subject } : {}),
  };
}

/** Warnings about a configuration that works but accepts more than it probably should. */
export function oauthWarnings(opts: OAuthOptions): string[] {
  return opts.scopes.length === 0
    ? [
        'http.oauth.scopes is empty: any token the authorization server issues for this audience is accepted. Require a scope that only apitame clients get, such as mcp:tools.',
      ]
    : [];
}

/**
 * How `http.oauth` differs from what the server started with, if it does. `permissions` is left
 * out: the runtime applies it, so a reload picks it up.
 */
function oauthDiff(before: unknown, after: unknown): string | undefined {
  const withoutPermissions = (v: unknown) =>
    JSON.stringify(v && typeof v === 'object' ? { ...v, permissions: undefined } : (v ?? null));
  if (withoutPermissions(before) === withoutPermissions(after)) return undefined;
  return before === undefined ? 'was added' : after === undefined ? 'was removed' : 'changed';
}

/** What a `--watch` reload should say when `http.oauth` differs from what the server started with. */
export function oauthChange(before: unknown, after: unknown): string | undefined {
  const what = oauthDiff(before, after);
  return what && `http.oauth ${what}; restart apitame to apply it.`;
}

/**
 * Why a `--watch` reload must be refused, when the server checks OAuth tokens with `before`.
 * The transport keeps those settings until a restart, so a reload that removes or changes
 * `http.oauth` would serve OAuth callers with a config that no longer describes them: without
 * `http.oauth`, every caller would get the full server config instead of its permissions.
 */
export function oauthReloadRefusal(before: unknown, after: unknown): string | undefined {
  if (before === undefined) return undefined;
  const what = oauthDiff(before, after);
  return (
    what &&
    `http.oauth ${what}, but this server checks OAuth tokens with the settings it started with. Restart apitame to change http.oauth (per-user permissions apply on reload without one).`
  );
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
