import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import {
  hashSubject,
  OTEL_NPX,
  OTEL_PACKAGES,
  otlpHeaderValues,
  parseOtlpHeaders,
  parseTraceparent,
  readTelemetrySettings,
  telemetryOn,
} from '../../src/telemetry/config.js';
import { ServerRatioSampler } from '../../src/telemetry/otel.js';
import { ROOT } from '../helpers.js';

/**
 * The SDK's own header parser (@opentelemetry/core, a dependency of the exporters, not of apitame),
 * found through the exporter as the exporter finds it.
 */
function sdkHeaderParser(): (value?: string) => Record<string, string> {
  const exporter = createRequire(import.meta.resolve('@opentelemetry/exporter-trace-otlp-proto'));
  const core = createRequire(exporter.resolve('@opentelemetry/otlp-exporter-base'))(
    '@opentelemetry/core',
  ) as { parseKeyPairsIntoRecord: (value?: string) => Record<string, string> };
  return core.parseKeyPairsIntoRecord;
}

const ENDPOINT = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' };

describe('telemetry settings: when it is on', () => {
  it('is off without an OTLP endpoint', () => {
    const s = readTelemetrySettings({});
    expect(telemetryOn(s)).toBe(false);
    expect(s.off).toBe('OTEL_EXPORTER_OTLP_ENDPOINT is not set');
    expect(s.warnings).toEqual([]);
  });

  it('exports traces and metrics to the shared endpoint, with the signal path appended', () => {
    const s = readTelemetrySettings(ENDPOINT);
    expect(telemetryOn(s)).toBe(true);
    expect(s.traces).toBe('http://collector:4318/v1/traces');
    expect(s.metrics).toBe('http://collector:4318/v1/metrics');
    expect(
      readTelemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://c.example/otlp/' }).traces,
    ).toBe('https://c.example/otlp/v1/traces');
  });

  it('uses a per-signal endpoint as it is, and only for that signal', () => {
    const s = readTelemetrySettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://jaeger:4318/x' });
    expect(s.traces).toBe('http://jaeger:4318/x');
    expect(s.metrics).toBeUndefined();
    const m = readTelemetrySettings({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://prom:9090/otlp',
    });
    expect(m.traces).toBeUndefined();
    expect(m.metrics).toBe('http://prom:9090/otlp');
  });

  it('respects OTEL_SDK_DISABLED=true', () => {
    for (const v of ['true', 'TRUE', ' true ']) {
      const s = readTelemetrySettings({ ...ENDPOINT, OTEL_SDK_DISABLED: v });
      expect(telemetryOn(s)).toBe(false);
      expect(s.off).toBe('OTEL_SDK_DISABLED is true');
    }
    expect(telemetryOn(readTelemetrySettings({ ...ENDPOINT, OTEL_SDK_DISABLED: 'false' }))).toBe(
      true,
    );
  });

  it('turns a signal off with OTEL_*_EXPORTER=none, and refuses exporters other than OTLP', () => {
    const s = readTelemetrySettings({ ...ENDPOINT, OTEL_METRICS_EXPORTER: 'none' });
    expect(s.traces).toBeDefined();
    expect(s.metrics).toBeUndefined();
    const both = readTelemetrySettings({
      ...ENDPOINT,
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_TRACES_EXPORTER: 'none',
    });
    expect(telemetryOn(both)).toBe(false);
    const zipkin = readTelemetrySettings({ ...ENDPOINT, OTEL_TRACES_EXPORTER: 'zipkin' });
    expect(zipkin.traces).toBeUndefined();
    expect(zipkin.warnings.join('\n')).toMatch(/OTEL_TRACES_EXPORTER=zipkin is not supported/);
    expect(
      readTelemetrySettings({ ...ENDPOINT, OTEL_TRACES_EXPORTER: 'otlp' }).traces,
    ).toBeDefined();
  });

  it('warns about protocols other than http/protobuf, once', () => {
    const s = readTelemetrySettings({ ...ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' });
    expect(telemetryOn(s)).toBe(true);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/grpc is not supported.*http\/protobuf.*4318/);
    expect(
      readTelemetrySettings({ ...ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' }).warnings,
    ).toEqual([]);
  });

  it('refuses an endpoint that is not an http or https URL', () => {
    const s = readTelemetrySettings({ OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4317' });
    expect(telemetryOn(s)).toBe(false);
    expect(s.warnings.join('\n')).toMatch(
      /OTEL_EXPORTER_OTLP_ENDPOINT is not an http or https URL/,
    );
  });

  it('shows endpoints without credentials or query strings', () => {
    const s = readTelemetrySettings({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        'https://user:fake-key-pw@c.example/v1/traces?key=fake-key-q',
    });
    expect(s.traces).toBe('https://c.example/v1/traces');
  });
});

describe('telemetry settings: propagation, sampling and subjects', () => {
  it('continues W3C trace context unless OTEL_PROPAGATORS leaves tracecontext out', () => {
    expect(readTelemetrySettings(ENDPOINT).propagate).toBe(true);
    expect(
      readTelemetrySettings({ ...ENDPOINT, OTEL_PROPAGATORS: 'tracecontext,baggage' }).propagate,
    ).toBe(true);
    const none = readTelemetrySettings({ ...ENDPOINT, OTEL_PROPAGATORS: 'none' });
    expect(none.propagate).toBe(false);
    expect(none.warnings).toEqual([]);
    const b3 = readTelemetrySettings({ ...ENDPOINT, OTEL_PROPAGATORS: 'b3' });
    expect(b3.propagate).toBe(false);
    expect(b3.warnings.join('\n')).toMatch(/only reads W3C trace context/);
  });

  it('records every call by default, whatever the incoming sampled flag says', () => {
    expect(readTelemetrySettings(ENDPOINT).sampler).toEqual({
      kind: 'always_on',
      parentBased: false,
      ratio: 1,
    });
    expect(
      readTelemetrySettings({
        ...ENDPOINT,
        OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
      }).sampler,
    ).toEqual({ kind: 'traceidratio', parentBased: true, ratio: 0.25 });
    const bad = readTelemetrySettings({ ...ENDPOINT, OTEL_TRACES_SAMPLER: 'jaeger_remote' });
    expect(bad.sampler.kind).toBe('always_on');
    expect(bad.warnings.join('\n')).toMatch(/jaeger_remote is not supported/);
    const ratio = readTelemetrySettings({
      ...ENDPOINT,
      OTEL_TRACES_SAMPLER: 'traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '2',
    });
    expect(ratio.sampler.ratio).toBe(1);
    expect(ratio.warnings.join('\n')).toMatch(/OTEL_TRACES_SAMPLER_ARG/);
  });

  it('refuses weak subject keys: whitespace only, or fewer than 8 different characters', () => {
    for (const key of [' '.repeat(16), 'k'.repeat(16), 'abababababababab', '\t'.repeat(20)]) {
      const s = readTelemetrySettings({
        ...ENDPOINT,
        APITAME_OTEL_SUBJECT: 'hash',
        APITAME_OTEL_SUBJECT_KEY: key,
      });
      expect(s.subject, JSON.stringify(key)).toBe('off');
      expect(s.subjectKey).toBeUndefined();
      expect(s.warnings.join('\n')).toMatch(/at least 8 different ones.*openssl rand -hex 32/);
    }
    // What `openssl rand -hex 32` prints, and a key with exactly 8 different characters.
    for (const key of [
      '3f9a0c1d7e5b2a4c6d8e0f1a3b5c7d9e2f4a6b8c0d1e3f5a7b9c2d4e6f8a0b1c',
      'abcdefghabcdefgh',
    ]) {
      const s = readTelemetrySettings({
        ...ENDPOINT,
        APITAME_OTEL_SUBJECT: 'hash',
        APITAME_OTEL_SUBJECT_KEY: key,
      });
      expect(s.subject, key).toBe('hash');
    }
  });

  it('keeps the OAuth client on spans unless APITAME_OTEL_CLIENT=off', () => {
    expect(readTelemetrySettings(ENDPOINT).client).toBe(true);
    expect(readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_CLIENT: 'on' }).client).toBe(true);
    expect(readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_CLIENT: 'OFF' }).client).toBe(false);
    const typo = readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_CLIENT: 'no' });
    expect(typo.client).toBe(false);
    expect(typo.warnings.join('\n')).toMatch(/APITAME_OTEL_CLIENT=no is not on or off/);
  });

  it('warns once when OTLP headers would go over plain http to a host other than loopback', () => {
    const plain = readTelemetrySettings({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=fake-key-hdr-01234567',
    });
    const warnings = plain.warnings.filter((w) => w.includes('plain http'));
    expect(warnings).toEqual([
      'OTLP headers (OTEL_EXPORTER_OTLP_HEADERS) go to collector.example.com:4318 over plain http, where anyone on the network path can read them, an API key included. Use an https endpoint (http is fine on loopback only).',
    ]);
    for (const env of [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com',
        OTEL_EXPORTER_OTLP_HEADERS: 'k=v',
      },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'k=v' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', OTEL_EXPORTER_OTLP_HEADERS: 'k=v' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://[::1]:4318', OTEL_EXPORTER_OTLP_HEADERS: 'k=v' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318' },
      // Headers the exporter would not send (no value) are no headers.
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318',
        OTEL_EXPORTER_OTLP_HEADERS: 'k=',
      },
      // Trace headers only, and traces over https: the metrics endpoint sends no headers.
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/v1/traces',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics.example.com/v1/metrics',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'k=v',
      },
    ]) {
      expect(readTelemetrySettings(env).warnings, JSON.stringify(env)).toEqual([]);
    }
    const metricsOnly = readTelemetrySettings({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/v1/traces',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://metrics.example.com/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'k=v',
    });
    expect(metricsOnly.warnings.join('\n')).toMatch(/go to metrics\.example\.com over plain http/);
  });

  it('leaves subjects out unless asked, and hashes them only with a long enough key', () => {
    expect(readTelemetrySettings(ENDPOINT).subject).toBe('off');
    expect(readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_SUBJECT: 'plain' }).subject).toBe(
      'plain',
    );
    const noKey = readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_SUBJECT: 'hash' });
    expect(noKey.subject).toBe('off');
    expect(noKey.warnings.join('\n')).toMatch(/needs APITAME_OTEL_SUBJECT_KEY/);
    const shortKey = readTelemetrySettings({
      ...ENDPOINT,
      APITAME_OTEL_SUBJECT: 'hash',
      APITAME_OTEL_SUBJECT_KEY: 'too-short',
    });
    expect(shortKey.subject).toBe('off');
    const hashed = readTelemetrySettings({
      ...ENDPOINT,
      APITAME_OTEL_SUBJECT: 'hash',
      APITAME_OTEL_SUBJECT_KEY: 'fake-key-0123456789abcdef',
    });
    expect(hashed.subject).toBe('hash');
    expect(hashed.subjectKey).toBe('fake-key-0123456789abcdef');
    const typo = readTelemetrySettings({ ...ENDPOINT, APITAME_OTEL_SUBJECT: 'yes' });
    expect(typo.subject).toBe('off');
    expect(typo.warnings.join('\n')).toMatch(/not one of off, hash or plain/);
  });

  it('keeps the metric export timeout within the interval', () => {
    const s = readTelemetrySettings({ ...ENDPOINT, OTEL_METRIC_EXPORT_INTERVAL: '5000' });
    expect(s.metricIntervalMs).toBe(5000);
    expect(s.metricTimeoutMs).toBe(5000);
    const bad = readTelemetrySettings({ ...ENDPOINT, OTEL_METRIC_EXPORT_INTERVAL: 'soon' });
    expect(bad.metricIntervalMs).toBe(60_000);
    expect(bad.warnings.join('\n')).toMatch(/OTEL_METRIC_EXPORT_INTERVAL/);
  });
});

