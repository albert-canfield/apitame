import {
  constants,
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
  type SignKeyObjectInput,
} from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

/**
 * A minimal authorization server on 127.0.0.1: RFC 8414 or OpenID Connect
 * metadata, and a JWKS whose content and status tests can change.
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

  private constructor(
    private readonly http: Server,
    readonly issuer: string,
  ) {}

  static async start(): Promise<FakeAuthServer> {
    const http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    const self = new FakeAuthServer(http, `http://127.0.0.1:${port}`);
    http.on('request', (req, res) => self.handle(req.url ?? '/', res));
    return self;
  }

  get jwksUri(): string {
    return `${this.issuer}/jwks`;
  }

  count(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  publish(...keys: TestKey[]): void {
    this.keys = keys.map((k) => k.jwk);
  }

  private handle(path: string, res: ServerResponse): void {
    this.hits.set(path, this.count(path) + 1);
    const override = this.overrides.get(path);
    if (override) return override(res);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    const metadata = { issuer: this.metadataIssuer ?? this.issuer, jwks_uri: this.jwksUri };
    if (path === '/.well-known/oauth-authorization-server' && this.discovery === 'rfc8414')
      return json(200, metadata);
    if (path === '/.well-known/openid-configuration' && this.discovery === 'oidc')
      return json(200, metadata);
    if (path === '/jwks') return json(this.jwksStatus, { keys: this.keys });
    json(404, { error: 'not found' });
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
