import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { OAuthError } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import type { OAuthConfig } from '../../src/config/schema.js';
import { Redactor } from '../../src/safety/redact.js';
import {
  AutoVerifier,
  createOAuthVerifiers,
  IntrospectionMisconfigured,
  IntrospectionVerifier,
  MAX_CACHED_TOKENS,
  MAX_WARNED_CLIENTS,
  REFUSED,
  type IntrospectionDeps,
  type IntrospectionSettings,
} from '../../src/server/introspection.js';
import { JwtVerifier, type OAuthOptions } from '../../src/server/oauth.js';
import {
  activeAnswer,
  claimsFor,
  FakeAuthServer,
  INTROSPECTION_CLIENT,
  makeKey,
  signers,
  signJwt,
  type TestKey,
} from '../oauth-fixtures.js';
import { startDripServer } from '../helpers.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const INTROSPECT = '/introspect';

let as: FakeAuthServer;
let key: TestKey;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  key = makeKey('ec', 'ec-1');
});
afterAll(() => as.close());
beforeEach(() => {
  as.publish(key);
  as.hits.clear();
  as.overrides.clear();
  as.answers.clear();
  as.introspections.length = 0;
  as.introspectionClient = { ...INTROSPECTION_CLIENT };
  as.introspectionGate = undefined;
});

function verifier(
  settings: Partial<IntrospectionSettings> = {},
  deps: IntrospectionDeps = {},
  opts: Partial<OAuthOptions> = {},
): IntrospectionVerifier {
  return new IntrospectionVerifier(
    { issuer: as.issuer, resource: RESOURCE, scopes: [], audiences: [], ...opts },
    {
      url: as.introspectionUrl,
      clientId: INTROSPECTION_CLIENT.id,
      clientSecret: INTROSPECTION_CLIENT.secret,
      ...settings,
    },
    deps,
  );
}

/** A new opaque token that the fake authorization server answers for. */
const opaque = (extra: Record<string, unknown> = {}) => as.issue(RESOURCE, extra);
const calls = () => as.count(INTROSPECT);

/**
 * The verifier refuses the token as invalid_token for a reason matching `reason`. A token
 * refused on what the authorization server answered carries the reason as `cause` (the client
 * only gets a general description, checked on its own below); other refusals say it directly.
 */
async function refused(
  v: { verifyAccessToken(t: string): Promise<unknown> },
  token: string,
  reason: RegExp,
): Promise<OAuthError> {
  const err = await v.verifyAccessToken(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'token was accepted').toBeInstanceOf(OAuthError);
  expect((err as OAuthError).code).toBe('invalid_token');
  const cause = (err as Error).cause;
  expect(cause instanceof Error ? cause.message : (err as Error).message).toMatch(reason);
  return err as OAuthError;
}

/**
 * The verifier could not reach a verdict: a plain error (the transport answers 500 and logs it),
 * never an invalid_token answer and never access.
 */
async function failed(v: IntrospectionVerifier, token: string, reason: RegExp): Promise<Error> {
  const err = await v.verifyAccessToken(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'token was accepted').toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(OAuthError);
  expect((err as Error).message).toMatch(reason);
  return err as Error;
}

