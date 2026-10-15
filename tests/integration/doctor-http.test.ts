import { copyFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Finding } from '../../src/cli/commands/doctor.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { checkHttp, wantsHttpChecks } from '../../src/cli/commands/doctor-http.js';
import { parseConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/schema.js';
import { Logger } from '../../src/log.js';
import { Redactor } from '../../src/safety/redact.js';
import { createMcpServer } from '../../src/server/mcp.js';
import { JwtVerifier } from '../../src/server/oauth.js';
import { createOpenApiRuntime, type OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { serveHttp } from '../../src/server/transport.js';
import {
  forceGc,
  freePort,
  outcomeWithin,
  PETSTORE,
  petstore,
  petstoreConfig,
  startDripServer,
  tempDir,
} from '../helpers.js';
import { FakeAuthServer, INTROSPECTION_CLIENT, makeKey, type TestKey } from '../oauth-fixtures.js';

type OAuthInput = Record<string, unknown>;

const LONG_TOKEN = 'fake-key-0123456789abcdef0123456789abcdef';
const RFC8414 = '/.well-known/oauth-authorization-server';

let as: FakeAuthServer;
let key: TestKey;
let rt: OpenApiRuntime;

beforeAll(async () => {
  as = await FakeAuthServer.start();
  key = makeKey('rsa', 'rsa-1');
  rt = await createOpenApiRuntime({
    config: await petstoreConfig(),
    configDir: '.',
    spec: await petstore(),
    baseUrlOverride: 'http://127.0.0.1:9',
    env: {},
  });
});
afterAll(() => as.close());
beforeEach(() => {
  as.publish(key);
  as.jwksStatus = 200;
  as.metadataIssuer = undefined;
  as.overrides.clear();
  as.introspectionClient = { ...INTROSPECTION_CLIENT };
  as.introspections.length = 0;
});

/** The `http` block of a config, with schema defaults. */
function httpConfig(oauth?: OAuthInput): Config['http'] {
  return parseConfig({
    name: 'doctor-http',
    source: { type: 'openapi', spec: PETSTORE },
    ...(oauth ? { http: { oauth } } : {}),
  }).http;
}

const oauthFor = (resource: string, extra: OAuthInput = {}): OAuthInput => ({
  issuer: as.issuer,
  resource,
  scopes: ['mcp:tools'],
  ...extra,
});

async function check(
  http: Config['http'],
  opts: Partial<Parameters<typeof checkHttp>[1]> = {},
): Promise<Finding[]> {
  const findings: Finding[] = [];
  await checkHttp(http, { host: '127.0.0.1', ...opts }, (status, check, detail) =>
    findings.push({ status, check, detail }),
  );
  return findings;
}

const of = (findings: Finding[], check: string) => findings.filter((f) => f.check === check);
const statuses = (findings: Finding[], check: string) => of(findings, check).map((f) => f.status);
const details = (findings: Finding[], check: string) =>
  of(findings, check)
    .map((f) => f.detail)
    .join('\n');

/** Metadata that MCP clients can sign users in with. */
function fullMetadata(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({
      issuer: as.issuer,
      jwks_uri: as.jwksUri,
      authorization_endpoint: `${as.issuer}/authorize`,
      token_endpoint: `${as.issuer}/token`,
      code_challenge_methods_supported: ['S256'],
    }),
  );
}

/** A port nothing listens on: the public URL is not reachable. */
async function closedResource(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}/mcp`;
}

/** A stand-in for a reverse proxy in front of apitame, answering with `handle`. */
async function fakeProxy(
  handle: (path: string, res: ServerResponse, base: string) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('request', (req, res) => handle(req.url ?? '/', res, base));
  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const stop = (http: HttpServer) =>
  new Promise<void>((r) => {
    http.closeAllConnections();
    http.close(() => r());
  });

describe('doctor: HTTP deployments', () => {
  it('runs when asked for, or when the config or the environment has HTTP settings', () => {
    const plain = httpConfig();
    expect(wantsHttpChecks(plain, {}, undefined)).toBe(false);
    expect(wantsHttpChecks(plain, { http: true }, undefined)).toBe(true);
    expect(wantsHttpChecks(plain, { host: '0.0.0.0' }, undefined)).toBe(true);
    expect(wantsHttpChecks(plain, {}, LONG_TOKEN)).toBe(true);
    expect(wantsHttpChecks(httpConfig(oauthFor('https://mcp.example.com/mcp')), {}, '')).toBe(true);
  });

  it('requires authentication beyond loopback, as serve does', async () => {
    let f = await check(httpConfig(), { host: '0.0.0.0' });
    expect(statuses(f, 'HTTP auth')).toEqual(['fail']);
    expect(details(f, 'HTTP auth')).toMatch(/refuses to listen on 0\.0\.0\.0/);

    f = await check(httpConfig(), { host: '127.0.0.1' });
    expect(statuses(f, 'HTTP auth')).toEqual(['info']);

    f = await check(httpConfig(), { host: '0.0.0.0', token: LONG_TOKEN });
    expect(statuses(f, 'HTTP auth')).toEqual(['ok']);
    expect(details(f, 'HTTP auth')).toMatch(
      /bearer token \(APITAME_HTTP_TOKEN\) required on 0\.0\.0\.0/,
    );
    expect(details(f, 'HTTP auth')).not.toContain(LONG_TOKEN);

    f = await check(httpConfig(), { host: '0.0.0.0', token: 'fake-key-short' });
    expect(statuses(f, 'HTTP auth')).toEqual(['warn']);
    expect(details(f, 'HTTP auth')).toMatch(/14 characters/);
    expect(details(f, 'HTTP auth')).not.toContain('fake-key-short');

    // docker run --env-file keeps the quotes of NAME="value" in the value.
    f = await check(httpConfig(), { host: '0.0.0.0', token: `"${LONG_TOKEN}"` });
    expect(statuses(f, 'HTTP auth')).toEqual(['warn']);
    expect(details(f, 'HTTP auth')).toMatch(/quotes or spaces/);
    expect(details(f, 'HTTP auth')).not.toContain(LONG_TOKEN);

    const oauth = httpConfig(oauthFor('https://mcp.example.com/mcp'));
    f = await check(oauth, { host: '0.0.0.0', token: LONG_TOKEN, offline: true });
    expect(statuses(f, 'HTTP auth')).toEqual(['fail']);
    expect(details(f, 'HTTP auth')).toMatch(/both set/);

    f = await check(httpConfig(oauthFor('https://mcp.example.com/mcp', { scopes: [] })), {
      host: '0.0.0.0',
      offline: true,
    });
    expect(statuses(f, 'HTTP auth')).toEqual(['ok', 'warn']);
    expect(details(f, 'HTTP auth')).toMatch(/scopes is empty/);
  });

  it('checks the resource URL against how serve listens', async () => {
    const resource = async (url: string, host = '0.0.0.0') => {
      const f = await check(httpConfig(oauthFor(url)), { host, offline: true });
      return { status: statuses(f, 'OAuth resource'), detail: details(f, 'OAuth resource') };
    };
    expect(await resource('http://mcp.example.com/mcp')).toMatchObject({
      status: ['fail'],
      detail: expect.stringMatching(/must use https.*serve refuses to start/),
    });
    expect(await resource('http://127.0.0.1:3333/mcp')).toMatchObject({
      status: ['warn'],
      detail: expect.stringMatching(/loopback address, but serve listens on 0\.0\.0\.0/),
    });
    expect((await resource('http://127.0.0.1:3333/mcp', '127.0.0.1')).status).toEqual(['ok']);
    expect(await resource('https://mcp.example.com/api')).toMatchObject({
      status: ['warn'],
      detail: expect.stringMatching(/answers MCP on \/mcp only/),
    });
    expect(await resource('https://mcp.example.com/mcp/')).toMatchObject({ status: ['warn'] });
    expect(await resource('https://example.com/tools/mcp')).toMatchObject({
      status: ['info', 'ok'],
      detail: expect.stringMatching(
        /map \/tools\/mcp to \/mcp and pass \/\.well-known\/oauth-protected-resource\/tools\/mcp/,
      ),
    });
    expect(await resource('https://mcp.example.com/mcp?tenant=1')).toMatchObject({
      status: ['warn'],
      detail: expect.stringMatching(/query string/),
    });
    expect(await resource('https://mcp.example.com/mcp', '127.0.0.1')).toMatchObject({
      status: ['ok'],
      detail: expect.stringMatching(/also accept mcp\.example\.com/),
    });
  });

  it('skips the issuer, the keys and the public URL with --offline', async () => {
    const before = as.count(RFC8414) + as.count('/jwks');
    const f = await check(httpConfig(oauthFor('https://mcp.example.com/mcp')), {
      host: '0.0.0.0',
      offline: true,
    });
    expect(statuses(f, 'OAuth issuer')).toEqual(['info']);
    expect(of(f, 'OAuth keys')).toEqual([]);
    expect(of(f, 'Public URL')).toEqual([]);
    expect(as.count(RFC8414) + as.count('/jwks')).toBe(before);
  });

  it('is happy with a working OAuth deployment', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const port = await freePort();
    const resource = `http://127.0.0.1:${port}/mcp`;
    const config = httpConfig(oauthFor(resource));
    const options = config.oauth!;
    const http = await serveHttp(() => createMcpServer(rt), {
      host: '127.0.0.1',
      port,
      logger: new Logger(new Redactor(), 'silent'),
      oauth: { verifier: new JwtVerifier(options), options, name: 'petstore' },
    });
    try {
      const f = await check(config);
      expect(f.filter((x) => x.status !== 'ok')).toEqual([]);
      expect(f.map((x) => x.check)).toEqual([
        'HTTP auth',
        'OAuth resource',
        'OAuth issuer',
        'OAuth keys',
        'Public URL',
      ]);
      expect(details(f, 'OAuth issuer')).toMatch(/oauth-authorization-server names this issuer/);
      expect(details(f, 'OAuth keys')).toBe(`1 signing key at ${as.jwksUri}`);
      expect(details(f, 'Public URL')).toMatch(/reaches apitame/);
    } finally {
      await stop(http);
    }
  });

  it('fails when the metadata names another issuer, and points at a trailing slash', async () => {
    as.metadataIssuer = `${as.issuer}/`;
    const f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'OAuth issuer')).toEqual(['fail']);
    expect(details(f, 'OAuth issuer')).toMatch(/names issuer ".*\/", but http\.oauth\.issuer/);
    expect(details(f, 'OAuth issuer')).toMatch(/only in a trailing slash/);
    // serve finds no keys through metadata it refuses, so there is nothing more to check.
    expect(of(f, 'OAuth keys')).toEqual([]);
  });

  it('warns about metadata that MCP clients cannot sign users in with', async () => {
    // The fake server's own metadata names the issuer and the keys, and nothing else.
    const f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'OAuth issuer')).toEqual(['warn', 'warn']);
    expect(details(f, 'OAuth issuer')).toMatch(/no authorization_endpoint or token_endpoint/);
    expect(details(f, 'OAuth issuer')).toMatch(/S256/);
    expect(statuses(f, 'OAuth keys')).toEqual(['ok']);
  });

  it('without metadata, fails unless http.oauth.jwksUri says where the keys are', async () => {
    as.overrides.set(RFC8414, (res) => res.writeHead(404).end());
    let f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'OAuth issuer')).toEqual(['fail']);
    expect(details(f, 'OAuth issuer')).toMatch(/could not read the authorization server metadata/);
    expect(details(f, 'OAuth issuer')).toMatch(/answered HTTP 404/);
    expect(of(f, 'OAuth keys')).toEqual([]);

    f = await check(httpConfig(oauthFor(await closedResource(), { jwksUri: as.jwksUri })));
    expect(statuses(f, 'OAuth issuer')).toEqual(['warn']);
    expect(details(f, 'OAuth issuer')).toMatch(/MCP clients need the metadata/);
    expect(statuses(f, 'OAuth keys')).toEqual(['ok']);
  });

  it('warns when http.oauth.jwksUri differs from the published key set', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const f = await check(
      httpConfig(oauthFor(await closedResource(), { jwksUri: `${as.issuer}/old-jwks` })),
    );
    expect(statuses(f, 'OAuth issuer')).toEqual(['warn']);
    expect(details(f, 'OAuth issuer')).toMatch(/publishes its keys at .*\/jwks/);
    // apitame reads the configured location, which does not exist.
    expect(statuses(f, 'OAuth keys')).toEqual(['fail']);
  });

  it('refuses a key set location that is not https, and never prints it raw', async () => {
    as.overrides.set(RFC8414, (res) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ issuer: as.issuer, jwks_uri: 'http://keys.example/\u001b[2Jjwks' })),
    );
    const f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'OAuth issuer')).toEqual(['fail']);
    expect(details(f, 'OAuth issuer')).toMatch(/not an https URL, so serve refuses it/);
    expect(details(f, 'OAuth issuer')).toContain('http://keys.example/%1B[2Jjwks');
    expect(f.map((x) => x.detail).join('')).not.toContain('\u001b');
    expect(of(f, 'OAuth keys')).toEqual([]);
  });

  it('does not follow redirects to the metadata', async () => {
    as.overrides.set(RFC8414, (res) =>
      res.writeHead(302, { Location: `${as.issuer}/elsewhere` }).end(),
    );
    const f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'OAuth issuer')).toEqual(['fail']);
    expect(details(f, 'OAuth issuer')).toMatch(/Redirects are not followed/);
    expect(as.count('/elsewhere')).toBe(0);
  });

  it('fails when the key set cannot be read or has no key apitame can use', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const config = httpConfig(oauthFor(await closedResource()));

    as.jwksStatus = 500;
    let f = await check(config);
    expect(statuses(f, 'OAuth keys')).toEqual(['fail']);
    expect(details(f, 'OAuth keys')).toMatch(/HTTP 500.*Every token is refused/);

    as.jwksStatus = 200;
    as.publish(makeKey('rsa', 'weak', {}, 1024));
    f = await check(config);
    expect(statuses(f, 'OAuth keys')).toEqual(['fail']);
    expect(details(f, 'OAuth keys')).toMatch(/no key apitame can use/);

    as.keys = [];
    f = await check(config);
    expect(statuses(f, 'OAuth keys')).toEqual(['fail']);
  });

  it('checks the public URL as clients reach it through the reverse proxy', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const publicUrl = async (handle: Parameters<typeof fakeProxy>[0]) => {
      const proxy = await fakeProxy(handle);
      try {
        const f = await check(httpConfig(oauthFor(`${proxy.base}/mcp`)));
        return { status: statuses(f, 'Public URL'), detail: details(f, 'Public URL') };
      } finally {
        await proxy.close();
      }
    };
    const challenge = (base: string) => ({
      'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    });
    const metadata = (res: ServerResponse, body: unknown) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    // Not up yet: not an error, doctor may run before the deploy.
    const f = await check(httpConfig(oauthFor(await closedResource())));
    expect(statuses(f, 'Public URL')).toEqual(['info']);
    expect(details(f, 'Public URL')).toMatch(/not reachable from here/);

    // The proxy does not route /mcp to apitame.
    expect(await publicUrl((_path, res) => res.writeHead(404).end())).toMatchObject({
      status: ['warn'],
      detail: expect.stringMatching(/answered HTTP 404 without apitame's challenge/),
    });
    // A redirect (a trailing slash added by the proxy) is reported, not followed.
    expect(
      await publicUrl((_path, res, base) => res.writeHead(301, { Location: `${base}/mcp/` }).end()),
    ).toMatchObject({ status: ['warn'], detail: expect.stringMatching(/HTTP 301/) });
    // /mcp reaches apitame, but the metadata path does not.
    expect(
      await publicUrl((path, res, base) =>
        path === '/mcp' ? res.writeHead(401, challenge(base)).end() : res.writeHead(404).end(),
      ),
    ).toMatchObject({
      status: ['warn'],
      detail: expect.stringMatching(
        /HTTP 404\. The reverse proxy must pass \/\.well-known\/oauth-protected-resource\/mcp/,
      ),
    });
    // Another server, or apitame with another config.
    expect(
      await publicUrl((path, res, base) =>
        path === '/mcp'
          ? res.writeHead(401, challenge(base)).end()
          : metadata(res, {
              resource: 'https://other.example.com/mcp',
              authorization_servers: [as.issuer],
            }),
      ),
    ).toMatchObject({ status: ['warn'], detail: expect.stringMatching(/another server/) });
    // Everything in place.
    expect(
      await publicUrl((path, res, base) =>
        path === '/mcp'
          ? res.writeHead(401, challenge(base)).end()
          : metadata(res, { resource: `${base}/mcp`, authorization_servers: [as.issuer] }),
      ),
    ).toMatchObject({ status: ['ok'] });
  });

  it('runs from apitame doctor with --host, and only then without HTTP settings', async () => {
    const t = tempDir('apitame-doctor-http-');
    const saved = process.env.APITAME_HTTP_TOKEN;
    delete process.env.APITAME_HTTP_TOKEN;
    try {
      copyFileSync(PETSTORE, join(t.dir, 'openapi.yaml'));
      const config = join(t.dir, 'apitame.config.yaml');
      writeFileSync(
        config,
        stringify({
          name: 'petstore',
          source: { type: 'openapi', spec: './openapi.yaml', baseUrl: 'http://127.0.0.1:9' },
        }),
      );
      expect(of(await runDoctor({ config, offline: true }), 'HTTP auth')).toEqual([]);
      const f = await runDoctor({ config, offline: true, host: '0.0.0.0' });
      expect(statuses(f, 'HTTP auth')).toEqual(['fail']);
      // The other checks still run.
      expect(statuses(f, 'API')).toEqual(['info']);

      process.env.APITAME_HTTP_TOKEN = LONG_TOKEN;
      const withToken = await runDoctor({ config, offline: true });
      expect(statuses(withToken, 'HTTP auth')).toEqual(['ok']);
      expect(details(withToken, 'HTTP auth')).toMatch(/required on 127\.0\.0\.1/);
    } finally {
      if (saved === undefined) delete process.env.APITAME_HTTP_TOKEN;
      else process.env.APITAME_HTTP_TOKEN = saved;
      t.cleanup();
    }
  });
});

