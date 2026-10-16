import { createHmac } from 'node:crypto';

/**
 * OpenTelemetry settings, read from the standard `OTEL_*` environment variables. Nothing here
 * loads OpenTelemetry: its packages are optional peer dependencies, imported only once telemetry
 * is on (see ./index.ts), so a default install neither grows nor pays for them.
 */

/**
 * The OpenTelemetry packages apitame loads, at the releases it is tested with. To move to newer
 * ones: update the devDependencies in package.json and these versions together (a test checks
 * that they agree), run the test suite, and check docs/telemetry.md.
 */
export const OTEL_PACKAGES = {
  '@opentelemetry/api': '1.9.1',
  '@opentelemetry/sdk-trace': '2.12.0',
  '@opentelemetry/sdk-metrics': '2.12.0',
  '@opentelemetry/resources': '2.12.0',
  '@opentelemetry/exporter-trace-otlp-proto': '0.223.0',
  '@opentelemetry/exporter-metrics-otlp-proto': '0.223.0',
} as const;

/** The pinned package specs, for npx -p and npm install. */
export const OTEL_SPECS = Object.entries(OTEL_PACKAGES).map(([name, v]) => `${name}@${v}`);

/** How to run apitame with OpenTelemetry without installing anything. */
export const OTEL_NPX = `npx -p apitame ${OTEL_SPECS.map((s) => `-p ${s}`).join(' ')} apitame`;

export function otelMissingMessage(detail?: string): string {
  return [
    'OpenTelemetry export is on (an OTEL_EXPORTER_OTLP_*ENDPOINT variable is set), but its packages are not installed: apitame does not install them by default, and serves without telemetry until they are.',
    `Run apitame together with them, for example: ${OTEL_NPX} serve`,
    `or install them next to apitame: npm install ${OTEL_SPECS.join(' ')}`,
    ...(detail ? [`(loading them failed with: ${detail})`] : []),
  ].join('\n');
}

export type SubjectMode = 'off' | 'hash' | 'plain';

export interface SamplerSetting {
  kind: 'always_on' | 'always_off' | 'traceidratio';
  /** Follow the sampling decision of an incoming trace context. */
  parentBased: boolean;
  ratio: number;
}

export interface TelemetrySettings {
  /** Where spans go (for messages), when traces are exported. */
  traces?: string;
  /** Where metrics go (for messages), when metrics are exported. */
  metrics?: string;
  /** Why nothing is exported, when nothing is. */
  off?: string;
  /** Continue a W3C trace context sent in `params._meta` or the HTTP `traceparent` header. */
  propagate: boolean;
  sampler: SamplerSetting;
  /** Whether and how the OAuth subject is exported (it can be personal data). */
  subject: SubjectMode;
  /** The HMAC key for `subject: hash`. A secret. */
  subjectKey?: string;
  /** Whether spans carry the OAuth client (`APITAME_OTEL_CLIENT=off` leaves it out). */
  client: boolean;
  metricIntervalMs: number;
  metricTimeoutMs: number;
  warnings: string[];
}

export const telemetryOn = (s: TelemetrySettings): boolean => Boolean(s.traces || s.metrics);

const word = (v: string | undefined) => v?.trim().toLowerCase() || undefined;
const list = (v: string | undefined) =>
  v
    ?.split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

/** The URL with no credentials and no query string, for messages. */
export function displayUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(not a URL)';
  }
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, warnings: string[]) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  warnings.push(`${name} must be a whole number of milliseconds; using ${fallback}.`);
  return fallback;
}

const SAMPLERS: Record<string, Omit<SamplerSetting, 'ratio'>> = {
  always_on: { kind: 'always_on', parentBased: false },
  always_off: { kind: 'always_off', parentBased: false },
  traceidratio: { kind: 'traceidratio', parentBased: false },
  parentbased_always_on: { kind: 'always_on', parentBased: true },
  parentbased_always_off: { kind: 'always_off', parentBased: true },
  parentbased_traceidratio: { kind: 'traceidratio', parentBased: true },
};

function readSampler(env: NodeJS.ProcessEnv, warnings: string[]): SamplerSetting {
  const name = word(env.OTEL_TRACES_SAMPLER);
  // Not parent based by default: a client must not be able to switch off the recording of its
  // own calls by sending a trace context marked "not sampled".
  const chosen = name ? SAMPLERS[name] : SAMPLERS.always_on!;
  if (!chosen) {
    warnings.push(
      `OTEL_TRACES_SAMPLER=${name} is not supported (use always_on, always_off, traceidratio or a parentbased_ variant); every call is recorded.`,
    );
    return { kind: 'always_on', parentBased: false, ratio: 1 };
  }
  let ratio = 1;
  if (chosen.kind === 'traceidratio') {
    const arg = env.OTEL_TRACES_SAMPLER_ARG?.trim();
    const n = arg ? Number(arg) : 1;
    if (Number.isFinite(n) && n >= 0 && n <= 1) ratio = n;
    else warnings.push('OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1; using 1.');
  }
  return { ...chosen, ratio };
}

