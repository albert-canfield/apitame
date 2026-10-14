import { OAuthError } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSecureUrl,
  JwtVerifier,
  metadataUrls,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
  type OAuthOptions,
} from '../../src/server/oauth.js';
import {
  claimsFor,
  FakeAuthServer,
  makeKey,
  signers,
  signJwt,
  type TestKey,
} from '../oauth-fixtures.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const JWKS = '/jwks';

let as: FakeAuthServer;
let rsa: TestKey;
let ec: TestKey;
let ed: TestKey;
let attacker: TestKey;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  rsa = makeKey('rsa', 'rsa-1');
  ec = makeKey('ec', 'ec-1');
  ed = makeKey('ed25519', 'ed-1');
  attacker = makeKey('rsa', 'attacker');
});
afterAll(() => as.close());
beforeEach(() => {
  as.publish(rsa, ec, ed);
  as.jwksStatus = 200;
  as.discovery = 'rfc8414';
  as.metadataIssuer = undefined;
  as.hits.clear();
});

function verifier(opts: Partial<OAuthOptions> = {}, now?: () => number): JwtVerifier {
  return new JwtVerifier(
    { issuer: as.issuer, resource: RESOURCE, scopes: [], audiences: [], ...opts },
    fetch,
    now,
  );
}

const claims = (extra: Record<string, unknown> = {}) => claimsFor(as.issuer, RESOURCE, extra);
const rs256 = (extra: Record<string, unknown> = {}, kid = 'rsa-1') =>
  signJwt({ alg: 'RS256', kid, typ: 'at+jwt' }, claims(extra), signers.rs(rsa.privateKey));

/** The verifier refuses the token as invalid_token, with a message matching `reason`. */
async function refused(v: JwtVerifier, token: string, reason: RegExp): Promise<void> {
  const err = await v.verifyAccessToken(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'token was accepted').toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe('invalid_token');
  expect((err as Error).message).toMatch(reason);
}

