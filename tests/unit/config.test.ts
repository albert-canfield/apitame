import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv, MissingEnvError, resolveEnv } from '../../src/config/env.js';
import { ConfigError, loadConfig, parseConfig } from '../../src/config/load.js';
import { tempDir } from '../helpers.js';

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
    });
    expect(() =>
      parseConfig({ ...minimal, http: { oauth: { issuer: 'https://auth.example.com' } } }),
    ).toThrow(/http\.oauth\.resource/);
    expect(() =>
      parseConfig({ ...minimal, http: { oauth: { issuer: 'auth', resource: 'https://x/mcp' } } }),
    ).toThrow(/http\.oauth\.issuer/);
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
