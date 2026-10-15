import {
  constants,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
  type SignKeyObjectInput,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A key pair plus its public JWK, as an authorization server publishes it. */
export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function makeKey(
  kind: 'rsa' | 'ec' | 'ed25519',
  kid: string,
  jwkExtra: Record<string, unknown> = {},
  rsaBits = 2048,
): TestKey {
  const { privateKey, publicKey } =
    kind === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: rsaBits })
      : kind === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('ed25519');
  return {
    kid,
    privateKey,
    publicKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, ...jwkExtra },
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** How a signature is made. Deliberately independent of what the header claims. */
export type Signer = (data: Buffer) => Buffer;

export const signers = {
  rs:
    (key: KeyObject, hash = 'sha256'): Signer =>
    (data) =>
      sign(hash, data, key),
  ps:
    (key: KeyObject): Signer =>
    (data) =>
      sign('sha256', data, {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      } as SignKeyObjectInput),
  es:
    (key: KeyObject, hash = 'sha256'): Signer =>
    (data) =>
      sign(hash, data, { key, dsaEncoding: 'ieee-p1363' }),
  ed:
    (key: KeyObject): Signer =>
    (data) =>
      sign(null, data, key),
  hs:
    (secret: string | Buffer): Signer =>
    (data) =>
      createHmac('sha256', secret).update(data).digest(),
  none: (): Signer => () => Buffer.alloc(0),
};

export function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  signer: Signer,
): string {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${signer(Buffer.from(data)).toString('base64url')}`;
}

/** A request the fake introspection endpoint received. */
export interface IntrospectionRequest {
  method: string;
  contentType: string | undefined;
  accept: string | undefined;
  authorization: string | undefined;
  form: URLSearchParams;
}

/** The client apitame introspects tokens as, unless a test sets another one. */
export const INTROSPECTION_CLIENT = { id: 'apitame-rs', secret: 'introspection-s3cret!' };

/**
 * A minimal authorization server on 127.0.0.1: RFC 8414 or OpenID Connect
 * metadata, a JWKS whose content and status tests can change, and an RFC 7662
 * introspection endpoint at /introspect.
 */
export class FakeAuthServer {
  /** Keys published at /jwks. */
  keys: Array<Record<string, unknown>> = [];
  jwksStatus = 200;
  /** Which discovery document exists. */
  discovery: 'rfc8414' | 'oidc' = 'rfc8414';
  /** The `issuer` the metadata states; defaults to the real one. */
  metadataIssuer: string | undefined;
  /** Requests per path. */
  readonly hits = new Map<string, number>();
  /** Custom answers by path (a redirect, a slow or oversized body), checked first. */
  readonly overrides = new Map<string, (res: ServerResponse) => void>();
  /** What /introspect answers for each token. Any other token is inactive. */
  readonly answers = new Map<string, Record<string, unknown>>();
  /** Requests /introspect received. */
  readonly introspections: IntrospectionRequest[] = [];
  /** The client credentials /introspect requires (Basic or in the form body). */
  introspectionClient = { ...INTROSPECTION_CLIENT };
  /** When set, /introspect waits for it before answering. */
  introspectionGate: Promise<void> | undefined;

  private constructor(
    private readonly http: Server,
    readonly issuer: string,
  ) {}

  static async start(): Promise<FakeAuthServer> {
    const http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    const self = new FakeAuthServer(http, `http://127.0.0.1:${port}`);
    http.on('request', (req, res) => self.handle(req, res));
    return self;
  }

  get jwksUri(): string {
    return `${this.issuer}/jwks`;
  }

  get introspectionUrl(): string {
    return `${this.issuer}/introspect`;
  }

  /**
   * A new opaque token, and what /introspect answers for it: an active access token for
   * `resource` (see {@link activeAnswer}) with `extra` on top.
   */
  issue(resource: string, extra: Record<string, unknown> = {}): string {
    const token = `opaque_${randomBytes(18).toString('base64url')}`;
    this.answers.set(token, activeAnswer(this.issuer, resource, extra));
    return token;
  }

  count(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  publish(...keys: TestKey[]): void {
    this.keys = keys.map((k) => k.jwk);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = req.url ?? '/';
    this.hits.set(path, this.count(path) + 1);
    const override = this.overrides.get(path);
    if (override) {
      req.resume();
      return override(res);
    }
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (path === '/introspect') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          this.introspections.push({
            method: req.method ?? '',
            contentType: req.headers['content-type'],
            accept: req.headers.accept,
            authorization: req.headers.authorization,
            form,
          });
          await this.introspectionGate;
          if (!this.authenticated(req.headers.authorization, form))
            return json(401, { error: 'invalid_client' });
          json(200, this.answers.get(form.get('token') ?? '') ?? { active: false });
        })();
      });
      return;
    }
    const metadata = { issuer: this.metadataIssuer ?? this.issuer, jwks_uri: this.jwksUri };
    if (path === '/.well-known/oauth-authorization-server' && this.discovery === 'rfc8414')
      return json(200, metadata);
    if (path === '/.well-known/openid-configuration' && this.discovery === 'oidc')
      return json(200, metadata);
    if (path === '/jwks') return json(this.jwksStatus, { keys: this.keys });
    json(404, { error: 'not found' });
  }

  /** RFC 6749 section 2.3.1: Basic with URL-encoded id and secret, or both in the form body. */
  private authenticated(header: string | undefined, form: URLSearchParams): boolean {
    const { id, secret } = this.introspectionClient;
    const basic = /^Basic (.+)$/.exec(header ?? '');
    if (basic) {
      const decoded = Buffer.from(basic[1] as string, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return (
        decodeURIComponent(decoded.slice(0, colon)) === id &&
        decodeURIComponent(decoded.slice(colon + 1)) === secret
      );
    }
    return form.get('client_id') === id && form.get('client_secret') === secret;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.http.closeAllConnections();
      this.http.close(() => resolve());
    });
  }
}

/** Claims of a token that a verifier configured for `issuer` and `resource` accepts. */
export function claimsFor(
  issuer: string,
  resource: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    aud: resource,
    sub: 'user-1',
    client_id: 'client-1',
    scope: 'mcp:tools',
    iat: now,
    exp: now + 300,
    ...extra,
  };
}

/** What an introspection endpoint answers for an active access token meant for `resource`. */
export function activeAnswer(
  issuer: string,
  resource: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { active: true, token_type: 'Bearer', ...claimsFor(issuer, resource, extra) };
}
