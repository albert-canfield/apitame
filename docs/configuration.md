# Configuration reference

apitame reads `apitame.config.yaml` from the current folder (or `--config <path>`, or the `APITAME_CONFIG` environment variable). `init` writes a commented version you can edit. Relative paths in the file resolve from the folder that holds it, and a `.env` file in that folder is loaded at startup without overriding variables that are already set.

Values may reference environment variables as `${NAME}` or `${NAME:-default}`. Secret fields must use a reference; a literal secret is a validation error.

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
| `sql` | object | see below | Named queries and table filters (SQL only). |
| `skills` | object | `{dir: ./skills}` | Where generated skills live. |

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

### PostgreSQL

```yaml
source:
  type: postgres
  url: ${DATABASE_URL}     # default
  schemas: [public]        # default
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
  treatAsRead: []    # OpenAPI: non-GET operations that only read (POST /search)
  destructive: []    # writes to treat as destructive
```

Destructive operations always need confirmation; there is no setting to turn that off.

## `confirmation`

```yaml
confirmation:
  method: auto       # auto | elicitation | token
  ttlSeconds: 300    # confirmation token lifetime, 10 to 3600
```

- `auto`: ask the human through MCP elicitation when the client supports it, otherwise return a one-time token.
- `elicitation`: refuse destructive calls when the client cannot elicit.
- `token`: always use tokens.

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

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `APITAME_CONFIG` | `serve`, `inspect`, `test`, `add-to` | Config path when `--config` is not given. |
| `APITAME_LOG_LEVEL` | `serve` | `debug`, `info` (default), `warn`, `error` or `silent`. Logs go to stderr. |
| `APITAME_HTTP_TOKEN` | `serve --transport http` | Required bearer token when listening beyond loopback. |
| `APITAME_DEBUG` | all | Print stack traces for errors. |
| `NO_COLOR` | all | Disable colors. |
