# OpenTelemetry

apitame can export every tool call to your observability stack: one span per call, with the tool, the operation, the access level, the outcome the audit log records and how long it took, plus two metrics. It speaks OTLP over HTTP, so it works with an OpenTelemetry Collector, Jaeger, Grafana, Honeycomb, Datadog and any other backend that accepts OTLP.

It is off by default. Until an OTLP endpoint is set, apitame loads none of the OpenTelemetry code and a tool call costs exactly what it did before. Arguments, results and secrets are never exported.

## Turn it on

The OpenTelemetry packages are optional, like the DuckDB driver: they add about 29 MB that most users do not need, so a default install does not include them. Run apitame together with the tested releases:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npx -p apitame -p @opentelemetry/api@1.9.1 -p @opentelemetry/sdk-trace@2.12.0 \
  -p @opentelemetry/sdk-metrics@2.12.0 -p @opentelemetry/resources@2.12.0 \
  -p @opentelemetry/exporter-trace-otlp-proto@0.223.0 \
  -p @opentelemetry/exporter-metrics-otlp-proto@0.223.0 \
  apitame serve --transport http
```

Or install them next to apitame:

```bash
npm install apitame @opentelemetry/api@1.9.1 @opentelemetry/sdk-trace@2.12.0 @opentelemetry/sdk-metrics@2.12.0 @opentelemetry/resources@2.12.0 @opentelemetry/exporter-trace-otlp-proto@0.223.0 @opentelemetry/exporter-metrics-otlp-proto@0.223.0
```

For the container image, see [deploy.md](deploy.md#opentelemetry).

At startup `serve` logs where it sends what:

```text
[apitame] OpenTelemetry: traces to http://localhost:4318/v1/traces, metrics every 60 s to http://localhost:4318/v1/metrics (OTLP over HTTP)
```

If an endpoint is set but the packages are missing, `serve` logs a warning with the command above and keeps serving, without telemetry. Telemetry never stops the server and never fails a tool call: when the collector is down or refuses data, apitame logs a warning at most once a minute and goes on. `apitame doctor` reports whether telemetry is on and whether the packages load; it does not contact the collector.

## Settings

apitame reads the standard OpenTelemetry environment variables, from the environment or from the `.env` file next to the config. They are read once at startup: a `--watch` reload does not change them.

| Variable | Default | Description |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | The collector's OTLP/HTTP address, such as `http://localhost:4318`. Traces go to `/v1/traces` under it and metrics to `/v1/metrics`. Setting it turns telemetry on. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | The full URL for one signal. Setting only one of them exports only that signal. |
| `OTEL_SDK_DISABLED` | `false` | `true` turns telemetry off whatever else is set. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp` | `none` turns that signal off. Other exporters (`zipkin`, `prometheus`, `console`) are not supported: apitame warns and sends nothing for that signal. |
| `OTEL_EXPORTER_OTLP_HEADERS` (and `_TRACES_HEADERS`, `_METRICS_HEADERS`) | unset | Headers for the collector, such as a vendor API key: `x-api-key=...,x-team=...`. apitame reads them exactly as the exporter does and hides their values in its own log, including OpenTelemetry's error messages. Only there: they never reach tool results, so a value that is an ordinary word (`x-team=items`) does not disappear from API responses or span attributes. With headers set, an endpoint that uses plain `http` on a host other than loopback is a warning at startup: anyone on the network path could read them. |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_COMPRESSION`, `OTEL_EXPORTER_OTLP_CERTIFICATE` and the other OTLP exporter variables | the SDK's | Read by the OpenTelemetry exporters themselves, as documented by OpenTelemetry. Certificate and key paths resolve from the folder apitame runs in (its working directory), not from the folder that holds the config: use absolute paths. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | apitame always sends `http/protobuf`. Any other value (`grpc`, `http/json`) is a warning: point the endpoint at the collector's OTLP/HTTP port, usually 4318, not the gRPC port 4317. |
| `OTEL_SERVICE_NAME` | `apitame` | The service name in your backend. |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Extra resource attributes, such as `deployment.environment.name=prod,service.namespace=tools`. They win over apitame's own. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `always_on` | `always_on`, `always_off`, `traceidratio` (with a ratio from 0 to 1 in the argument) or their `parentbased_` variants. See [Trace context](#trace-context) for why the default is not parent based, and how `traceidratio` decides for calls that bring a trace context. |
| `OTEL_PROPAGATORS` | `tracecontext` | `none` ignores the trace context clients send. Only W3C trace context is read. |
| `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_TIMEOUT` | `60000`, `30000` | How often metrics are sent, and how long one export may take, in milliseconds. |
| `APITAME_OTEL_SUBJECT` | `off` | Whether spans carry the OAuth subject: `off`, `hash` or `plain`. See [Caller identity](#caller-identity). |
| `APITAME_OTEL_SUBJECT_KEY` | unset | The HMAC key for `APITAME_OTEL_SUBJECT=hash`: at least 16 characters, not only spaces, with at least 8 different characters. Make one with `openssl rand -hex 32`. A secret: keep it out of the config and out of your observability stack. |
| `APITAME_OTEL_CLIENT` | `on` | `off` leaves the OAuth client out of spans. See [Caller identity](#caller-identity). |

Unsupported values are warnings, never errors: telemetry is not worth a server that does not start.

## What is exported

### One span per tool call

Each `tools/call` request becomes one span of kind `SERVER`, named `tools/call <tool>` (`tools/call issues`), as the [OpenTelemetry semantic conventions for MCP](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md) describe it. Those conventions are still in development (October 2026), so their names may change; apitame follows them where they define an attribute and uses its own `apitame.*` names for the rest. The span covers the whole call, including the time a human takes to answer an approval prompt. Other MCP requests (`tools/list`, `resources/read`) are not traced.

| Attribute | From | Value |
| --- | --- | --- |
| `mcp.method.name` | MCP conventions | `tools/call` |
| `gen_ai.tool.name` | MCP conventions | The tool, when the server has a tool of that name. A name the client made up is left out, and the span is named `tools/call`. |
| `gen_ai.operation.name` | MCP conventions | `execute_tool` |
| `jsonrpc.request.id` | MCP conventions | The JSON-RPC id of the request, when it is a number or a short token (1 to 64 letters, digits and `.`, `_`, `:` or `-`). Any other id is left out, so a client cannot write free text into your traces. |
| `mcp.protocol.version` | MCP conventions | The protocol version of the request, such as `2025-11-25` or `2026-07-28`. |
| `mcp.session.id` | MCP conventions | With `serve --transport http --sessions`: a hash of the session id (SHA-256, first 32 hexadecimal characters), never the id itself. The spans of one session share it, but it cannot be used to send requests into the session. |
| `network.transport`, `network.protocol.name` | MCP conventions | `pipe` over stdio; `tcp` and `http` over HTTP. |
| `error.type` | MCP conventions | `tool_error` when the result is an error, `_OTHER` when the request failed outright. The span status is then `ERROR`, with the outcome as its message. |
| `apitame.outcome` | apitame | What happened to the call, see below. |
| `apitame.access` | apitame | `read`, `write` or `destructive`, when known. |
| `apitame.operation` | apitame | The OpenAPI operation id or the SQL named query, when known. |
| `apitame.upstream.status_code` | apitame | The HTTP status of the API's answer (the first page's, for a paged call). |
| `apitame.upstream.requests` | apitame | Requests sent to the API or the database for this call: 1, or one per page read with `pages`. Not set when nothing was sent. |
| `apitame.caller.client` | apitame | The OAuth client the access token was issued to, over HTTP with `http.oauth`, unless `APITAME_OTEL_CLIENT=off`. |
| `user.hash` or `user.id` | OpenTelemetry user attributes | The OAuth subject, only when `APITAME_OTEL_SUBJECT` asks for it. |

The outcome uses the audit log's words, so a span and an audit entry about the same call agree:

| `apitame.outcome` | Meaning |
| --- | --- |
| `sent` | The request reached the API or the database and the answer was not an error. |
| `error` | The API answered with an error status or the request or query failed. Also a call apitame could not start, such as an unknown tool or invalid arguments; then `apitame.upstream.requests` is not set. |
| `blocked` | A write that the mode, `writes.allow`, the caller's permissions or an argument rule refuses. |
| `refused` | A SQL query that a safety layer refused. |
| `dry-run` | `"dryRun": true`: nothing was changed. |
| `confirmation-requested` | A destructive call is waiting for a human: a confirm token or an approval form went back to the client. |
| `declined` | The human did not approve, a confirm token did not match, or apitame could not ask. |
| `approval-refused` | A 2026-07-28 approval id was unknown, used, expired or issued for another call. |
| `rate-limited` | Over a per-minute limit: all calls, the tool's own, writes, or the caller's own. |
| `ok` | apitame answered itself, without an audited request: `search_operations`, `list_tables`, `describe_table`. |

The outcome is the first thing the runtime decides about the call, so for a call that reads several pages it is the first page's outcome, and the following pages are counted in `apitame.upstream.requests`. Telemetry records reads as well as writes, whatever `audit.include` says.

Every span also carries resource attributes: `service.name` (`apitame`, or `OTEL_SERVICE_NAME`), `service.version`, `apitame.server.name` (the config's `name`), `apitame.source.type` (`openapi`, `postgres`, `mysql`, `sqlite` or `duckdb`), the SDK's `telemetry.sdk.*` and whatever `OTEL_RESOURCE_ATTRIBUTES` adds.

apitame does not create child spans for the requests it sends to the API or the database: the URL of a request can carry secrets in its path or query string, and the operation id, status and request count on the call's span answer the same questions.

### Metrics

| Metric | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `mcp.server.operation.duration` | histogram, with the buckets the MCP conventions give (10 ms to 300 s) | `s` | `mcp.method.name`, `gen_ai.tool.name`, `gen_ai.operation.name`, `network.transport`, `network.protocol.name`, `mcp.protocol.version`, and `error.type` for errors |
| `apitame.tool.calls` | counter | `{call}` | `gen_ai.tool.name`, `apitame.access`, `apitame.outcome` |

Metric attributes are few on purpose: no client, no subject, no operation id (a large API has hundreds) and no session, so the number of series stays small whatever the traffic. Use spans for the details. Sampling never applies to metrics: they count every call.

## What is never exported

- Tool arguments and results, in any form. There is no setting to export them: arguments hold the data your agent works on, and results hold what the API or the database returned.
- The text of errors, refusals and approval prompts, and the audit log's `reason`: they can quote argument values. The span status message is the outcome word, never a sentence.
- SQL text, request URLs, query strings, headers and bodies.
- Credentials of any kind: API keys, database URLs, OAuth access tokens, the scopes of a token, the introspection secret. String attributes also pass through the redactor before they leave, as a second line of defense.
- The OAuth subject, unless `APITAME_OTEL_SUBJECT` says otherwise, and the client's IP address.
- Tool names the server does not have, JSON-RPC ids that are not plain tokens, session ids (only their hash), `tracestate` and `baggage`.

The audit log stays the record of what the agent asked for, with redacted arguments and reasons ([safety.md](safety.md#audit-log)). Telemetry is for dashboards and alerts: how often each tool runs, how often writes are blocked or declined, which calls are slow.

## Caller identity

Over HTTP with `http.oauth`, every span names the OAuth client (`apitame.caller.client`), as the audit log does. A client id names an application, not a person, and it is what you need to tell your triage bot from your developers' editors. Some identity providers register one client per user and install (dynamic client registration), where a client id comes close to naming a person: `APITAME_OTEL_CLIENT=off` leaves it out.

The subject is usually a person: a user id, sometimes an email address. That is personal data, and your observability backend probably keeps it longer and shows it to more people than your audit log. So it is left out by default:

- `APITAME_OTEL_SUBJECT=hash` exports `user.hash`: an HMAC-SHA256 of the subject with `APITAME_OTEL_SUBJECT_KEY`, as 32 hexadecimal characters. The same user always gets the same value, so you can count users and follow one user's calls, and whoever holds the key can compute the value for a given user when they need to. Without the key, nobody can check a guess against it. It is still a pseudonym, not anonymous data. Changing the key changes every value. The key must be random: at least 16 characters, with at least 8 different ones (a key such as `kkkkkkkkkkkkkkkk` or sixteen spaces is refused, and subjects are then left out). `openssl rand -hex 32` makes a good one.
- `APITAME_OTEL_SUBJECT=plain` exports the subject as it is, as `user.id`. That is personal data in your observability backend: use it only where the backend may hold it, and only by explicit choice.

Neither ever goes into metrics. Over stdio, with `APITAME_HTTP_TOKEN` and without authentication there is no caller to name.

## Trace context

A client can make apitame's span part of its own trace. apitame looks for a W3C `traceparent`:

1. in the request's `params._meta`, where the MCP conventions put it (this works over stdio too);
2. otherwise, over HTTP, in the request's `traceparent` header, which an API gateway or a proxy in front of apitame may add. When both are there, the span's parent comes from `params._meta` and the header becomes a link.

Only the trace id and the parent span id are taken. An invalid value is ignored, and the call starts a new trace. Trace context is read inside the tool call, after authentication, and changes nothing about how the call is checked, decided or sent: it only says which trace the span belongs to. A client that sends one can attach apitame's spans to a trace of its choosing, so treat incoming trace ids as hints, not as proof of where a call came from. `OTEL_PROPAGATORS=none` ignores them.

Sampling stays apitame's decision unless you choose otherwise:

- The default sampler is `always_on` and not parent based, on purpose: with a parent-based sampler, a client could keep its calls out of your traces by sending a trace context marked "not sampled".
- `traceidratio` normally decides from the trace id. A call that brings a trace context takes its trace id from the client, which could then pick an id that is never sampled (to hide its calls) or always sampled. So for such a call apitame draws a random number on the server instead, and the client's trace id has no say. A call without a trace context gets apitame's own random trace id, and the ratio applies to it as usual.
- `parentbased_always_on`, `parentbased_traceidratio` and the other `parentbased_` samplers let the client's sampled flag decide. Choose one only if your clients are trusted and you want their sampling decisions to apply.

Metrics count every call, whatever the sampler decides.

## Stdio and shutdown

Telemetry works over stdio as over HTTP. Spans are sent in batches every 5 seconds and metrics every 60 seconds (`OTEL_METRIC_EXPORT_INTERVAL`). When `serve` stops (the client closes stdin, or `SIGTERM` or `SIGINT`), apitame sends what is left and waits at most 3 seconds for the collector, so a dead collector never holds up the exit for long; whatever it has not taken by then is dropped, with a warning. A client that kills the process outright loses the last batch.

## Example: an OpenTelemetry Collector and Jaeger

This Compose file runs a collector that receives OTLP over HTTP on port 4318, forwards traces to Jaeger and prints metrics to its own log:

```yaml
# compose.yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector:0.162.0
    volumes:
      - ./otel-collector.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - 127.0.0.1:4318:4318
  jaeger:
    image: jaegertracing/jaeger:2.22.0
    ports:
      - 127.0.0.1:16686:16686
```

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  otlp_grpc/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  debug: {}

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlp_grpc/jaeger]
    metrics:
      receivers: [otlp]
      exporters: [debug]
```

```bash
docker compose up -d
# then start apitame with the npx command from "Turn it on" above
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npx -p apitame -p @opentelemetry/api@1.9.1 ... apitame serve --transport http
```

Make a few tool calls, then open http://localhost:16686 and pick the service `apitame`. `docker compose logs otel-collector` shows the metrics arriving. In production, replace the `debug` exporter with your metrics backend (Prometheus, Grafana Mimir, a vendor).

Jaeger alone also accepts OTLP, for traces only. Run `docker run --rm -p 4318:4318 -p 16686:16686 jaegertracing/jaeger:2.22.0` and set only `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces`, so that apitame sends no metrics there.
