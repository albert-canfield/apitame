import type { ServerContext } from '@modelcontextprotocol/server';
import type { Logger } from '../log.js';
import type { Redactor } from '../safety/redact.js';
import type { CallContext, CallEvent, Runtime, ToolResult } from '../types.js';
import {
  OTEL_PACKAGES,
  otelMissingMessage,
  otlpHeaderValues,
  readTelemetrySettings,
  telemetryOn,
  type TelemetrySettings,
} from './config.js';

export { OTEL_NPX, OTEL_PACKAGES, OTEL_SPECS, readTelemetrySettings } from './config.js';
export type { TelemetrySettings } from './config.js';

/** What the MCP layer knows when a `tools/call` request arrives. */
export interface ToolCallInfo {
  /** The tool name, as the client sent it. */
  name: string;
  /** The runtime that serves the call. Tells the server's tools from names a client made up. */
  runtime: Runtime;
  ctx: ServerContext;
  /** `params._meta` of the request, where a client puts W3C trace context. */
  meta?: Record<string, unknown> | undefined;
  /** The OAuth client and subject, when the HTTP transport checked a token. */
  caller?: CallContext['caller'];
  /** The protocol version this server negotiated, when it did. */
  protocolVersion?: string | undefined;
}

/** One tool call's span and metrics. Never throws. */
export interface ToolCallTrace {
  /** Passed to the runtime as `CallContext.observe`. */
  observe: (event: CallEvent) => void;
  /** The call finished with this result, or threw (`undefined`). */
  end: (result: ToolResult | undefined) => void;
}

/** OpenTelemetry export, as `createMcpServer` uses it. Never throws into a tool call. */
export interface Telemetry {
  /** Where spans and metrics go, for the startup log line. */
  readonly description: string;
  startToolCall(info: ToolCallInfo): ToolCallTrace;
  /** Export what is buffered now. */
  flush(): Promise<void>;
  /** Export what is buffered and stop, waiting at most a few seconds for the collector. */
  shutdown(): Promise<void>;
}

export interface TelemetryDeps {
  /** How `serve` serves: sets `network.transport` (`pipe` for stdio, `tcp` for HTTP). */
  transport: 'stdio' | 'http';
  logger: Logger;
  redactor: Redactor;
  /** The config's server name and source type, exported as resource attributes. */
  server: { name: string; source: string };
}

/** The implementation in ./otel.ts, the only module that imports OpenTelemetry. */
export interface OtelModule {
  createTelemetry(settings: TelemetrySettings, deps: TelemetryDeps): Telemetry;
}

/** Loaded with import() only when telemetry is on, so its packages are never loaded otherwise. */
const loadOtel = (): Promise<OtelModule> => import('./otel.js');

/** Whether an error says that one of the OpenTelemetry packages is not installed. */
export function isMissingOtel(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  const message = String(e?.message);
  return (
    message.includes('@opentelemetry/') &&
    (e?.code === 'ERR_MODULE_NOT_FOUND' ||
      e?.code === 'MODULE_NOT_FOUND' ||
      /Cannot find (package|module)/.test(message))
  );
}

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0];

export interface StartTelemetryOptions extends TelemetryDeps {
  /** Defaults to `process.env`, which the OpenTelemetry exporters read too. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the import of ./otel.ts (tests). */
  load?: () => Promise<OtelModule>;
}

/**
 * Start OpenTelemetry export when the environment asks for it (`OTEL_EXPORTER_OTLP_ENDPOINT`
 * or a per-signal endpoint, and not `OTEL_SDK_DISABLED=true`). Otherwise nothing is imported and
 * this returns undefined. Missing packages are a warning: apitame serves without telemetry.
 */
export async function startTelemetry(opts: StartTelemetryOptions): Promise<Telemetry | undefined> {
  const env = opts.env ?? process.env;
  const settings = readTelemetrySettings(env);
  for (const w of settings.warnings) opts.logger.warn(`OpenTelemetry: ${w}`);
  if (!telemetryOn(settings)) return undefined;
  // Vendor API keys in the exporter headers are hidden in the log, and only there: they never
  // reach tool results, and a header value that is an ordinary word (`x-team=items`) must not be
  // cut out of API responses and span attributes. The subject key is a secret like any other.
  for (const value of otlpHeaderValues(env)) opts.logger.addSecret(value);
  opts.redactor.addSecret(settings.subjectKey);
  let mod: OtelModule;
  try {
    mod = await (opts.load ?? loadOtel)();
  } catch (err) {
    opts.logger.warn(otelMissingMessage(isMissingOtel(err) ? undefined : firstLine(err)));
    return undefined;
  }
  const telemetry = mod.createTelemetry(settings, opts);
  opts.logger.info(`OpenTelemetry: ${telemetry.description}`);
  return telemetry;
}

export interface TelemetryFinding {
  status: 'ok' | 'warn' | 'info';
  detail: string;
}

/**
 * What `doctor` reports: whether telemetry is on, and whether its packages load. The collector
 * is never contacted: export problems show up in `serve`'s log.
 */
export async function telemetryFindings(
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<OtelModule> = loadOtel,
): Promise<TelemetryFinding[]> {
  const settings = readTelemetrySettings(env);
  const findings: TelemetryFinding[] = settings.warnings.map((w) => ({
    status: 'warn',
    detail: w,
  }));
  if (!telemetryOn(settings)) {
    findings.push({ status: 'info', detail: `off (${settings.off})` });
    return findings;
  }
  try {
    await load();
  } catch (err) {
    findings.push({
      status: 'warn',
      detail: otelMissingMessage(isMissingOtel(err) ? undefined : firstLine(err)).replace(
        /\n/g,
        ' ',
      ),
    });
    return findings;
  }
  const where = [
    settings.traces ? `traces to ${settings.traces}` : '',
    settings.metrics ? `metrics to ${settings.metrics}` : '',
  ].filter(Boolean);
  findings.push({
    status: 'ok',
    detail: `${where.join(', ')}; packages load (${Object.keys(OTEL_PACKAGES).length} of them). The collector is not contacted by doctor.`,
  });
  return findings;
}
