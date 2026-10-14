import { OAuthError } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSecureUrl,
  JwtVerifier,
  metadataUrls,
  oauthChange,
  oauthWarnings,
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
  as.overrides.clear();
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
    await refused(v, signJwt({ kid: 'rsa-1' }, claims(), signers.none()), /missing/);
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
    const v = verifier({ audiences: ['api://apitame'], scopes: ['mcp:tools'] });
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
    await refused(verifier(), rs256({ exp: String(now + 300) }), /exp claim is not a number/);
  });

  it('refuses dates that are not finite numbers (an exp of 1e400 never expires)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = verifier();
    const infinite = signJwt(
      { alg: 'RS256', kid: 'rsa-1' },
      claims({ exp: '__EXP__' }),
      signers.rs(rsa.privateKey),
    );
    // JSON cannot express Infinity, but 1e400 parses to it: build that payload by hand.
    const [h, p] = infinite.split('.') as [string, string];
    const payload = Buffer.from(p, 'base64url').toString().replace('"__EXP__"', '1e400');
    const data = `${h}.${Buffer.from(payload).toString('base64url')}`;
    const token = `${data}.${signers.rs(rsa.privateKey)(Buffer.from(data)).toString('base64url')}`;
    await refused(v, token, /exp claim is not a number/);
    await refused(v, rs256({ nbf: String(now + 99_999) }), /nbf claim is not a number/);
    await refused(v, rs256({ iat: 'yesterday' }), /iat claim is not a number/);
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
    await refused(v, '!!.e30.', /not a signed JWT/);
    await refused(
      v,
      `${Buffer.from('not json').toString('base64url')}.e30.`,
      /header is not valid JSON/,
    );
    await refused(v, 'a'.repeat(20_000), /too large/);
    // One token has one spelling: padding, junk or standard base64 in a segment are refused.
    const good = rs256();
    await v.verifyAccessToken(good);
    await refused(v, `${good}==`, /not a signed JWT/);
    await refused(v, `${good}!!`, /not a signed JWT/);
    const [h, p, sig] = good.split('.') as [string, string, string];
    const standard = Buffer.from(sig, 'base64url').toString('base64');
    expect(standard).toMatch(/[+/=]/);
    await refused(v, `${h}.${p}.${standard}`, /not a signed JWT/);
  });

  it('never echoes raw header values into errors and logs', async () => {
    const v = verifier();
    const forged = 'X"\r\n[apitame] error: FORGED LOG LINE';
    for (const header of [
      { alg: forged },
      { alg: 'A'.repeat(11_000) },
      { alg: 'RS256', kid: 'rsa-1', typ: forged },
    ]) {
      const err = (await v
        .verifyAccessToken(signJwt(header, claims(), signers.rs(rsa.privateKey)))
        .catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.message).not.toMatch(/[\r\n]/);
      expect(err.message.length).toBeLessThan(120);
    }
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
    // The refresh runs in the background.
    await vi.waitFor(() => expect(as.count(JWKS)).toBe(2));
    // The failed refresh is not retried on every request.
    await v.verifyAccessToken(token);
    await new Promise((r) => setTimeout(r, 50));
    expect(as.count(JWKS)).toBe(2);
  });

  it('answers known keys from the cache while a refresh is slow; only unknown keys wait', async () => {
    let clock = Date.now();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let slow = false;
    const gatedFetch: typeof fetch = async (input, init) => {
      if (slow && String(input).endsWith(JWKS)) await gate;
      return fetch(input, init);
    };
    const v = new JwtVerifier(
      { issuer: as.issuer, resource: RESOURCE, scopes: [], audiences: [] },
      gatedFetch,
      () => clock,
    );
    await v.warmUp();
    slow = true;
    clock += 2 * 60 * 60_000; // a refresh is due, and the key set host hangs
    const later = Math.floor(clock / 1000);
    expect((await v.verifyAccessToken(rs256({ iat: later, exp: later + 300 }))).clientId).toBe(
      'client-1',
    );
    // A rotated key is unknown: that request waits for the refresh in flight.
    const next = makeKey('ec', 'ec-2');
    as.publish(rsa, next);
    let settled = false;
    const rotated = v
      .verifyAccessToken(
        signJwt(
          { alg: 'ES256', kid: 'ec-2' },
          claims({ iat: later, exp: later + 300 }),
          signers.es(next.privateKey),
        ),
      )
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    release();
    expect((await rotated).clientId).toBe('client-1');
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

  it('never follows redirects for metadata or keys', async () => {
    const elsewhere = `${as.issuer}/elsewhere`;
    as.overrides.set(JWKS, (res) => res.writeHead(302, { Location: elsewhere }).end());
    await expect(verifier().warmUp()).rejects.toThrow(/Redirects are not followed/);
    expect(as.count('/elsewhere')).toBe(0);
    // A redirecting discovery document is skipped like a missing one.
    as.overrides.clear();
    as.overrides.set('/.well-known/oauth-authorization-server', (res) =>
      res.writeHead(301, { Location: elsewhere }).end(),
    );
    await expect(verifier().warmUp()).rejects.toThrow(
      /Could not read .*Redirects are not followed/,
    );
    expect(as.count('/elsewhere')).toBe(0);
  });

  it('refuses metadata or key sets larger than 1 MB', async () => {
    const huge = JSON.stringify({ keys: [rsa.jwk], padding: 'x'.repeat(1_100_000) });
    as.overrides.set(JWKS, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Chunked, without a Content-Length, so only the streaming cap can stop it.
      res.write(huge.slice(0, 600_000));
      res.end(huge.slice(600_000));
    });
    await expect(verifier().warmUp()).rejects.toThrow(/more than 1 MB/);
  });

  it('moves on when a discovery URL answers 200 with something that is not metadata', async () => {
    as.discovery = 'oidc';
    as.overrides.set('/.well-known/oauth-authorization-server', (res) =>
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>app</html>'),
    );
    expect(await verifier().warmUp()).toBe(3);
    expect(as.count('/.well-known/openid-configuration')).toBe(1);
    as.overrides.set('/.well-known/oauth-authorization-server', (res) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
    );
    expect(await verifier().warmUp()).toBe(3);
  });

  it('keeps every key published under one key id and uses the one that fits', async () => {
    const enc = makeKey('rsa', 'rsa-1', { use: 'enc' });
    const ecSame = makeKey('ec', 'rsa-1');
    as.keys = [rsa.jwk, enc.jwk, ecSame.jwk];
    const v = verifier();
    expect(await v.warmUp()).toBe(3);
    await v.verifyAccessToken(rs256());
    const es = signJwt({ alg: 'ES256', kid: 'rsa-1' }, claims(), signers.es(ecSame.privateKey));
    await v.verifyAccessToken(es);
    // The encryption key under the same id never verifies anything.
    const byEnc = signJwt({ alg: 'RS256', kid: 'rsa-1' }, claims(), signers.rs(enc.privateKey));
    await refused(v, byEnc, /signature is not valid/);
  });

  it('honors key_ops', async () => {
    as.keys = [
      { ...rsa.jwk, kid: 'encrypt-only', key_ops: ['encrypt'] },
      { ...rsa.jwk, kid: 'verify', key_ops: ['verify'] },
    ];
    const v = verifier();
    await refused(v, rs256({}, 'encrypt-only'), /does not match the algorithm/);
    await v.verifyAccessToken(rs256({}, 'verify'));
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

describe('JwtVerifier: token types and identity', () => {
  const oidc = { scopes: ['mcp:tools'], audiences: ['mcp-client-id'] };

  it('refuses ID tokens and refresh tokens, even when their audience is accepted', async () => {
    const v = verifier(oidc);
    const idToken = (extra: Record<string, unknown>) =>
      signJwt(
        { alg: 'RS256', kid: 'rsa-1', typ: 'JWT' },
        claims({ aud: 'mcp-client-id', azp: 'mcp-client-id', ...extra }),
        signers.rs(rsa.privateKey),
      );
    for (const marker of [{ nonce: 'n-0S6' }, { at_hash: 'HK6E' }, { c_hash: 'LDkt' }]) {
      await refused(v, idToken(marker), /ID or refresh token/);
    }
    for (const typ of ['ID', 'Refresh', 'Offline', 'refresh']) {
      await refused(v, rs256({ typ }), /ID or refresh token/);
    }
    // Keycloak access tokens say typ Bearer in the payload.
    await v.verifyAccessToken(rs256({ typ: 'Bearer' }));
  });

  it('accepts header typ at+jwt, application/at+jwt, JWT or none, and refuses other types', async () => {
    const v = verifier();
    const typed = (typ: unknown) =>
      signJwt(
        { alg: 'RS256', kid: 'rsa-1', ...(typ === undefined ? {} : { typ }) },
        claims(),
        signers.rs(rsa.privateKey),
      );
    for (const ok of [undefined, 'at+jwt', 'application/at+jwt', 'AT+JWT', 'JWT', 'jwt']) {
      await v.verifyAccessToken(typed(ok));
    }
    for (const bad of ['id_token+jwt', 'logout+jwt', 'application/okta-internal-at+jwt', 7]) {
      await refused(v, typed(bad), /is not an access token type/);
    }
  });

  it('with requireAccessTokenType, accepts only at+jwt', async () => {
    const v = verifier({ requireAccessTokenType: true });
    await v.verifyAccessToken(rs256());
    const header = (typ?: string) => ({ alg: 'RS256', kid: 'rsa-1', ...(typ ? { typ } : {}) });
    await v.verifyAccessToken(
      signJwt(header('application/at+jwt'), claims(), signers.rs(rsa.privateKey)),
    );
    await refused(v, signJwt(header('JWT'), claims(), signers.rs(rsa.privateKey)), /typ at\+jwt/);
    await refused(v, signJwt(header(), claims(), signers.rs(rsa.privateKey)), /typ at\+jwt/);
  });

  it('with clients, accepts only tokens issued to those clients', async () => {
    const v = verifier({ clients: ['mcp-app'] });
    for (const claim of ['client_id', 'azp', 'cid', 'appid']) {
      await v.verifyAccessToken(rs256({ client_id: undefined, [claim]: 'mcp-app' }));
    }
    await refused(v, rs256({ client_id: 'billing-spa' }), /http\.oauth\.clients/);
    await refused(v, rs256({ client_id: undefined }), /http\.oauth\.clients/);
  });

  it('refuses broad audiences without scopes or clients', () => {
    expect(() => verifier({ audiences: ['api://default'] })).toThrow(/Also set scopes or clients/);
    expect(() => verifier({ audiences: ['api://default'], clients: ['mcp-app'] })).not.toThrow();
  });

  it('keeps the client and the subject apart', async () => {
    const v = verifier();
    const both = await v.verifyAccessToken(rs256({ client_id: undefined, cid: 'okta-app' }));
    expect(both.extra).toEqual({ client: 'okta-app', subject: 'user-1' });
    // client_id wins over azp, cid and appid.
    const order = await v.verifyAccessToken(rs256({ azp: 'b', cid: 'c', appid: 'd' }));
    expect(order.extra?.client).toBe('client-1');
    // The subject is never taken for a client.
    const userOnly = await v.verifyAccessToken(rs256({ client_id: undefined }));
    expect(userOnly.extra).toEqual({ subject: 'user-1' });
    expect(userOnly.clientId).toBe('');
    const neither = await v.verifyAccessToken(rs256({ client_id: undefined, sub: undefined }));
    expect(neither.extra).toEqual({});
  });

  it('warns about a configuration without scopes, and about http.oauth changes on reload', () => {
    const base = { issuer: 'https://a.example', resource: RESOURCE, audiences: [] };
    expect(oauthWarnings({ ...base, scopes: [] })[0]).toMatch(/scopes is empty/);
    expect(oauthWarnings({ ...base, scopes: ['mcp:tools'] })).toEqual([]);
    const cfg = { ...base, scopes: ['mcp:tools'] };
    expect(oauthChange(cfg, { ...cfg })).toBeUndefined();
    expect(oauthChange(undefined, undefined)).toBeUndefined();
    expect(oauthChange(undefined, cfg)).toMatch(/was added; restart/);
    expect(oauthChange(cfg, undefined)).toMatch(/was removed; restart/);
    expect(oauthChange(cfg, { ...cfg, scopes: [] })).toMatch(/changed; restart/);
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