describe('JwtVerifier: signatures and algorithms', () => {
  it('accepts RS256, PS256, ES256 and EdDSA tokens and reports who sent them', async () => {
    const v = verifier();
    const info = await v.verifyAccessToken(rs256());
    expect(info).toMatchObject({
      clientId: 'client-1',
      scopes: ['mcp:tools'],
      extra: { subject: 'user-1' },
    });
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const tokens = [
      signJwt({ alg: 'PS256', kid: 'rsa-1' }, claims(), signers.ps(rsa.privateKey)),
      signJwt({ alg: 'ES256', kid: 'ec-1' }, claims(), signers.es(ec.privateKey)),
      signJwt({ alg: 'EdDSA', kid: 'ed-1' }, claims(), signers.ed(ed.privateKey)),
    ];
    for (const token of tokens) {
      expect((await v.verifyAccessToken(token)).clientId).toBe('client-1');
    }
  });

  it('reads scopes from scp (array or string) and the client id from azp', async () => {
    const v = verifier();
    const a = await v.verifyAccessToken(
      rs256({ scope: undefined, scp: ['a', 'b'], client_id: undefined, azp: 'web-app' }),
    );
    expect(a.scopes).toEqual(['a', 'b']);
    expect(a.clientId).toBe('web-app');
    const b = await v.verifyAccessToken(rs256({ scope: undefined, scp: 'c d' }));
    expect(b.scopes).toEqual(['c', 'd']);
  });

  it('refuses alg none and HS256 signed with the public key as the HMAC secret', async () => {
    const v = verifier();
    await refused(v, signJwt({ alg: 'none', kid: 'rsa-1' }, claims(), signers.none()), /"none"/);
    await refused(v, signJwt({ kid: 'rsa-1' }, claims(), signers.none()), /"none"/);
    await refused(
      v,
      signJwt({ alg: 'constructor', kid: 'rsa-1' }, claims(), signers.none()),
      /"constructor" is not accepted/,
    );
    const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
    await refused(
      v,
      signJwt({ alg: 'HS256', kid: 'rsa-1' }, claims(), signers.hs(pem)),
      /"HS256" is not accepted/,
    );
  });

  it('refuses a valid signature by a key that is not in the key set', async () => {
    const v = verifier();
    // The attacker reuses a published key id, or leaves it out and embeds their own key.
    const forged = signJwt(
      { alg: 'RS256', kid: 'rsa-1' },
      claims(),
      signers.rs(attacker.privateKey),
    );
    await refused(v, forged, /signature is not valid/);
    const embedded = signJwt(
      { alg: 'RS256', jwk: attacker.jwk },
      claims(),
      signers.rs(attacker.privateKey),
    );
    await refused(v, embedded, /signature is not valid/);
  });

  it('refuses an RSA key used with an ES256 header (algorithm confusion)', async () => {
    // Signed by the real RSA key, so only the key type check stands in the way: Node would
    // verify an RSA signature even when the header says ECDSA.
    const token = signJwt({ alg: 'ES256', kid: 'rsa-1' }, claims(), signers.rs(rsa.privateKey));
    await refused(verifier(), token, /does not match the algorithm/);
  });

  it('refuses a P-256 key used with ES384', async () => {
    const token = signJwt(
      { alg: 'ES384', kid: 'ec-1' },
      claims(),
      signers.es(ec.privateKey, 'sha384'),
    );
    await refused(verifier(), token, /does not match the algorithm/);
  });

  it('honors the alg and use a key is published with', async () => {
    as.keys = [
      { ...rsa.jwk, kid: 'pinned', alg: 'RS256' },
      { ...rsa.jwk, kid: 'enc', use: 'enc' },
    ];
    const v = verifier();
    const pss = signJwt({ alg: 'PS256', kid: 'pinned' }, claims(), signers.ps(rsa.privateKey));
    await refused(v, pss, /does not match the algorithm/);
    expect((await v.verifyAccessToken(rs256({}, 'pinned'))).clientId).toBe('client-1');
    await refused(v, rs256({}, 'enc'), /does not match the algorithm/);
  });

  it('refuses tokens with critical header extensions', async () => {
    const token = signJwt(
      { alg: 'RS256', kid: 'rsa-1', crit: ['exp-ext'], 'exp-ext': true },
      claims(),
      signers.rs(rsa.privateKey),
    );
    await refused(verifier(), token, /critical/);
  });

  it('ignores RSA keys shorter than 2048 bits', async () => {
    const weak = makeKey('rsa', 'weak', {}, 1024);
    as.publish(weak);
    const token = signJwt({ alg: 'RS256', kid: 'weak' }, claims(), signers.rs(weak.privateKey));
    await refused(verifier(), token, /unknown key/);
  });

  it('without a key id, uses the only key that fits, and refuses when several do', async () => {
    const noKid = signJwt({ alg: 'RS256' }, claims(), signers.rs(rsa.privateKey));
    expect((await verifier().verifyAccessToken(noKid)).clientId).toBe('client-1');
    as.keys = [rsa.jwk, { ...rsa.jwk, kid: 'rsa-copy' }];
    await refused(verifier(), noKid, /unknown key/);
  });
});

describe('JwtVerifier: claims', () => {
  it('refuses a token for another audience, and accepts the configured audiences', async () => {
    const v = verifier({ audiences: ['api://apitame'] });
    await refused(v, rs256({ aud: 'https://other.example.com/mcp' }), /audience/);
    await refused(v, rs256({ aud: undefined }), /audience/);
    await v.verifyAccessToken(rs256({ aud: `${RESOURCE}/` }));
    await v.verifyAccessToken(rs256({ aud: ['https://other.example.com', 'api://apitame'] }));
  });

  it('refuses a token from another issuer', async () => {
    await refused(verifier(), rs256({ iss: 'https://evil.example.com' }), /another server/);
    await refused(verifier(), rs256({ iss: `${as.issuer}/` }), /another server/);
  });

  it('refuses expired tokens and tokens without an expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused(verifier(), rs256({ exp: now - 1 }), /expired/);
    await refused(verifier(), rs256({ exp: undefined }), /no expiry/);
  });

  it('tolerates a minute of clock skew on nbf and iat, and no more', async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = verifier();
    await v.verifyAccessToken(rs256({ nbf: now + 30, iat: now + 30 }));
    await refused(v, rs256({ nbf: now + 120 }), /not valid yet/);
    await refused(v, rs256({ iat: now + 120 }), /in the future/);
  });

  it('refuses malformed and oversized tokens', async () => {
    const v = verifier();
    await refused(v, 'not-a-jwt', /not a signed JWT/);
    await refused(v, 'e30.e30', /not a signed JWT/);
    await refused(v, '!!.e30.', /header is not valid JSON/);
    await refused(v, 'a'.repeat(20_000), /too large/);
  });
});

