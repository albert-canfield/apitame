# Safety model

apitame sits between an agent and something that can be damaged: a production API or a database. This page explains what it enforces, how, and where its protection ends.

The short version: **reads run, writes are refused unless you opt in operation by operation, destructive writes need a human, and secrets never reach the agent.**

## Threat model

apitame assumes that:

- The agent can be wrong. It may pick the wrong operation, invent arguments, or retry something destructive.
- The agent can be manipulated. Content returned by an API or stored in a database can contain instructions (prompt injection) that try to make the agent call something it should not.
- The person running apitame controls `apitame.config.yaml` and the environment. The config file is trusted; tool arguments are not.

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

- **Elicitation (preferred).** When the MCP client supports elicitation, apitame sends a form to the human with a preview of the exact request and an approve checkbox. Declining or cancelling stops the call.
- **One-time token (fallback).** Otherwise the first call returns `CONFIRMATION REQUIRED` with a preview and a token. The agent must show the preview to the user and call again with the same arguments plus `"confirm": "<token>"`. Tokens are random, bound to the operation and a hash of the exact arguments, expire after `confirmation.ttlSeconds` (default 300), and work once. A token used with different arguments is rejected and burned.

Elicitation needs a stateful connection, so it is used over stdio (how Claude Code, Codex, Cursor, VS Code and Gemini CLI run apitame). The streamable HTTP transport is stateless and uses the token flow.

`confirmation.method` chooses the behavior: `auto` (elicitation if available, else token), `elicitation` (refuse if the client cannot elicit), or `token`.

Be clear about the limit of the token flow: an agent that ignores its instructions could send the token back without asking. The token flow guarantees that the human-readable preview reaches the conversation and that the second call is identical to what was previewed. If you need a hard guarantee that a human approved, use a client with elicitation support and set `confirmation.method: elicitation`, or keep your client's per-call approval on for write tools (apitame marks them with `destructiveHint` and `readOnlyHint` annotations).

### Dry run

Every tool that can write accepts `"dryRun": true`. For HTTP operations the result is the exact method, URL, headers and body that would be sent, with credentials hidden and nothing sent. Dry runs do not need confirmation.

### Validation and limits

- Arguments are validated against the operation's JSON Schema before anything is sent. Unknown parameters are rejected (they are usually typos), and obvious type mismatches such as `"42"` for an integer are coerced.
- `limits.timeoutMs` (default 15 s) aborts slow requests.
- `limits.maxResponseBytes` (default 50 KB) caps what goes back to the agent. JSON arrays are trimmed to the number of items that fit, with a note such as "showing 37 of 500 items", so the agent gets valid data and knows to paginate.

### Outgoing requests

- Path parameters are percent-encoded, and the values `.` and `..` are refused: URL parsing would resolve them and turn `/repos/{owner}/{repo}` into a different endpoint. The final URL must also stay under the base URL's path.
- Redirects are followed manually, at most five hops, and only to `http` or `https`. Credentials and custom headers are sent only to the API's own origin; a redirect to another host (for example a download URL on a CDN) is followed with a bare request, so an API key is never handed to a third party.
- File uploads take content inline (base64 or text) and never a local path, so an agent cannot be talked into uploading files from the machine. Total upload size is capped by `limits.maxUploadBytes`.
- Binary responses (images, PDFs, archives and similar) are described (`{"binary": true, "contentType", "bytes"}`) instead of being returned to the agent.

## SQL sources

### The `query` tool

Free-form SQL passes four independent layers. Each one would stop the common attacks on its own; together they cover each other's blind spots.

