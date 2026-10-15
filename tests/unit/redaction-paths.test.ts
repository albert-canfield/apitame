import { describe, expect, it } from 'vitest';
import type { OpenApiRuntime } from '../../src/server/openapi-runtime.js';
import { fakeApi, type SentRequest as Sent } from '../helpers.js';

const SECRET = 'fake-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A runtime over a one-endpoint API whose responses the test controls. */
function runtime(opts: {
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  baseUrl?: string;
  method?: 'get' | 'post';
  respond: (s: Sent) => Response;
}) {
  return fakeApi({
    paths: {
      '/echo': {
        [opts.method ?? 'get']: {
          operationId: opts.method === 'post' ? 'send' : 'echo',
          parameters: [{ name: 'pad', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    config: {
      ...(opts.method === 'post' ? { mode: 'read-write', writes: { allow: ['send'] } } : {}),
      ...opts.config,
    },
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    respond: opts.respond,
  });
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join('\n');

/** Call an operation through the long-tail tool (the test configs define no tool groups). */
const call = (
  rt: OpenApiRuntime,
  operationId: string,
  params: Record<string, unknown> = {},
  flags: Record<string, unknown> = {},
) => rt.callTool('call_operation', { operationId, params, ...flags });

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('secrets in responses that are cut to size', () => {
  const apiKey = {
    auth: { type: 'apiKey', in: 'header', name: 'X-Key', value: '${K}' },
    limits: { maxResponseBytes: 1000 },
  };

  it('never shows part of a secret that straddles the cut (text)', async () => {
    const { rt } = runtime({
      config: apiKey,
      env: { K: SECRET },
      respond: (s) =>
        new Response(
          `${'x'.repeat(Number(new URL(s.url).searchParams.get('pad')))}key=${s.headers['X-Key']} ${'y'.repeat(2000)}`,
          { headers: { 'content-type': 'text/plain' } },
        ),
    });
    for (const pad of [900, 960, 975, 985, 990]) {
      const out = text(await call(rt, 'echo', { pad }));
      expect(out).not.toContain('fake-k');
      expect(out).not.toContain('ABCDEFG');
    }
  });

  it('keeps key-based masking when an oversized object falls back to text', async () => {
    const { rt } = runtime({
      config: apiKey,
      env: { K: 'opaque-value-1234' },
      respond: () =>
        json({
          pad: 'x'.repeat(500),
          echo: { token: 'unregistered-9f8e7d6c' },
          more: 'y'.repeat(2000),
        }),
    });
    const out = text(await call(rt, 'echo'));
    expect(out).not.toContain('unregistered-9f8e7d6c');
    expect(out).toContain('truncated');
  });
});

describe('secrets that come from environment variables', () => {
  it('hides a token carried in the base URL path in previews and logs', async () => {
    const token = 'fake-bot-token-not-real-0123456789';
    const { rt, logs } = runtime({
      baseUrl: 'https://api.telegram.org/bot${BOT_TOKEN}',
      env: { BOT_TOKEN: token },
      method: 'post',
      respond: () => json({ ok: true }),
    });
    const preview = text(await call(rt, 'send', {}, { dryRun: true }));
    expect(preview).toContain('https://api.telegram.org/bot[REDACTED]/echo');
    await call(rt, 'send');
    expect(logs.join('\n')).toContain('/bot[REDACTED]/echo');
    expect([preview, ...logs].join('\n')).not.toContain('not-real');
  });

  it('hides the bare variable inside a composite value', async () => {
    const cases: Array<{ config: Record<string, unknown>; echo: (s: Sent) => string }> = [
      {
        config: {
          auth: { type: 'apiKey', in: 'header', name: 'Authorization', value: 'SSWS ${T}' },
        },
        echo: (s) => (s.headers.Authorization ?? '').replace('SSWS ', ''),
      },
      {
        config: {
          source: {
            type: 'openapi',
            spec: 'x.yaml',
            baseUrl: 'https://api.example.com/v1',
            headers: { 'X-Tenant': 'tenant-${T}' },
          },
        },
        echo: (s) => (s.headers['X-Tenant'] ?? '').replace('tenant-', ''),
      },
      {
        config: { auth: { type: 'basic', username: '${T}', password: '${EMPTY:-}' } },
        echo: (s) =>
          Buffer.from((s.headers.Authorization ?? '').replace('Basic ', ''), 'base64')
            .toString()
            .split(':')[0] ?? '',
      },
    ];
    for (const c of cases) {
      const { rt } = runtime({
        config: c.config,
        env: { T: 'bare-secret-value-42' },
        respond: (s) => json({ youSent: c.echo(s), note: `key ${c.echo(s)} is invalid` }),
      });
      const out = text(await call(rt, 'echo'));
      expect(out).not.toContain('bare-secret-value-42');
    }
  });

  it('hides every static header value in previews, literal or not', async () => {
    const { rt } = runtime({
      method: 'post',
      config: {
        mode: 'read-write',
        writes: { allow: ['send'] },
        source: {
          type: 'openapi',
          spec: 'x.yaml',
          baseUrl: 'https://api.example.com/v1',
          headers: { 'X-Tenant-Key': 'literal-tenant-key' },
        },
      },
      respond: () => json({ ok: true }),
    });
    const preview = text(await call(rt, 'send', {}, { dryRun: true }));
    expect(preview).not.toContain('literal-tenant-key');
    expect(preview).toContain('X-Tenant-Key');
  });
});