/** The smallest HMAC key accepted for `APITAME_OTEL_SUBJECT=hash`. */
export const MIN_SUBJECT_KEY_LENGTH = 16;
/** How many different characters that key needs at least: `kkkkkkkkkkkkkkkk` is no secret. */
export const MIN_SUBJECT_KEY_DISTINCT = 8;

/** Whether a key is long and varied enough to keep a guess from being checked against a hash. */
export function strongSubjectKey(key: string | undefined): key is string {
  return (
    key !== undefined &&
    key.length >= MIN_SUBJECT_KEY_LENGTH &&
    key.trim() !== '' &&
    new Set(key).size >= MIN_SUBJECT_KEY_DISTINCT
  );
}

function readSubject(env: NodeJS.ProcessEnv, warnings: string[]) {
  const mode = word(env.APITAME_OTEL_SUBJECT);
  if (!mode || mode === 'off') return { subject: 'off' as const };
  if (mode === 'plain') return { subject: 'plain' as const };
  if (mode === 'hash') {
    const key = env.APITAME_OTEL_SUBJECT_KEY;
    if (strongSubjectKey(key)) return { subject: 'hash' as const, key };
    warnings.push(
      `APITAME_OTEL_SUBJECT=hash needs APITAME_OTEL_SUBJECT_KEY, a random secret of at least ${MIN_SUBJECT_KEY_LENGTH} characters with at least ${MIN_SUBJECT_KEY_DISTINCT} different ones (for example from \`openssl rand -hex 32\`), so subjects are left out.`,
    );
    return { subject: 'off' as const };
  }
  warnings.push(
    `APITAME_OTEL_SUBJECT=${mode} is not one of off, hash or plain, so subjects are left out.`,
  );
  return { subject: 'off' as const };
}

/** The OAuth client is on spans unless `APITAME_OTEL_CLIENT=off`; a value it does not know is off. */
function readClient(env: NodeJS.ProcessEnv, warnings: string[]): boolean {
  const mode = word(env.APITAME_OTEL_CLIENT);
  if (!mode || mode === 'on') return true;
  if (mode !== 'off') {
    warnings.push(`APITAME_OTEL_CLIENT=${mode} is not on or off, so clients are left out.`);
  }
  return false;
}

/**
 * Read the settings from the environment. Telemetry is on when an OTLP endpoint is set for
 * traces or metrics, unless `OTEL_SDK_DISABLED=true`. Unsupported values are warnings, never
 * errors: telemetry must not stop the server.
 */