describe('doctor: token introspection', () => {
  const SECRET_VAR = 'DOCTOR_TEST_INTROSPECTION_SECRET';
  const env = { [SECRET_VAR]: INTROSPECTION_CLIENT.secret };
  const basic = Buffer.from(
    `${INTROSPECTION_CLIENT.id}:${encodeURIComponent(INTROSPECTION_CLIENT.secret)}`,
  ).toString('base64');

  /** http.oauth with introspection at the fake server (or `url`), as `verify` says. */
  const introspecting = async (extra: OAuthInput = {}, url = as.introspectionUrl) =>
    httpConfig(
      oauthFor(await closedResource(), {
        introspection: {
          url,
          clientId: INTROSPECTION_CLIENT.id,
          clientSecret: `\${${SECRET_VAR}}`,
        },
        ...extra,
      }),
    );

  /** The secret, or the Basic credentials made from it, must never be printed. */
  const noSecret = (f: Finding[]) => {
    const all = f.map((x) => x.detail).join('\n');
    expect(all).not.toContain(INTROSPECTION_CLIENT.secret);
    expect(all).not.toContain(basic);
  };

  it('checks the endpoint and the credentials as serve does at startup', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['ok']);
    expect(details(f, 'OAuth introspection')).toMatch(
      /accepts apitame's credentials and calls a token nobody issued inactive/,
    );
    expect(details(f, 'HTTP auth')).toMatch(/\(verify: introspection\)/);
    // One question, about a random token, with the configured client.
    expect(as.introspections).toHaveLength(1);
    expect(as.introspections[0]!.form.get('token')).toMatch(/^apitame-check-[0-9a-f]{32}$/);
    expect(as.introspections[0]!.authorization).toBe(`Basic ${basic}`);
    noSecret(f);
  });

  it('skips the signing keys under verify: introspection, and checks both under auto', async () => {
    as.overrides.set(RFC8414, fullMetadata);
    const jwksBefore = as.count('/jwks');
    let f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth keys')).toEqual(['info']);
    expect(details(f, 'OAuth keys')).toMatch(/not used/);
    expect(as.count('/jwks')).toBe(jwksBefore);

    f = await check(await introspecting({ verify: 'auto' }), { env });
    expect(statuses(f, 'OAuth keys')).toEqual(['ok']);
    expect(statuses(f, 'OAuth introspection')).toEqual(['ok']);
    expect(details(f, 'HTTP auth')).toMatch(/\(verify: auto\)/);
  });

  it('needs no jwks_uri in the metadata under verify: introspection, nor metadata at all', async () => {
    as.overrides.set(RFC8414, (res) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          issuer: as.issuer,
          authorization_endpoint: `${as.issuer}/authorize`,
          token_endpoint: `${as.issuer}/token`,
          code_challenge_methods_supported: ['S256'],
        }),
      ),
    );
    let f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth issuer')).toEqual(['ok']);

    as.overrides.set(RFC8414, (res) => res.writeHead(404).end());
    f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth issuer')).toEqual(['warn']);
    expect(details(f, 'OAuth issuer')).toMatch(/does not need it under verify: introspection/);
    expect(statuses(f, 'OAuth introspection')).toEqual(['ok']);
  });

  it('fails when the credentials are rejected, without printing them', async () => {
    as.introspectionClient = { id: INTROSPECTION_CLIENT.id, secret: 'another-secret' };
    const f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['fail']);
    expect(details(f, 'OAuth introspection')).toMatch(
      /HTTP 401\. Check http\.oauth\.introspection\.clientId and clientSecret\./,
    );
    noSecret(f);
  });

  it('fails when the endpoint calls a random token active, or does not answer as RFC 7662 says', async () => {
    const answer = (body: unknown) => (res: ServerResponse) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    as.overrides.set('/introspect', answer({ active: true }));
    let f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['fail']);
    expect(details(f, 'OAuth introspection')).toMatch(
      /random token nobody issued is active.*serve refuses to start with it/,
    );

    as.overrides.set('/introspect', answer({ ok: true }));
    f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['fail']);
    expect(details(f, 'OAuth introspection')).toMatch(/did not answer as RFC 7662 says/);
    noSecret(f);
  });

  it('fails without https or without the secret, before sending anything', async () => {
    let f = await check(await introspecting({}, 'http://introspect.example.com/introspect'), {
      env,
    });
    expect(statuses(f, 'OAuth introspection')).toEqual(['fail']);
    expect(details(f, 'OAuth introspection')).toMatch(
      /introspection\.url must use https.*serve refuses to start/,
    );

    f = await check(await introspecting(), { env: {} });
    expect(statuses(f, 'OAuth introspection')).toEqual(['fail']);
    expect(details(f, 'OAuth introspection')).toContain(SECRET_VAR);
    expect(as.introspections).toHaveLength(0);
  });

  it('warns when the issuer publishes another introspection endpoint', async () => {
    const withEndpoint = (endpoint: string) => (res: ServerResponse) =>
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          issuer: as.issuer,
          jwks_uri: as.jwksUri,
          authorization_endpoint: `${as.issuer}/authorize`,
          token_endpoint: `${as.issuer}/token`,
          code_challenge_methods_supported: ['S256'],
          introspection_endpoint: endpoint,
        }),
      );
    as.overrides.set(RFC8414, withEndpoint(`${as.issuer}/oauth2/introspect`));
    let f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['warn', 'ok']);
    expect(details(f, 'OAuth introspection')).toMatch(
      /names the introspection endpoint http:\/\/127\.0\.0\.1:\d+\/oauth2\/introspect, but http\.oauth\.introspection\.url is/,
    );

    as.overrides.set(RFC8414, withEndpoint(as.introspectionUrl));
    f = await check(await introspecting(), { env });
    expect(statuses(f, 'OAuth introspection')).toEqual(['ok']);
  });

  it('contacts nothing with --offline', async () => {
    const f = await check(await introspecting(), { env, offline: true });
    expect(statuses(f, 'OAuth introspection')).toEqual(['info']);
    expect(details(f, 'OAuth introspection')).toMatch(/not contacted \(--offline\)/);
    expect(as.introspections).toHaveLength(0);
  });
});

