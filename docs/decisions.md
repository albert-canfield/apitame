# Design decisions

A running log of decisions and the reasons behind them. Newest last. Add an entry when you make a choice that someone would otherwise have to rediscover.

## 001. Safety is the headline, not tool count

**Context.** The landscape review ([landscape.md](landscape.md)) found that search-plus-call tool surfaces already exist in several projects, and that major clients now load tool schemas on demand. Read-only defaults, enforced confirmation and dry runs, together and in a local tool, were not found elsewhere.

**Decision.** Lead with safety: read-only by default, an explicit allowlist, server-enforced confirmation for destructive operations, and dry run on every write. Keep curated tools and token reporting, but present them honestly.

## 002. Node 20.12+ despite Node 20 being end of life

**Context.** Node 20 reached end of life on 30 April 2026. Some current dependency majors (commander 15, vitest 5, better-sqlite3 13) require Node 22.

**Decision.** Support Node 20.12+ for v0.1 because many machines still run it and `npx` users do not choose their Node version. Pin dependency majors that still support 20. CI runs on 20, 22 and 24. Plan to require Node 22 in a later minor release. Superseded by 016.

## 003. MCP TypeScript SDK v2 and the low-level `Server`

**Context.** SDK v2 (`@modelcontextprotocol/server`) is the stable line and implements the 2026-07-28 protocol; v1 is in maintenance. `McpServer.registerTool` expects Zod or Standard Schema inputs.

**Decision.** Use v2 with the low-level `Server` and `setRequestHandler('tools/list' | 'tools/call')`, passing generated JSON Schema unchanged. This keeps tool definitions identical to what `inspect` measures and avoids a lossy JSON Schema to Zod conversion.

## 004. Grouped tools take `{operation, params}`

**Context.** One tool per operation floods the context; a single generic tool hides what the API can do.

**Decision.** Group by tag (or first path segment), list each operation as a one-line signature in the tool description, and validate `params` server-side against the full operation schema. Invalid calls return the full schema, so the agent can correct itself in one round trip. Single-operation tools take their parameters directly.

## 005. SQL: lexer plus parser plus database, not parser alone

**Context.** A SQL parser that differs from the database in how it reads strings or comments can be bypassed. Example: `SELECT '\'; DELETE FROM t; --'` is one statement to `node-sql-parser` and two to PostgreSQL.

**Decision.** Three independent layers: a small lexer that follows each database's quoting rules (statement count, keywords, functions, catalogs), the parser (statement type, INTO, locks, tables), and database enforcement (PostgreSQL `READ ONLY` transaction, extended protocol, cursor, `statement_timeout`; SQLite read-only connection, `query_only`, per-statement read-only check, worker thread for timeouts). Anything the parser cannot read is refused for free-form queries.

## 006. SQLite in a worker thread

**Context.** `better-sqlite3` is synchronous and has no way to interrupt a running statement.

**Decision.** Run SQLite in a worker thread created from inline source (works from both the build and the TypeScript sources). On timeout the worker is terminated and a new one starts on the next call. `better-sqlite3` is an optional dependency so a failed native install never breaks the OpenAPI path.

## 007. Two ways to confirm

**Context.** MCP elicitation lets the server ask the human directly, but not every client supports it.