describe('JwtVerifier: key set', () => {
  it('refreshes the key set once for an unknown key id, and at most once a minute', async () => {
    let clock = Date.now();
    const v = verifier({}, () => clock);
    await v.warmUp();
    expect(as.count(JWKS)).toBe(1);

    // The authorization server rotates in a new key.
    const next = makeKey('rsa', 'rsa-2');
    as.publish(rsa, next);
    const rotated = signJwt({ alg: 'RS256', kid: 'rsa-2' }, claims(), signers.rs(next.privateKey));
    clock += 61_000;
    expect((await v.verifyAccessToken(rotated)).clientId).toBe('client-1');
    expect(as.count(JWKS)).toBe(2);

    // Made-up key ids do not make it fetch again within the minute.
    const ghost = signJwt(
      { alg: 'RS256', kid: 'ghost' },
      claims(),
      signers.rs(attacker.privateKey),
    );
    for (let i = 0; i < 5; i++) {
      clock += 1_000;
      await refused(v, ghost, /unknown key/);
    }
    expect(as.count(JWKS)).toBe(2);
    clock += 60_000;
    await refused(v, ghost, /unknown key/);
    expect(as.count(JWKS)).toBe(3);
    // Known keys keep working without a fetch.
    await v.verifyAccessToken(rs256());
    expect(as.count(JWKS)).toBe(3);
  });

  it('keeps the keys it has when the authorization server is down', async () => {
    let clock = Date.now();
    const v = verifier({}, () => clock);
    await v.warmUp();
    as.jwksStatus = 500;
    clock += 2 * 60 * 60_000; // older than the maximum key age: a refresh is due
    const later = Math.floor(clock / 1000);
    const token = rs256({ iat: later, exp: later + 300 });
    expect((await v.verifyAccessToken(token)).clientId).toBe('client-1');
    expect(as.count(JWKS)).toBe(2);
    // The failed refresh is not retried on every request.
    await v.verifyAccessToken(token);
    expect(as.count(JWKS)).toBe(2);
  });

  it('retries within seconds while no key has loaded yet', async () => {
    let clock = Date.now();
    const v = verifier({}, () => clock);
    as.jwksStatus = 503;
    await expect(v.warmUp()).rejects.toThrow(/HTTP 503/);
    as.jwksStatus = 200;
    clock += 1_000;
    await refused(v, rs256(), /unknown key/);
    expect(as.count(JWKS)).toBe(1);
    clock += 5_000;
    expect((await v.verifyAccessToken(rs256())).clientId).toBe('client-1');
    expect(as.count(JWKS)).toBe(2);
  });

  it('discovers the key set through RFC 8414 or OpenID Connect metadata', async () => {
    expect(await verifier().warmUp()).toBe(3);
    expect(as.count('/.well-known/oauth-authorization-server')).toBe(1);
    as.discovery = 'oidc';
    expect(await verifier().warmUp()).toBe(3);
    expect(as.count('/.well-known/openid-configuration')).toBe(1);
  });

  it('refuses metadata that names another issuer', async () => {
    as.metadataIssuer = 'https://evil.example.com';
    await expect(verifier().warmUp()).rejects.toThrow(
      /names issuer "https:\/\/evil\.example\.com"/,
    );
    expect(as.count(JWKS)).toBe(0);
  });

  it('uses http.oauth.jwksUri without discovery', async () => {
    expect(await verifier({ jwksUri: as.jwksUri }).warmUp()).toBe(3);
    expect(as.count('/.well-known/oauth-authorization-server')).toBe(0);
  });

  it('never loads private or symmetric keys', async () => {
    // A private key published by mistake means the key is compromised: tokens it signed
    // are refused rather than trusted.
    const leaked = makeKey('ec', 'leaked');
    const secret = Buffer.from('shared-secret').toString('base64url');
    as.keys = [
      { ...leaked.privateKey.export({ format: 'jwk' }), kid: 'leaked' },
      { kty: 'oct', k: secret, kid: 'oct' },
    ];
    expect(await verifier().warmUp()).toBe(0);
    const token = signJwt({ alg: 'ES256', kid: 'leaked' }, claims(), signers.es(leaked.privateKey));
    await refused(verifier(), token, /unknown key/);
  });

  it('lets requests that arrive while the keys load wait for them', async () => {
    const v = verifier();
    const [keys, info] = await Promise.all([v.warmUp(), v.verifyAccessToken(rs256())]);
    expect(keys).toBe(3);
    expect(info.clientId).toBe('client-1');
    expect(as.count(JWKS)).toBe(1);
  });
});

