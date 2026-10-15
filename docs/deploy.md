# Deploying apitame over HTTP

This page is for running one apitame server that several people or agents reach over the network: in a container, behind a reverse proxy with TLS, with a token or with your identity provider (OAuth). For a server on your own machine, `npx apitame serve --transport http` is enough (see [clients.md](clients.md#streamable-http)).

What you need:

- a folder with `apitame.config.yaml` and what it names (the spec, the skills folder), made with `apitame init` and reviewed like code;
- the credentials the config reads from the environment (the API token or the database URL);
- a way for clients to authenticate: `APITAME_HTTP_TOKEN` (one shared token, for one person or one service) or `http.oauth` (each user signs in with your identity provider, see [clients.md](clients.md#oauth)).

## The container image

```text
ghcr.io/albert-canfield/apitame:0.4      # the latest 0.4.x release (recommended)
ghcr.io/albert-canfield/apitame:0.4.0    # exactly this release
ghcr.io/albert-canfield/apitame:latest   # the latest release, whatever its version
```

Images are published for `linux/amd64` and `linux/arm64` by the release workflow, from the same commit as the npm package, starting with the first release after 0.3.0. Each one contains:

- Debian 13 (slim) and Node.js 22, without npm, npx, yarn or corepack;
- the `apitame` npm package, packed from that commit exactly as it is published, with its production dependencies. PostgreSQL, MySQL and SQLite work out of the box; the DuckDB driver and the OpenTelemetry packages are not included (how to add [DuckDB](#duckdb) and [OpenTelemetry](#opentelemetry));
- a user `apitame` (UID and GID 10001). The server never runs as root.

| Setting | Value |
| --- | --- |
| Entrypoint | `apitame` |
| Command | `serve --transport http --host 0.0.0.0 --port 8080` |
| Port | 8080 (`/mcp`, and `/health` for health checks) |
| Config | `APITAME_CONFIG=/config/apitame.config.yaml`, working directory `/config` |
| Writes | only the audit log, when `audit.file` points into `/audit` |
| Health check | `GET /health` every 30 seconds |

Every image comes with a build provenance attestation signed by GitHub Actions, an SBOM and a provenance record. Before anything is pushed, the release workflow runs the smoke test on the image and scans it for vulnerabilities, and stops on a critical one that has a fix. To check that an image was built by this repository's release workflow:

```bash
gh attestation verify oci://ghcr.io/albert-canfield/apitame:0.4 --repo albert-canfield/apitame
```

### Authentication is required

Inside a container apitame listens on all of the container's interfaces, so it always needs authentication: started without `APITAME_HTTP_TOKEN` and without `http.oauth`, it stops at once with `Refusing to listen on 0.0.0.0 without authentication`. That holds even when you publish the port on `127.0.0.1` only, and there is no setting to turn it off. Do not work around it with `--host 127.0.0.1`: nothing outside the container could connect, while the health check would still pass.

## Run it with Docker

```bash
cd my-api                                   # the folder with apitame.config.yaml
export APITAME_HTTP_TOKEN="$(openssl rand -hex 32)"

docker run -d --name apitame \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e APITAME_HTTP_TOKEN \
  --env-file .env \
  -v "$PWD:/config:ro" \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/albert-canfield/apitame:0.4
```

- `-v "$PWD:/config:ro"` mounts the folder read-only. Relative paths in the config (`spec: ./openapi.yaml`, `skills.dir: ./skills`) resolve from it, as they do outside a container.
- `--env-file .env` passes the API or database credentials the config names, such as `GITHUB_TOKEN` or `DATABASE_URL`. Docker takes each value literally, quotes included, so write `NAME=value` without quotes. apitame also reads a `.env` next to the config by itself, but the file must then be readable by UID 10001; passing it with `--env-file` avoids that.
- `-p 127.0.0.1:8080:8080` keeps the port on this machine. Put a reverse proxy with TLS in front before exposing it further (see below).

Check it, then connect a client:

```bash
curl http://127.0.0.1:8080/health           # {"ok":true}
docker logs apitame                          # serving ... at http://0.0.0.0:8080/mcp (bearer token required)
claude mcp add --transport http github http://127.0.0.1:8080/mcp --header "Authorization: Bearer $APITAME_HTTP_TOKEN"
```

`apitame doctor` runs in the image too. `--host 0.0.0.0` tells it where the server listens, so it also checks the HTTP setup:

```bash
docker run --rm -e APITAME_HTTP_TOKEN --env-file .env -v "$PWD:/config:ro" \
  ghcr.io/albert-canfield/apitame:0.4 doctor --host 0.0.0.0
```

### A read-only filesystem

apitame writes nothing at runtime except the audit log, when `audit.file` is set, so `--read-only` with a tmpfs on `/tmp` works. To keep the audit log, point it at `/audit` and mount a volume there; a new named volume takes the owner of `/audit` in the image, so UID 10001 can write to it:

```yaml
# apitame.config.yaml
audit:
  file: /audit/apitame-audit.jsonl
```

```bash
docker run ... -v apitame-audit:/audit ghcr.io/albert-canfield/apitame:0.4
```

For a SQLite file, mount it read-only with the config (apitame opens it read-only anyway; `doctor` reports `the database file is read-only for this user`). Kubernetes works the same way: `readOnlyRootFilesystem: true`, an `emptyDir` on `/tmp`, `runAsNonRoot: true` (the image user is numeric), and `httpGet` probes on `/health` port 8080.

### Secrets from a secret manager

The image has no `op`, `aws` or `gcloud`, so `${op://...}`, `${aws-sm://...}` and `${gcp-sm://...}` references ([configuration.md](configuration.md#secret-managers)) stop it at startup with `op was not found on PATH`. Two ways to use a secret manager with it:

- **Let the platform inject the value** (recommended), and reference it as an environment variable (`${STRIPE_API_KEY}`). The orchestrator reads the secret with its own identity and the container never holds secret manager credentials: ECS task definitions (`secrets` with `valueFrom` a Secrets Manager ARN), Kubernetes Secrets synced by the External Secrets Operator or the 1Password Kubernetes Operator, Cloud Run (`--set-secrets`), or `op run --env-file` around `docker compose up` on a single machine.
- **Build an image that adds the CLI.** Start `FROM ghcr.io/albert-canfield/apitame:0.4`, switch to `USER root` to install the CLI from its vendor's instructions, and end with `USER 10001`. Give the CLI an identity at run time, never in the image: a task, pod or instance role for `aws`, an attached service account for `gcloud`, `OP_SERVICE_ACCOUNT_TOKEN` for `op`. The image user's home is `/nonexistent`, and the CLIs keep configuration and caches there, so set `HOME` to a writable folder (with `--read-only`, `HOME=/tmp` and the tmpfs on `/tmp`), or `CLOUDSDK_CONFIG` for gcloud. Set these with `-e`, `--env-file` or the orchestrator, not in a `.env` next to the config: a CLI takes only credentials, a profile and a region from that file. If the CLI is not on `PATH`, set `APITAME_OP_CLI`, `APITAME_AWS_CLI` or `APITAME_GCLOUD_CLI` to its absolute path the same way.

Either way the value is redacted from logs and errors like any other secret, and `doctor --host 0.0.0.0` in the container says whether each reference reads.

### Logs

apitame logs to standard error, so `docker logs` and `docker compose logs` show them. Set `APITAME_LOG_LEVEL=debug` to see why a token was refused or which MCP protocol version each request uses. Secrets from the environment are redacted from logs. The audit log is a separate JSON Lines file (see [safety.md](safety.md#audit-log)), and tool calls can also go to an OpenTelemetry collector (see [OpenTelemetry](#opentelemetry)).

apitame stops cleanly on `SIGTERM`, so `docker stop` takes a moment, not the ten second timeout.

## Docker Compose behind Caddy

Caddy gets and renews a TLS certificate by itself, so it is the shortest way to put HTTPS in front of apitame. The folder layout:

```text
deploy/
  compose.yaml
  Caddyfile
  .env              # APITAME_HTTP_TOKEN and the API credentials; never committed
  apitame/          # apitame.config.yaml, the spec, skills/
```

`compose.yaml`:

```yaml
services:
  apitame:
    image: ghcr.io/albert-canfield/apitame:0.4
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    env_file: .env
    volumes:
      - ./apitame:/config:ro
      - audit:/audit
    # No ports: only Caddy reaches apitame, on the Compose network.

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ['80:80', '443:443', '443:443/udp']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      apitame:
        condition: service_healthy

volumes:
  audit:
  caddy-data:
  caddy-config:
```

`Caddyfile` (point the DNS name at the machine first, so Caddy can get the certificate):

```text
mcp.example.com {
	reverse_proxy apitame:8080
}
```

```bash
docker compose up -d
curl https://mcp.example.com/health          # {"ok":true}
```

Clients connect to `https://mcp.example.com/mcp`. Caddy passes streamed responses (server-sent events) through as they come and keeps long requests open, so nothing else needs configuring.

nginx works too. The parts that matter for MCP are HTTP/1.1, no buffering of streamed responses, and a read timeout longer than the longest stream:

```nginx
location / {
    proxy_pass http://apitame:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## OAuth behind the proxy

With `http.oauth`, every user signs in with your identity provider, and apitame checks their access tokens. Drop `APITAME_HTTP_TOKEN` from `.env` (apitame refuses to start with both) and configure:

```yaml
# apitame/apitame.config.yaml
http:
  oauth:
    issuer: https://login.example.com/realms/tools
    resource: https://mcp.example.com/mcp      # the public URL, through the proxy
    scopes: [mcp:tools]
```

`resource` must be exactly the URL clients connect to: `https`, the proxy's host name, and the path `/mcp`. It is what tokens must carry in `aud`, what the protected resource metadata names, and what MCP clients compare with the URL they were given. Do not use the container's address (`http://apitame:8080/mcp`) or a `localhost` URL there: clients never connect to those.

The proxy must pass two paths to apitame unchanged: `/mcp` and `/.well-known/oauth-protected-resource/mcp` (the document that tells clients where to sign in). Passing everything, as in the Caddyfile above, does both. If apitame lives under a prefix, say `https://example.com/tools/mcp`, set `resource` to that URL and have the proxy map `/tools/mcp` to `/mcp` and pass `/.well-known/oauth-protected-resource/tools/mcp` through as it is.

apitame must also reach the issuer over HTTPS from inside the container, to read its metadata and signing keys. If your identity provider uses a private certificate authority, mount its certificate and set `NODE_EXTRA_CA_CERTS` to its path.

If your identity provider issues opaque tokens, apitame asks its introspection endpoint about each one (see [clients.md](clients.md#opaque-tokens-token-introspection)). The client secret comes from the environment, so it goes in `.env` next to the other credentials, never in the config:

```yaml
http:
  oauth:
    issuer: https://login.example.com/realms/tools
    resource: https://mcp.example.com/mcp
    scopes: [mcp:tools]
    introspection:
      url: https://login.example.com/realms/tools/protocol/openid-connect/token/introspect
      clientId: apitame
      clientSecret: ${INTROSPECTION_CLIENT_SECRET}   # set in .env
```

The container must reach that endpoint too. Each new token costs one request to it, and active answers are cached for a minute by default, so a restart briefly sends more of them.

Then let `doctor` check the whole chain from inside the deployment:

```bash
docker compose exec apitame apitame doctor --host 0.0.0.0
```

```text
✔ HTTP auth       OAuth access tokens from https://login.example.com/realms/tools required on 0.0.0.0
✔ OAuth resource  https://mcp.example.com/mcp
✔ OAuth issuer    https://login.example.com/realms/tools/.well-known/openid-configuration names this issuer
✔ OAuth keys      2 signing keys at https://login.example.com/realms/tools/protocol/openid-connect/certs
✔ Public URL      https://mcp.example.com/mcp reaches apitame, and its metadata names this issuer
```

With `http.oauth.introspection`, `doctor` also asks the endpoint about a random token with the configured client, as `serve` does at startup, and fails if the credentials are rejected, the answer is not RFC 7662, or that token comes back active. Under `verify: introspection` it skips the signing keys, which apitame does not use then.

It warns, among other things, when the proxy does not pass the metadata path, when the issuer's metadata names a slightly different issuer (a trailing slash), when the metadata lacks what MCP clients need to sign users in, and when `resource` is not a public HTTPS URL. See [cli.md](cli.md#apitame-doctor) for every check.

## Host and Origin checks

apitame checks the `Host` and `Origin` headers only when it listens on loopback (`127.0.0.1`, the default outside a container), where they stop web pages from reaching it through DNS rebinding. Listening on `0.0.0.0`, as in a container, it does not check them: authentication protects it there, and a web page cannot attach the token or an access token to its requests. There is no setting for allowed hosts.

This matters when the proxy runs on the same machine and forwards to `127.0.0.1:3333` without a container:

- With `http.oauth`, the Host check also accepts the host name of `resource`, and the Origin check its origin, so the proxy can pass the original `Host` header.
- With `APITAME_HTTP_TOKEN`, only local names are accepted. nginx sends the upstream address as `Host` unless told otherwise (leave out `proxy_set_header Host $host`); in Caddy add `header_up Host {upstream_hostport}` inside `reverse_proxy`.

## Sessions and more than one replica

Run one replica: apitame is light, and it keeps some state in memory. Confirmation tokens, approval ids for clients on protocol 2026-07-28, rate limits and, with `--sessions`, the sessions of 2025-era clients all live in the process that created them. A restart forgets them: clients start a new session, and a pending approval has to be asked again.

If you run more than one replica, route each client to the same one, for example by client IP (`lb_policy ip_hash` in Caddy's `reverse_proxy`, `ip_hash` in an nginx `upstream`), and keep in mind that the rate limits in the config apply to each replica.

To give 2025-era clients approval prompts through elicitation, add `--sessions` to the command:

```yaml
services:
  apitame:
    command: [serve, --transport, http, --host, 0.0.0.0, --port, '8080', --sessions]
```

If you change the port, change the health check too (`healthcheck.test` in Compose), since it calls port 8080.

## Upgrading

Pin the minor version (`:0.4`), as `add-to` pins `apitame@0.3` for local clients: you get fixes without behavior changes you did not read about. Before moving to a new minor version, read the [changelog](../CHANGELOG.md), then:

```bash
docker compose pull && docker compose up -d
docker compose exec apitame apitame doctor --host 0.0.0.0
```

For full control, pin the exact version (`:0.4.0`) or the digest (`@sha256:...`). `latest` follows every release, minor versions included.

## DuckDB

The image leaves out the optional DuckDB driver, like the npm package: its native library would add about 90 MB to every image (22 MB to download), for a source that most HTTP deployments do not use. To serve a DuckDB file, build an image that adds the tested release of the driver:

```dockerfile
FROM node:22-trixie-slim AS duckdb
RUN npm install --global --ignore-scripts @duckdb/node-api@1.5.6-r.1

FROM ghcr.io/albert-canfield/apitame:0.4
COPY --from=duckdb /usr/local/lib/node_modules/@duckdb /usr/local/lib/node_modules/@duckdb
```

`doctor` then reports `DuckDB driver  @duckdb/node-api (DuckDB v1.5.6)`. Mount the DuckDB file read-only with the config.

## OpenTelemetry

apitame can send every tool call to your observability stack as an OpenTelemetry span, with metrics ([telemetry.md](telemetry.md)). The image leaves out the OpenTelemetry packages, like the npm package (they add about 29 MB). Build an image that adds the tested releases:

```dockerfile
FROM node:22-trixie-slim AS otel
WORKDIR /otel
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
      @opentelemetry/api@1.9.1 @opentelemetry/sdk-trace@2.12.0 @opentelemetry/sdk-metrics@2.12.0 \
      @opentelemetry/resources@2.12.0 @opentelemetry/exporter-trace-otlp-proto@0.223.0 \
      @opentelemetry/exporter-metrics-otlp-proto@0.223.0 \
 && rm node_modules/.package-lock.json

FROM ghcr.io/albert-canfield/apitame:0.4
COPY --from=otel /otel/node_modules /usr/local/lib/node_modules
```

The packages land next to apitame in the global `node_modules`, where it finds them. Then point it at your collector:

```yaml
services:
  apitame:
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_RESOURCE_ATTRIBUTES: deployment.environment.name=prod
```

`docker compose exec apitame apitame doctor` reports `Telemetry  traces to http://otel-collector:4318/v1/traces, metrics to ...; packages load`. With the endpoint set and the packages missing, the server starts anyway and logs a warning with the packages to add. Keep a vendor API key for `OTEL_EXPORTER_OTLP_HEADERS` in an environment file or a secret, like the other credentials; apitame redacts it from its logs.

## Build the image yourself

From a checkout:

```bash
docker build -t apitame:local .
IMAGE=apitame:local scripts/docker-smoke.sh
```

The build packs the npm package from the checkout (`npm pack`, as the release does), installs it with its production dependencies on a clean Node.js image, and copies the result onto Debian without npm. `scripts/docker-smoke.sh` checks that the image refuses to start without authentication, then runs it read-only as UID 10001 and calls `/health` and MCP over HTTP. CI runs it on every pull request.