export function readTelemetrySettings(env: NodeJS.ProcessEnv): TelemetrySettings {
  const warnings: string[] = [];
  const subject = readSubject(env, warnings);
  const metricIntervalMs = positive(env, 'OTEL_METRIC_EXPORT_INTERVAL', 60_000, warnings);
  const settings: TelemetrySettings = {
    propagate: true,
    sampler: readSampler(env, warnings),
    subject: subject.subject,
    ...(subject.key ? { subjectKey: subject.key } : {}),
    client: readClient(env, warnings),
    metricIntervalMs,
    // The reader refuses a timeout longer than the interval.
    metricTimeoutMs: Math.min(
      metricIntervalMs,
      positive(env, 'OTEL_METRIC_EXPORT_TIMEOUT', 30_000, warnings),
    ),
    warnings,
  };

  const propagators = list(env.OTEL_PROPAGATORS);
  settings.propagate = !propagators || propagators.includes('tracecontext');
  if (propagators && !settings.propagate && !propagators.includes('none')) {
    warnings.push(
      `OTEL_PROPAGATORS=${propagators.join(',')}: apitame only reads W3C trace context (tracecontext), so every call starts a new trace.`,
    );
  }

  if (word(env.OTEL_SDK_DISABLED) === 'true') {
    return { ...settings, off: 'OTEL_SDK_DISABLED is true' };
  }

  const protocols = new Set<string>();
  const plainHeaders = new Set<string>();
  const signal = (name: 'traces' | 'metrics'): string | undefined => {
    const upper = name.toUpperCase();
    const own = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]?.trim();
    const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (!own && !shared) return undefined;
    const exporters = list(env[`OTEL_${upper}_EXPORTER`]);
    if (exporters?.includes('none')) return undefined;
    if (exporters && exporters.length > 0 && !exporters.includes('otlp')) {
      warnings.push(
        `OTEL_${upper}_EXPORTER=${exporters.join(',')} is not supported: apitame only exports OTLP, so it sends no ${name}.`,
      );
      return undefined;
    }
    // The exporters read these variables themselves; this is what they make of them.
    const url = own || `${shared!.endsWith('/') ? shared : `${shared}/`}v1/${name}`;
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      const variable = own ? `OTEL_EXPORTER_OTLP_${upper}_ENDPOINT` : 'OTEL_EXPORTER_OTLP_ENDPOINT';
      warnings.push(`${variable} is not an http or https URL, so apitame sends no ${name}.`);
      return undefined;
    }
    const protocol = (
      env[`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL
    )?.trim();
    if (protocol && protocol !== 'http/protobuf') protocols.add(protocol);
    // The headers this signal sends, as the exporter merges them (its own over the shared ones).
    const headers = {
      ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]),
    };
    if (
      Object.keys(headers).length > 0 &&
      parsed.protocol === 'http:' &&
      !LOOPBACK.has(parsed.hostname)
    ) {
      plainHeaders.add(parsed.host);
    }
    return displayUrl(url);
  };
  const traces = signal('traces');
  const metrics = signal('metrics');
  for (const host of plainHeaders) {
    warnings.push(
      `OTLP headers (OTEL_EXPORTER_OTLP_HEADERS) go to ${host} over plain http, where anyone on the network path can read them, an API key included. Use an https endpoint (http is fine on loopback only).`,
    );
  }
  for (const p of protocols) {
    warnings.push(
      `OTEL_EXPORTER_OTLP_PROTOCOL ${p} is not supported: apitame sends OTLP over HTTP with protobuf (http/protobuf). Point the endpoint at the collector's OTLP/HTTP port, usually 4318.`,
    );
  }
  if (!traces && !metrics) {
    const set =
      env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
    return {
      ...settings,
      off: set ? 'no signal left to export' : 'OTEL_EXPORTER_OTLP_ENDPOINT is not set',
    };
  }
  return {
    ...settings,
    ...(traces ? { traces } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

/** Hosts where an OTLP endpoint may use plain http, as for the token introspection URL. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * One OTLP headers variable (`key=value,key2=value2`), parsed exactly as the exporters parse it:
 * `parseKeyPairsIntoRecord` and `parsePairKeyValue` in @opentelemetry/core 2.12.0. Entries are
 * split on `,` and cut at the first `;`; the key and the value around the first `=` are trimmed,
 * must not be empty and are percent-decoded, and an entry that does not decode is dropped. A
 * later entry with the same key wins.
 */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'string' || value.length === 0) return out;
  for (const entry of value.split(',')) {
    if (!entry) continue;
    const semicolon = entry.indexOf(';');
    const pair = semicolon === -1 ? entry : entry.slice(0, semicolon);
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const rawKey = pair.slice(0, at).trim();
    const rawValue = pair.slice(at + 1).trim();
    if (!rawKey || !rawValue) continue;
    try {
      const key = decodeURIComponent(rawKey);
      const decoded = decodeURIComponent(rawValue);
      if (decoded.length > 0) out[key] = decoded;
    } catch {
      // The exporter drops an entry it cannot decode, so nothing of it is sent.
    }
  }
  return out;
}

/**
 * The header values the OTLP exporters send (`OTEL_EXPORTER_OTLP_HEADERS` and the per-signal
 * variants): vendor API keys usually travel there. They are hidden in apitame's log, and only
 * there (see `Logger.addSecret`).
 */
export function otlpHeaderValues(env: NodeJS.ProcessEnv): string[] {
  const values = [
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
    'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  ].flatMap((name) => Object.values(parseOtlpHeaders(env[name])));
  return [...new Set(values)];
}

/**
 * A pseudonym for an OAuth subject: HMAC-SHA256 with a key only the operator holds, so the same
 * user always gets the same value, and without the key nobody can check a guess (an email
 * address, say) against it.
 */
export function hashSubject(key: string, subject: string): string {
  return createHmac('sha256', key).update(subject).digest('hex').slice(0, 32);
}

export interface RemoteParent {
  traceId: string;
  spanId: string;
  flags: number;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * Read a W3C `traceparent` value (from `params._meta` or the HTTP header). Anything that is not
 * a valid one is ignored, as the W3C recommendation says: the call then starts a new trace.
 */
export function parseTraceparent(value: unknown): RemoteParent | undefined {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  const m = TRACEPARENT.exec(value.trim());
  if (!m) return undefined;
  const [, version, traceId, spanId, flags, rest] = m as unknown as string[];
  if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined;
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return undefined;
  return { traceId: traceId!, spanId: spanId!, flags: parseInt(flags!, 16) };
}