describe('OAuth URLs and metadata', () => {
  it('requires https except on loopback hosts', () => {
    expect(() => assertSecureUrl('http://auth.example.com', 'issuer')).toThrow(/must use https/);
    for (const ok of ['https://auth.example.com', 'http://localhost:8080', 'http://[::1]:9000']) {
      expect(() => assertSecureUrl(ok, 'issuer')).not.toThrow();
    }
    const base = { resource: RESOURCE, scopes: [], audiences: [] };
    expect(() => new JwtVerifier({ ...base, issuer: 'http://auth.example.com' })).toThrow(
      /http\.oauth\.issuer must use https/,
    );
    expect(
      () => new JwtVerifier({ ...base, issuer: 'https://auth.example.com/?tenant=1' }),
    ).toThrow(/query or fragment/);
    expect(
      () =>
        new JwtVerifier({
          ...base,
          issuer: 'https://auth.example.com',
          jwksUri: 'http://k.example',
        }),
    ).toThrow(/jwksUri must use https/);
  });

  it('builds the authorization server metadata URLs in the order MCP gives', () => {
    expect(metadataUrls('https://as.example.com/')).toEqual([
      'https://as.example.com/.well-known/oauth-authorization-server',
      'https://as.example.com/.well-known/openid-configuration',
    ]);
    expect(metadataUrls('https://login.example.com/tenant/v2.0')).toEqual([
      'https://login.example.com/.well-known/oauth-authorization-server/tenant/v2.0',
      'https://login.example.com/.well-known/openid-configuration/tenant/v2.0',
      'https://login.example.com/tenant/v2.0/.well-known/openid-configuration',
    ]);
  });

  it('describes the protected resource as RFC 9728 asks', () => {
    const opts = {
      issuer: 'https://auth.example.com',
      resource: RESOURCE,
      scopes: ['mcp:tools'],
      audiences: [],
    };
    expect(protectedResourceMetadata(opts, 'shop')).toEqual({
      resource: RESOURCE,
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
      resource_name: 'shop',
    });
    expect(protectedResourceMetadata({ ...opts, scopes: [] }, 'shop')).not.toHaveProperty(
      'scopes_supported',
    );
    expect(protectedResourceMetadataPath(RESOURCE)).toBe(
      '/.well-known/oauth-protected-resource/mcp',
    );
    expect(protectedResourceMetadataPath('https://mcp.example.com/')).toBe(
      '/.well-known/oauth-protected-resource',
    );
    expect(protectedResourceMetadataUrl('https://example.com/tools/github/mcp')).toBe(
      'https://example.com/.well-known/oauth-protected-resource/tools/github/mcp',
    );
  });
});