describe('doctor: request deadlines', () => {
  let drip: Awaited<ReturnType<typeof startDripServer>> | undefined;
  afterEach(async () => {
    await drip?.close();
    drip = undefined;
  });

  it('ends a metadata request whose body drips forever, garbage collections included', async () => {
    drip = await startDripServer('{"issuer":"');
    const issuer = drip.url.replace(/\/$/, '');
    const started = Date.now();
    const collector = setInterval(forceGc, 50);
    const outcome = await outcomeWithin(
      check(httpConfig(oauthFor(await closedResource(), { issuer })), { timeoutMs: 300 }),
      5_000,
    ).finally(() => clearInterval(collector));
    expect(outcome.state, 'doctor still waits for the body').toBe('fulfilled');
    expect(Date.now() - started).toBeLessThan(4_000);
    const f = await check(httpConfig(oauthFor(await closedResource(), { issuer })), {
      timeoutMs: 300,
    });
    expect(statuses(f, 'OAuth issuer')).toEqual(['fail']);
    expect(details(f, 'OAuth issuer')).toMatch(/did not answer within 0\.3 seconds/);
  });

  it('checks a base URL with no parameterless read, even when its body never ends', async () => {
    drip = await startDripServer('<html>');
    const t = tempDir('apitame-doctor-api-');
    try {
      writeFileSync(
        join(t.dir, 'openapi.yaml'),
        stringify({
          openapi: '3.0.3',
          info: { title: 'one', version: '1' },
          paths: {
            '/items/{id}': {
              get: {
                operationId: 'getItem',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        }),
      );
      const config = join(t.dir, 'apitame.config.yaml');
      writeFileSync(
        config,
        stringify({
          name: 'one',
          source: { type: 'openapi', spec: './openapi.yaml', baseUrl: drip.url },
        }),
      );
      const f = await runDoctor({ config });
      expect(statuses(f, 'API')).toEqual(['ok']);
      expect(details(f, 'API')).toMatch(/is reachable \(HTTP 200\); no parameterless read/);
    } finally {
      t.cleanup();
    }
  });
});
