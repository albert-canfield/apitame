# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- MySQL and MariaDB sources: `list_tables`, `describe_table`, guarded `query` and named queries, with MySQL-accurate lexing (executable comments refused, `#` and `-- ` comments, backslash strings), read-only transactions, `max_execution_time`, `sql_select_limit` and server-side prepared statements.
- CI runs the SQL integration suite against real PostgreSQL 17 and MySQL 8.4 servers, in addition to PGlite and SQLite.

- Swagger 2.0 documents are converted to OpenAPI 3 in memory: servers, body and form parameters, `collectionFormat`, responses and security definitions.
- `add-to gemini` (`.gemini/settings.json`, skills in `.agents/skills/`) and `add-to claude-desktop` (absolute paths and `PATH` for desktop apps, skills packaged as `.zip` for upload).
- `apitame doctor`: checks Node, config, environment variables, whether `.env` is git-ignored, API or database connectivity and credentials, whether the database role could write, allowlist typos, stale skills and client configs.
- Rate limits: `limits.maxCallsPerMinute` (default 120) and `limits.maxWritesPerMinute` (default 20) stop runaway agent loops.
- Audit log: `audit.file` appends a redacted JSON Lines record of every write attempt and refused query (`include: all` adds reads).
- Response field selection: read tools accept `"fields": ["id", "items.name"]` (dot paths, arrays mapped) to return only what the agent needs. Applied before the response size cap.

### Security

- Path parameters can no longer be `.` or `..`, which URL parsing would resolve into a different endpoint. Built URLs must stay under the base path.
- Redirects are followed manually: credentials and custom headers are only sent to the API's own origin, never to a redirect target on another host.

### Changed

- Binary responses are described instead of returned as text.
- Requests send a `User-Agent: apitame/<version>` header (some APIs, such as GitHub's, require one).
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

[Unreleased]: https://github.com/albert-canfield/apitame/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/albert-canfield/apitame/releases/tag/v0.1.0
