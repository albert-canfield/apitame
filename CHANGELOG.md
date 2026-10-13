# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
