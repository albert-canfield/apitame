# CLI reference

```text
apitame <command> [options]
```

Every command except `init` reads `apitame.config.yaml` from the current folder. Use `-c, --config <path>` or `APITAME_CONFIG` to point elsewhere. Errors print one line; set `APITAME_DEBUG=1` for a stack trace. Exit code 1 means failure.

## `apitame init [source]`

Introspects a source and writes `apitame.config.yaml`, `skills/` and, when needed, `.env.example` (and `.env` for a PostgreSQL or MySQL URL given on the command line).

```bash
apitame init ./openapi.yaml
apitame init https://api.example.com/openapi.json
apitame init https://api.example.com                # finds the spec
apitame init postgres://user:pass@host:5432/db
apitame init mysql://user:pass@host:3306/db
apitame init '$DATABASE_URL'                        # or env:DATABASE_URL
apitame init ./shop.db
apitame init ./data.duckdb                          # or duckdb:./data.duckdb (needs the DuckDB driver, below)
apitame init --skills-only                          # regenerate skills from the existing config
```

DuckDB's driver (`@duckdb/node-api`) is not installed with apitame. Run any command with it through npx, `npx -p apitame -p @duckdb/node-api@1.5.6-r.1 apitame init ./data.duckdb` (the tested release), or install both packages; without it the command stops with that hint and writes nothing. See [DuckDB](sql.md#duckdb).

| Option | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `.` | Folder to write into. |
| `-n, --name <name>` | from the spec title or database name | Server name. |
| `--base-url <url>` | | API base URL, overrides the servers in the spec. |
| `--max-tools <n>` | `12` | Tool budget, including `search_operations` and `call_operation`. |
| `--env-var <name>` | `DATABASE_URL` | Variable that holds the database URL. |
| `--schema <names...>` | `public` | PostgreSQL schemas to expose. |
| `-f, --force` | | Overwrite an existing config. |
| `--skills-only` | | Regenerate skills from the existing config (for example after switching to read-write). For a database, secret manager references in the connection URL are read; for an OpenAPI source no secret manager is asked. |
| `-c, --config <path>` | | Config to use with `--skills-only`. |

## `apitame serve`

Runs the MCP server.

```bash
apitame serve                                  # stdio, for clients that launch the server
apitame serve --transport http --port 3333     # streamable HTTP on http://127.0.0.1:3333/mcp
apitame serve --transport http --sessions      # sessions for 2025-era clients, so they can elicit
APITAME_HTTP_TOKEN=... apitame serve --transport http --host 0.0.0.0
```

