<h1 align="center">apitame</h1>

<p align="center">
  <b>Turn any OpenAPI spec or SQL database into a safe MCP server, plus agent skills. One command.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/apitame"><img alt="npm version" src="https://img.shields.io/npm/v/apitame.svg"></a>
  <a href="https://github.com/albert-canfield/apitame/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/albert-canfield/apitame/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20.12-339933.svg">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-TypeScript%20SDK%20v2-8A2BE2.svg">
</p>

<p align="center">
  <img src="docs/assets/demo.svg" alt="Terminal demo: apitame init turns a 38-endpoint GitHub API spec into 8 read-only tools, inspect shows about 60% fewer tokens, test passes and add-to installs it in Claude Code" width="900">
</p>

```bash
npx apitame init ./openapi.yaml          # or an API URL, postgres://..., mysql://..., ./shop.db
npx apitame add-to claude-code --write   # or codex, cursor, vscode, gemini, claude-desktop
```

That is the whole setup. Your agent now has a small set of task-level tools for the API, read-only by default, plus a skill that teaches it how to use them.

## Why apitame

Giving an agent an API is easy. Giving it one safely, without flooding its context, is not. Most generators map every endpoint to a tool and expose every write operation. apitame makes the opposite choices:

- **Safe by default.** Read-only out of the box. Writes need `mode: read-write` and an explicit allowlist. Destructive operations stop for human approval. Every write has a dry run.
- **A curated tool surface.** Endpoints are grouped into a handful of task-level tools, with `search_operations` and `call_operation` for the long tail. The GitHub example goes from 38 endpoints to 8 tools and about 60% fewer tokens; Stripe's full API goes from 612 endpoints to 12 tools and 99% fewer. Responses can be trimmed to the fields the agent needs with `"fields": ["items.full_name"]`.
- **Skills that match the server.** Generated `SKILL.md` files use the real tool names, argument shapes, workflows and safety rules. They are installed where Claude Code, Codex, Cursor, VS Code and Gemini CLI look for them, packaged for Claude Desktop, and served over MCP.
- **SQL without the usual footguns.** PostgreSQL, MySQL and SQLite with `list_tables`, `describe_table` and a SELECT-only `query`, checked by a lexer and a real SQL parser, then run in a read-only transaction with a row limit and a timeout.
- **One config file you can review in a pull request.** `apitame.config.yaml` holds the tool groups, the allowlist, limits and auth. No daemon, no account, no code generation.
- **Secrets stay secret.** Credentials come only from environment variables and are redacted from every tool result, error, log line and dry-run preview.

## Quick start

Requires Node.js 20.12 or later.

### From an OpenAPI spec (3.0, 3.1 or Swagger 2.0)

```bash
npx apitame init ./openapi.yaml       # a file
npx apitame init https://api.example.com   # a spec URL, or a base URL (apitame looks for the spec)
```

```text
✔ Read GitHub REST API (subset): 38 operations (25 read, 13 write)
✔ Grouped into 8 tools: repos, issues, pulls, search, users, activity, search_operations, call_operation
✔ Read-only mode: 13 write operations blocked until you allow them
✔ Tool list costs ~2,087 tokens (one tool per endpoint: ~5,522, 62% saved)
✔ Wrote ./apitame.config.yaml and 2 skill files in ./skills
```

### From a database

```bash
npx apitame init postgres://readonly_user:password@localhost:5432/shop
npx apitame init mysql://readonly_user:password@localhost:3306/shop
npx apitame init ./shop.db
```

The connection string is saved to `.env` (never to the config file). Use a read-only role: [docs/sql.md](docs/sql.md) has a two-line setup.

### Check it, then connect your agent

```bash
npx apitame inspect                     # tools, modes and estimated token cost
npx apitame test                        # call every read tool against a mock and run safety checks
npx apitame doctor                      # if something does not work, this says what to fix
npx apitame add-to claude-code --write  # writes .mcp.json and installs the skill
```

## Connect a client

`add-to` prints the right snippet for each client, and `--write` writes it into the project for you. These are the shapes it produces:

<details open>
<summary><b>Claude Code</b> (<code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.1", "serve", "--config", "${CLAUDE_PROJECT_DIR:-.}/apitame.config.yaml"]
    }
  }
}
```

Or: `claude mcp add --transport stdio --scope project github -- npx -y apitame@0.1 serve --config /abs/path/apitame.config.yaml`. Skills go to `.claude/skills/`.

</details>

<details>
<summary><b>Codex</b> (<code>~/.codex/config.toml</code>)</summary>

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "apitame@0.1", "serve", "--config", "/abs/path/apitame.config.yaml"]
```

Or: `codex mcp add github -- npx -y apitame@0.1 serve --config /abs/path/apitame.config.yaml`. Skills go to `.agents/skills/`.

</details>

<details>
<summary><b>Cursor</b> (<code>.cursor/mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.1", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
    }
  }
}
```

`add-to cursor` also prints a one-click install link. Skills go to `.agents/skills/`.

</details>

<details>
<summary><b>VS Code</b> (<code>.vscode/mcp.json</code>)</summary>

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.1", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
    }
  }
}
```

</details>

<details>
<summary><b>Gemini CLI</b> and <b>Claude Desktop</b></summary>

`add-to gemini` writes `.gemini/settings.json` and installs skills in `.agents/skills/`. `add-to claude-desktop` writes Claude Desktop's config with absolute paths (desktop apps do not inherit your shell's `PATH`) and packages each skill as a `.zip` to upload in the app.

</details>

Prefer HTTP? `npx apitame serve --transport http` listens on `http://127.0.0.1:3333/mcp` (add `--sessions` so destructive actions are approved in the client). More in [docs/clients.md](docs/clients.md).

## What the agent sees

For the GitHub example in read-only mode, `tools/list` returns 8 tools. Related operations share one tool:

```text
issues: Issues, comments and labels
Operations (pass the name as "operation" and its arguments in "params"):
- issues/list-for-repo(owner: string, repo: string, state?: "open"|"closed"|"all", ...): List repository issues
- issues/get(owner: string, repo: string, issue_number: integer): Get an issue
...
```

A write in read-only mode is refused before any request is sent, with a reason the agent can pass on:

```text
Blocked: "issues/create" is a write operation and the server runs in read-only mode.
To enable it, set "mode: read-write" and add "issues/create" to writes.allow in apitame.config.yaml.
```

In read-write mode, a destructive call asks the human first. Clients that support MCP elicitation show an approval prompt. Other clients get a preview and a one-time token the agent must send back after the user agrees:

```text
CONFIRMATION REQUIRED. Nothing has been changed yet.

DESTRUCTIVE: Delete a repository
{ "method": "DELETE", "url": "https://api.github.com/repos/octocat/hello-world", ... }

Show this to the user and ask for explicit approval. Only if they approve, call the same tool again
with exactly the same arguments plus "confirm": "confirm_...". The token works once and expires in 5 minutes.
```

## Safety model

apitame assumes the agent will eventually call the wrong thing, and makes that boring.

| Layer | What it does |
| --- | --- |
| Read-only mode (default) | Write operations are not exposed as tools, and `call_operation` refuses them. Anything other than GET, HEAD and OPTIONS counts as a write unless you mark it as a read. |
| Allowlist | In `read-write` mode, only operations in `writes.allow` run. Wildcards like `create*` work. |
| Confirmation | DELETE and anything named like delete, remove, purge, cancel or bulk is destructive and always needs approval, through MCP elicitation or a one-time token bound to the exact arguments. |
| Dry run | `"dryRun": true` on any write returns the exact request (or, for SQL, the affected row count in a rolled-back transaction) without changing anything. |
| Validation | Arguments are checked against the operation's schema before anything is sent. Unknown parameters are rejected. |
| Limits | Per-request timeout and response size cap. Large JSON is trimmed to fit, with a note saying how much was kept. |
| Secrets | Credentials come only from environment variables (inline secrets in the config are refused) and are redacted from results, errors, logs and previews, even when an API echoes them back. |
| HTTP transport | Loopback only by default, with Host and Origin checks. Listening on another interface requires a bearer token. |
| Outgoing requests | Path parameters cannot be `.` or `..`; credentials never follow a redirect to another host; files are passed inline, never as local paths, and uploads are capped. |
| Rate limits | By default 120 calls and 20 writes per minute, so a looping agent cannot hammer an API or database. |
| Audit log | Optional JSON Lines record of every write attempt (blocked, dry run, confirmed, sent) and every refused query, with secrets redacted. |