**Decision.** `confirmation.method: auto` uses elicitation when the client advertises it and falls back to a one-time token bound to the operation and a hash of the exact arguments. The limits of the token flow are documented in [safety.md](safety.md#confirmation).

## 008. Secrets only from the environment, redacted everywhere

**Decision.** The config schema refuses literal secrets. A single `Redactor` is shared by the runtime, auth providers and logger, and is applied to every tool result, error and log line. Errors that may contain secrets are rethrown without `cause`. The ESLint `preserve-caught-error` rule is disabled on those lines with a comment.

## 009. Token estimates without a tokenizer dependency

**Context.** Exact counts need model-specific tokenizers; shipping vocabularies adds megabytes to every `npx` run.

**Decision.** A calibrated heuristic in `src/tokens/estimate.ts`, tuned on real tool lists to land about 15% above OpenAI's o200k encoding, because other tokenizers tend to count more for the same JSON. Always labelled as an estimate.

## 010. Skills are deterministic

**Decision.** Skills are generated from the config and the source with fixed rules, not by a model, so they are reproducible, reviewable and produce clean diffs. They follow the Agent Skills format with the folder name equal to `name`, and are also served through the MCP Skills extension.

## 011. PostgreSQL tests use PGlite over the wire protocol

**Context.** CI and contributors should not need Docker to run the suite.

**Decision.** Integration tests start PGlite (PostgreSQL compiled to WebAssembly) behind `pglite-socket` and connect with the real `pg` driver. The Docker Compose example remains the way to try a full PostgreSQL server. PGlite does not enforce `statement_timeout`, so the driver also sets a client-side `query_timeout`, and pool connections carry a permanent error listener so a protocol hiccup can never crash the server.

## 012. Config files written by `add-to` are portable

**Decision.** When the config is inside the project, client configs reference it through the client's project variable (`${CLAUDE_PROJECT_DIR:-.}` for Claude Code, `${workspaceFolder}` for Cursor and VS Code) so they can be committed. Codex gets an absolute path because its config does not document interpolation. The launcher pins the minor version (for example `apitame@0.2`).

## 013. Releases use npm trusted publishing

**Context.** npm requires two-factor authentication to publish and is restricting tokens that bypass it. v0.1.0 was published manually with a short-lived token.

**Decision.** Releases run from `.github/workflows/release.yml` on a version tag, with npm trusted publishing (OIDC from GitHub Actions, npm 11.5.1 or later) and provenance. The goal is no long-lived npm token in the repository; until trusted publishing is configured on npmjs.com, the workflow falls back to a granular `NPM_TOKEN` secret, which should be deleted once it is. The workflow skips publishing when the version is already on npm and skips the GitHub release when it already exists, so a release can be finished by hand without breaking the workflow.

## 014. Bundle only the SQL parsers apitame needs

**Context.** `node-sql-parser` installs about 88 MB (every dialect plus source maps), while apitame uses three dialect builds of about 800 KB. It was most of what every `npx apitame` user downloaded, even for OpenAPI-only use.

**Decision.** Import the PostgreSQL, MySQL and SQLite builds statically and let the bundler include them (with `big-integer`), keep `node-sql-parser` as a development dependency, and load all SQL code lazily so OpenAPI users never parse it. Published builds have no source maps. License texts are shipped in `THIRD_PARTY_NOTICES.md`. Install size went from about 141 MB to 53 MB.

## 015. HTTP sessions are opt-in

**Context.** Elicitation lets the human approve a destructive call in the client, but the server must send a request in the middle of a tool call and receive the answer. Stateless HTTP builds a fresh server per request, which never sees `initialize` (so it does not know the client can elicit) and cannot receive the reply.

**Decision.** `serve --transport http --sessions` keeps one server per client, keyed by `Mcp-Session-Id`, with an idle timeout (30 minutes, counted only while no request or stream is open) and a cap (100, the oldest idle session makes room). Stateless stays the default: it is simpler to run behind load balancers and has no per-client memory. All sessions read the same live runtime, so `--watch` reloads and confirmation tokens work the same way in both modes.

## 016. Require Node 22 or later

**Context.** Node 20 reached end of life on 30 April 2026 (see 002). Supporting it held back dependency majors (commander 15, better-sqlite3 13, vitest 5) and cost workarounds: on Node 20 a timeout signal reachable only through `AbortSignal.any()` can be garbage collected and never fire, which hid a real bug until 0.2.0.

**Decision.** From 0.3.0, require Node.js 22 or later (`engines.node: ">=22.0.0"`). CI drops Node 20, `doctor` fails on older versions, and Dependabot no longer holds back majors that need Node 22. Contributed by @Enard52 in #48.

## 017. Node 22.14 is the floor, TypeScript 7 waits

**Context.** After 016, TypeScript 7 is the native compiler and has no JavaScript compiler API: `tsc --noEmit` passes, but typescript-eslint refuses to load ("typescript-eslint does not support TS 7.0") and the tsup declaration build fails (`Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')`). better-sqlite3 13 ships prebuilt Node-API 10 binaries while declaring `node: ">=22"`: on Node 22.0 to 22.13 opening a database crashes the process with a segmentation fault, so `apitame init` and `test` on a SQLite file exit with code 139 and no message. CI runs the latest Node 22 and cannot see this. commander 15 declares Node 22.12+.

**Decision.** Require Node.js 22.14 or later (released February 2025), which makes better-sqlite3 13 and commander 15 safe, and check it in `doctor`. Stay on TypeScript 5.9 and have Dependabot ignore its majors until typescript-eslint and tsup support 7. `@types/node` follows the minimum supported Node (22), so code cannot use APIs that Node 22 lacks.

## 018. HTTP auth through an external OAuth authorization server

**Context.** Over HTTP, apitame's only authentication was one static token (`APITAME_HTTP_TOKEN`) shared by every client. That is fine on one machine, but a team that shares one server cannot tell users apart, cut one person off without handing everyone a new token, or rely on its identity provider's sign-in and policies. The MCP authorization spec expects an MCP server to act as an OAuth 2.1 resource server, and MCP clients already know how to sign users in once a server points them to an authorization server.

**Decision.** apitame is a resource server only. With `http.oauth`, it publishes RFC 9728 protected resource metadata naming the configured issuer, answers requests without a valid token with a 401 that points to that document, and accepts JWT access tokens (RFC 9068) that it checks locally: signature against the issuer's JWKS (found through RFC 8414 or OpenID Connect discovery), `iss`, `aud`, `exp` and required scopes. Running an authorization server (login pages, client registration, consent, token storage) is a product of its own and better left to Keycloak, Auth0, Okta, Entra ID and the like. Verification uses `node:crypto` rather than a JWT library: with an allowlist of asymmetric algorithms and a check that each key is only used with the algorithm it was published for, it takes a few hundred lines and adds no dependency, and the bearer parsing and challenges come from the MCP SDK. Because tokens are checked locally, cutting someone off at the authorization server takes effect when their access token expires (streams are closed then too), so short token lifetimes matter. The static token stays for single-user setups and cannot be combined with OAuth. Opaque tokens (token introspection, RFC 7662) are left for later.

## 019. Approvals through multi round-trip input (protocol 2026-07-28)

**Context.** MCP protocol 2026-07-28 removed requests from server to client. A server that needs input answers the call with an input-required result, and the client retries with the answers (multi round-trip input). Every request also carries the client's capabilities, so a stateless server knows whether the client can show a form. apitame asked for approval with `elicitInput()` in the middle of a tool call, which 2026-07-28 clients cannot receive, and which over HTTP needed `--sessions`. The SDK (`@modelcontextprotocol/server` 2.3) only negotiates 2026-07-28 through its era-aware entries (`serveStdio`, `createMcpHandler`), not on a server connected to a transport by hand.

**Decision.** Serve both eras. stdio goes through `serveStdio` with a server factory. HTTP keeps every existing check (Host, Origin, static token, OAuth) in front, reads the body once, and routes with the SDK's `isLegacyRequest`: 2025-era requests to the existing stateless or session wiring, unchanged, and 2026-07-28 requests to a strict `createMcpHandler`. 2026-07-28 requests are stateless by design, with or without `--sessions`. 2025-era connections keep `elicitInput()`; the SDK's shim that could serve input-required results to them is turned off, because its failures skip the audit log and its timeout is 10 minutes.

On a 2026-07-28 request whose capabilities include form elicitation, the first call stores a random approval id (256 bits) and returns the same form as before, with the id as `requestState`. The id is one-time, expires after `confirmation.ttlSeconds`, and is bound to the operation, a hash of the exact arguments and the OAuth client and subject, so one user cannot spend another's approval. It lives in its own map next to the confirm tokens, so neither works as the other. The second call runs only if the id checks out and the box came back checked. A wrong or forged answer, changed arguments, another user, an expired or reused id and a decline are refused with nothing sent and use the id up; a second round that stops earlier (a dry run, invalid arguments, a blocked operation, the write rate limit) sends nothing and leaves the id usable once until it expires. Without form elicitation, `auto` falls back to the token flow and `elicitation` refuses, as for 2025-era clients. The write rate limit is checked before asking, without reserving a slot. The audit log keeps `confirmation-requested`, `declined` and `sent`, and records a refused approval id as `approval-refused` with the reason (`unknown`, `used`, `expired`, `mismatch`), so a forged or replayed id is never mistaken for a human decline.

Elicitation proves that the MCP client answered, not that a human did. That holds only when the agent cannot reach the server itself: over stdio, or over HTTP with a token or OAuth client the agent does not hold, on a port its sandbox cannot reach. Over HTTP without authentication, any local process can answer the form with two plain requests, so `serve` warns at startup when it runs that way and some operation asks for confirmation, and `confirmation.method: elicitation` refuses 2026-07-28 approvals there, which keeps that setting's meaning (before, stateless HTTP could not elicit at all). 2025-era sessions without authentication had the same weakness and keep their behavior; the warning covers them.

The id is not signed (`createRequestStateCodec` would need a key): it is only a lookup key into memory, which is enough in one process. Approvals in flight therefore live in the process that asked, like confirm tokens; several processes behind a load balancer need sticky routing, and a restart or reload forgets them. Over HTTP, `serve --watch` publishes list changes to an event bus that serves 2026-07-28 clients' `subscriptions/listen` streams, which are limited like sessions (100 in all, and 10 per OAuth user); over stdio the connection's server delivers them on those streams. `--log-level debug` logs the era of each stdio connection and HTTP request, so users can tell which protocol their client speaks.
