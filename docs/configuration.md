# Configuration reference

apitame reads `apitame.config.yaml` from the current folder (or `--config <path>`, or the `APITAME_CONFIG` environment variable). `init` writes a commented version you can edit. Relative paths in the file resolve from the folder that holds it, and a `.env` file in that folder is loaded at startup without overriding variables that are already set.

Values may reference environment variables as `${NAME}` or `${NAME:-default}`. Secret fields must use a reference, and a literal secret is a validation error: so is a default in a secret field (`${TOKEN:-hunter2}` is still a secret written in the config), and text next to references that all have an empty default (`hunter2${UNSET:-}`). Text around a real reference (`SSWS ${OKTA_TOKEN}`) is fine, and `${NAME:-}` alone stands for an empty value.

Unknown keys at the top level and under `http` and `writes` (including inside each argument rule) are an error that names the key, so a typo (`scope:` for `scopes:`, `rule:` for `rules:`) or a block at the wrong level cannot silently turn a setting off.

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

### DuckDB

```yaml
source:
  type: duckdb
  path: ./data.duckdb      # relative to the config file, opened read-only
```

DuckDB needs the optional `@duckdb/node-api` package next to apitame (`npx -p apitame -p @duckdb/node-api@1.5.6-r.1 apitame <command>`, see [sql.md](sql.md#duckdb)). Named queries on a DuckDB source must be reads: `write: true` is a validation error.

DuckDB runs in a separate process, and each call opens the file with these limits (`init` writes them with the defaults):

```yaml
sql:
  duckdb:
    memoryLimit: 1GB   # DuckDB memory_limit, for example 512MB or 2GB; queries never spill to disk
    threads: 2         # DuckDB threads, 1 to 64
```

`sql.duckdb` is a validation error for other sources.

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
| `perCaller.maxCallsPerMinute` | 0 | all | Tool calls per minute for each OAuth user (client and subject), on top of the server-wide limits. `0` means no per-user limit. Only applies over HTTP with `http.oauth`. |
| `perCaller.maxWritesPerMinute` | 0 | all | Writes per minute for each OAuth user. `0` means no per-user limit. |

Per-user limits are off by default because good numbers depend on the team and on the server-wide budget. A starting point for a shared server: give each user a fifth to a quarter of the server-wide limits, so that one looping agent leaves room for everyone else:

```yaml
limits:
  maxCallsPerMinute: 300     # the whole team
  maxWritesPerMinute: 40
  perCaller:
    maxCallsPerMinute: 60    # one user: enough for an agent at work, too little for a loop to starve the others
    maxWritesPerMinute: 10
```

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
  rules: {}          # limits on the arguments of allowed writes, see below
```

Destructive operations always need confirmation; there is no setting to turn that off.

### `writes.rules`

Argument rules limit how an allowed write may be called. A call that breaks one is refused before anything is previewed, confirmed or sent. Rules only ever refuse calls; whether an operation can run at all is still up to `mode` and `writes.allow`. See [safety.md](safety.md#argument-rules) for how they are enforced.

```yaml
writes:
  allow: [createRefund, issues/update, archive_order]
  rules:
    createRefund:                                  # an exact operation id
      body.amount: { min: 1, max: 5000 }           # a refund without an amount is refused too
      body.currency: { in: [usd, eur] }
      body.metadata.reason: { maxLength: 200 }
    issues/update:
      owner: { in: [acme] }
      repo: { pattern: '^(web|api)$' }
      body.state: { optional: true, in: [open, closed] }           # an update may leave it out
      body.labels[]: { optional: true, notIn: [security, legal] }  # every item of the list
      body.assignees: { optional: true, maxLength: 3 }             # at most 3 items
      body.locked: { forbidden: true }
    archive_order:                                 # a named SQL write query
      id: { min: 1 }
```

**Keys** are exact operation ids (or named query names), never patterns, so a rule cannot miss an operation by accident.

**Paths** name a tool argument, the way the agent passes it:

- A parameter by name: `owner`, `amount`. The request body is `body`. For named queries, the parameter names. Rule paths always use the API's own parameter names, even where a single-operation tool exposes them as `api_dryRun` or `api_confirm`.
- Nested fields with dots: `body.state`, `body.metadata.reason`.
- `[]` after a name for every item of a list: `body.labels[]` (each label), `body.items[].price` (the price of each item), `matrix[][]` for a list of lists. Indexes such as `items[0]` and `*` are not accepted.

**Operators.** A rule needs at least one. The first eight check a value, and a call that leaves that value out is refused unless the rule also says `optional: true` (see [Missing values](#missing-values)).

| Operator | Value | The argument must |
| --- | --- | --- |
| `in` | list of values | be one of them. |
| `notIn` | list of values | not be any of them, and not be `null`. Text is compared ignoring case and surrounding spaces, and anything that reads as a number by its value, so `"Security "` and `"042"` match `security` and `42`. |
| `equals` | a value | be exactly this value. |
| `pattern` | text, up to 200 characters | match as a whole, as if the pattern were wrapped in `^(?:...)$`. Numbers are checked in their usual text form. |
| `min`, `max` | numbers | be a number from `min` to `max`, both included. Text that is plainly a number (`"12.50"`) is compared as one; any other value is refused. |
| `minLength`, `maxLength` | whole numbers | have that many characters (text, counted as characters, not bytes) or items (lists). |
| `required` | `true` | be present and not `null`. Value operators need the value anyway, so next to them it only changes the wording of the refusal. |
| `forbidden` | `true` | be left out. `null` counts as set. It cannot be combined with other operators. |
| `optional` | `true` | Not a check: lets the value be left out. The value operators next to it then apply only when it is there. It needs at least one value operator and cannot be combined with `required` or `forbidden`. |

Values in `in`, `notIn` and `equals` are text, numbers, `true`, `false` or `null`. `in` and `equals` also accept a number or boolean sent in its usual text form (`"42"` for 42, `"true"` for true), since many APIs take both, but nothing looser: `"42.0"` is not 42. A list or object is never equal to a listed value, and `notIn` refuses it.

#### Missing values

A value operator refuses a call that leaves its value out: `body.amount: { max: 5000 }` refuses a refund without an amount, because for a write, a missing value often means "everything" or "the default", which the rule never sees. The refusal says `is missing; the rule requires it, mark it optional: true if leaving it out is safe`.

When leaving the value out is safe, for example `body.state` in an update that may change only the title, add `optional: true`: the other operators then check the value only when it is there. Below a missing object, everything counts as missing. For a path through a list, a missing list counts as missing (refused unless `optional`), an item without the field counts as missing too, and an empty list passes, since it has no item to break the rule.

`null` is a value, not a missing one: it fails `in`, `equals`, `pattern`, `min`, `max`, `minLength`, `maxLength` and `notIn` unless `in` or `equals` lists it, with or without `optional`. For `required` it counts as missing, and for `forbidden` as set.

**Shapes.** A value that does not fit the path is refused, not skipped: with `body.items[].price`, an `items` that is not a list is refused, and so is an item that is not an object.

**Patterns** use a safe subset of regular expressions: literals, `.`, classes such as `[a-z0-9_]` and `[^,]`, `\d \w \s \D \W \S`, `\n \r \t \xHH \uXXXX`, escaped punctuation (`\.`, `\$`), groups `( )` and `(?: )`, alternation `|`, `* + ?`, `{n}`, `{n,}`, `{n,m}` and `^` and `$`. Backreferences, lookahead and lookbehind, named groups, flags and `\b` are refused with a message. apitame runs patterns on its own matcher, which takes time linear in the length of the value, so no pattern can be made to hang the server ([why](safety.md#argument-rules)). There is no case-insensitive flag: write `[Aa]` or list the values with `in`.

**Checks.** Rules are validated when the config loads: unknown operators (`maximum` for `max`), values of the wrong type (`max: "5000"`), `min` above `max`, unsupported patterns and invalid paths are errors. Rules for operations or named queries that do not exist, for arguments or fields the schema does not have, for reads (which are never checked), on DuckDB sources (which cannot write) and operators that can never match the field's type are warnings in `serve`, `inspect` and `doctor`. `inspect` lists every rule.

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
      write: false                         # true for INSERT, UPDATE, DELETE (not on DuckDB)
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
    # verify: auto                  # jwt, introspection or auto (see below)
    # introspection:                # for opaque tokens (RFC 7662)
    #   url: https://login.example.com/realms/tools/protocol/openid-connect/token/introspect
    #   clientId: apitame
    #   clientSecret: ${INTROSPECTION_CLIENT_SECRET}
    permissions:
      default: { mode: read-only, tools: [issues, search_operations] }   # every OAuth caller
      byScope:
        mcp:write: { tools: [issues], writes: [createIssue, updateIssue] }
      byClient:
        release-bot: { tools: [issues], writes: [closeIssue] }
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
| `oauth.verify` | `jwt`, `introspection` or `auto` | see description | How tokens are checked. `jwt`: JWTs locally against the keys, other tokens refused. `introspection`: every token by asking the authorization server. `auto`: JWTs locally, every other token by introspection. Default: `introspection` when `introspection` is set, `jwt` otherwise. |
| `oauth.introspection.url` | URL | required | The authorization server's token introspection endpoint (RFC 7662). Must be the final URL, without credentials in it. Written as is: `${VAR}` is refused, since it would not be read. |
| `oauth.introspection.clientId` | string | required | apitame's client id at the authorization server. May use `${VAR}`. |
| `oauth.introspection.clientSecret` | `${VAR}` | required | That client's secret. Environment variable references only: no default and no text around them. Registered with the redactor. |
| `oauth.introspection.clientAuthMethod` | `client_secret_basic` or `client_secret_post` | `client_secret_basic` | How the client credentials are sent: HTTP Basic, or in the form body. |
| `oauth.introspection.cacheSeconds` | 0 to 300 | `60` | How long an active answer is reused, never past the token's expiry; after that the token is introspected again. A revoked token is refused within this time. `0` asks on every request. Refusals are never cached. |
| `oauth.introspection.maxCallsPerMinute` | 1 to 100000 | `600` | Most introspections of new tokens in any minute; past it, new tokens are refused with a 500 until the minute passes. Tokens seen active before are checked again (once their cached answer is stale) within a second budget of the same size, which made-up tokens cannot use, so signed-in users keep working through a flood of them. Each active user costs about one re-check every `cacheSeconds`. |
| `oauth.permissions.default` | entry | read-only | What every OAuth caller gets. Unset: read-only access with every tool. Entries can only add to it. |
| `oauth.permissions.byScope` | map | `{}` | What callers whose token carries the scope (the key) get on top of `default`. |
| `oauth.permissions.byClient` | map | `{}` | What callers whose token was issued to the client (the key; `client_id`, `azp`, `cid` or `appid`) get on top of `default`. |

URLs must use `https`, except on loopback hosts (`localhost`, `127.0.0.1`, `[::1]`) for local testing. Metadata, keys and introspection answers are fetched without following redirects, so `issuer`, `jwksUri` and `introspection.url` must be final URLs. Settings that cannot work together are errors: `verify: introspection` or `auto` without `introspection`, `verify: jwt` with `introspection` (it would never be used), and `jwksUri` or `requireAccessTokenType` when every token is introspected (they only apply to JWTs checked locally). `http.oauth` cannot be combined with `APITAME_HTTP_TOKEN`, and changes to it need a restart, except `permissions`, which apply on a `--watch` reload. While apitame checks OAuth tokens, a reload that removes or changes the rest of `http.oauth` is refused and the previous config keeps being served. See [clients.md](clients.md#oauth) for the full picture.

### `http.oauth.permissions`

Every OAuth caller gets `default`, and each entry that matches its token's scopes or client adds to it. An entry can set:

| Field | Type | Description |
| --- | --- | --- |
| `mode` | `read-only` or `read-write` | `read-only`: the entry grants no writes. `read-write` never makes a read-only server writable. |
| `writes` | list | Writes the entry grants (operation ids or named queries, `*` wildcards). Unset: every write in `writes.allow`. Cannot be combined with `mode: read-only`. |
| `tools` | list | Tools the entry shows (`*` wildcards). Unset: every tool. |

A tool is shown when one of the caller's entries shows it. A write runs only when one single entry grants it in `writes` and reaches it through one of its own `tools`, and the server config (`mode`, `writes.allow`) allows it too. The operations of a group a caller does not see are out of reach of `call_operation` and `search_operations` as well. Since entries only add, `default` must be the least any caller should get.

Names that match no tool or operation, write patterns that grant nothing and entries that add nothing to `default` are warnings in `serve`, `doctor` and `inspect`. Mistakes in the shape (a wrong type, `mode: read-only` with `writes`, a scope directly under `permissions`) are errors. Permissions only apply over HTTP with `http.oauth`; over stdio and other transports the server config applies. See [safety.md](safety.md#per-user-permissions) for the rules.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `APITAME_CONFIG` | `serve`, `inspect`, `test`, `add-to` | Config path when `--config` is not given. |
| `APITAME_LOG_LEVEL` | `serve` | `debug`, `info` (default), `warn`, `error` or `silent`. Logs go to stderr. |
| `APITAME_HTTP_TOKEN` | `serve --transport http` | Static bearer token, required when listening beyond loopback unless `http.oauth` is set. Cannot be combined with `http.oauth`. |
| `APITAME_DEBUG` | all | Print stack traces for errors. |
| `NO_COLOR` | all | Disable colors. |
