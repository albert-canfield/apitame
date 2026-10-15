# Safety model

apitame sits between an agent and something that can be damaged: a production API or a database. This page explains what it enforces, how, and where its protection ends.

The short version: **reads run, writes are refused unless you opt in operation by operation, destructive writes need a human, and secrets never reach the agent.**

## Threat model

apitame assumes that:

- The agent can be wrong. It may pick the wrong operation, invent arguments, or retry something destructive.
- The agent can be manipulated. Content returned by an API or stored in a database can contain instructions (prompt injection) that try to make the agent call something it should not.
- The person running apitame controls `apitame.config.yaml` and the environment, and chose the OpenAPI spec. The config file is trusted, and the spec is trusted to describe the API (which operations exist and how they are classified, see the end of this page). Tool arguments, API responses and database contents are not trusted.

It does not assume that the MCP client asks the user before every tool call. Many people run agents with automatic approval, so every rule below is enforced inside apitame, not left to the client.

## OpenAPI sources

### Access levels

Every operation gets one of three access levels when the spec is loaded:

| Access | Rule |
| --- | --- |
| `read` | GET, HEAD and OPTIONS. |
| `write` | Any other method. |
| `destructive` | DELETE, and any write whose id, summary or path contains delete, remove, destroy, purge, drop, truncate, wipe, erase, reset, revoke, terminate, cancel, bulk, batch or overwrite. |

You can override the classification:

- `writes.treatAsRead: [searchInvoices]` for POST endpoints that only read (search, query, preview).
- `writes.destructive: [archiveProject]` for writes that are worse than they look.
- `x-apitame-access: read | write | destructive` on the operation in the spec.

`treatAsRead` and `destructive` accept the same `*` patterns as `writes.allow` (`archive*`).

Classification never downgrades on its own. A POST named `searchSomething` is still a write until you say otherwise; `init` lists such operations in a comment so you can decide.

### Modes and the allowlist

```yaml
mode: read-only          # default
writes:
  allow: []              # operation ids, wildcards allowed: "create*", "*"
  confirm: []            # writes that also need confirmation
```

The decision is made in one place (`src/safety/policy.ts`) for every path into the API:

1. Reads always run.
2. In `read-only` mode every write is blocked, even if `writes.allow` contains `"*"`.
3. In `read-write` mode a write runs only if its id matches `writes.allow`.
4. A write that runs needs confirmation if it is destructive or matches `writes.confirm`.

Blocked operations are not listed in any tool, so they cost no tokens. If the agent still asks for one through `call_operation`, it gets a refusal that explains how a human can enable it. `search_operations` shows blocked operations with their status, so the agent can tell the user what exists.

### Confirmation

Confirmation is enforced by the server, not requested politely in a description.

