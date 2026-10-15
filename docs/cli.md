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
| `--skills-only` | | Regenerate skills from the existing config (for example after switching to read-write). |
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

Both MCP protocol eras are served on stdio and HTTP: 2025-era clients (which start with `initialize`) and clients on protocol 2026-07-28. The server exposes `tools/list` and `tools/call`. When the config has skills, it also declares the MCP Skills extension (`io.modelcontextprotocol/skills`) and answers `skills/list`, `skills/get`, `resources/list` and `resources/read` for `skill://` URIs. The HTTP server also answers `GET /health`, and with `http.oauth` it serves its protected resource metadata at `/.well-known/oauth-protected-resource`.

Missing credentials do not stop the server: it starts, logs a warning, and tool calls explain which variable is missing.

With `--watch`, editing the config takes effect without restarting the client: allow a write, save, and the new tool appears (clients that support `notifications/tools/list_changed`, such as Claude Code, refresh their tool list). A config that does not validate is reported in the log and the previous one keeps serving. Changed `.env` values are picked up too.

## `apitame inspect`

Shows what an agent will see.

```text
$ apitame inspect
github  openapi · read-only · ./openapi.yaml

TOOL               OPS  ACCESS  TOKENS
repos               11  read       550
issues               4  read       307
...
8 tools, ~2,087 tokens (includes 122 for server instructions; estimate)
  one tool per endpoint (38 tools): ~5,522 tokens, apitame saves 62%
  search + call only: ~233 tokens (smallest, but every task needs extra round trips)

! 13 operations blocked by read-only mode: repos/update, repos/delete, ...
✔ Skills: github-api
```

With [argument rules](configuration.md#writesrules), it lists them too, and warns about rules that cannot apply:

```text
✔ Argument rules for 2 writes, checked before anything is sent or anyone is asked:
  OPERATION   ARGUMENT       RULE
  addPet      body.status    one of "available", "pending"
  placeOrder  body.quantity  required, between 1 and 5
! writes.rules.getPetById: "getPetById" is a read operation; rules only apply to writes, so these are ignored.
```

| Option | Description |
| --- | --- |
| `--json` | Machine-readable output: tools with tokens, totals, blocked operations, argument rules per operation, skills and warnings. |
| `--verbose` | List the operations inside each tool. |
| `--max-tokens <n>` | Exit with code 1 when the tool list costs more than `n` tokens. Use it in CI to stop the tool list from growing unnoticed. |

Token counts are estimates. They are calibrated against a common BPE tokenizer and land slightly above it, because tokenizers differ between models.

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
| writes.* | Every allowlist or confirm pattern matches at least one operation (catches typos). |
| writes.rules | Argument rules name operations, arguments and fields that exist, are not on reads (where they are ignored), and use operators that can match the field's type. |
| API | Calls the first GET that needs no input, to test DNS, TLS and credentials. 401 and 403 are failures. |
| DuckDB driver | For DuckDB sources: `@duckdb/node-api` loads in a child process, and its DuckDB version (a warning when it is newer than the tested release). |
| Database | Connects, lists tables, and checks whether the role (or the SQLite or DuckDB file) could write. |
| Skills | Generated skills match the current config, and installed copies in `.claude/skills` or `.agents/skills` match too. |
| Clients | Which client configs in the current folder reference this server, and for DuckDB sources, whether they start it with `@duckdb/node-api` at the tested version. |

| Option | Description |
| --- | --- |
| `-c, --config <path>` | Config file. |
| `--offline` | Skip the checks that contact the API or database. |
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