describe('IntrospectionVerifier: requests and answers', () => {
  it('posts the token as RFC 7662 asks, with Basic client credentials, and reports who sent it', async () => {
    const token = opaque();
    const info = await verifier().verifyAccessToken(token);
    expect(info).toMatchObject({
      token,
      clientId: 'client-1',
      scopes: ['mcp:tools'],
      extra: { client: 'client-1', subject: 'user-1' },
    });
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.expiresAt).toBe(as.answers.get(token)?.exp);

    expect(as.introspections).toHaveLength(1);
    const req = as.introspections[0]!;
    expect(req.method).toBe('POST');
    expect(req.contentType).toBe('application/x-www-form-urlencoded');
    expect(req.accept).toBe('application/json');
    expect(Object.fromEntries(req.form)).toEqual({
      token,
      token_type_hint: 'access_token',
    });
    // RFC 6749 section 2.3.1: id and secret are URL-encoded before base64.
    const basic = Buffer.from(req.authorization!.replace(/^Basic /, ''), 'base64').toString();
    expect(basic).toBe(`apitame-rs:${encodeURIComponent('introspection-s3cret!')}`);
  });

  it('sends the client credentials in the form body with client_secret_post', async () => {
    const token = opaque();
    await verifier({ clientAuthMethod: 'client_secret_post' }).verifyAccessToken(token);
    const req = as.introspections[0]!;
    expect(req.authorization).toBeUndefined();
    expect(req.form.get('client_id')).toBe(INTROSPECTION_CLIENT.id);
    expect(req.form.get('client_secret')).toBe(INTROSPECTION_CLIENT.secret);
  });

  it('refuses inactive, revoked and unknown tokens', async () => {
    const v = verifier();
    const revoked = opaque();
    as.answers.set(revoked, { active: false });
    await refused(v, revoked, /not active/);
    await refused(v, 'never-issued', /not active/);
    // An active flag that is not exactly true is no answer at all.
    as.answers.set(revoked, { ...activeAnswer(as.issuer, RESOURCE), active: 'true' });
    await failed(v, revoked, /RFC 7662/);
  });

  it('refuses a token for another audience or issuer, and accepts the configured audiences', async () => {
    const v = verifier({}, {}, { audiences: ['api://apitame'], scopes: ['mcp:tools'] });
    await refused(v, opaque({ aud: 'https://other.example.com/mcp' }), /audience/);
    await refused(v, opaque({ aud: undefined }), /audience/);
    await refused(v, opaque({ iss: 'https://evil.example.com' }), /another server/);
    await refused(v, opaque({ iss: `${as.issuer}/` }), /another server/);
    // RFC 7662 lets the answer leave iss out: it comes from the authorization server itself.
    await v.verifyAccessToken(opaque({ iss: undefined }));
    await v.verifyAccessToken(opaque({ aud: `${RESOURCE}/` }));
    await v.verifyAccessToken(opaque({ aud: ['https://other.example.com', 'api://apitame'] }));
  });

  it('refuses tokens without an expiry, expired ones and ones not valid yet', async () => {
    const v = verifier();
    const now = Math.floor(Date.now() / 1000);
    await refused(v, opaque({ exp: undefined }), /no expiry/);
    await refused(v, opaque({ exp: now - 1 }), /expired/);
    await refused(v, opaque({ exp: String(now + 300) }), /exp claim is not a number/);
    await refused(v, opaque({ nbf: now + 120 }), /not valid yet/);
    await refused(v, opaque({ iat: now + 120 }), /in the future/);
    await v.verifyAccessToken(opaque({ nbf: now + 30 }));
  });

  it('refuses refresh tokens, ID tokens and tokens bound to a client key', async () => {
    const v = verifier();
    for (const token_type of [
      'refresh_token',
      'Refresh_Token',
      'urn:ietf:params:oauth:token-type:refresh_token',
      'id_token',
    ]) {
      await refused(v, opaque({ token_type }), /not an access token \(token_type/);
    }
    await refused(v, opaque({ token_use: 'refresh_token' }), /not an access token \(token_use/);
    await refused(v, opaque({ token_use: 'id' }), /not an access token \(token_use/);
    await refused(v, opaque({ token_type: 7 }), /token_type is not text/);
    // Keycloak marks the type in typ; ID tokens carry nonce or at_hash.
    await refused(v, opaque({ typ: 'Refresh' }), /ID or refresh token/);
    await refused(v, opaque({ nonce: 'n-0S6' }), /ID or refresh token/);
    // A DPoP- or certificate-bound token is not a bearer token apitame can check.
    await refused(v, opaque({ token_type: 'DPoP' }), /bound to a key/);
    await refused(
      v,
      opaque({ cnf: { 'x5t#S256': 'bwcK0esc3ACC3DB2Y5_lESsXE8o9ltc05O89jdN-dg2' } }),
      /bound to a key/,
    );
    for (const extra of [
      { token_type: 'Bearer' },
      { token_type: 'access_token' },
      { token_type: 'urn:ietf:params:oauth:token-type:access_token' },
      { token_type: undefined },
      { token_use: 'access_token' },
      { token_use: 'access' },
      { typ: 'Bearer' },
    ]) {
      await v.verifyAccessToken(opaque(extra));
    }
  });

  it('with clients, accepts only tokens issued to those clients, and keeps client and subject apart', async () => {
    const v = verifier({}, {}, { clients: ['mcp-app'] });
    expect((await v.verifyAccessToken(opaque({ client_id: 'mcp-app' }))).extra).toEqual({
      client: 'mcp-app',
      subject: 'user-1',
    });
    await refused(v, opaque({ client_id: 'billing-spa' }), /http\.oauth\.clients/);
    await refused(v, opaque({ client_id: undefined }), /http\.oauth\.clients/);
    const open = verifier();
    const userOnly = await open.verifyAccessToken(opaque({ client_id: undefined }));
    expect(userOnly.extra).toEqual({ subject: 'user-1' });
    expect(userOnly.clientId).toBe('');
    const scopes = await open.verifyAccessToken(opaque({ scope: 'mcp:tools  mcp:write' }));
    expect(scopes.scopes).toEqual(['mcp:tools', 'mcp:write']);
  });

  it('refuses what is not a bearer token, or too large, without asking', async () => {
    const v = verifier();
    for (const token of ['tok"en', 'a,b', 'café', 'x\r\ny', '=abc', 'a'.repeat(20_000)]) {
      await refused(v, token, /not a valid bearer token|too large/);
    }
    expect(calls()).toBe(0);
  });
});

describe('IntrospectionVerifier: what callers and operators learn', () => {
  it('answers every refusal of an answer with one description, and keeps the reason as cause', async () => {
    const v = verifier({}, {}, { clients: ['client-1'] });
    const now = Math.floor(Date.now() / 1000);
    const revoked = opaque();
    as.answers.set(revoked, { active: false });
    const cases: Array<[string, RegExp]> = [
      [revoked, /not active/],
      ['never-issued', /not active/],
      [opaque({ aud: 'https://other.example.com/mcp' }), /audience/],
      [opaque({ iss: 'https://evil.example.com' }), /another server/],
      [opaque({ exp: now - 1 }), /expired/],
      [opaque({ client_id: 'billing-spa' }), /http\.oauth\.clients/],
      [opaque({ token_type: 'refresh_token' }), /not an access token/],
      [opaque({ cnf: { jkt: 'x' } }), /bound to a key/],
    ];
    for (const [token, reason] of cases) {
      const err = await refused(v, token, reason);
      // RFC 7662 section 4: the caller must not learn why, or it could probe the server.
      expect(err.message).toBe(REFUSED);
      expect((err.cause as Error).message).toMatch(reason);
    }
    // A malformed token says what is wrong: nothing about it came from the server.
    expect((await refused(v, 'tok"en', /not a valid bearer token/)).message).not.toBe(REFUSED);
  });

  it('refuses refresh, offline and ID tokens however their type is spelled', async () => {
    const v = verifier();
    const spellings = [
      'refresh_token',
      'refresh',
      'Refresh Token',
      ' refresh_token',
      'refresh-token',
      'RefreshToken',
      'urn:ietf:params:oauth:token-type:refresh_token',
      'id_token',
      'id',
      'ID',
      'id-token',
      'Id Token',
      'urn:ietf:params:oauth:token-type:id_token',
      'offline',
      'Offline',
      'offline_token',
      'Offline Token',
    ];
    for (const value of spellings) {
      for (const field of ['token_type', 'token_use']) {
        await refused(v, opaque({ [field]: value }), /not an access token/);
      }
      await refused(v, opaque({ typ: value }), /ID or refresh token/);
    }
    for (const ok of ['Bearer', 'access_token', 'Access Token', 'N_A', 'identity']) {
      await v.verifyAccessToken(opaque({ token_type: ok, typ: ok }));
    }
  });

  it('warns once per client when answers name no user, and never takes username instead', async () => {
    const warnings: string[] = [];
    const v = verifier({}, { warn: (m) => warnings.push(m) });
    const info = await v.verifyAccessToken(opaque({ sub: undefined, username: 'alice' }));
    expect(info.extra).toEqual({ client: 'client-1' });
    await v.verifyAccessToken(opaque({ sub: undefined }));
    await v.verifyAccessToken(opaque({ sub: '', client_id: 'other-app' }));
    await v.verifyAccessToken(opaque({ sub: undefined, client_id: undefined }));
    await v.verifyAccessToken(opaque());
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(
      /client "client-1" name no user \(sub\), so all its users count as one caller/,
    );
    expect(warnings[1]).toMatch(/client "other-app"/);
    expect(warnings[2]).toMatch(/neither a client nor a user/);
  });

  it(`warns about at most ${MAX_WARNED_CLIENTS} clients`, async () => {
    const now = Math.floor(Date.now() / 1000);
    const fakeFetch: typeof fetch = async (_url, init) => {
      const token = new URLSearchParams(String(init?.body)).get('token');
      return new Response(
        JSON.stringify(
          activeAnswer(as.issuer, RESOURCE, { sub: undefined, client_id: token, exp: now + 300 }),
        ),
      );
    };
    const warnings: string[] = [];
    const v = verifier(
      { maxCallsPerMinute: 100_000 },
      { fetch: fakeFetch, warn: (m) => warnings.push(m) },
    );
    for (let i = 0; i <= MAX_WARNED_CLIENTS; i++) await v.verifyAccessToken(`client-${i}`);
    expect(warnings).toHaveLength(MAX_WARNED_CLIENTS);
  });
});

describe('IntrospectionVerifier: cache', () => {
  it('reuses an active answer for cacheSeconds, and never past the token expiry', async () => {
    let clock = Date.now();
    const v = verifier({ cacheSeconds: 60 }, { now: () => clock });
    const token = opaque();
    await v.verifyAccessToken(token);
    await v.verifyAccessToken(token);
    clock += 59_000;
    await v.verifyAccessToken(token);
    expect(calls()).toBe(1);
    clock += 2_000;
    await v.verifyAccessToken(token);
    expect(calls()).toBe(2);

    // A token that expires in 10 seconds is asked about again after 10 seconds, not 60.
    const shortLived = opaque({ exp: Math.floor(clock / 1000) + 10 });
    await v.verifyAccessToken(shortLived);
    expect(calls()).toBe(3);
    clock += 11_000;
    await refused(v, shortLived, /expired/);
    expect(calls()).toBe(4);
  });

  it('hands each request its own copy of a cached answer', async () => {
    const v = verifier();
    const token = opaque();
    const first = await v.verifyAccessToken(token);
    first.scopes.push('mcp:admin');
    (first.extra as Record<string, unknown>).subject = 'mallory';
    const second = await v.verifyAccessToken(token);
    expect(second.scopes).toEqual(['mcp:tools']);
    expect(second.extra).toEqual({ client: 'client-1', subject: 'user-1' });
    expect(calls()).toBe(1);
  });

  it('with cacheSeconds 0, asks about every request', async () => {
    const v = verifier({ cacheSeconds: 0 });
    const token = opaque();
    await v.verifyAccessToken(token);
    await v.verifyAccessToken(token);
    expect(calls()).toBe(2);
    // So a revoked token is refused at once.
    as.answers.set(token, { active: false });
    await refused(v, token, /not active/);
  });

  it('never remembers a refusal', async () => {
    const v = verifier();
    await refused(v, 'unknown-token', /not active/);
    await refused(v, 'unknown-token', /not active/);
    const elsewhere = opaque({ aud: 'https://other.example.com/mcp' });
    await refused(v, elsewhere, /audience/);
    await refused(v, elsewhere, /audience/);
    expect(calls()).toBe(4);
    // A token refused once is accepted when the server changes its mind (it was not cached).
    as.answers.set(elsewhere, activeAnswer(as.issuer, RESOURCE));
    await v.verifyAccessToken(elsewhere);
  });

  it('keeps no raw token in memory: the cache is keyed by a hash', async () => {
    const v = verifier();
    const good = opaque();
    const bad = opaque({ aud: 'https://other.example.com/mcp' });
    await v.verifyAccessToken(good);
    await refused(v, bad, /audience/);
    as.overrides.set(INTROSPECT, (res) => res.writeHead(503).end());
    const failing = opaque();
    await failed(v, failing, /HTTP 503/);
    const everything = inspect(v, {
      depth: null,
      showHidden: true,
      maxArrayLength: null,
      maxStringLength: null,
    });
    // The cache is in there, under the token's hash...
    expect(everything).toContain(createHash('sha256').update(good).digest('base64url'));
    expect(everything).toContain('client-1');
    // ...but none of the tokens themselves.
    for (const token of [good, bad, failing]) expect(everything).not.toContain(token);
  });

  it('shares one introspection request between concurrent requests for the same token', async () => {
    const v = verifier();
    let release = () => {};
    as.introspectionGate = new Promise<void>((r) => (release = r));
    const token = opaque();
    const pending = Array.from({ length: 20 }, () => v.verifyAccessToken(token));
    await vi.waitFor(() => expect(as.introspections).toHaveLength(1));
    const unknown = Array.from({ length: 10 }, () =>
      v.verifyAccessToken('unknown-token').catch((e: unknown) => e),
    );
    await vi.waitFor(() => expect(as.introspections).toHaveLength(2));
    release();
    for (const info of await Promise.all(pending)) expect(info.extra?.subject).toBe('user-1');
    for (const err of await Promise.all(unknown)) expect(err).toBeInstanceOf(OAuthError);
    expect(calls()).toBe(2);
    // Once settled, the next request is answered from the cache, or asks again when refused.
    await v.verifyAccessToken(token);
    await refused(v, 'unknown-token', /not active/);
    expect(calls()).toBe(3);
  });

  it(`keeps at most ${MAX_CACHED_TOKENS} answers, dropping the least recently used`, async () => {
    // In memory: ten thousand answers over HTTP would only make the test slow.
    let asked = 0;
    const now = Math.floor(Date.now() / 1000);
    const fakeFetch: typeof fetch = async () => {
      asked++;
      return new Response(JSON.stringify(activeAnswer(as.issuer, RESOURCE, { exp: now + 300 })));
    };
    const v = verifier({ maxCallsPerMinute: 100_000 }, { fetch: fakeFetch });
    const tokens = Array.from({ length: MAX_CACHED_TOKENS }, (_, i) => `token-${i}`);
    for (const t of tokens) await v.verifyAccessToken(t);
    expect(asked).toBe(MAX_CACHED_TOKENS);
    await v.verifyAccessToken('token-0'); // used again: now the most recent
    await v.verifyAccessToken('one-more'); // makes room by dropping token-1
    expect(asked).toBe(MAX_CACHED_TOKENS + 1);
    await v.verifyAccessToken('token-0');
    expect(asked).toBe(MAX_CACHED_TOKENS + 1);
    await v.verifyAccessToken('token-1');
    expect(asked).toBe(MAX_CACHED_TOKENS + 2);
  });
});

describe('IntrospectionVerifier: limits and failures', () => {
  it('caps introspection requests per minute under a flood of random tokens', async () => {
    let clock = Date.now();
    const warnings: string[] = [];
    const v = verifier(
      { maxCallsPerMinute: 5 },
      { now: () => clock, warn: (m) => warnings.push(m) },
    );
    const good = opaque();
    await v.verifyAccessToken(good);
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        v.verifyAccessToken(`random-${i}`).then(
          () => 'accepted',
          (e: unknown) => (e as OAuthError).code,
        ),
      ),
    );
    expect(results.filter((r) => r === 'accepted')).toHaveLength(0);
    expect(results.filter((r) => r === 'invalid_token')).toHaveLength(4);
    expect(results.filter((r) => r === 'server_error')).toHaveLength(46);
    expect(calls()).toBe(5);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/maxCallsPerMinute/);
    // A token checked before the flood keeps working, without a request.
    await v.verifyAccessToken(good);
    // A new good token waits for the window too: refused as a server error, not as invalid.
    const late = opaque();
    const err = (await v.verifyAccessToken(late).catch((e: unknown) => e)) as OAuthError;
    expect(err.code).toBe('server_error');
    expect(err.message).toMatch(/Try again in a minute/);
    expect(calls()).toBe(5);
    clock += 60_000;
    await v.verifyAccessToken(late);
    expect(calls()).toBe(6);
  });

  it('never follows a redirect', async () => {
    as.overrides.set(INTROSPECT, (res) =>
      res.writeHead(307, { Location: `${as.issuer}/elsewhere` }).end(),
    );
    await failed(verifier(), opaque(), /Redirects are not followed/);
    expect(as.count('/elsewhere')).toBe(0);
  });

  it('refuses answers larger than 1 MB', async () => {
    const huge = JSON.stringify({
      ...activeAnswer(as.issuer, RESOURCE),
      pad: 'x'.repeat(1_100_000),
    });
    as.overrides.set(INTROSPECT, (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Chunked, without a Content-Length, so only the streaming cap can stop it.
      res.write(huge.slice(0, 600_000));
      res.end(huge.slice(600_000));
    });
    await failed(verifier(), opaque(), /more than 1 MB/);
  });

  it('fails closed when the endpoint is down, errs, hangs or does not answer as RFC 7662 says', async () => {
    const answers: Array<[(res: ServerResponse) => void, RegExp]> = [
      [(res) => res.writeHead(500).end('{"active":true}'), /HTTP 500/],
      [(res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html/>'), /JSON/],
      [(res) => res.writeHead(200).end('{"active":"yes"}'), /RFC 7662/],
      [(res) => res.writeHead(200).end('[]'), /RFC 7662/],
      [(res) => res.writeHead(200).end('{}'), /RFC 7662/],
    ];
    for (const [answer, reason] of answers) {
      as.overrides.set(INTROSPECT, answer);
      await failed(verifier(), opaque(), reason);
    }
    // An endpoint that never answers is given up on after the timeout.
    as.overrides.set(INTROSPECT, () => {});
    await failed(verifier({}, { timeoutMs: 200 }), opaque(), /timed out after 200 ms/);
    // Nothing listens there any more.
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
    const { port } = gone.address() as AddressInfo;
    await new Promise<void>((r) => gone.close(() => r()));
    await failed(verifier({ url: `http://127.0.0.1:${port}/introspect` }), opaque(), /failed/);
  });

  it('reports rejected client credentials without reading what the server sent back', async () => {
    as.introspectionClient = { id: 'apitame-rs', secret: 'another-secret' };
    const err = await failed(verifier(), opaque(), /HTTP 401.*clientId and clientSecret/);
    // An error page that echoes the request never reaches the message.
    as.overrides.set(INTROSPECT, (res) =>
      res.writeHead(401).end(`bad client ${INTROSPECTION_CLIENT.secret}`),
    );
    const echoed = await failed(verifier(), opaque(), /HTTP 401/);
    for (const e of [err, echoed]) expect(e.message).not.toContain(INTROSPECTION_CLIENT.secret);
  });

  it('warmUp checks the endpoint and the credentials with a token nobody issued', async () => {
    await verifier().warmUp();
    expect(as.introspections[0]?.form.get('token')).toMatch(/^apitame-check-[0-9a-f]{32}$/);
    as.introspectionClient = { id: 'apitame-rs', secret: 'another-secret' };
    await expect(verifier().warmUp()).rejects.toThrow(/HTTP 401/);
  });
});

describe('IntrospectionVerifier: signed-in users during a flood', () => {
  it('keeps signed-in users working through a flood longer than cacheSeconds', async () => {
    let clock = Date.now();
    const warnings: string[] = [];
    const v = verifier(
      { maxCallsPerMinute: 20, cacheSeconds: 10 },
      { now: () => clock, warn: (m) => warnings.push(m) },
    );
    const users = ['ann', 'bob', 'cat'].map((sub) => opaque({ sub }));
    for (const u of users) await v.verifyAccessToken(u);
    const outcome = { users: { ok: 0, refused: 0 }, junk: { invalid: 0, limited: 0 } };
    let junk = 0;
    // Three minutes: every second, five made-up tokens and a request from each user. Their
    // cached answers go stale every 10 seconds, so each user is checked again 18 times.
    for (let second = 0; second < 180; second++) {
      clock += 1_000;
      for (let j = 0; j < 5; j++) {
        const code = await v.verifyAccessToken(`junk-${junk++}`).then(
          () => 'accepted',
          (e: unknown) => (e as OAuthError).code,
        );
        if (code === 'invalid_token') outcome.junk.invalid++;
        else if (code === 'server_error') outcome.junk.limited++;
        else throw new Error(`made-up token: ${code}`);
      }
      for (const u of users) {
        await v.verifyAccessToken(u).then(
          () => outcome.users.ok++,
          () => outcome.users.refused++,
        );
      }
    }
    expect(outcome.users).toEqual({ ok: 540, refused: 0 });
    // Made-up tokens got at most 20 introspections a minute; the rest never left apitame.
    expect(outcome.junk.invalid).toBeLessThanOrEqual(60);
    expect(outcome.junk.limited).toBe(900 - outcome.junk.invalid);
    // Re-checks are bounded by the real users: three of them, every 10 seconds.
    const rechecks = calls() - users.length - outcome.junk.invalid;
    expect(rechecks).toBeGreaterThan(0);
    expect(rechecks).toBeLessThanOrEqual(3 * 18);
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).toMatch(/new tokens were introspected/);
  });

  it('never answers from a stale entry: a user revoked during a flood is refused, then forgotten', async () => {
    let clock = Date.now();
    const v = verifier({ maxCallsPerMinute: 2, cacheSeconds: 10 }, { now: () => clock });
    const user = opaque();
    await v.verifyAccessToken(user);
    await refused(v, 'junk-1', /not active/);
    const full = (await v.verifyAccessToken('junk-2').catch((e: unknown) => e)) as OAuthError;
    expect(full.code).toBe('server_error');
    as.answers.set(user, { active: false });
    clock += 11_000;
    // Checked again from the re-check budget, although new tokens have none left.
    await refused(v, user, /not active/);
    expect(calls()).toBe(3);
    // Refused, so forgotten: the token now counts as new, and that budget is spent.
    const again = (await v.verifyAccessToken(user).catch((e: unknown) => e)) as OAuthError;
    expect(again.code).toBe('server_error');
    expect(again.message).toMatch(/new tokens/);
    expect(calls()).toBe(3);
  });

  it('counts a token as new again once it has expired', async () => {
    let clock = Date.now();
    const v = verifier({ maxCallsPerMinute: 2, cacheSeconds: 10 }, { now: () => clock });
    const shortLived = opaque({ exp: Math.floor(clock / 1000) + 5 });
    await v.verifyAccessToken(shortLived);
    await refused(v, 'junk-1', /not active/);
    clock += 6_000;
    // Past its expiry, it has no claim on the re-check budget: the budget for new tokens is spent.
    const err = (await v.verifyAccessToken(shortLived).catch((e: unknown) => e)) as OAuthError;
    expect(err.code).toBe('server_error');
    expect(err.message).toMatch(/new tokens/);
  });

  it('caps re-checks too', async () => {
    let clock = Date.now();
    const warnings: string[] = [];
    const v = verifier(
      { maxCallsPerMinute: 2, cacheSeconds: 0 },
      { now: () => clock, warn: (m) => warnings.push(m) },
    );
    const [a, b] = [opaque(), opaque()];
    await v.verifyAccessToken(a);
    await v.verifyAccessToken(b);
    // With cacheSeconds 0, every request asks again, from the re-check budget.
    clock += 1_000;
    await v.verifyAccessToken(a);
    await v.verifyAccessToken(b);
    const err = (await v.verifyAccessToken(a).catch((e: unknown) => e)) as OAuthError;
    expect(err.code).toBe('server_error');
    expect(err.message).toMatch(/check again/);
    expect(calls()).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/already seen active were introspected again/);
    clock += 60_000;
    await v.verifyAccessToken(a);
  });
});

