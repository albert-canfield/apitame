# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- OAuth 2.1 for the HTTP transport (`http.oauth` in the config): apitame acts as a resource server for your own authorization server (Keycloak, Auth0, Okta, Entra ID and others that issue JWT access tokens). It serves RFC 9728 protected resource metadata, answers requests without a valid token with a 401 that points MCP clients to the sign-in, and checks each access token locally: signature against the issuer's published keys, issuer, audience, expiry and required scopes (403 `insufficient_scope`). Keys are discovered through RFC 8414 or OpenID Connect metadata and refreshed when the issuer rotates them. With `--sessions`, a session belongs to the user who started it, and the audit log records the token's client id and subject. `APITAME_HTTP_TOKEN` and `http.oauth` cannot be combined (#28).

### Changed

- **Breaking:** Node.js 22.14 or later is required. Node 20 reached end of life in April 2026, and the SQLite driver (better-sqlite3 13) crashes on Node 22 before 22.14; `apitame doctor` fails on older versions. Thanks @Enard52 (#48).
- commander 15: a "too many arguments" error now lists the arguments it got (`Expected 0 arguments but got 2: extra1, extra2.`). Options and help output are unchanged.

## [0.2.0] - 2026-10-14

### Added

- MySQL and MariaDB sources: `list_tables`, `describe_table`, guarded `query` and named queries, with MySQL-accurate lexing (executable comments refused, `#` and `-- ` comments, backslash strings), read-only transactions, `max_execution_time`, `sql_select_limit` and server-side prepared statements.
- Swagger 2.0 documents are converted to OpenAPI 3 in memory: servers, body and form parameters, `collectionFormat`, responses and security definitions.
- File uploads: `multipart/form-data` and binary request bodies, with files passed inline as base64 or text (never a local path), capped by `limits.maxUploadBytes` (10 MB). Previews show file names and sizes only.
- Response field selection: read tools accept `"fields": ["id", "items.name"]` (dot paths, arrays mapped) to return only what the agent needs, applied before the response size cap.
- `apitame doctor`: checks Node, config, environment variables, whether `.env` is git-ignored, API or database connectivity and credentials, whether the database role could write, allowlist typos, stale skills and client configs.
- `serve --watch`: reloads when the config, a local spec, the skills folder or `.env` change, keeps the previous config if the new one is invalid, and sends `notifications/tools/list_changed` so clients refresh without a restart.
- `serve --transport http --sessions`: one MCP session per client (`Mcp-Session-Id`), so destructive operations are approved by the human through elicitation over HTTP too, as over stdio. Idle sessions are closed after 30 minutes and at most 100 are kept. Stateless stays the default. With `--watch`, every session is told when the tool list changes.
- Rate limits: `limits.maxCallsPerMinute` (default 120) and `limits.maxWritesPerMinute` (default 20) stop runaway agent loops.
- Per-tool rate limits: `limits.perTool` (for example `{ search: 10 }`), on top of the server-wide limits. Shown by `inspect`.
- Audit log: `audit.file` appends a redacted JSON Lines record of every write attempt and refused query (`include: all` adds reads).
- `add-to gemini` (`.gemini/settings.json`, skills in `.agents/skills/`) and `add-to claude-desktop` (absolute paths and `PATH` for desktop apps, skills packaged as `.zip` for upload).
- CI runs on Windows, and runs the SQL suite against real PostgreSQL 17 and MySQL 8.4 servers in addition to PGlite and SQLite.

### Security

- Responses are redacted before they are trimmed to `limits.maxResponseBytes`. Before, a secret echoed by an API right at the cut could be partly shown (for example the first 20 characters of an API key), and an oversized JSON object that fell back to text lost key-based masking. The same ordering bug is fixed for SQL results and OAuth token endpoint errors.
- SQL `query`: `sql.tables.allow` could be bypassed with a CTE named like a real table (`WITH customers AS (SELECT * FROM customers)`, or a CTE inside a subquery hiding the outer table). CTE names are now resolved per scope as the database does.
- SQL `query`: functions that run a SQL string or read a table by name escaped both table lists (`ts_stat('SELECT ... FROM secrets')`, `ts_rewrite`, `crosstab`, `connectby`, `xpath_table`, `pgstattuple`, `get_raw_page`) and are refused, as are `pg_stat_get_activity()` and friends (other sessions' statements). Planner statistics that hold sampled values (`pg_stats`, `pg_stats_ext`, `sqlite_stat4`, MySQL `column_statistics`) and MySQL `innodb_trx` are denied.
- MySQL: a dry run, and the row count measured for the confirmation preview before the human approves, ran the statement and rolled back. On MyISAM, MEMORY and other non-transactional tables (or through a trigger that writes to one) the change was not undone, so a destructive named query took effect before approval. Dry runs now require every table involved to be InnoDB or NDB without triggers.
- Confirmation: when a client that supports elicitation failed to show the prompt or did not answer in time, apitame fell back to the token flow, so the agent could confirm on its own. Such a failure now stops the call. The prompt is also sent on the tool call's own stream: over HTTP sessions it could go to the client's standalone stream before that was open, where it was dropped and the call hung. The human has 5 minutes to answer (was 60 seconds).
- `dryRun` must be a boolean (or `"true"`/`"false"`), for HTTP operations and SQL named queries alike. Before, `"dryRun": "true"` or `1` ran the real request or statement; destructive ones still stopped at confirmation, but allowlisted writes ran. Named query parameters called `dryRun` or `confirm` are refused by config validation.
- `dryRun` and `confirm` always control apitame. In single-operation tools an API parameter with the same name took them over, so a "dry run" could be sent to the API for real; such parameters are now exposed as `api_dryRun` and `api_confirm`.
- SQL named queries: `writes.destructive` patterns (`archive_*`) were matched exactly, so such queries ran without confirmation; parameters were bound with their raw values instead of the validated ones (`0` for a string parameter, which MySQL compares numerically against text); `"dryRun": null` ran the write; and the write rate limit was checked after the human approved, so a refused call used up the approval.
- Values from `${VAR}` in `source.baseUrl` are registered as secrets. Before, a token in the base URL (`https://api.telegram.org/bot${BOT_TOKEN}`) appeared in dry-run and confirmation previews and in the write log line.
- Each variable inside a composite value is registered on its own (`SSWS ${OKTA_TOKEN}`, `tenant-${KEY}`), and so is a Basic auth username that comes from the environment (Stripe sends the key as the username).
- The redactor also catches query-string encoded secrets, `Authorization: <scheme> <value>` pairs, lowercase schemes, object keys and non-string values under sensitive keys, and no longer backtracks quadratically on long dotted input (a 200,000-character argument took about 20 seconds and blocked the server).
- Generated skills: database table and column names and comments were written into `SKILL.md` and `references/schema.md` as raw markdown, so a comment with line breaks could add headings or instructions to a file the agent reads as guidance. Text from a database or spec is now kept on one line, with leading markdown markers and pipes escaped, and example queries only use plain identifiers.
- Redirect chains that leave the API's origin never get credentials back, even when a later hop returns to the API (an open redirect could bring a request back to another endpoint with credentials). A write is no longer resent by a 307 or 308 redirect outside the base URL.
- Exploded object query parameters only accept the keys their schema lists, so an agent cannot add parameters such as `_method=DELETE`.
- `limits.timeoutMs` covers the whole request, including redirects, the token refresh retry and reading the body. Before, it applied per hop.
- The write rate limit is checked before confirmation, so a rate-limited call no longer uses up the human's approval token.
- `writes.destructive` and `writes.treatAsRead` accept `*` patterns like `allow` and `confirm`. Before, `destructive: [archive*]` was ignored at runtime (while `doctor` reported it as matching), so those operations ran without confirmation.
- SQL `list_tables` and `describe_table` go through the redactor and the response size cap like query results. Oversized text is cut by bytes, never in the middle of a character.
- Static header values are hidden in previews, including literal ones.
- Skills served over MCP only follow symlinks that stay inside the skill folder, and file sizes are checked before reading.
- `confirmation.method: elicitation` refuses when there is no way to ask the human, instead of falling back to a token (library use only; the MCP server always offers elicitation).
- Path parameters can no longer be `.` or `..`, which URL parsing would resolve into a different endpoint. Built URLs must stay under the base path.
- Redirects are followed manually: credentials and custom headers are only sent to the API's own origin, never to a redirect target on another host.
- The SQL guard also denies `pg_stat_statements`, `information_schema.user_mapping_options` and MySQL's `processlist`, which expose other sessions' statements or stored credentials.
- The HTTP transport is covered by tests: loopback-only default, bearer token, Host and Origin checks, and confirmation (stateless HTTP uses the token flow).
- MySQL: dry runs of DDL named queries are refused even when a comment comes first (`/* note */ DROP TABLE ...`). Before, the check could be bypassed that way and MySQL, which commits DDL implicitly, would have run the statement during the dry run. Named queries come from the trusted config, so this needed a config author to write such a query.

### Fixed

- `APITAME_CONFIG` was documented but ignored: the CLI gave `--config` a default, so the variable was never read. It now works for every command, and `--config` still wins.
- `serve --watch`: a reload that failed after reading `.env` left the new values set and untracked, so later edits to them were ignored. One invalid `SKILL.md` stopped the server from starting; such folders are now skipped with a warning. An audit log inside the skills folder no longer triggers a reload (and a rate limit reset) on every call.
- On Node 20, request timeouts could silently stop working after a garbage collection: a timeout signal reachable only through `AbortSignal.any()` is collected there and never fires, so a slow API could hold a tool call indefinitely (0.1.0 is affected too). The deadline is now an explicit timer.
- JSON media types with a structured suffix (`application/vnd.api+json`, `application/vnd.github+json`) were treated as binary, so JSON:API responses were never returned.
- A base URL with a query string (`https://api.example.com/v1?api-version=2024-01-01`) put the operation path inside the query.

### Changed

- Install size down from about 141 MB to 53 MB: only the three SQL parser builds apitame uses are bundled, SQL code loads on demand, and published builds carry no source maps.
- Large APIs: untagged specs rank top-level resources (`/v1/customers`) before nested product areas when choosing tools. Stripe's full spec (612 operations) becomes 12 tools in about 4,400 tokens; GitHub's full REST API (1,242 operations) about 9,100.
- `init` prefers bearer auth over basic when a spec accepts both, and checks whether database credentials could write instead of always printing the read-only-role advice.
- `test` against the mock no longer validates generated responses (Stripe's run went from 49 s to about 3 s); `--live` still validates. `test` and `doctor` ignore rate limits and do not write to the audit log.
- Binary responses are described instead of returned as text, and requests send a `User-Agent: apitame/<version>` header.
- Generated configs and paths use forward slashes on every OS.
- The release workflow can be run manually as a dry run, and publishes through npm trusted publishing when configured.

## [0.1.0] - 2026-10-14

### Added

- `apitame init` for OpenAPI 3.0/3.1 files and URLs (with spec discovery), PostgreSQL and SQLite.
- `apitame serve` over stdio and streamable HTTP, built on the MCP TypeScript SDK v2.
- `apitame inspect` with token estimates, comparisons and a `--max-tokens` CI budget.
- `apitame test` against a generated mock or the live API, with safety checks.
- `apitame add-to` for Claude Code, Codex, Cursor and VS Code, including skill installation.
- Read-only mode by default, write allowlist, confirmation through MCP elicitation or one-time tokens, and dry run for every write.
- Task-level tool grouping with `search_operations` and `call_operation` for the long tail.
- SQL guard with a database-accurate lexer, a SQL parser and database-level read-only enforcement; named queries with bound parameters.
- Bearer, API key, basic and OAuth2 client credentials auth from environment variables, with redaction of secrets in all output.
- Deterministic skill generation, also served through the MCP Skills extension.
- Examples: Petstore, a GitHub API subset and a PostgreSQL shop with Docker Compose.

[Unreleased]: https://github.com/albert-canfield/apitame/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/albert-canfield/apitame/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/albert-canfield/apitame/releases/tag/v0.1.0
