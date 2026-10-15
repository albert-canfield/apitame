import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hashSubject,
  OTEL_NPX,
  OTEL_PACKAGES,
  otlpHeaderValues,
  parseTraceparent,
  readTelemetrySettings,
  telemetryOn,
} from '../../src/telemetry/config.js';
import { ROOT } from '../helpers.js';

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

  it('finds the header values to redact, raw and decoded', () => {
    expect(
      otlpHeaderValues({
        OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=fake-key-a%20b, x-team = fake-key-team',
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=Basic%20fake-key-basic',
      }),
    ).toEqual([
      'fake-key-a%20b',
      'fake-key-a b',
      'fake-key-team',
      'Basic%20fake-key-basic',
      'Basic fake-key-basic',
    ]);
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