describe('IntrospectionVerifier: startup check and connections', () => {
  it('warmUp refuses an endpoint that calls a token nobody issued active', async () => {
    as.overrides.set(INTROSPECT, (res) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(activeAnswer(as.issuer, RESOURCE))),
    );
    const err = await verifier()
      .warmUp()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntrospectionMisconfigured);
    expect((err as Error).message).toMatch(/random token nobody issued is active/);
  });

  it('warmUp counts against the budget for new tokens', async () => {
    const v = verifier({ maxCallsPerMinute: 1 });
    await v.warmUp();
    const err = (await v.verifyAccessToken(opaque()).catch((e: unknown) => e)) as OAuthError;
    expect(err.code).toBe('server_error');
    expect(calls()).toBe(1);
  });

  it('closes the connection of an answer it does not read', async () => {
    const answers: Array<[number, Record<string, string>, RegExp]> = [
      [500, {}, /HTTP 500/],
      [401, {}, /HTTP 401/],
      [200, { 'Content-Length': '2000000' }, /more than 1 MB/],
    ];
    for (const [status, headers, reason] of answers) {
      const drip = await startDripServer('{"active":', status, headers);
      try {
        // The default timeout (5 s) would close it too, but much later.
        await failed(verifier({ url: drip.url }), opaque(), reason);
        await vi.waitFor(() => expect(drip.open()).toBe(0), { timeout: 1_000 });
      } finally {
        await drip.close();
      }
    }
  });
});

