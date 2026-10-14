# Configuration reference

apitame reads `apitame.config.yaml` from the current folder (or `--config <path>`, or the `APITAME_CONFIG` environment variable). `init` writes a commented version you can edit. Relative paths in the file resolve from the folder that holds it, and a `.env` file in that folder is loaded at startup without overriding variables that are already set.

Values may reference environment variables as `${NAME}` or `${NAME:-default}`. Secret fields must use a reference; a literal secret is a validation error.

Unknown keys at the top level and under `http` are an error that names the key, so a typo (`scope:` for `scopes:`) or a block at the wrong level cannot silently turn a setting off.

## Top level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config format version. |
| `name` | string | required | Server name: lowercase letters, digits and dashes, up to 64 characters. Used in client configs and skill names. |
| `description` | string | `""` | Shown in generated skills. |
| `source` | object | required | Where tools come from. See below. |
| `mode` | `read-only` \| `read-write` | `read-only` | In read-only mode every write is blocked, whatever the allowlist says. |
| `auth` | object | `{type: none}` | Credentials for OpenAPI sources. |
| `limits` | object | see below | Tool budget, timeouts and size caps. |
| `tools` | list | `[]` | Tool groups (OpenAPI only). |
| `longTail` | object | `{enabled: true}` | Adds `search_operations` and `call_operation` (OpenAPI only). |
| `writes` | object | see below | Allowlist and confirmation rules. |
| `confirmation` | object | see below | How destructive calls are approved. |
| `audit` | object | `{include: writes}` | Optional JSON Lines audit file. |
| `sql` | object | see below | Named queries and table filters (SQL only). |
| `skills` | object | `{dir: ./skills}` | Where generated skills live. |
| `http` | object | `{}` | Settings for `serve --transport http`: OAuth access tokens. |

## `source`

### OpenAPI

```yaml
source:
  type: openapi
  spec: ./openapi.yaml               # file path (relative to the config) or http(s) URL
  baseUrl: https://api.example.com   # optional, overrides servers[0]
  headers:                           # optional static headers, values may use ${VAR}
    X-Tenant: ${TENANT_ID}
```

Values from `${VAR}` in `baseUrl` and `headers` are treated as secrets and hidden from all output, so a token in the base URL (`https://api.telegram.org/bot${BOT_TOKEN}`) is safe. Static header values are always hidden in previews.

### PostgreSQL

```yaml
source:
  type: postgres
  url: ${DATABASE_URL}     # default
  schemas: [public]        # default
```

### MySQL and MariaDB

```yaml
source:
  type: mysql
  url: ${DATABASE_URL}     # mysql://user:password@host:3306/db (mariadb:// also accepted by init)
```

### SQLite

```yaml
source:
  type: sqlite
  path: ./shop.db          # relative to the config file
```

## `auth`

Only used by OpenAPI sources.

```yaml
auth: { type: none }

auth: { type: bearer, token: ${API_TOKEN} }

auth: { type: apiKey, in: header, name: X-API-Key, value: ${API_KEY} }   # in: header | query | cookie

auth: { type: basic, username: ${API_USER}, password: ${API_PASSWORD} }

auth:
  type: oauth2                        # client credentials flow
  tokenUrl: https://auth.example.com/oauth/token
  clientId: ${CLIENT_ID}
  clientSecret: ${CLIENT_SECRET}
  scopes: [read:invoices]
  audience: https://api.example.com   # optional
  clientAuthMethod: client_secret_basic   # or client_secret_post
```

## `limits`

| Field | Default | Applies to | Description |
| --- | --- | --- | --- |
| `maxTools` | 12 | OpenAPI | Tool budget used by `init`, including the two long-tail tools. |
| `maxOperationsPerTool` | 15 | OpenAPI | Operations per tool used by `init`. |
| `timeoutMs` | 15000 | all | Request or query timeout, 100 to 600000. |
| `maxResponseBytes` | 50000 | all | Size cap for what goes back to the agent. JSON is trimmed to fit. |
| `rowLimit` | 200 | SQL | Maximum rows per query result. |
| `maxUploadBytes` | 10000000 | OpenAPI | Total size of file content in one call (multipart and binary bodies). |
| `maxCallsPerMinute` | 120 | all | Tool calls per minute across all tools. `0` means unlimited. |
| `maxWritesPerMinute` | 20 | all | Writes per minute, counted just before they are sent. `0` means unlimited. |
| `perTool` | `{}` | all | Calls per minute for individual tools, for example `{ search: 10, call_operation: 30 }`, on top of the server-wide limits. |

## `tools`

OpenAPI only. Each entry becomes one MCP tool.

```yaml
tools:
  - name: issues                       # lowercase letters, digits and underscores, max 48
    description: Issues, comments and labels
    operations:                        # operation ids from the spec
      - issues/list-for-repo
      - issues/get
      - issues/create
```

