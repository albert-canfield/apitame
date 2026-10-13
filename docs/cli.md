# CLI reference

```text
apitame <command> [options]
```

Every command except `init` reads `apitame.config.yaml` from the current folder. Use `-c, --config <path>` or `APITAME_CONFIG` to point elsewhere. Errors print one line; set `APITAME_DEBUG=1` for a stack trace. Exit code 1 means failure.

## `apitame init [source]`

Introspects a source and writes `apitame.config.yaml`, `skills/` and, when needed, `.env.example` (and `.env` for a Postgres URL given on the command line).

```bash
apitame init ./openapi.yaml
apitame init https://api.example.com/openapi.json
apitame init https://api.example.com                # finds the spec
apitame init postgres://user:pass@host:5432/db
apitame init '$DATABASE_URL'                        # or env:DATABASE_URL
apitame init ./shop.db
apitame init --skills-only                          # regenerate skills from the existing config
```

| Option | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `.` | Folder to write into. |
| `-n, --name <name>` | from the spec title or database name | Server name. |
| `--base-url <url>` | | API base URL, overrides the servers in the spec. |
| `--max-tools <n>` | `12` | Tool budget, including `search_operations` and `call_operation`. |
| `--env-var <name>` | `DATABASE_URL` | Variable that holds the Postgres URL. |
| `--schema <names...>` | `public` | Postgres schemas to expose. |
| `-f, --force` | | Overwrite an existing config. |
| `--skills-only` | | Regenerate skills from the existing config (for example after switching to read-write). |
| `-c, --config <path>` | | Config to use with `--skills-only`. |

## `apitame serve`

Runs the MCP server.

```bash
apitame serve                                  # stdio, for clients that launch the server
apitame serve --transport http --port 3333     # streamable HTTP on http://127.0.0.1:3333/mcp
APITAME_HTTP_TOKEN=... apitame serve --transport http --host 0.0.0.0
```

| Option | Default | Description |
| --- | --- | --- |
| `-c, --config <path>` | `apitame.config.yaml` | Config file. |
| `-t, --transport <stdio\|http>` | `stdio` | Transport. |
| `-p, --port <port>` | `3333` | HTTP port. |
| `--host <host>` | `127.0.0.1` | HTTP host. Anything other than loopback needs `APITAME_HTTP_TOKEN`. |
| `--log-level <level>` | `info` | `debug`, `info`, `warn`, `error` or `silent`. Logs go to stderr. |

The server exposes `tools/list` and `tools/call`. When the config has skills, it also declares the MCP Skills extension (`io.modelcontextprotocol/skills`) and answers `skills/list`, `skills/get`, `resources/list` and `resources/read` for `skill://` URIs. The HTTP server also answers `GET /health`.

Missing credentials do not stop the server: it starts, logs a warning, and tool calls explain which variable is missing.

## `apitame inspect`

Shows what an agent will see.

```text
$ apitame inspect
github  openapi · read-only · ./openapi.yaml

TOOL               OPS  ACCESS  TOKENS
repos               11  read       535
issues               4  read       292
...
8 tools, ~1,954 tokens (includes 94 for server instructions; estimate)
  one tool per endpoint (38 tools): ~5,522 tokens, apitame saves 65%
  search + call only: ~218 tokens (smallest, but every task needs extra round trips)

! 13 operations blocked by read-only mode: repos/update, repos/delete, ...
✔ Skills: github-api
```

| Option | Description |
| --- | --- |
| `--json` | Machine-readable output: tools with tokens, totals, blocked operations, skills and warnings. |
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
2. validates successful responses against the response schema;
3. calls every blocked write through `call_operation` and checks that each one is refused and that nothing reached the server.

For SQL sources it lists tables, describes each one, runs `SELECT * ... LIMIT 1` on each, runs every named read query with sample parameters, and sends known write and injection payloads (`DELETE`, `COMMIT; DROP SCHEMA ...`, stacked statements, the backslash string trick, a data-modifying CTE) that must all be refused.

Exit code 1 when any check fails. Warnings (for example HTTP 404 for a sample id in `--live` mode) do not fail the run.

## `apitame add-to <client>`

Prints, or writes with `--write`, the configuration for an MCP client, and installs the generated skills.

| Client | Writes | Skills go to |
| --- | --- | --- |
| `claude-code` | `.mcp.json` (merged) | `.claude/skills/` |
| `codex` | `.codex/config.toml` (appended once; Codex reads it for trusted projects) | `.agents/skills/` |
| `cursor` | `.cursor/mcp.json` (merged), and prints an install link | `.agents/skills/` |
| `vscode` | `.vscode/mcp.json` (merged) | `.agents/skills/` |

| Option | Default | Description |
| --- | --- | --- |
| `-c, --config <path>` | `apitame.config.yaml` | Config file. |
| `-w, --write` | | Write files in the current folder instead of only printing. |
| `-n, --name <name>` | config `name` | Server name in the client. |
| `--command <cmd>` | `npx -y apitame@<major.minor>` | How the client should launch apitame, for example `node /path/to/apitame/dist/cli.js`. |

Paths are written relative to the project (`${CLAUDE_PROJECT_DIR:-.}/...` or `${workspaceFolder}/...`) when the config is inside the current folder, so the files can be committed and shared. Secrets are never written to client configs.
