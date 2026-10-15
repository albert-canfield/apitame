/**
 * OpenTelemetry export for tool calls. This is the only module that imports OpenTelemetry, and
 * ./index.ts loads it with import() only when telemetry is on: the packages are optional peer
 * dependencies, missing from a default install.
 *
 * One span per `tools/call`, following the OpenTelemetry semantic conventions for MCP
 * (https://github.com/open-telemetry/semantic-conventions-genai, docs/gen-ai/mcp.md), plus
 * `apitame.*` attributes with what the audit log records about the call. Never arguments,
 * results, reasons, headers, SQL or secrets: see docs/telemetry.md.
 */
import {
  diag,
  DiagLogLevel,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type DiagLogger,
  type Link,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import type { Logger } from '../log.js';
import type { CallEvent, Runtime, ToolSummary } from '../types.js';
import { VERSION } from '../version.js';
import {
  hashSubject,
  parseTraceparent,
  type SamplerSetting,
  type TelemetrySettings,
} from './config.js';
import type { Telemetry, TelemetryDeps, ToolCallInfo, ToolCallTrace } from './index.js';

/** How long `shutdown` waits for the collector before giving up on what is still buffered. */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

/** The bucket boundaries the MCP semantic conventions give for operation durations, in seconds. */
const DURATION_BUCKETS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

/** The longest string attribute apitame exports. */
const MAX_ATTRIBUTE_CHARS = 256;

const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;

export interface OtelOptions extends TelemetryDeps {
  /** Tests: export spans here instead of to the OTLP endpoint. */
  spanExporter?: SpanExporter;
  /** Tests: read metrics with this reader instead of the periodic OTLP one. */
  metricReader?: IMetricReader;
  shutdownTimeoutMs?: number;
}

function samplerOf(s: SamplerSetting): Sampler {
  const root =
    s.kind === 'always_off'
      ? new AlwaysOffSampler()
      : s.kind === 'traceidratio'
        ? new TraceIdRatioBasedSampler(s.ratio)
        : new AlwaysOnSampler();
  return s.parentBased ? new ParentBasedSampler({ root }) : root;
}

/**
 * The message of an error. OpenTelemetry's global error handler hands over errors as JSON with
 * their stack; only the message is worth a log line.
 */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  const text = String(value);
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      // not JSON after all
    }
  }
  return text;
}

/**
 * OpenTelemetry's own problems (an unreachable collector, a refused export) go to apitame's log
 * as warnings, at most once a minute, through the redactor like every log line.
 */
function diagnostics(
  logger: Logger,
): DiagLogger & { report: (message: string, ...args: unknown[]) => void } {
  let last = Number.NEGATIVE_INFINITY;
  let skipped = 0;
  const report = (message: string, ...args: unknown[]) => {
    const now = Date.now();
    if (now - last < 60_000) {
      skipped++;
      return;
    }
    last = now;
    const text = [message, ...args].map(describe).join(' ').slice(0, 500);
    logger.warn(
      `OpenTelemetry: ${text}${skipped > 0 ? ` (${skipped} similar message${skipped === 1 ? '' : 's'} skipped)` : ''}`,
    );
    skipped = 0;
  };
  const ignore = () => {};
  return { error: report, warn: report, info: ignore, debug: ignore, verbose: ignore, report };
}

/** The tools of each runtime by name: only these names are exported (a client can send any). */
const toolIndex = new WeakMap<Runtime, Map<string, ToolSummary>>();
function summaryOf(runtime: Runtime, name: string): ToolSummary | undefined {
  let index = toolIndex.get(runtime);
  if (!index) {
    index = new Map(runtime.summarizeTools().map((t) => [t.name, t]));
    toolIndex.set(runtime, index);
  }
  return index.get(name);
}

/** Access level and operation known from the tool alone, before the runtime says more. */
function fromTool(summary: ToolSummary | undefined): Pick<CallEvent, 'access' | 'operation'> {
  if (!summary) return {};
  switch (summary.kind) {
    case 'operation':
      return { access: summary.access, operation: summary.operations[0] };
    case 'named-query':
      return { access: summary.access, operation: summary.name };
    case 'search':
    case 'sql':
      return { access: 'read' };
    default:
      return {};
  }
}