- A tool with one operation takes that operation's parameters directly; a tool with several takes `{operation, params}`.
- Operations that the current mode blocks are left out of the tool. A tool whose operations are all blocked is not listed.
- Unknown operation ids are reported as warnings by `serve` and `inspect` and ignored.
- An operation may appear in more than one tool.

## `longTail`

```yaml
longTail:
  enabled: true
```

When enabled, `search_operations` and `call_operation` are added. `call_operation` can reach every available operation, including ones not listed in `tools`. Set it to `false` for a strictly curated surface.

## `writes`

```yaml
writes:
  allow: []          # ids (operations or named queries) allowed to write in read-write mode; "*" wildcards
  confirm: []        # writes that need confirmation even if they are not destructive
  treatAsRead: []    # OpenAPI: non-GET operations that only read (POST /search), * allowed
  destructive: []    # writes to treat as destructive, * allowed
```

Destructive operations always need confirmation; there is no setting to turn that off.

## `confirmation`

```yaml
confirmation:
  method: auto       # auto | elicitation | token
  ttlSeconds: 300    # lifetime of confirmation tokens and approval ids, 10 to 3600
```

- `auto`: ask the human through MCP elicitation when the client supports it (in the middle of the call for 2025-era clients, in two rounds for clients on protocol 2026-07-28, see [safety.md](safety.md#protocol-eras)), otherwise return a one-time token.
- `elicitation`: refuse destructive calls when the client cannot elicit.
- `token`: always use tokens.

## `audit`

```yaml
audit:
  file: ./apitame-audit.jsonl   # relative to the config file; no file when unset
  include: writes               # writes (default) or all
```

See [safety.md](safety.md#audit-log) for the format.

## `sql`

```yaml
sql:
  queries:
    - name: orders_for_customer            # tool name
      description: Recent orders of one customer
      sql: SELECT id, total FROM orders WHERE customer_id = :customer_id ORDER BY id DESC LIMIT 20
      params:
        customer_id: { type: integer, description: Customer id, required: true }
      write: false                         # true for INSERT, UPDATE, DELETE
  tables:
    allow: []                              # if non-empty, only these tables
    deny: []                               # never these tables
```

See [sql.md](sql.md#named-queries) for the rules.

## `skills`

```yaml
skills:
  dir: ./skills
```

`init` writes skills here, `serve` serves them over MCP, and `add-to --write` copies them into the client's skills folder.

## `http`

Settings for `serve --transport http`. Without them, the HTTP transport needs no authentication on loopback and `APITAME_HTTP_TOKEN` anywhere else.

```yaml
http:
  oauth:
    issuer: https://login.example.com/realms/tools
    resource: https://mcp.example.com/mcp
    scopes: [mcp:tools]
    requireAccessTokenType: true
    # clients: [mcp-desktop, mcp-web]
    # jwksUri: https://login.example.com/realms/tools/protocol/openid-connect/certs
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `oauth.issuer` | URL | required | The authorization server, exactly as it appears in the tokens' `iss` claim (mind a trailing slash). Its metadata must name the same issuer. |
| `oauth.resource` | URL | required | The public URL of this MCP endpoint, as clients connect to it. Advertised in the protected resource metadata, and accepted in `aud`. |
| `oauth.scopes` | list | `[]` | Scopes every token must carry. A token without one gets 403 `insufficient_scope`. Also advertised as `scopes_supported`. Leaving it empty logs a warning. |
| `oauth.audiences` | list | `[]` | Other accepted `aud` values, for authorization servers that do not put the resource URL there (for example an Entra ID Application ID URI). Such audiences are often shared by other apps, so `scopes` or `clients` must be set too. |
| `oauth.clients` | list | `[]` | When set, only tokens issued to these clients are accepted (the `client_id`, `azp`, `cid` or `appid` claim). |
| `oauth.requireAccessTokenType` | boolean | `false` | Accept only tokens whose header says `typ: at+jwt` (RFC 9068). Turn it on when your authorization server sets it. ID and refresh tokens are refused either way. |
| `oauth.jwksUri` | URL | discovered | Where the signing keys are, when the issuer publishes no RFC 8414 or OpenID Connect metadata. |

URLs must use `https`, except on loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) for local testing. Metadata and keys are fetched without following redirects, so `issuer` and `jwksUri` must be final URLs. `http.oauth` cannot be combined with `APITAME_HTTP_TOKEN`, and changes to it need a restart, even with `--watch`. See [clients.md](clients.md#oauth) for the full picture.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `APITAME_CONFIG` | `serve`, `inspect`, `test`, `add-to` | Config path when `--config` is not given. |
| `APITAME_LOG_LEVEL` | `serve` | `debug`, `info` (default), `warn`, `error` or `silent`. Logs go to stderr. |
| `APITAME_HTTP_TOKEN` | `serve --transport http` | Static bearer token, required when listening beyond loopback unless `http.oauth` is set. Cannot be combined with `http.oauth`. |
| `APITAME_DEBUG` | all | Print stack traces for errors. |
| `NO_COLOR` | all | Disable colors. |