| Option | Default | Description |
| --- | --- | --- |
| `-c, --config <path>` | `apitame.config.yaml` | Config file. |
| `-t, --transport <stdio\|http>` | `stdio` | Transport. |
| `-p, --port <port>` | `3333` | HTTP port. |
| `--host <host>` | `127.0.0.1` | HTTP host. Anything other than loopback needs `APITAME_HTTP_TOKEN` or `http.oauth` in the config (OAuth access tokens, see [clients.md](clients.md#oauth)). |
| `--sessions` | | HTTP only. Keep one MCP session per 2025-era client (`Mcp-Session-Id`), so destructive operations can be confirmed by the human through elicitation. Without it the HTTP transport is stateless and those clients use the token flow. Clients on protocol 2026-07-28 are asked through elicitation either way, without a session. With it, requests without a session id may carry at most 1 MB. |
| `-w, --watch` | | Reload when `apitame.config.yaml`, a local spec, the skills folder or `.env` change, and notify clients that the tool list changed (2026-07-28 clients on their `subscriptions/listen` stream). |
| `--log-level <level>` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr. `debug` also logs the protocol era of each stdio connection and HTTP request. |

Both MCP protocol eras are served on stdio and HTTP: 2025-era clients (which start with `initialize`) and clients on protocol 2026-07-28. The server exposes `tools/list` and `tools/call`. When the config has skills, it also declares the MCP Skills extension (`io.modelcontextprotocol/skills`) and answers `skills/list`, `skills/get`, `resources/list` and `resources/read` for `skill://` URIs. The HTTP server also answers `GET /health` with `{"ok":true}`, without authentication and without any detail about the server, for container health checks and load balancers (on loopback it checks the `Host` header, as for `/mcp`). With `http.oauth` it serves its protected resource metadata at `/.well-known/oauth-protected-resource`. To run it in a container or behind a reverse proxy, see [deploy.md](deploy.md).

Missing credentials do not stop the server: it starts, logs a warning, and tool calls explain which variable is missing. Secret manager references (`${op://...}`, `${aws-sm://...}`, `${gcp-sm://...}`) are different: they are read at startup, and one that cannot be read stops the server with a message that names the field and the reference ([configuration.md](configuration.md#secret-managers)).

With `--watch`, editing the config takes effect without restarting the client: allow a write, save, and the new tool appears (clients that support `notifications/tools/list_changed`, such as Claude Code, refresh their tool list). A config that does not validate is reported in the log and the previous one keeps serving. Changed `.env` values are picked up too.

## `apitame inspect`

Shows what an agent will see.

```text
$ apitame inspect
github  openapi · read-only · ./openapi.yaml

TOOL               OPS  ACCESS  TOKENS
repos               11  read       566
issues               4  read       323
...
8 tools, ~2,218 tokens (includes 158 for server instructions; estimate)
  one tool per endpoint (38 tools): ~5,522 tokens, apitame saves 60%
  search + call only: ~249 tokens (smallest, but every task needs extra round trips)

! 13 operations blocked by read-only mode: repos/update, repos/delete, ...
✔ Skills: github-api
```

With [argument rules](configuration.md#writesrules), it lists them too, and warns about rules that cannot apply:

```text
✔ Argument rules for 2 writes, checked before anything is sent or anyone is asked:
  OPERATION   ARGUMENT       RULE
  addPet      body.status    if set, one of "available", "pending"
  placeOrder  body.quantity  required, between 1 and 5
! writes.rules.getPetById: "getPetById" is a read operation; rules only apply to writes, so these are ignored.
```

| Option | Description |
| --- | --- |
| `--json` | Machine-readable output: tools with tokens, totals, blocked operations, argument rules per operation, skills and warnings. |
| `--verbose` | List the operations inside each tool. |
| `--max-tokens <n>` | Exit with code 1 when the tool list costs more than `n` tokens. Use it in CI to stop the tool list from growing unnoticed. |

Token counts are estimates. They are calibrated against a common BPE tokenizer and land slightly above it, because tokenizers differ between models.

`inspect` sends nothing, so it never asks a secret manager: references (`${op://...}` and the like) read as a placeholder.

## `apitame diff <old-spec> [new-spec]`

Shows what a new version of the OpenAPI spec changes for the agent, under your current config, before the agent sees it. It only reads the two specs: it never calls the API and needs no credentials.

New in apitame 0.4.

```bash
apitame diff ./openapi.old.yaml ./openapi.yaml        # two files
apitame diff ./openapi.reviewed.json                  # against the spec the config points to (file or URL)
apitame diff ./v1.json https://api.example.com/v2/openapi.json
apitame diff ./openapi.old.yaml --fail-on             # exit 1 when a new write would be allowed (CI)
apitame diff ./openapi.old.yaml --json
```

Both versions are built with the same `apitame.config.yaml`, exactly as `serve` and `inspect` would build them, and compared. Without `new-spec`, the old spec is compared with the one in `source.spec`, its current file or URL. Specs are files or spec URLs (not API base URLs), and Swagger 2.0 is converted as in `init`. Relative paths on the command line are relative to the current folder.

The config below allows every `create*` write, asks before `createRefund` and limits its amount. In the new spec, `createRefund` is renamed to `createOrderRefund`, a bulk refund endpoint appears, and a GET turns into a POST:

```yaml
mode: read-write
tools:
  - name: orders
    operations: [listOrders, getOrder, listOrderNotes, createOrder, cancelOrder, createRefund]
  - name: reports
    operations: [exportReport]
writes:
  allow: ['create*', cancelOrder]
  confirm: [createRefund]
  rules:
    createRefund:
      amount: { max: 5000 }
    createOrder:
      body.quantity: { max: 10 }
```

```text
$ apitame diff shop-v1.yaml shop-v2.yaml --fail-on new-writes,access-changes
shop  read-write · shop-v1.yaml -> shop-v2.yaml
Operations: 7 -> 8 (2 added, 1 removed, 2 renamed)

Added (2)
  OPERATION         ACCESS       ENDPOINT            AGENT
  createBulkRefund  destructive  POST /refunds/bulk  call_operation (asks for approval)
  listInvoices      read         GET /invoices       call_operation

Removed (1)
  OPERATION       ACCESS  ENDPOINT                     WAS IN
  listOrderNotes  read    GET /orders/{orderId}/notes  orders

Renamed (2)
  BEFORE        AFTER              ENDPOINT                                     AGENT
  createRefund  createOrderRefund  POST /orders/{id}/refunds                    call_operation
  exportReport  exportReport       GET /reports/export -> POST /reports/export  blocked: not in writes.allow

! Access level changes (1)
  OPERATION     ENDPOINT              ACCESS         AGENT
  exportReport  POST /reports/export  read -> write  reports -> blocked: not in writes.allow

! New writes that the config allows without naming them (2)
  OPERATION          ACCESS       ALLOWED BY            AGENT                               WHY
  createOrderRefund  write        writes.allow create*  call_operation                      renamed from createRefund
  createBulkRefund   destructive  writes.allow create*  call_operation (asks for approval)  added

! Config references that match no operation now (4)
  WHERE           REFERENCE       MATCHED BEFORE  NOW
  writes.confirm  createRefund    createRefund    renamed to createOrderRefund
  writes.rules    createRefund    createRefund    renamed to createOrderRefund
  tools.orders    listOrderNotes  listOrderNotes  removed
  tools.orders    createRefund    createRefund    renamed to createOrderRefund

! Argument changes on allowed writes (1)
  createOrder (POST /orders, orders)
    added: body.items, body.currency (required)
    removed: body.quantity
    ! writes.rules.createOrder.body.quantity: there is no field "quantity" in body

! Base URL: https://api.shop.test/v1 -> https://api.shop.test/v2

Tool list: ~796 -> ~659 tokens (-137; estimate)
  TOOL     BEFORE  AFTER
  orders      329    265
  reports      73      -

✖ --fail-on new-writes: 2 found (new writes the config allows without naming them)
✖ --fail-on access-changes: 1 found (access level changes)
```

The renamed refund is the case to look for: the config names `createRefund`, so its approval, its amount rule and its group stay behind, and `create*` lets `createOrderRefund` run without either. The AGENT column says where the agent finds an operation (its group, or `call_operation` for operations in no group), whether it asks for approval, or why it cannot call it.

What each section lists, and the `--fail-on` category that counts it:

| Section | What it lists | Category |
| --- | --- | --- |
| Added | Operations only in the new spec, with the tool they land in. A new operation is in no group unless the config already names it, so it lands in `call_operation`. | `added` |
| Removed | Operations only in the old spec, with the tool they were in. | `removed` |
| Renamed | A new id on the same method and path (path parameter names do not count), when exactly one operation on each side has them; or the same id on a new method or path. Anything else is an addition plus a removal. | `renamed` |
| Access level changes | Operations whose access level changed, in either direction, with what the agent could do before and after. A destructive operation that becomes a write stops asking for approval, and a write that becomes a read runs in read-only mode and outside the allowlist, so a downgrade counts as much as an upgrade. | `access-changes` |
| New writes the config allows without naming them | Writes the agent can call in the new spec, and could not call as a write before, that no one listed by exact id: allowed by a `writes.allow` pattern such as `create*` or `*`, or a POST, PUT, PATCH or DELETE that runs as a read because of a `writes.treatAsRead` pattern or `x-apitame-access: read` in the spec (those run even in read-only mode). Renamed writes count, because everything the config said about the old id stays with the old id. Each one shows whether it asks for approval. | `new-writes` |
| Config references that match no operation now | Names and patterns in `writes.allow`, `writes.confirm`, `writes.treatAsRead`, `writes.destructive`, `writes.rules`, `tools` and `http.oauth.permissions` that matched an operation in the old spec and match none in the new one, with the new id when the operation was renamed. A name that matched nothing before is a typo that `doctor` reports, not a change. | `stale-config` |
| Argument changes on allowed writes | For writes the agent can call, under the same id in both specs: arguments added (and whether they are required), arguments that became required, arguments removed, and `writes.rules` entries that no longer fit (a field that is gone or changed type). Paths are written as in `writes.rules`, such as `body.items[].price`. | `write-changes` |
| Base URL | The first server in the spec, when it changed and the config does not set `source.baseUrl`. Requests, with their credentials, go there. | `base-url` |
| Tool list | The estimated token cost of the tool list before and after, as `inspect` measures it, and the tools whose cost changed (`-` when a tool is not in that list). | none; use `inspect --max-tokens` for a budget |

`any` counts every category in the table.

| Option | Description |
| --- | --- |
| `-c, --config <path>` | Config file (default: `$APITAME_CONFIG` or `apitame.config.yaml`). |
| `--json` | Machine-readable output: `before` and `after` (spec and operation count), `added`, `removed`, `renamed`, `accessChanges`, `newWrites`, `staleConfig`, `writeChanges`, `baseUrl`, `tokens`, and `failOn` and `failed`. Operations carry their id, method, path, access, the tools that reach them, whether they ask for approval and, when the agent cannot call them, why. |
| `--fail-on [categories]` | Exit with code 1 when one of these categories has findings: `new-writes`, `access-changes`, `added`, `removed`, `renamed`, `stale-config`, `write-changes`, `base-url` or `any`, separated by commas (`--fail-on new-writes,access-changes`) or in repeated options. Without a value it means `new-writes`. Put the spec files before it. |

Without `--fail-on`, diff is a report and exits with code 0. A spec that cannot be read, or a config that does not validate, exits with code 1 too, so a CI check fails closed. For SQL sources there is no spec to compare, and diff says so.

When `source.spec` is a URL the API publishes, keep a reviewed copy next to the config and compare it with what the URL serves now, for example in a scheduled job: `apitame diff ./openapi.reviewed.json --fail-on any`. Once the change is reviewed, replace the copy.

### In CI

This GitHub Actions workflow runs on pull requests that touch the spec or the config, and fails when the change lets the agent run a write that no one named, or changes an access level. The report is in the job log.

```yaml
name: API spec review

on:
  pull_request:
    paths: ['openapi.yaml', 'apitame.config.yaml']

permissions:
  contents: read

jobs:
  apitame-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Check out the spec as it is on the base branch
        env:
          BASE_REF: ${{ github.base_ref }}
        run: |
          git fetch --depth=1 origin "$BASE_REF"
          git worktree add --detach "$RUNNER_TEMP/base" FETCH_HEAD
      - name: What the change means for the agent
        run: npx -y apitame@0.4 diff "$RUNNER_TEMP/base/openapi.yaml" --fail-on new-writes,access-changes
```

The base branch is checked out as a whole, so specs split over several files (`$ref` to other files) work too. The config is the one in the pull request, so a wildcard added to `writes.allow` in the same pull request is taken into account. Add `stale-config` to catch renames that leave rules or approvals behind, or use `--fail-on any` to have a human look at every change.

diff compares two specs under one config, so a pull request that changes only the config (a new `writes.allow` pattern, a removed approval) shows no findings. Review config changes in the pull request itself, and run `apitame inspect` on the new config to see what the agent can call.

## `apitame test`

```bash
apitame test            # OpenAPI: local mock built from the spec. SQL: the configured database.
apitame test --live     # OpenAPI: the real API (read operations only)
apitame test --json
```

For OpenAPI sources it:

1. calls every read operation through the tool an agent would use, with sample arguments built from the spec;
2. with `--live`, validates successful responses against the response schema (against the mock that would only test the sample generator);
3. calls every blocked write through `call_operation` and checks that each one is refused and that nothing reached the server.

For SQL sources it lists tables, describes each one, runs `SELECT * ... LIMIT 1` on each, runs every named read query with sample parameters, and sends known write and injection payloads (`DELETE`, `COMMIT; DROP SCHEMA ...`, stacked statements, a data-modifying CTE, for PostgreSQL, SQLite and DuckDB the backslash string trick, and for DuckDB file reads, `query()` and `INSTALL`) that must all be refused.

Exit code 1 when any check fails. Warnings (for example HTTP 404 for a sample id in `--live` mode) do not fail the run.

Against the mock, secret manager references are not read (the mock accepts any credentials); with `--live` and for SQL sources they are read as `serve` reads them.

## `apitame doctor`

Checks a setup end to end and says what to fix.

```text
$ apitame doctor
✔ Node.js        v22.22.2
✔ Config         apitame.config.yaml (postgres, read-only)
✔ .env           present and ignored by git
✔ Environment    DATABASE_URL set
✔ Database       connected, 4 tables and views visible
! Database role  role "shop_owner" can write to 4 tables (public.customers, ...). apitame enforces read-only access itself, but a read-only role is the layer nothing can bypass (docs/sql.md).
✔ Skills         shop-db up to date
✔ Clients        "shop" configured for Claude Code (.mcp.json)
```

| Check | What it looks at |
| --- | --- |
| Node.js | 22.14 or later. |
| Config | The config file validates; unknown operation ids and skipped named queries. |
| .env | If present, that git ignores it (a committed `.env` leaks secrets). |
| Environment | Every `${VAR}` the config needs is set (after loading `.env`). |
| Secrets | Each secret manager reference (`${op://...}`, `${aws-sm://...}`, `${gcp-sm://...}`): its CLI is found, and it reads as `serve` reads it. The value is never printed, nor what a failing CLI said. With `--offline`, only the CLI is looked for. When one cannot be read, the API or database check is skipped. |
| writes.* | Every allowlist or confirm pattern matches at least one operation (catches typos). |
| writes.rules | Argument rules name operations, arguments and fields that exist, are not on reads (where they are ignored), and use operators that can match the field's type. |
| API | Calls the first GET that needs no input, to test DNS, TLS and credentials. 401 and 403 are failures. |
| DuckDB driver | For DuckDB sources: `@duckdb/node-api` loads in a child process, and its DuckDB version (a warning when it is newer than the tested release). |
| Database | Connects, lists tables, and checks whether the role (or the SQLite or DuckDB file) could write. |
| Skills | Generated skills match the current config, and installed copies in `.claude/skills` or `.agents/skills` match too. |
| Clients | Which client configs in the current folder reference this server, and for DuckDB sources, whether they start it with `@duckdb/node-api` at the tested version. |
| HTTP auth | Authentication where `serve --transport http` listens (`--host`, `127.0.0.1` by default). None beyond loopback fails, as `serve` refuses to start, and so do `APITAME_HTTP_TOKEN` and `http.oauth` together. A token shorter than 32 characters or with quotes or spaces in it (`docker run --env-file` keeps quotes), and empty `http.oauth.scopes`, are warnings. |
| OAuth resource | `http.oauth.resource` uses https (http only on loopback), has no query, does not name a loopback address when `serve` listens beyond it, and ends in `/mcp`, where apitame answers (otherwise it says what the reverse proxy must map). |
| OAuth issuer | The issuer's metadata (RFC 8414 or OpenID Connect discovery, fetched as `serve` fetches it: no redirects, at most 1 MB) is reachable and names the same issuer, with a hint when they differ only in a trailing slash. Warns when it names no authorization or token endpoint, or no PKCE `S256`, which MCP clients need to sign users in, and when `jwksUri` differs from the key set it publishes. |
| OAuth keys | The key set loads as `serve` loads it at startup and has at least one key apitame can verify tokens with. Skipped under `verify: introspection`, which uses no keys. |
| OAuth introspection | With `http.oauth.introspection`: the URL uses https (http only on loopback) and the client secret is set, then the endpoint is asked about a random token with the configured client, as `serve` does at startup. Rejected credentials, an answer that is not RFC 7662 and that token coming back active fail. Warns when the issuer's metadata names another `introspection_endpoint`. The secret is never printed. |
| Public URL | Through the reverse proxy, `resource` answers a request without a token with apitame's challenge, and the protected resource metadata it points to names this resource and issuer. A URL that is not reachable from where doctor runs is only a note. |

The HTTP checks run when the config has `http.oauth`, when `APITAME_HTTP_TOKEN` is set, or with `--http` or `--host`. Run doctor where the server runs, with the host it listens on: `apitame doctor --host 0.0.0.0` (in a container, see [deploy.md](deploy.md#oauth-behind-the-proxy)).

| Option | Description |
| --- | --- |
| `-c, --config <path>` | Config file. |
| `--offline` | Skip the checks that contact the API, database, authorization server or public URL. |
| `--http` | Check the HTTP setup even without `http.oauth` or `APITAME_HTTP_TOKEN`. |
| `--host <host>` | The host `serve --transport http` listens on (default `127.0.0.1`). Implies `--http`. |
| `--json` | Machine-readable findings. |

Exit code 1 when a check fails; warnings do not fail.

## `apitame add-to <client>`

Prints, or writes with `--write`, the configuration for an MCP client, and installs the generated skills.

| Client | Writes | Skills go to |
| --- | --- | --- |
| `claude-code` | `.mcp.json` (merged) | `.claude/skills/` |
| `codex` | `.codex/config.toml` (appended once; Codex reads it for trusted projects) | `.agents/skills/` |
| `cursor` | `.cursor/mcp.json` (merged), and prints an install link | `.agents/skills/` |
| `vscode` | `.vscode/mcp.json` (merged) | `.agents/skills/` |
| `gemini` | `.gemini/settings.json` (merged) | `.agents/skills/` |
| `claude-desktop` | `claude_desktop_config.json` in the app's settings folder (merged, absolute paths, `PATH` set) | `skills/<name>.zip`, to upload in the app |

| Option | Default | Description |
| --- | --- | --- |
| `-c, --config <path>` | `apitame.config.yaml` | Config file. |
| `-w, --write` | | Write files in the current folder instead of only printing. |
| `-n, --name <name>` | config `name` | Server name in the client. |
| `--command <cmd>` | `npx -y apitame@<major.minor>` | How the client should launch apitame, for example `node /path/to/apitame/dist/cli.js`. |

Paths are written relative to the project (`${CLAUDE_PROJECT_DIR:-.}/...` or `${workspaceFolder}/...`) when the config is inside the current folder, so the files can be committed and shared. Secrets are never written to client configs.

For a DuckDB source the launcher adds the driver, pinned to the tested release: `npx -y -p apitame@<major.minor> -p @duckdb/node-api@1.5.6-r.1 apitame serve --config ...`.
