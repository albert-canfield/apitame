import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, MissingEnvError, resolveEnv } from '../../src/config/env.js';
import { ConfigError, loadConfig, parseConfig } from '../../src/config/load.js';
import { verifyMode } from '../../src/config/schema.js';
import { ROOT, tempDir } from '../helpers.js';

const minimal = { name: 'demo', source: { type: 'openapi', spec: './openapi.yaml' } };

describe('config schema', () => {
  it('applies safe defaults', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.mode).toBe('read-only');
    expect(cfg.auth).toEqual({ type: 'none' });
    expect(cfg.writes.allow).toEqual([]);
    expect(cfg.longTail.enabled).toBe(true);
    expect(cfg.limits).toMatchObject({ maxTools: 12, timeoutMs: 15_000, rowLimit: 200 });
    expect(cfg.confirmation).toEqual({ method: 'auto', ttlSeconds: 300 });
  });

  it.each([
    ['bearer', { type: 'bearer', token: 'ghp_inline_secret' }],
    ['apiKey', { type: 'apiKey', name: 'X-Key', value: 'inline' }],
    ['basic', { type: 'basic', username: 'u', password: 'inline' }],
    [
      'oauth2',
      { type: 'oauth2', tokenUrl: 'https://x/token', clientId: 'id', clientSecret: 'inline' },
    ],
  ])('refuses inline %s secrets', (_n, auth) => {
    expect(() => parseConfig({ ...minimal, auth })).toThrow(/environment variable/);
  });

  it('accepts secrets from env references', () => {
    const cfg = parseConfig({ ...minimal, auth: { type: 'bearer', token: '${MY_TOKEN}' } });
    expect(cfg.auth).toEqual({ type: 'bearer', token: '${MY_TOKEN}' });
  });

  it('validates names and duplicate tools', () => {
    expect(() => parseConfig({ ...minimal, name: 'Bad Name' })).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        ...minimal,
        tools: [
          { name: 'a', operations: ['x'] },
          { name: 'a', operations: ['y'] },
        ],
      }),
    ).toThrow(/Duplicate tool name/);
    expect(() =>
      parseConfig({ ...minimal, tools: [{ name: 'Not-Snake', operations: ['x'] }] }),
    ).toThrow(ConfigError);
  });

  it('rejects tool groups on SQL sources', () => {
    expect(() =>
      parseConfig({
        name: 'db',
        source: { type: 'sqlite', path: 'x.db' },
        tools: [{ name: 'a', operations: ['x'] }],
      }),
    ).toThrow(/only apply to OpenAPI/);
  });

  it('reserves dryRun and confirm in named query parameters', () => {
    const withParam = (name: string) => ({
      name: 'demo',
      source: { type: 'sqlite', path: './shop.db' },
      sql: {
        queries: [
          {
            name: 'q',
            description: 'd',
            sql: 'UPDATE t SET x = :x',
            params: { [name]: { type: 'string' } },
            write: true,
          },
        ],
      },
    });
    expect(() => parseConfig(withParam('confirm'))).toThrow(/reserved for apitame/);
    expect(() => parseConfig(withParam('dryRun'))).toThrow(/reserved for apitame/);
    expect(() => parseConfig(withParam('x'))).not.toThrow();
  });

  it('reads http.oauth with defaults, and refuses it without valid URLs', () => {
    expect(parseConfig(minimal).http.oauth).toBeUndefined();
    const cfg = parseConfig({
      ...minimal,
      http: {
        oauth: { issuer: 'https://auth.example.com', resource: 'https://mcp.example.com/mcp' },
      },
    });
    expect(cfg.http.oauth).toEqual({
      issuer: 'https://auth.example.com',
      resource: 'https://mcp.example.com/mcp',
      scopes: [],
      audiences: [],
      clients: [],
      requireAccessTokenType: false,
    });
    expect(() =>
      parseConfig({ ...minimal, http: { oauth: { issuer: 'https://auth.example.com' } } }),
    ).toThrow(/http\.oauth\.resource/);
    expect(() =>
      parseConfig({ ...minimal, http: { oauth: { issuer: 'auth', resource: 'https://x/mcp' } } }),
    ).toThrow(/http\.oauth\.issuer/);
  });

  it('refuses unknown keys, so a typo or a misplaced block cannot turn a setting off', () => {
    const oauth = { issuer: 'https://auth.example.com', resource: 'https://mcp.example.com/mcp' };
    expect(() => parseConfig({ ...minimal, oauth })).toThrow(
      /\(root\): Unknown key "oauth" \(it belongs under http\.oauth\)/,
    );
    expect(() => parseConfig({ ...minimal, http: oauth })).toThrow(
      /http: Unknown key "issuer" \(it belongs under http\.oauth\)/,
    );
    expect(() =>
      parseConfig({ ...minimal, http: { oauth: { ...oauth, scope: ['mcp:tools'] } } }),
    ).toThrow(/http\.oauth: Unknown key "scope" \(did you mean scopes\?\)/);
    expect(() => parseConfig({ ...minimal, mdoe: 'read-write' })).toThrow(/Unknown key "mdoe"/);
  });

  it('accepts every example config', () => {
    for (const example of ['petstore', 'github-subset', 'postgres-shop']) {
      expect(
        loadConfig(join(ROOT, 'examples', example, 'apitame.config.yaml')).config.name,
      ).toBeTruthy();
    }
  });

  it('refuses http.oauth.audiences without scopes or clients', () => {
    const oauth = {
      issuer: 'https://dev-1.okta.com/oauth2/default',
      resource: 'https://mcp.example.com/mcp',
      audiences: ['api://default'],
    };
    expect(() => parseConfig({ ...minimal, http: { oauth } })).toThrow(
      /http\.oauth\.audiences: .*Also set scopes or clients/,
    );
    expect(
      parseConfig({ ...minimal, http: { oauth: { ...oauth, scopes: ['mcp:tools'] } } }),
    ).toBeTruthy();
    expect(
      parseConfig({ ...minimal, http: { oauth: { ...oauth, clients: ['0oa1'] } } }),
    ).toBeTruthy();
  });

  it('reads http.oauth.introspection with defaults', () => {
    const introspection = {
      url: 'https://auth.example.com/oauth/introspect',
      clientId: '${INTROSPECTION_CLIENT_ID}',
      clientSecret: '${INTROSPECTION_CLIENT_SECRET}',
    };
    const oauth = { issuer: 'https://auth.example.com', resource: 'https://mcp.example.com/mcp' };
    const cfg = parseConfig({ ...minimal, http: { oauth: { ...oauth, introspection } } });
    expect(cfg.http.oauth?.introspection).toEqual({
      ...introspection,
      clientAuthMethod: 'client_secret_basic',
      cacheSeconds: 60,
      maxCallsPerMinute: 600,
    });
    expect(verifyMode(cfg.http.oauth!)).toBe('introspection');
    expect(verifyMode(parseConfig({ ...minimal, http: { oauth } }).http.oauth!)).toBe('jwt');
    // The client id may be literal; the secret must come from the environment.
    expect(
      parseConfig({
        ...minimal,
        http: { oauth: { ...oauth, introspection: { ...introspection, clientId: 'apitame' } } },
      }).http.oauth?.introspection?.clientId,
    ).toBe('apitame');
    const bad = (extra: Record<string, unknown>) => () =>
      parseConfig({
        ...minimal,
        http: { oauth: { ...oauth, introspection: { ...introspection, ...extra } } },
      });
    expect(bad({ clientSecret: 'inline-secret' })).toThrow(
      /http\.oauth\.introspection\.clientSecret must come from an environment variable/,
    );
    expect(bad({ cacheSeconds: 301 })).toThrow(/cacheSeconds/);
    expect(bad({ maxCallsPerMinute: 0 })).toThrow(/maxCallsPerMinute/);
    expect(bad({ url: 'introspect' })).toThrow(/introspection\.url/);
    expect(bad({ clientAuthMethod: 'private_key_jwt' })).toThrow(/clientAuthMethod/);
    expect(bad({ authMethod: 'client_secret_post' })).toThrow(
      /Unknown key "authMethod" \(did you mean clientAuthMethod\?\)/,
    );
    expect(bad({ endpoint: 'https://x' })).toThrow(/Unknown key "endpoint" \(did you mean url\?\)/);
  });

  it('refuses http.oauth.verify combinations that cannot work', () => {
    const introspection = {
      url: 'https://auth.example.com/oauth/introspect',
      clientId: 'apitame',
      clientSecret: '${SECRET}',
    };
    const oauth = (extra: Record<string, unknown>) => () =>
      parseConfig({
        ...minimal,
        http: {
          oauth: {
            issuer: 'https://auth.example.com',
            resource: 'https://mcp.example.com/mcp',
            ...extra,
          },
        },
      });
    expect(oauth({ verify: 'introspection' })).toThrow(
      /http\.oauth\.verify: introspection needs http\.oauth\.introspection/,
    );
    expect(oauth({ verify: 'auto' })).toThrow(/http\.oauth\.verify: auto needs/);
    expect(oauth({ verify: 'jwt', introspection })).toThrow(
      /http\.oauth\.introspection: is set, but verify: jwt never introspects/,
    );
    expect(oauth({ introspection, jwksUri: 'https://auth.example.com/jwks' })).toThrow(
      /http\.oauth\.jwksUri: has no effect with verify: introspection/,
    );
    expect(oauth({ introspection, requireAccessTokenType: true })).toThrow(
      /http\.oauth\.requireAccessTokenType: has no effect/,
    );
    expect(oauth({ verify: 'local' })).toThrow(/http\.oauth\.verify/);
    expect(oauth({ mode: 'introspection' })).toThrow(
      /Unknown key "mode" \(did you mean verify\?\)/,
    );
    // Each of these works.
    for (const ok of [
      { verify: 'jwt' },
      { verify: 'auto', introspection, jwksUri: 'https://auth.example.com/jwks' },
      { verify: 'auto', introspection, requireAccessTokenType: true },
      { verify: 'introspection', introspection, requireAccessTokenType: false },
    ]) {
      expect(oauth(ok)()).toBeTruthy();
    }
  });

  it('loads YAML from disk and reports a helpful error when missing', () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(() => loadConfig('apitame.config.yaml', dir)).toThrow(/apitame init/);
      writeFileSync(
        join(dir, 'apitame.config.yaml'),
        'name: demo\nsource:\n  type: sqlite\n  path: ./shop.db\n',
      );
      const loaded = loadConfig('apitame.config.yaml', dir);
      expect(loaded.config.source).toEqual({ type: 'sqlite', path: './shop.db' });
      expect(loaded.dir).toBe(dir);
    } finally {
      cleanup();
    }
  });
});

describe('env', () => {
  it('resolves references and defaults', () => {
    expect(resolveEnv('Bearer ${T}', 'f', { T: 'abc' })).toBe('Bearer abc');
    expect(resolveEnv('${MISSING:-fallback}', 'f', {})).toBe('fallback');
  });

  it('reports every missing variable without leaking values', () => {
    try {
      resolveEnv('${A}:${B}', 'auth.token', { C: 'secret' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).variables).toEqual(['A', 'B']);
      expect((err as Error).message).not.toContain('secret');
    }
  });

  it('loads .env without overriding existing variables', () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(join(dir, '.env'), 'NEW_ONE=from-file\nEXISTING=from-file\n');
      const env: NodeJS.ProcessEnv = { EXISTING: 'from-shell' };
      expect(loadDotEnv(dir, env)).toEqual(['NEW_ONE']);
      expect(env).toEqual({ EXISTING: 'from-shell', NEW_ONE: 'from-file' });
    } finally {
      cleanup();
    }
  });
});