const remote = (value: unknown): Context | undefined => {
  const parent = parseTraceparent(value);
  return parent
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parent.traceId,
        spanId: parent.spanId,
        traceFlags: parent.flags,
        isRemote: true,
      })
    : undefined;
};

export function createTelemetry(settings: TelemetrySettings, opts: OtelOptions): Telemetry {
  const { logger, redactor } = opts;
  const problems = diagnostics(logger);
  diag.setLogger(problems, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });

  // apitame's defaults, then OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME, which win.
  const resource = defaultResource()
    .merge(
      resourceFromAttributes({
        'service.name': 'apitame',
        'service.version': VERSION,
        'apitame.server.name': opts.server.name,
        'apitame.source.type': opts.server.source,
      }),
    )
    .merge(detectResources({ detectors: [envDetector] }));

  // The exporters read the endpoint, headers, timeout, compression and certificates from the
  // standard OTEL_EXPORTER_OTLP_* variables themselves.
  const tracerProvider =
    settings.traces || opts.spanExporter
      ? new TracerProvider({
          resource,
          sampler: samplerOf(settings.sampler),
          spanProcessors: [
            new BatchSpanProcessor({ exporter: opts.spanExporter ?? new OTLPTraceExporter() }),
          ],
        })
      : undefined;
  const meterProvider =
    settings.metrics || opts.metricReader
      ? new MeterProvider({
          resource,
          readers: [
            opts.metricReader ??
              new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter(),
                exportIntervalMillis: settings.metricIntervalMs,
                exportTimeoutMillis: settings.metricTimeoutMs,
              }),
          ],
        })
      : undefined;

  const tracer = tracerProvider?.getTracer('apitame', VERSION);
  const meter = meterProvider?.getMeter('apitame', VERSION);
  const duration = meter?.createHistogram('mcp.server.operation.duration', {
    unit: 's',
    description:
      'MCP request duration as observed on the receiver from the time it was received until the result was sent.',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
  const calls = meter?.createCounter('apitame.tool.calls', {
    unit: '{call}',
    description: 'Tool calls, by tool, access level and outcome.',
  });

  const network: Attributes =
    opts.transport === 'http'
      ? { 'network.transport': 'tcp', 'network.protocol.name': 'http' }
      : { 'network.transport': 'pipe' };

  /** Strings pass the redactor and are capped: defense in depth, they hold no secrets by design. */
  const clean = (attributes: Attributes): Attributes => {
    const out: Attributes = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (v === undefined) continue;
      out[k] = typeof v === 'string' ? redactor.text(v).slice(0, MAX_ATTRIBUTE_CHARS) : v;
    }
    return out;
  };

  let warned = false;
  const failed = (err: unknown) => {
    if (warned) return;
    warned = true;
    logger.warn(`OpenTelemetry: recording a tool call failed: ${(err as Error)?.message ?? err}`);
  };

  const startToolCall = (info: ToolCallInfo): ToolCallTrace => {
    const started = performance.now();
    const summary = summaryOf(info.runtime, info.name);
    // A name the server does not have comes from the client unchecked: it is not exported.
    const tool = summary ? info.name : undefined;
    const req = info.ctx.http?.req;
    const header = req?.headers.get('mcp-protocol-version') ?? undefined;
    const protocol =
      info.protocolVersion ?? (header && PROTOCOL_VERSION.test(header) ? header : undefined);
    // Low cardinality: shared by the span and the duration histogram.
    const common: Attributes = {
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      ...(tool ? { 'gen_ai.tool.name': tool } : {}),
      ...network,
      ...(protocol ? { 'mcp.protocol.version': protocol } : {}),
    };
    const caller = info.caller ?? {};
    const subject =
      caller.subject === undefined
        ? {}
        : settings.subject === 'plain'
          ? { 'user.id': caller.subject }
          : settings.subject === 'hash' && settings.subjectKey
            ? { 'user.hash': hashSubject(settings.subjectKey, caller.subject) }
            : {};
    const requestId = String(info.ctx.mcpReq.id);

    // The client's trace context: from params._meta (the MCP semantic conventions), else the
    // HTTP request's traceparent header (a gateway's). With both, the header becomes a link.
    let parent: Context = ROOT_CONTEXT;
    const links: Link[] = [];
    if (settings.propagate) {
      const fromMeta = remote(info.meta?.traceparent);
      const fromHeader = remote(req?.headers.get('traceparent'));
      parent = fromMeta ?? fromHeader ?? ROOT_CONTEXT;
      const linked = fromMeta && fromHeader && trace.getSpanContext(fromHeader);
      if (linked) links.push({ context: linked });
    }

    let span: ReturnType<NonNullable<typeof tracer>['startSpan']> | undefined;
    try {
      span = tracer?.startSpan(
        tool ? `tools/call ${tool}` : 'tools/call',
        {
          kind: SpanKind.SERVER,
          attributes: clean({
            ...common,
            ...(requestId.length <= 128 ? { 'jsonrpc.request.id': requestId } : {}),
            ...(info.ctx.sessionId ? { 'mcp.session.id': info.ctx.sessionId } : {}),
            ...(caller.client ? { 'apitame.caller.client': caller.client } : {}),
            ...subject,
          }),
          links,
        },
        parent,
      );
    } catch (err) {
      failed(err);
    }

    let first: CallEvent | undefined;
    let requests = 0;
    let ended = false;
    return {
      observe: (event) => {
        first ??= event;
        if (event.outcome === 'sent' || event.outcome === 'error') requests++;
      },
      end: (result) => {
        if (ended) return;
        ended = true;
        try {
          const isError = !result || result.isError === true;
          // The first audit entry is the decision about the call; later ones are its pages.
          const outcome = first?.outcome ?? (isError ? 'error' : 'ok');
          const known = fromTool(summary);
          const access = first?.access ?? known.access;
          const operation = first?.operation ?? known.operation;
          const errorType = isError ? (result ? 'tool_error' : '_OTHER') : undefined;
          if (span) {
            span.setAttributes(
              clean({
                'apitame.outcome': outcome,
                'apitame.access': access,
                'apitame.operation': operation,
                'apitame.upstream.status_code': first?.status,
                ...(requests > 0 ? { 'apitame.upstream.requests': requests } : {}),
                'error.type': errorType,
              }),
            );
            // The status message is the outcome: the result's text may quote arguments.
            if (isError) span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
            span.end();
          }
          duration?.record(
            (performance.now() - started) / 1000,
            clean({ ...common, 'error.type': errorType }),
          );
          // No subject, client or operation: metric attributes must stay few.
          calls?.add(
            1,
            clean({
              'gen_ai.tool.name': tool,
              'apitame.access': access,
              'apitame.outcome': outcome,
            }),
          );
        } catch (err) {
          failed(err);
        }
      },
    };
  };

  const where = [
    settings.traces ? `traces to ${settings.traces}` : '',
    settings.metrics
      ? `metrics every ${settings.metricIntervalMs / 1000} s to ${settings.metrics}`
      : '',
  ].filter(Boolean);

  let closing: Promise<void> | undefined;
  return {
    description: `${where.join(', ') || 'in-process export'} (OTLP over HTTP)`,
    startToolCall: (info) => {
      try {
        return startToolCall(info);
      } catch (err) {
        failed(err);
        return { observe: () => {}, end: () => {} };
      }
    },
    flush: async () => {
      // A failed export is reported like those of the periodic exports, never thrown.
      const results = await Promise.allSettled([
        tracerProvider?.forceFlush(),
        meterProvider?.forceFlush(),
      ]);
      for (const r of results)
        if (r.status === 'rejected') problems.report('export failed:', r.reason);
    },
    shutdown: () => {
      closing ??= (async () => {
        const limit = opts.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
        let timer: NodeJS.Timeout | undefined;
        const done = Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown()]);
        const late = await Promise.race([
          done.then((results) => {
            for (const r of results)
              if (r.status === 'rejected') problems.report('export failed:', r.reason);
            return false;
          }),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), limit);
          }),
        ]);
        clearTimeout(timer);
        if (late) {
          logger.warn(
            `OpenTelemetry: the collector did not take the last spans and metrics within ${limit / 1000} s, so they are dropped.`,
          );
        }
        diag.disable();
      })();
      return closing;
    },
  };
}