describe('telemetry helpers', () => {
  it('reads W3C traceparent values and ignores invalid ones', () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    const span = '00f067aa0ba902b7';
    expect(parseTraceparent(`00-${trace}-${span}-01`)).toEqual({
      traceId: trace,
      spanId: span,
      flags: 1,
    });
    expect(parseTraceparent(`00-${trace}-${span}-00`)?.flags).toBe(0);
    // A later version may append fields; version 00 may not.
    expect(parseTraceparent(`01-${trace}-${span}-01-extra`)?.traceId).toBe(trace);
    for (const bad of [
      `00-${trace}-${span}-01-extra`,
      `ff-${trace}-${span}-01`,
      `00-${'0'.repeat(32)}-${span}-01`,
      `00-${trace}-${'0'.repeat(16)}-01`,
      `00-${trace.toUpperCase()}-${span}-01`,
      `00-${trace}-${span}`,
      `00-${trace}-${span}-01${' '.repeat(300)}`,
      42,
      undefined,
    ]) {
      expect(parseTraceparent(bad)).toBeUndefined();
    }
  });

  it('hashes subjects with HMAC-SHA256 and the key', () => {
    const key = 'fake-key-0123456789abcdef';
    expect(hashSubject(key, 'alice@example.com')).toBe(
      createHmac('sha256', key).update('alice@example.com').digest('hex').slice(0, 32),
    );
    expect(hashSubject(key, 'alice@example.com')).not.toBe(
      hashSubject('fake-key-other-key-000000', 'alice@example.com'),
    );
  });

  it('parses OTLP headers exactly as the exporter does, and finds the values it sends', () => {
    // The reviewer's case: the exporter cuts the value at ";" and decodes it.
    expect(parseOtlpHeaders('Authorization=Bearer%20fake-key-abc12345;meta')).toEqual({
      Authorization: 'Bearer fake-key-abc12345',
    });
    const sdk = sdkHeaderParser();
    for (const value of [
      'Authorization=Bearer%20fake-key-abc12345;meta',
      'x-api-key=fake-key-a%20b, x-team = items',
      'a=1,a=2',
      '=nokey,k=,  =  ,novalue',
      'k=%E0%A4%A,ok=fine',
      'k==v=w',
      ' k%20x = v%3Dy ',
      ';meta=1,k=v;x=y;z',
      'k=v,,,',
      '',
      'k=%20',
      'k= %41 ',
    ]) {
      expect(parseOtlpHeaders(value), value).toEqual(sdk(value));
    }
    expect(
      otlpHeaderValues({
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=fake-key-a%20b, x-team = items',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Basic%20fake-key-basic;meta,bad=%E0',
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'x-team=items',
      }),
    ).toEqual(['fake-key-a b', 'items', 'Basic fake-key-basic']);
  });

  it('samples a call with a client trace context on a server-side draw, not on its trace id', () => {
    const withParent = (traceId: string) =>
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId: 'ab'.repeat(8),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    // The reviewer's trace ids: never sampled, and always sampled, by TraceIdRatioBasedSampler.
    const hide = 'ffffffff' + '0'.repeat(23) + '1';
    const force = '0'.repeat(31) + '1';
    for (const [draw, expected] of [
      [0.49, SamplingDecision.RECORD_AND_SAMPLED],
      [0.5, SamplingDecision.NOT_RECORD],
    ] as const) {
      const sampler = new ServerRatioSampler(0.5, () => draw);
      for (const traceId of [hide, force]) {
        expect(sampler.shouldSample(withParent(traceId), traceId).decision, traceId).toBe(expected);
      }
    }
    // Without a parent, the trace id is apitame's own random id, and the ratio applies to it.
    const noDraw = new ServerRatioSampler(0.5, () => {
      throw new Error('no draw without a parent');
    });
    expect(noDraw.shouldSample(ROOT_CONTEXT, force).decision).toBe(
      SamplingDecision.RECORD_AND_SAMPLED,
    );
    expect(noDraw.shouldSample(ROOT_CONTEXT, hide).decision).toBe(SamplingDecision.NOT_RECORD);
    // The default draw is real randomness: both ids land near the ratio.
    const real = new ServerRatioSampler(0.5);
    for (const traceId of [hide, force]) {
      let sampled = 0;
      for (let i = 0; i < 400; i++) {
        if (
          real.shouldSample(withParent(traceId), traceId).decision ===
          SamplingDecision.RECORD_AND_SAMPLED
        )
          sampled++;
      }
      expect(sampled, traceId).toBeGreaterThan(120);
      expect(sampled, traceId).toBeLessThan(280);
    }
  });

  it('pins the tested releases as optional peers and development dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(OTEL_PACKAGES)) {
      expect(pkg.devDependencies[name], name).toBe(version);
      expect(pkg.peerDependencies[name], name).toBeDefined();
      expect(pkg.peerDependenciesMeta[name]?.optional, name).toBe(true);
      expect(pkg.dependencies[name], name).toBeUndefined();
      expect(OTEL_NPX).toContain(`-p ${name}@${version}`);
    }
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith('@opentelemetry/'))).toEqual(
      [],
    );
  });
});