For SQL, every free-form query passes four independent layers:

1. **A lexer that follows the database's own quoting rules**: exactly one statement, no write keywords, no side-effect functions (`pg_sleep`, `pg_read_file`, `dblink`, `load_extension` and others), no credential catalogs.
2. **A real SQL parser**: the statement must be a SELECT, with no `SELECT INTO` and no row locks. Anything the parser cannot read is refused.
3. **The database itself**: PostgreSQL runs the query inside `BEGIN READ ONLY` with `statement_timeout`, through the extended protocol (which accepts one statement only) and a cursor that stops at the row limit. MySQL uses `START TRANSACTION READ ONLY`, `max_execution_time`, `sql_select_limit` and single-statement prepared statements. SQLite uses a read-only connection, `query_only`, a per-statement read-only check and a worker thread that is killed on timeout.
4. **Your read-only database role**, which nothing can bypass.

The layers exist because parsers and databases disagree. `SELECT '\'; DELETE FROM orders; --'` is one harmless string to a typical SQL parser and two statements to PostgreSQL. apitame's lexer reads it the way PostgreSQL does, and the test suite includes that case and the `COMMIT; DROP SCHEMA` escape that affected the archived reference Postgres server.

Read [docs/safety.md](docs/safety.md) for the full model, including what apitame does not protect against.

## Commands

| Command | What it does |
| --- | --- |
| `apitame init <source>` | Introspect an OpenAPI or Swagger file or URL, a `postgres://` or `mysql://` URL, or a SQLite file. Writes `apitame.config.yaml` and `skills/`. |
| `apitame serve` | Run the MCP server over stdio (default) or `--transport http`. With `--watch`, config and spec edits apply live and clients are told the tools changed. |
| `apitame inspect` | List tools, access levels and estimated token cost. `--max-tokens <n>` fails CI when the tool list grows past a budget. |
| `apitame test` | Call every read tool against a local mock built from the spec (or `--live`, which also validates responses), and prove that blocked writes are refused. For SQL, check every table and try known injection payloads. |
| `apitame add-to <client>` | Print or `--write` the config for `claude-code`, `codex`, `cursor`, `vscode`, `gemini` or `claude-desktop`, and install the skills. |
| `apitame doctor` | Check the setup end to end: config, environment variables, `.env` safety, API or database connectivity and credentials, whether the database role could write, skills and client configs. |

Full reference: [docs/cli.md](docs/cli.md).

## Configuration

`init` writes a commented `apitame.config.yaml`. The parts you are most likely to edit:

```yaml
mode: read-only            # read-write lets allowlisted writes run

auth:
  type: bearer
  token: ${GITHUB_TOKEN}   # always from the environment or .env

tools:                     # task-level tools: rename, regroup, drop operations
  - name: issues
    description: Issues, comments and labels
    operations: [issues/list-for-repo, issues/get, issues/create, issues/update]

writes:
  allow: [issues/create, issues/update]   # only used in read-write mode
  confirm: [issues/update]                # destructive operations always ask
```

Every field is documented in [docs/configuration.md](docs/configuration.md).

## Token cost

`apitame inspect` estimates what the tool list costs in the model's context:

| Example | Operations | One tool per endpoint | apitame (read-only) | Saved |
| --- | ---: | ---: | ---: | ---: |
| [Petstore](examples/petstore) | 19 | ~2,046 tokens, 19 tools | ~855 tokens, 5 tools | 58% |
| [GitHub subset](examples/github-subset) | 38 | ~5,522 tokens, 38 tools | ~2,087 tokens, 8 tools | 62% |
| [Stripe](https://github.com/stripe/openapi) (full public spec) | 612 | ~434,000 tokens, 612 tools | ~4,400 tokens, 12 tools | 99% |
| [GitHub REST](https://github.com/github/rest-api-description) (full public spec) | 1,242 | ~421,000 tokens, 1,242 tools | ~9,100 tokens, 12 tools | 98% |

On the full Stripe and GitHub APIs, a one-tool-per-endpoint list would not even fit in most context windows; apitame serves both in a few thousand tokens, keeps every operation reachable through `search_operations`, and `init` plus `test` take about three seconds each. The estimate is calibrated against a real BPE tokenizer and lands slightly above it; exact counts vary by model. Several clients now load tool schemas on demand, so the bigger win is often fewer, clearer tools rather than raw token count. A search-and-call-only surface is smaller still (about 230 tokens) but costs extra round trips on every task; apitame gives you both.

## How it compares

There is good prior work here. This table is our honest reading as of 13 October 2026; [docs/landscape.md](docs/landscape.md) has the details and sources.

| | apitame | [FastMCP](https://github.com/PrefectHQ/fastmcp) `from_openapi` | [Executor](https://github.com/UsefulSoftwareCo/executor) | [mcp-openapi-server](https://github.com/ivo-toby/mcp-openapi-server) | [openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator) | [MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox) | [DBHub](https://github.com/bytebase/dbhub) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Inputs | OpenAPI 3.x, Swagger 2.0, PostgreSQL, MySQL, SQLite | OpenAPI (in Python code) | OpenAPI, GraphQL, MCP | OpenAPI | OpenAPI | 20+ databases | 6 SQL engines |
| Runs as | CLI plus a config file | Python framework | Daemon, desktop app or hosted | CLI proxy | Generated Node project | Go server | Node server |
| Tool surface | Grouped task tools (capped) plus search and call | One per endpoint, or search and call, or code mode | Code mode, or search and invoke | One per endpoint, or 3 discovery tools | One per endpoint | Hand-written toolsets | 2 tools plus custom |
| Read-only by default | Yes | No | Partial | No | No | No | Partial |
| Enforced write confirmation | Yes | Advisory | Yes | No | No | No | No |
| Dry run for writes | Yes | No | No | No | No | No | No |
| Generated skills | Yes, also over MCP | No | No | No | No | Partial | No |
| Token report | Yes, with CI budget | No | No | No | No | No | Partial |

Executor is the closest match on safety and is a great choice if you want a managed gateway with a UI. FastMCP is the right tool if you are already writing Python. MCP Toolbox and DBHub are mature database servers with many engines. apitame's angle is a local, zero-config CLI whose safety rules live in a file you can review.

## Examples

- [`examples/petstore`](examples/petstore): the classic Petstore. Runs against the public demo server.
- [`examples/github-subset`](examples/github-subset): 38 real GitHub endpoints with bearer auth, search and pagination.
- [`examples/postgres-shop`](examples/postgres-shop): a shop database (Docker Compose or SQLite) with named queries and a read-only role.

## Roadmap

- [A published tool-selection eval](https://github.com/albert-canfield/apitame/issues/24): curated tools vs one tool per endpoint vs search-only.
- [SQL Server and DuckDB](https://github.com/albert-canfield/apitame/issues/27).
- [OAuth 2.1 for the HTTP transport](https://github.com/albert-canfield/apitame/issues/28).
- [Approvals through multi round-trip input](https://github.com/albert-canfield/apitame/issues/45), ready for the 2026-07-28 protocol and for stateless HTTP.
- [Require Node 22](https://github.com/albert-canfield/apitame/issues/29) (Node 20 is past end of life).
- Later: GraphQL sources.

Ideas and votes are welcome in [issues](https://github.com/albert-canfield/apitame/issues).

## Documentation

- [Configuration reference](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [Safety model](docs/safety.md)
- [OpenAPI sources](docs/openapi.md)
- [SQL sources](docs/sql.md)
- [Skills](docs/skills.md)
- [Client setup](docs/clients.md)
- [Architecture](docs/architecture.md)
- [Design decisions](docs/decisions.md)

## Contributing

Bug reports, specs that break apitame, and pull requests are all welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Albert Canfield