- **Elicitation (preferred).** When the MCP client supports elicitation, apitame shows the human a form with a preview of the exact request and an approve checkbox. How the form travels depends on the protocol version the client speaks (see [Protocol eras](#protocol-eras) below). Declining or cancelling stops the call, and so does a prompt that fails or is not answered: once the client has said it can ask the human, apitame never falls back to a token the agent could send back on its own.
- **One-time token (fallback).** Otherwise the first call returns `CONFIRMATION REQUIRED` with a preview and a token. The agent must show the preview to the user and call again with the same arguments plus `"confirm": "<token>"`. Tokens are random, bound to the operation and a hash of the exact arguments, expire after `confirmation.ttlSeconds` (default 300), and work once. A token used with different arguments is rejected and burned.

`confirmation.method` chooses the behavior: `auto` (elicitation if available, else token), `elicitation` (refuse if the client cannot elicit), or `token`. It works the same in both protocol eras.

#### Protocol eras

MCP clients speak one of two protocol eras, and apitame serves both on every transport. Over stdio the client's first message decides for the whole connection; over HTTP each request says which era it belongs to. `--log-level debug` logs the era of each stdio connection and HTTP request.

- **2025-era clients** (protocol 2025-11-25 and earlier, started with `initialize`). apitame sends the form in the middle of the tool call (`elicitation/create`) and waits up to 5 minutes for the answer. This needs a connection that stays open: stdio (how Claude Code, Codex, Cursor, VS Code and Gemini CLI run apitame) or HTTP with `serve --transport http --sessions`. Over the default stateless HTTP transport these clients get the token flow.
- **Clients on protocol 2026-07-28.** This version has no requests from server to client. Instead, the first call returns the form as an input-required result together with a one-time approval id (`requestState`). The client shows the form, then calls the tool again with the same arguments, the answer and the approval id (multi round-trip input). The call runs only if the id is known, unused and unexpired, was issued for the same operation (through whichever tool), the same arguments and the same OAuth client and user, and the box came back checked. An answer sent back without an approval id never runs anything: the human is asked again. Because the question and the answer travel in two ordinary requests, this works over every transport, stateless HTTP included, and `--sessions` makes no difference.

| Transport | 2025-era clients | 2026-07-28 clients |
| --- | --- | --- |
| stdio | elicitation | elicitation, in two rounds |
| HTTP (stateless, the default) | token flow | elicitation, in two rounds |
| HTTP with `--sessions` | elicitation | elicitation, in two rounds (served without a session) |

A 2026-07-28 client that does not declare form elicitation gets the token flow under `auto` and a refusal under `elicitation`, exactly like a 2025-era client without elicitation.

What happens to an approval id on the second round:

- **Used up, with nothing sent**: an answer that is not an approval (a decline, a cancel, an unchecked box, or anything other than `approve: true`), other arguments, another operation or another OAuth user, and an id that expired. Using the same id again is refused too.
- **Not looked at, so it stays usable once until it expires**: a second round that stops before the approval is checked. That includes a dry run (`"dryRun": true` shows the request and sends nothing), invalid arguments, an operation that is blocked, and a call refused by the write rate limit. Nothing is sent in any of these cases.

Approval ids are random (256 bits), expire after `confirmation.ttlSeconds` like tokens, and are kept in a store of their own: an approval id never works as a `confirm` token, and a token never works as an approval id. They are not signed. Approvals in flight live in the memory of the apitame process that asked, like confirm tokens: behind a load balancer the second round must reach the same process (otherwise it is refused as unknown, with nothing sent), and a restart or a `--watch` reload forgets them.

The write rate limit is checked before the human is asked, in both eras, so a call that is already over the limit never asks and never uses up an approval. The check does not reserve a slot. When calls run at the same time, the limit can fill up while the human answers (for SQL write queries, also while apitame counts the rows the preview shows): the approved call is then refused by the rate limit after all, nothing is sent, and the approval is spent.

#### What an approval proves

Elicitation proves that the MCP client answered, not that a human did. The client application is meant to show the form to the human and never to the agent, and apitame cannot check that it did. Anything that can talk to apitame directly can answer the form itself, in both protocol eras: on protocol 2026-07-28 that takes two ordinary requests.

So an approval means something only when the agent cannot reach apitame on its own:

- **stdio**: the client starts apitame and is the only one connected to it. This is how Claude Code, Codex, Cursor, VS Code and Gemini CLI run it.
- **HTTP with authentication**: `APITAME_HTTP_TOKEN` or an OAuth client whose credentials the client holds and the agent does not, on a port the agent's sandbox cannot reach.

Over HTTP without authentication, any local process that can reach the port, an agent's shell included, can call the tools and approve destructive operations itself. apitame logs a warning at startup when it serves HTTP without authentication and some operation asks for confirmation. Under `confirmation.method: elicitation`, it also refuses approvals there, in both protocol eras and before anyone is asked: it answers as for a client that cannot elicit, says why, and audits `declined` with the reason `unauthenticated HTTP`. Under `auto` and `token` nothing changes, apart from the warning.

The token flow guarantees less still: an agent that ignores its instructions can send the token back without asking anyone. It guarantees that the human-readable preview reaches the conversation and that the second call is identical to what was previewed. When a human decision matters, serve over stdio or authenticated HTTP, use a client that supports elicitation, set `confirmation.method: elicitation`, and consider keeping your client's own per-call approval on for write tools (apitame marks them with `destructiveHint` and `readOnlyHint` annotations).

### Dry run

Every tool that can write accepts `"dryRun": true`. For HTTP operations the result is the exact method, URL, headers and body that would be sent, with credentials hidden and nothing sent. Dry runs do not need confirmation.

`dryRun` must be `true` or `false` (the strings `"true"` and `"false"` are accepted too); any other value, `null` included, is refused, so a preview is never sent by mistake. `dryRun` and `confirm` always mean what they say here: if an API has its own parameter with one of these names, a single-operation tool exposes it as `api_dryRun` or `api_confirm`.

A call that would exceed `limits.maxWritesPerMinute` is refused before the human is asked, so a rate limit never uses up an approval.

### Validation and limits

- Arguments are validated against the operation's JSON Schema before anything is sent. Unknown parameters are rejected (they are usually typos), and obvious type mismatches such as `"42"` for an integer are coerced.
- `limits.timeoutMs` (default 15 s) aborts slow requests. It covers the whole exchange: every redirect, a retry after a token refresh, and reading the response.
- `limits.maxResponseBytes` (default 50 KB) caps what goes back to the agent. JSON arrays are trimmed to the number of items that fit, with a note such as "showing 37 of 500 items", so the agent gets valid data and knows to paginate.

### Outgoing requests

- Path parameters are percent-encoded, and the values `.` and `..` are refused: URL parsing would resolve them and turn `/repos/{owner}/{repo}` into a different endpoint. The final URL must also stay under the base URL's path.
- Redirects are followed manually, at most five hops, and only to `http` or `https`. Credentials and custom headers are sent only to the API's own origin; a redirect to another host (for example a download URL on a CDN) is followed with a bare request, so an API key is never handed to a third party. Once a chain has left the origin it never gets credentials back, even if a later hop returns to the API.
- A write is never resent to another place: a 307 or 308 redirect (which repeats the method and body) is only followed when the target stays under the base URL. 301, 302 and 303 after a write become a plain GET, as in browsers.
- Object query parameters with `explode` (each key becomes its own query parameter) only accept the keys their schema lists, unless the schema allows additional properties, so an agent cannot add parameters such as `_method=DELETE` that some frameworks honor.
- File uploads take content inline (base64 or text) and never a local path, so an agent cannot be talked into uploading files from the machine. Total upload size is capped by `limits.maxUploadBytes`.
- Binary responses (images, PDFs, archives and similar, but not `+json` or `+xml` types such as `application/vnd.api+json`) are described (`{"binary": true, "contentType", "bytes"}`) instead of being returned to the agent.

## SQL sources

### The `query` tool

Free-form SQL passes four independent layers. Each one would stop the common attacks on its own; together they cover each other's blind spots.

1. **Lexer.** `src/sources/sql/lexer.ts` tokenizes the query with the database's real rules: standard strings where a backslash is just a character, PostgreSQL `E''` strings where it is an escape, dollar quoting, nested block comments in PostgreSQL but not in SQLite, SQLite `[brackets]` and backticks. On that token stream it requires exactly one statement, starting with SELECT, WITH, VALUES or a parenthesis, and refuses write keywords (INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, TRUNCATE, GRANT, COPY, CALL, COMMIT, ATTACH, PRAGMA, INTO and others), side-effect functions, and catalogs that hold credentials or other sessions' statements (`pg_authid`, `pg_shadow`, `pg_user_mappings`, `pg_stat_activity`, `pg_stat_statements`, `user_mapping_options`, MySQL's `processlist` and others).
2. **Parser.** `node-sql-parser` must read the query as exactly one SELECT, with no `SELECT INTO`, no `FOR UPDATE` or `FOR SHARE`, and no denied functions or tables anywhere in the tree. If the parser cannot read the query, it is refused. Table allow and deny lists from the config are checked against the parsed table references. CTE names are resolved per scope, as the database does, so a CTE can never hide a real table of the same name.
3. **Database.**
   - PostgreSQL: `BEGIN TRANSACTION READ ONLY`, `SET LOCAL statement_timeout`, `SET LOCAL standard_conforming_strings = on`, then `DECLARE ... CURSOR FOR <query>` sent through the extended query protocol, which refuses more than one statement, and `FETCH` of at most `rowLimit + 1` rows. The transaction is always rolled back. A cursor also refuses data-modifying CTEs.
   - MySQL: `START TRANSACTION READ ONLY`, `SET SESSION max_execution_time` (or `max_statement_time` on MariaDB) and `sql_select_limit`, with multi-statement queries disabled in the protocol. Its lexer also refuses `/*! */` executable comments, which MySQL runs.
   - SQLite: a connection opened with `readonly: true` and `PRAGMA query_only = ON`; each prepared statement must report `reader` and `readonly`; `prepare` refuses multiple statements. Queries run in a worker thread that is terminated when `timeoutMs` passes.
4. **Role.** The database role you connect with. See [sql.md](sql.md#a-read-only-role) for a read-only role in a few lines. This is the one layer that does not depend on apitame at all.

Why both a lexer and a parser? Because they can disagree with the database. For example, PostgreSQL treats `\` inside a standard string as a normal character, so

```sql
SELECT '\'; DELETE FROM orders; --'
```

is a SELECT of the string `\` followed by a DELETE. A parser that treats `\'` as an escaped quote sees a single harmless SELECT. apitame's lexer follows PostgreSQL, sees two statements and refuses; even if it did not, the extended protocol and the read-only transaction would. Both this case and the `COMMIT; DROP SCHEMA public CASCADE;` escape reported against the archived reference Postgres server are in the test suite.

### Named queries

Named queries in `sql.queries` are written by you, not the agent, and are exposed as their own tools with typed parameters. Parameter values are always bound by the driver, never interpolated into SQL.

- Read queries go through the same lexer and parser checks when the server starts. If the parser cannot read a query you wrote, apitame still serves it (with a warning) because the lexer and database layers still apply.
- Write queries (`write: true`) are hidden unless `mode: read-write` and the query name is in `writes.allow`. DELETE, DROP, TRUNCATE, ALTER, MERGE and UPDATE without WHERE are destructive and always need confirmation. The confirmation preview includes the number of rows the statement would affect right now, measured in a rolled-back transaction. On MySQL that measurement only runs when every table involved is transactional (InnoDB or NDB) and has no triggers, since a rollback cannot undo changes to MyISAM or MEMORY tables. `dryRun: true` reports the same number without changing anything; as for HTTP operations, anything but `true` or `false` is refused. Named query parameters cannot be called `dryRun` or `confirm`, and are bound with their declared types after validation (`"42"` becomes 42 for an integer, `0` becomes `"0"` for a string). `writes.destructive` patterns and the write rate limit apply as for HTTP operations.

### Limits

`limits.rowLimit` (default 200) caps rows per result and the agent can only ask for fewer. `limits.maxResponseBytes` caps every result, `list_tables` and `describe_table` included. `limits.timeoutMs` cancels slow queries on the server (PostgreSQL `statement_timeout`) and on the client.

## Rate limits

An agent stuck in a loop can call the same tool hundreds of times. Two per-server limits stop that, for both OpenAPI and SQL sources:

| Setting | Default | Counts |
| --- | --- | --- |
| `limits.maxCallsPerMinute` | 120 | every tool call |
| `limits.maxWritesPerMinute` | 20 | writes that are about to be sent (after dry run and confirmation) |

`limits.perTool` adds limits for individual tools, for endpoints the API itself limits more strictly:

```yaml
limits:
  perTool:
    search: 10          # GitHub's search API allows about 30 requests per minute
    call_operation: 30
```

The window slides over the last 60 seconds. A call over the limit is refused with the number of seconds to wait, and nothing is sent. `0` turns a limit off.

The limits are per server, not per user. In HTTP mode every client shares them, and that stays true with `http.oauth`: one signed-in user whose agent loops can use up the budget for everyone until the window moves on. Give heavy users their own server if that matters.

## Audit log

```yaml
audit:
  file: ./apitame-audit.jsonl   # relative to the config file; unset means no audit file
  include: writes               # or all
```

With a file set, apitame appends one JSON object per line:

```json
{"time":"2026-10-14T01:30:00.000Z","server":"github","tool":"issues","operation":"issues/update","access":"write","outcome":"sent","status":200,"durationMs":312,"args":{"owner":"octocat","repo":"hello-world","issue_number":12,"body":{"state":"closed"}}}
```

- `include: writes` records every write attempt, whatever happened to it: `blocked`, `dry-run`, `confirmation-requested`, `declined`, `approval-refused`, `rate-limited`, `sent` or `error`. Refused SQL queries are always recorded, because a refused DELETE is worth knowing about.
- `declined` means the human did not approve, or that apitame could not ask under `confirmation.method: elicitation` (with the reason `unauthenticated HTTP` when that is because HTTP runs without authentication). `approval-refused` means a 2026-07-28 approval id was refused, whatever the answer said, with the `reason`: `unknown` (never issued, or changed), `used` (sent again), `expired`, or `mismatch` (other arguments, another operation or another user). A forged or replayed approval therefore never looks like a human decision.
- `include: all` records reads too.
- Arguments go through the redactor and are capped at 2,000 characters. The file is created with owner-only permissions (`0600`).
- Over HTTP with `http.oauth`, each entry also names the token's client and subject (`"client"`, `"subject"`), each when the token carries it, so you can tell which user's agent made the call.
- If the file cannot be written, apitame logs one error and keeps serving; tool calls never fail because of the audit log.

## Secrets

- Auth secrets must be `${ENV_VAR}` references. A literal secret in the config is a validation error.
- Values are read from the process environment, or from a `.env` file next to the config (existing variables are never overwritten).
- Every secret value, its URL-encoded and query-string forms, and derived values (Basic auth headers, OAuth tokens as they are issued) is registered with a redactor. The redactor runs over every tool result, error message, log line and dry-run preview.
- Anything read from an environment variable for `auth`, `source.baseUrl` or `source.headers` counts as a secret, and so does each variable inside a longer value: with `value: "SSWS ${OKTA_TOKEN}"` or `baseUrl: https://api.telegram.org/bot${BOT_TOKEN}`, the bare token is hidden too, wherever it shows up. Keep values you want visible (such as a plain base URL) literal in the config.
- It also masks credential shapes it was never told about: `Bearer ...`, `Basic ...`, `Authorization: ...` pairs, passwords inside URLs, and JSON keys such as `password`, `access_token` or `client_secret` (whatever their value type). Object keys are redacted too.
- Responses are redacted before they are trimmed to `limits.maxResponseBytes`, so a cut can never leave part of a secret behind.
- Sensitive headers (`Authorization`, `Cookie`, `X-API-Key` and your configured API key header) and every static header from `source.headers` are hidden entirely in previews.
- Errors are rethrown without the original error attached, so an unredacted message cannot leak through an error chain.

The test suite checks that a bearer token echoed back by an API, OAuth client secrets in token endpoint errors, database passwords in connection errors, secrets that straddle the response size cut and tokens inside base URLs never reach the agent.

## HTTP transport

`apitame serve --transport http` is streamable HTTP on `/mcp`, stateless unless `--sessions` is given. Each request is routed by protocol era with the MCP SDK's own classification: 2025-era requests go to the stateless or session wiring, and 2026-07-28 requests to the SDK's handler for that version, which serves each request with a fresh server and never uses a session. Every check below runs before that routing, so it applies to both eras.

- It binds to `127.0.0.1` by default and checks the `Host` and `Origin` headers, which blocks DNS rebinding from web pages.
- It refuses to listen on any other interface unless `APITAME_HTTP_TOKEN` or `http.oauth` is set. With `APITAME_HTTP_TOKEN`, every request needs `Authorization: Bearer <token>` (compared in constant time).
- With `http.oauth`, every request needs an OAuth access token from the configured authorization server: a JWT whose signature checks out against the server's published keys, whose `iss`, `aud` and `exp` match, and which carries the required scopes (and, with `clients`, was issued to one of those clients). Only asymmetric algorithms are accepted (`none` and HMAC are refused), and a key is only used with the algorithm family, curve and uses it was published for, so a token cannot pick an algorithm that reads the key differently. ID tokens and refresh tokens signed by the same server are refused, so a token that only proves a sign-in to some app is not accepted as access. Unknown key ids refresh the key set at most once a minute, so made-up tokens cannot turn apitame into a request amplifier against the authorization server. Metadata and keys are fetched without following redirects and capped at 1 MB. Values from a refused token are never written raw into logs or errors. apitame never issues tokens, and never passes a client's token on to the API or database: those are called with the credentials from the config. See [clients.md](clients.md#oauth).
- `audiences` alone would accept any token the authorization server issues for that audience, which is often shared by every app it serves, so the config needs `scopes` or `clients` next to it. With `scopes` empty, apitame warns at startup.
- Tokens are checked locally, so revoking one at the authorization server takes effect when it expires. A stream (or any long response) is closed when the token that opened it expires; the client then needs a fresh token. Keep access token lifetimes short.
- The two cannot be combined: one shared token next to per-user tokens would quietly weaken the per-user setup, so apitame refuses to start with both.
- With `--sessions`, session ids are random UUIDs and only identify a conversation: the Host, Origin and token checks still apply to every request. With OAuth, a session also belongs to the client and subject of the token that started it, so a session id is useless with another user's token, and a token that names neither cannot start one. Unknown ids get a 404, and idle sessions are closed.
- Only an `initialize` request can start a session, and that is checked before the session table is touched: anything else without a session id gets a 400. With OAuth, each user (client and subject) holds at most 10 sessions, and room is only ever made among that user's own idle sessions, so one user cannot close or crowd out anyone else's.
- Request bodies are read once, up to 4 MB. With `--sessions`, a request without a session id (one that starts a session, and every 2026-07-28 request) may carry at most 1 MB, refused from its `Content-Length` before anything is read.
- `subscriptions/listen` streams, which 2026-07-28 clients keep open to hear about list changes, are limited like sessions: at most 100 open at once, and with OAuth at most 10 per user, so one user cannot lock everyone else out.
- Without authentication (possible on loopback only), any local process that can reach the port can call the tools and answer approval prompts itself. See [What an approval proves](#what-an-approval-proves).

## What apitame does not protect against

- **Data the credentials can read.** Read-only access is still access. An agent that can read customer records can repeat them. Scope the API token and the database role to what the agent needs, and use `sql.tables.allow` or `deny`.
- **Prompt injection in data.** apitame does not filter what an API or table returns. If a record says "ignore previous instructions", the agent sees it. The safety layers make sure such instructions cannot trigger writes you did not allow.
- **Side effects of reads.** Some APIs change state on GET (counters, "mark as read"). apitame classifies by HTTP method; mark such operations with `writes.destructive` or `x-apitame-access`.
- **Per-user permissions and limits.** With `http.oauth`, every user with a valid token gets the same tools, and apitame calls the API or database with the same credentials for all of them. Required scopes decide who may connect, not which operations each user may run. Rate limits are shared too (see [Rate limits](#rate-limits)). Run one server per access level if users need different ones.
- **A client that auto-approves and an agent that self-confirms.** See the token flow note above. Use elicitation or client-side approval when it matters.
- **Your config file.** Whoever can edit `apitame.config.yaml` can allow anything. Review changes to it like code.
- **The spec.** The OpenAPI document decides which operations exist and can mark them with `x-apitame-access` (for example `read` on an endpoint that deletes). A spec loaded from a URL is trusted like the config: point `source.spec` at a URL you control or pin to a version, or keep a reviewed copy next to the config.

Found a gap? Please report it privately: see [SECURITY.md](../SECURITY.md).
