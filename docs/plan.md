# Plan

## Goal

One command turns an OpenAPI spec, a REST API or a SQL database into a safe MCP server plus agent skills, ready for Claude Code, Codex, Cursor and other MCP clients. Quality, a clear README and a smooth first run matter as much as features.

## Scope of v0.1

**Inputs:** OpenAPI 3.0 and 3.1 (JSON or YAML, file or URL, with spec discovery from a base URL), PostgreSQL and SQLite.

**Outputs:** an MCP server (stdio and streamable HTTP), generated skills, and an editable `apitame.config.yaml`.

**Commands:** `init`, `serve`, `inspect`, `test`, `add-to`.

**Non-goals for v0.1:** GUI, GraphQL, hosted service, MongoDB, code generation into other languages.

## Architecture

See [architecture.md](architecture.md) for modules and request flows, and [decisions.md](decisions.md) for the reasoning. In brief:

- **Sources** normalize an OpenAPI document or a database into operations or tables.
- **Runtimes** build the tool list from the source and the config, and execute calls.
- **Safety** decides what may run (`policy`), gets human approval (`confirm`), and removes secrets (`redact`).
- **Server** wires a runtime into the MCP SDK v2 low-level `Server`, over stdio or HTTP, and serves skills through the MCP Skills extension.
- **Generator** writes the commented config and deterministic skills.
- **CLI** is a thin layer over all of the above.

## Milestones

| Milestone | Content | Status |
| --- | --- | --- |
| M1 | Research ([landscape.md](landscape.md)), name check, this plan | Done. `apitame` was free on npm and GitHub on 13 October 2026. |
| M2 | OpenAPI to read-only MCP server: loading, grouping, long tail, auth, stdio and HTTP | Done |
| M3 | SQL sources: PostgreSQL and SQLite, guard, drivers, named queries | Done |
| M4 | Skill generation, skills over MCP, `inspect` token cost and CI budget | Done |
| M5 | Write mode: allowlist, confirmation (elicitation and token), dry run, safety tests | Done |
| M6 | README, examples, demo, documentation, v0.1.0 release notes | Done. v0.1.0 published to npm on 14 October 2026. |

## Quality bar (v0.1)

- [x] Tests prove that writes are blocked in read-only mode and that destructive operations require confirmation (OpenAPI and SQL, unit and integration).
- [x] SQL guard tests include injection attempts, multi-statement tricks and parser/database differentials.
- [x] Secret redaction is tested (echoed tokens, OAuth errors, database passwords).
- [x] CI: lint, typecheck and tests on Node 22 and 24 (and 20 until 0.2); build and smoke test of the packed CLI.
- [x] `npx apitame init examples/petstore/openapi.yaml && npx apitame serve` works on a clean machine (checked against the published package with an empty npm cache, and covered by the e2e tests and the CI smoke test).

## Release checklist

1. `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
2. `node scripts/render-demo.mjs` if CLI output changed; optionally record the GIF ([demo-script.md](demo-script.md)).
3. Update `CHANGELOG.md` and `docs/release-notes/`.
4. `npm pack --dry-run` and check the file list.
5. Maintainer approval, then tag `vX.Y.Z` and push the tag. The release workflow publishes to npm with provenance through npm trusted publishing (see [decisions.md](decisions.md#013-releases-use-npm-trusted-publishing)) and creates the GitHub release.

## After v0.1

- v0.2: multipart uploads (done), Swagger 2.0 import (done), response field selection (done), MySQL (done), audit log and rate limits (done), `doctor` (done).
- v0.3: OAuth 2.1 for HTTP (done), per-user permissions and rate limits (done), argument rules for writes (done), DuckDB (done), approvals with MCP protocol 2026-07-28 (done), Node 22.14 (done).
- Next: see the [open issues](https://github.com/albert-canfield/apitame/issues): tool-selection eval (#24), SQL Server and DuckDB (#27).
- Later: GraphQL.