1. **Lexer.** `src/sources/sql/lexer.ts` tokenizes the query with the database's real rules: standard strings where a backslash is just a character, PostgreSQL `E''` strings where it is an escape, dollar quoting, nested block comments in PostgreSQL but not in SQLite, SQLite `[brackets]` and backticks. On that token stream it requires exactly one statement, starting with SELECT, WITH, VALUES or a parenthesis, and refuses write keywords (INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, TRUNCATE, GRANT, COPY, CALL, COMMIT, ATTACH, PRAGMA, INTO and others), side-effect functions, and catalogs that hold credentials or other sessions' statements (`pg_authid`, `pg_shadow`, `pg_user_mappings`, `pg_stat_activity`, `pg_stat_statements`, `user_mapping_options`, MySQL's `processlist` and others).
2. **Parser.** `node-sql-parser` must read the query as exactly one SELECT, with no `SELECT INTO`, no `FOR UPDATE` or `FOR SHARE`, and no denied functions or tables anywhere in the tree. If the parser cannot read the query, it is refused. Table allow and deny lists from the config are checked against the parsed table references, ignoring CTE names.
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
- Write queries (`write: true`) are hidden unless `mode: read-write` and the query name is in `writes.allow`. DELETE, DROP, TRUNCATE, ALTER, MERGE and UPDATE without WHERE are destructive and always need confirmation. The confirmation preview includes the number of rows the statement would affect right now, measured in a rolled-back transaction. `dryRun: true` reports the same number without changing anything.

### Limits

`limits.rowLimit` (default 200) caps rows per result and the agent can only ask for fewer. `limits.timeoutMs` cancels slow queries on the server (PostgreSQL `statement_timeout`) and on the client.

## Rate limits

An agent stuck in a loop can call the same tool hundreds of times. Two per-server limits stop that, for both OpenAPI and SQL sources:

| Setting | Default | Counts |
| --- | --- | --- |
| `limits.maxCallsPerMinute` | 120 | every tool call |
| `limits.maxWritesPerMinute` | 20 | writes that are about to be sent (after dry run and confirmation) |

The window slides over the last 60 seconds. A call over the limit is refused with the number of seconds to wait, and nothing is sent. `0` turns a limit off. In HTTP mode the limits are shared by every client of the server.

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

- `include: writes` records every write attempt, whatever happened to it: `blocked`, `dry-run`, `confirmation-requested`, `declined`, `rate-limited`, `sent` or `error`. Refused SQL queries are always recorded, because a refused DELETE is worth knowing about.
- `include: all` records reads too.
- Arguments go through the redactor and are capped at 2,000 characters. The file is created with owner-only permissions (`0600`).
- If the file cannot be written, apitame logs one error and keeps serving; tool calls never fail because of the audit log.

## Secrets

- Auth secrets must be `${ENV_VAR}` references. A literal secret in the config is a validation error.
- Values are read from the process environment, or from a `.env` file next to the config (existing variables are never overwritten).
- Every secret value, its URL-encoded form and derived values (Basic auth headers, OAuth tokens as they are issued) is registered with a redactor. The redactor runs over every tool result, error message, log line and dry-run preview.
- It also masks credential shapes it was never told about: `Bearer ...`, `Basic ...`, passwords inside URLs, and JSON keys such as `password`, `access_token` or `client_secret`.
- Sensitive headers (`Authorization`, `Cookie`, `X-API-Key` and your configured API key header) are hidden entirely in previews.
- Errors are rethrown without the original error attached, so an unredacted message cannot leak through an error chain.

The test suite checks that a bearer token echoed back by an API, OAuth client secrets in token endpoint errors and database passwords in connection errors never reach the agent.

## HTTP transport

`apitame serve --transport http` is stateless streamable HTTP on `/mcp`.

- It binds to `127.0.0.1` by default and checks the `Host` and `Origin` headers, which blocks DNS rebinding from web pages.
- It refuses to listen on any other interface unless `APITAME_HTTP_TOKEN` is set, and then requires `Authorization: Bearer <token>` (compared in constant time) on every request.

## What apitame does not protect against

- **Data the credentials can read.** Read-only access is still access. An agent that can read customer records can repeat them. Scope the API token and the database role to what the agent needs, and use `sql.tables.allow` or `deny`.
- **Prompt injection in data.** apitame does not filter what an API or table returns. If a record says "ignore previous instructions", the agent sees it. The safety layers make sure such instructions cannot trigger writes you did not allow.
- **Side effects of reads.** Some APIs change state on GET (counters, "mark as read"). apitame classifies by HTTP method; mark such operations with `writes.destructive` or `x-apitame-access`.
- **A client that auto-approves and an agent that self-confirms.** See the token flow note above. Use elicitation or client-side approval when it matters.
- **Your config file.** Whoever can edit `apitame.config.yaml` can allow anything. Review changes to it like code.

Found a gap? Please report it privately: see [SECURITY.md](../SECURITY.md).