describe('Token verifiers from http.oauth', () => {
  const base = { name: 'x', source: { type: 'openapi', spec: 'x.yaml' } };
  const oauthConfig = (oauth: Record<string, unknown>): OAuthConfig =>
    parseConfig({ ...base, http: { oauth: { resource: RESOURCE, ...oauth } } }).http.oauth!;
  const introspection = {
    url: '',
    clientId: '${INTROSPECTION_ID}',
    clientSecret: '${INTROSPECTION_SECRET}',
  };
  const env = {
    INTROSPECTION_ID: INTROSPECTION_CLIENT.id,
    INTROSPECTION_SECRET: INTROSPECTION_CLIENT.secret,
  };
  const jwt = (extra: Record<string, unknown> = {}) =>
    signJwt(
      { alg: 'ES256', kid: 'ec-1' },
      claimsFor(as.issuer, RESOURCE, extra),
      signers.es(key.privateKey),
    );

  it('requires https except on loopback, and no credentials in the URL', () => {
    const settings = { clientId: 'a', clientSecret: 'b' };
    const opts = { issuer: as.issuer, resource: RESOURCE, scopes: [], audiences: [] };
    expect(
      () => new IntrospectionVerifier(opts, { ...settings, url: 'http://auth.example.com/i' }),
    ).toThrow(/introspection\.url must use https/);
    expect(
      () => new IntrospectionVerifier(opts, { ...settings, url: 'https://u:p@auth.example.com/i' }),
    ).toThrow(/must not contain credentials/);
    // The same checks of http.oauth as for JWTs.
    expect(
      () =>
        new IntrospectionVerifier(
          { ...opts, audiences: ['api://default'] },
          { ...settings, url: 'https://auth.example.com/i' },
        ),
    ).toThrow(/Also set scopes or clients/);
    expect(
      () =>
        new IntrospectionVerifier(
          { ...opts, issuer: 'http://auth.example.com' },
          { ...settings, url: 'https://auth.example.com/i' },
        ),
    ).toThrow(/http\.oauth\.issuer must use https/);
  });

  it('resolves the credentials from the environment and registers the secret with the redactor', async () => {
    const redactor = new Redactor();
    const built = createOAuthVerifiers(
      oauthConfig({
        issuer: as.issuer,
        introspection: { ...introspection, url: as.introspectionUrl },
      }),
      { redactor, env },
    );
    expect(built.mode).toBe('introspection');
    expect(built.verifier).toBeInstanceOf(IntrospectionVerifier);
    expect(built.jwt).toBeUndefined();
    expect((await built.verifier.verifyAccessToken(opaque())).extra?.subject).toBe('user-1');

    const secret = INTROSPECTION_CLIENT.secret;
    const basic = as.introspections[0]!.authorization!.replace(/^Basic /, '');
    const line = redactor.text(
      `secret=${secret} form=${encodeURIComponent(secret)} basic=${basic}`,
    );
    for (const value of [secret, encodeURIComponent(secret), basic]) {
      expect(line).not.toContain(value);
    }
    // The client id is an identifier, not a secret.
    expect(redactor.text('client apitame-rs')).toBe('client apitame-rs');

    expect(() =>
      createOAuthVerifiers(
        oauthConfig({
          issuer: as.issuer,
          introspection: { ...introspection, url: as.introspectionUrl },
        }),
        { redactor, env: {} },
      ),
    ).toThrow(/Missing environment variables? INTROSPECTION_ID/);
  });

  it('verify: auto checks JWTs locally and introspects every other token', async () => {
    const built = createOAuthVerifiers(
      oauthConfig({
        issuer: as.issuer,
        verify: 'auto',
        introspection: { ...introspection, url: as.introspectionUrl },
      }),
      { redactor: new Redactor(), env },
    );
    expect(built.verifier).toBeInstanceOf(AutoVerifier);
    expect((await built.verifier.verifyAccessToken(jwt())).extra?.subject).toBe('user-1');
    expect(calls()).toBe(0);
    // A forged JWT is refused locally: it is never sent to the authorization server.
    const forged = signJwt(
      { alg: 'ES256', kid: 'ec-1' },
      claimsFor(as.issuer, RESOURCE),
      signers.es(makeKey('ec', 'other').privateKey),
    );
    await refused(built.verifier, forged, /signature/);
    expect(calls()).toBe(0);
    await built.verifier.verifyAccessToken(opaque());
    // Three segments that are not a JWT header, and an encrypted (five-part) token, are opaque.
    await refused(built.verifier, 'abc.def.ghi', /not active/);
    await refused(built.verifier, 'a.b.c.d.e', /not active/);
    expect(calls()).toBe(3);
  });

  it('verify: jwt never introspects, verify: introspection introspects JWTs too', async () => {
    const jwtOnly = createOAuthVerifiers(oauthConfig({ issuer: as.issuer }), {
      redactor: new Redactor(),
    });
    expect(jwtOnly.mode).toBe('jwt');
    expect(jwtOnly.verifier).toBeInstanceOf(JwtVerifier);
    expect(jwtOnly.introspection).toBeUndefined();
    await refused(jwtOnly.verifier, opaque(), /not a signed JWT/);
    expect(calls()).toBe(0);

    const all = createOAuthVerifiers(
      oauthConfig({
        issuer: as.issuer,
        introspection: { ...introspection, url: as.introspectionUrl },
      }),
      { redactor: new Redactor(), env },
    );
    const token = jwt();
    as.answers.set(token, activeAnswer(as.issuer, RESOURCE));
    await all.verifier.verifyAccessToken(token);
    expect(calls()).toBe(1);
    // Revoked at the authorization server: refused although its signature is fine.
    as.answers.set(token, { active: false });
    const fresh = createOAuthVerifiers(
      oauthConfig({
        issuer: as.issuer,
        introspection: { ...introspection, url: as.introspectionUrl },
      }),
      { redactor: new Redactor(), env },
    );
    await refused(fresh.verifier, token, /not active/);
  });
});
