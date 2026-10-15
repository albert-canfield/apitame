# Client setup

`npx apitame add-to <client>` prints the right configuration; add `--write` to write it into the current project and install the skills. This page shows what it produces and how to do it by hand.

In the examples the server is called `github` and the config sits at the project root. apitame reads secrets from the environment or from `.env` next to `apitame.config.yaml`, so none of these files contain credentials.

For a DuckDB source, the server needs the optional DuckDB driver next to apitame, and `add-to` adds it to every launcher: `"args": ["-y", "-p", "apitame@0.3", "-p", "@duckdb/node-api@1.5.6-r.1", "apitame", "serve", ...]` (the driver is pinned to the release apitame is tested with) instead of `["-y", "apitame@0.3", "serve", ...]`. See [DuckDB](sql.md#duckdb).

## Claude Code

Project scope, shared through git (`.mcp.json` at the project root):

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.3", "serve", "--config", "${CLAUDE_PROJECT_DIR:-.}/apitame.config.yaml"]
    }
  }
}
```

With the CLI:

```bash
claude mcp add --transport stdio --scope project github -- npx -y apitame@0.3 serve --config /abs/path/apitame.config.yaml
```

Skills: `.claude/skills/<name>/SKILL.md` for the project, or `~/.claude/skills/` for all projects. Claude Code asks you to approve project servers the first time.

## Codex

User scope (`~/.codex/config.toml`), or project scope (`.codex/config.toml`, read for trusted projects):

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "apitame@0.3", "serve", "--config", "/abs/path/apitame.config.yaml"]
```

With the CLI (writes the user config):

```bash
codex mcp add github -- npx -y apitame@0.3 serve --config /abs/path/apitame.config.yaml
```

Skills: `.agents/skills/` in the repository, or `~/.agents/skills/`.

## Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.3", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
    }
  }
}
```

`add-to cursor` also prints a `cursor://anysphere.cursor-deeplink/mcp/install?...` link that installs the server in one click. Skills: `.agents/skills/` (Cursor also reads `.cursor/skills/` and `.claude/skills/`).

## VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.3", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
    }
  }
}
```

Skills: `.agents/skills/`, `.github/skills/` or `.claude/skills/`.

## Gemini CLI

`.gemini/settings.json` in the project (or `~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "apitame@0.3", "serve", "--config", "/abs/path/apitame.config.yaml"]
    }
  }
}
```

Skills: `.agents/skills/`.

## Claude Desktop

Claude Desktop reads `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`; open it from Settings, Developer, Edit Config). It starts servers from an unknown folder with a minimal `PATH`, so `add-to claude-desktop` writes absolute paths and adds the folder of your `npx` to `PATH`:

```json
{
  "mcpServers": {
    "github": {
      "command": "/Users/you/.nvm/versions/node/v22.22.2/bin/npx",
      "args": ["-y", "apitame@0.3", "serve", "--config", "/Users/you/project/apitame.config.yaml"],
      "env": { "PATH": "/Users/you/.nvm/versions/node/v22.22.2/bin:..." }
    }
  }
}
```

Restart Claude Desktop after changing the file. If you later remove that Node version, run `add-to claude-desktop --write` again.

Claude Desktop takes skills as uploads rather than folders. `--write` packages each skill as `skills/<name>.zip`; upload it in Claude Desktop settings (Capabilities, Skills).

## Other clients

Any MCP client that can launch a stdio server works with:

```text
command: npx
args:    -y apitame@0.3 serve --config /abs/path/apitame.config.yaml
```

## Streamable HTTP

For clients that connect to a URL, or to share one server between several agents on the same machine:

```bash
npx apitame serve --transport http --port 3333
# MCP endpoint: http://127.0.0.1:3333/mcp, health check: http://127.0.0.1:3333/health
```

Claude Code: `claude mcp add --transport http github http://127.0.0.1:3333/mcp`.

To listen on other interfaces (for example inside a container), set a token. apitame refuses to start without one:

```bash
APITAME_HTTP_TOKEN=$(openssl rand -hex 24) npx apitame serve --transport http --host 0.0.0.0
```

Clients then send `Authorization: Bearer <token>`. Put TLS in front of it (a reverse proxy) before exposing it beyond a private network.

The HTTP transport serves both MCP protocol eras on the same URL (see [safety.md](safety.md#protocol-eras)). How a destructive operation is approved depends on the one the client speaks:

- **Clients on protocol 2026-07-28** are asked through elicitation over plain stateless HTTP: the first call returns the approval form, and the client sends the answer with a second call. No session is needed.
- **2025-era clients** (protocol 2025-11-25 and earlier) need a session for that, because the server asks in the middle of the call. By default the HTTP transport is stateless, so they confirm with the one-time token flow instead (see [safety.md](safety.md#confirmation)). With `--sessions`, each of them keeps a session (`Mcp-Session-Id`) and clients that support elicitation show the approval prompt to the human:

```bash
npx apitame serve --transport http --sessions
```

Sessions without requests or open streams are closed after 30 minutes, and at most 100 are kept (the oldest idle one makes room). A client whose session was closed gets a 404 and starts a new one. Requests from 2026-07-28 clients never open or use a session, with or without `--sessions`; with `--sessions` their bodies are limited to 1 MB, like requests that start a session.

Without `APITAME_HTTP_TOKEN` or `http.oauth`, any process on the machine that can reach the port, an agent's own shell included, can call the tools and answer approval prompts as if it were the client. apitame warns about this at startup when some operation asks for confirmation, and under `confirmation.method: elicitation` it refuses approvals on such a server, from clients of both protocol eras, without asking anyone. Set a token (and give it only to the MCP client) whenever the agent runs on the same machine with a shell. With `--watch`, 2025-era clients are told about tool list changes on their session, and 2026-07-28 clients on their `subscriptions/listen` stream. `--log-level debug` logs which protocol each request uses.

### OAuth

Instead of one shared token, apitame can accept OAuth 2.1 access tokens issued by your own authorization server (your identity provider). apitame is only the resource server: it never issues tokens, shows a login page or registers clients. Clients learn from apitame which authorization server to use, sign the user in there, and send the access token with every request. apitame checks each token locally against the authorization server's published keys, or asks the authorization server about it ([token introspection](#opaque-tokens-token-introspection), for opaque tokens).

```yaml
# apitame.config.yaml
http:
  oauth:
    issuer: https://login.example.com/realms/tools   # exactly as in the tokens' iss claim
    resource: https://mcp.example.com/mcp            # the public URL clients connect to
    scopes: [mcp:tools]                              # scopes every token must have
    requireAccessTokenType: true                     # if your server sets typ at+jwt
```

```bash
npx apitame serve --transport http --host 0.0.0.0
```

All the keys are described in [configuration.md](configuration.md#http). On every request to `/mcp`, apitame checks that (for opaque tokens, see [token introspection](#opaque-tokens-token-introspection)):

- the token is a JWT signed by one of the authorization server's keys (RS, PS, ES or EdDSA algorithms; `none` and shared-secret HMAC are refused). The keys come from the JWKS named in the server's metadata (RFC 8414 or OpenID Connect discovery), or from `jwksUri`;
- `iss` is `issuer`, `aud` contains `resource` (or one of `audiences`), and `exp` has not passed;
- it is an access token. ID tokens (with `nonce`, `at_hash` or `c_hash`) and refresh tokens (Keycloak's `typ` claim `ID`, `Refresh` or `Offline`) are refused, and so is a header `typ` other than `at+jwt`, `application/at+jwt` or `JWT`. With `requireAccessTokenType: true`, only `at+jwt` is accepted: turn it on when your authorization server sets it (RFC 9068);
- the token carries every scope in `scopes`. A token without one gets 403 `insufficient_scope`;
- with `clients` set, the token was issued to one of those clients (`client_id`, `azp`, `cid` or `appid` claim).

A request without a valid token gets a 401 whose `WWW-Authenticate` header points to `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`. That document (RFC 9728) is public and names the authorization server, so MCP clients that support OAuth start the sign-in on their own. Clients register with the authorization server (dynamic client registration, a client ID metadata document, or a client created there by hand), never with apitame.

#### Different permissions per user

Required scopes decide who may connect. To give users or clients different tools and writes, set what every caller gets (`default`) and what scopes and client ids add to it. Permissions can only narrow the server config:

```yaml
mode: read-write
writes:
  allow: [createIssue, updateIssue, closeIssue]
limits:
  perCaller: { maxCallsPerMinute: 60, maxWritesPerMinute: 10 }   # each user's own budget
http:
  oauth:
    issuer: https://login.example.com/realms/tools
    resource: https://mcp.example.com/mcp
    scopes: [mcp:tools]
    permissions:
      default: { mode: read-only, tools: [issues, search_operations] }  # every caller
      byScope:
        mcp:write: { tools: [issues], writes: [createIssue, updateIssue] }  # also needs writes.allow
      byClient:
        release-bot: { tools: [issues], writes: [closeIssue] }
```

Every caller gets `default` (read-only with every tool when unset), and each matching entry adds to it, so `default` must be the least any caller should get. A write runs only when one entry both grants it and reaches it through its own `tools`. Each caller's `tools/list` shows only what it may use, a refused write names the reason without naming anyone else's permissions, and the audit log records which entries applied. Permissions follow `--watch` reloads. MCP clients request the scopes in `scopes`, so the authorization server decides which other scopes reach a user's token: set it up to add them (by role or group), or use `byClient` for service accounts. The full rules are in [safety.md](safety.md#per-user-permissions).

Which authorization servers work: any that issues JWT access tokens, and any that offers token introspection (see below) for the opaque ones. Best is one that puts the resource URL in `aud`, because then a token can only be meant for this server: Keycloak (with an audience mapper), Auth0 (an API whose identifier is the resource URL), or an Okta custom authorization server created for apitame with the resource URL as its audience. If the audience is something else (Microsoft Entra ID puts its Application ID URI or client id there), list it in `audiences`, together with `scopes` or `clients`: such an audience is often shared by other apps, and apitame refuses `audiences` without one of them. Do not point apitame at an audience that every app on the authorization server uses, such as Okta's default `api://default`, without `clients`.

Good to know:

- `http.oauth` and `APITAME_HTTP_TOKEN` cannot be used together; apitame refuses to start with both. Either one allows `--host 0.0.0.0`.
- With `scopes` empty, apitame logs a warning at startup: any token the authorization server issues for this audience is then accepted.
- At startup apitame loads the signing keys and logs how many it found. If the authorization server cannot be reached, it logs the error and keeps running; tokens are refused until the keys load, which it tries again when requests arrive. It fetches the keys again when a token names an unknown key (at most once a minute), so key rotation needs no restart. Known keys are refreshed every hour in the background; a slow or unreachable authorization server never holds up requests whose key is already known.
- The issuer's metadata and keys are fetched without following redirects, and each document may be at most 1 MB, so `issuer` and `jwksUri` must be the final URLs.
- Changes to `http.oauth` need a restart, except `permissions`, which apply on a `--watch` reload. With `--watch`, apitame warns when the rest of `http.oauth` was added, removed or changed since it started.
- With JWTs checked locally, revoking a token at the authorization server takes effect when the token expires: apitame does not ask the server about each one. Keep access tokens short-lived, or use token introspection, which notices a revocation within `cacheSeconds`. When the token that opened a stream expires, apitame closes the stream, and the client has to come back with a fresh token.
- If apitame listens on `127.0.0.1` behind a reverse proxy on the same machine, the Host check also accepts the host name of `resource`, and the Origin check its origin.
- apitame reads the client from `client_id`, `azp`, `cid` or `appid` (the first one present) and the user from `sub`, and keeps them apart. With `--sessions`, a session belongs to that client and user: another token cannot use its id, each user can hold at most 10 sessions, and making room only ever closes that user's own idle sessions. A token that names neither a client nor a user cannot start a session. The audit log records both (`client`, `subject`).
- Rate limits are per server unless you set `limits.perCaller`, which gives each user (client and subject) a budget of their own on top (see [safety.md](safety.md#rate-limits)).
- `--log-level debug` logs why a token was refused. The 401 body says it too.

#### Opaque tokens: token introspection

Some authorization servers issue opaque access tokens: random strings that only the server itself can read. apitame checks those with token introspection (RFC 7662): it sends the token to the server's introspection endpoint, authenticated as a client of that server, and the server answers whether the token is active and what it allows. Register apitame as a confidential client there (a client id and secret), then:

```yaml
http:
  oauth:
    issuer: https://auth.example.com
    resource: https://mcp.example.com/mcp
    scopes: [mcp:tools]
    introspection:
      url: https://auth.example.com/oauth/introspect
      clientId: ${INTROSPECTION_CLIENT_ID}
      clientSecret: ${INTROSPECTION_CLIENT_SECRET}   # only environment variables
    # verify: auto   # check JWTs locally and introspect only the other tokens
```

`http.oauth.verify` says which tokens are introspected:

| `verify` | JWTs | Other tokens |
| --- | --- | --- |
| `jwt` (the default without `introspection`) | checked locally | refused |
| `introspection` (the default with `introspection`) | introspected | introspected |
| `auto` | checked locally | introspected |

`introspection` suits servers whose tokens are all opaque, and also JWT issuers when revocation must take effect quickly. `auto` suits servers that issue both kinds: a token shaped like a JWT (three parts, the first a JSON header) is checked against the keys as above and never sent to the server, so a forged one costs nothing. A JWT that the keys cannot check (one signed with a shared secret, say) is refused under `auto`; use `introspection` for those.

An introspected token passes the same checks as a JWT: the answer must say `active: true`; `aud` must contain `resource` (or one of `audiences`); `iss`, when the answer has one, must be `issuer`; `exp` is required and must not have passed (a token that never expires is refused, as for JWTs); `nbf` and `iat` get the same minute of clock skew; the required `scopes` come from `scope`; the client from `client_id` (or `azp`, `cid`, `appid`) and the user from `sub`, so `clients`, permissions, sessions, rate limits and the audit log work as with JWTs. Tokens bound to a client key or certificate (`token_type: DPoP` or a `cnf` member) are refused, since apitame cannot check their proof.

The audience check is the main defense against refresh tokens and tokens meant for other apps: an authorization server may introspect any token it issued, refresh tokens included, and say it is active. So make sure the access tokens for apitame carry the `resource` URL (or an entry of `audiences`) in `aud`, and that refresh tokens do not. On top, apitame refuses a token whose `token_type`, `token_use` or Keycloak `typ` names a refresh, offline or ID token in any spelling (`refresh_token`, `Refresh Token`, `refresh-token`, `ID`, `urn:ietf:params:oauth:token-type:id_token`, and so on), but not every server says it.

A refused token gets the same 401 whatever the reason: `The access token is invalid or inactive.` RFC 7662 asks for that, so that whoever presents a token they made up or found cannot learn from the answer what the authorization server knows about it. `--log-level debug` logs the reason next to it.

Each user should have a `sub` in the answer. Without one, all the users of a client count as one caller: one session owner, one `limits.perCaller` budget, one subject in the audit log. apitame logs a warning once per client when an answer has no `sub`, and does not use `username` instead (RFC 7662 makes it a name for people to read, not a stable identifier).

How apitame asks:

- A `POST` with `token=...&token_type_hint=access_token`, and the client credentials as HTTP Basic (`clientAuthMethod: client_secret_basic`, the default) or in the form body (`client_secret_post`). `https` only, except on loopback; no redirects; a 5 second timeout for the whole answer; at most 1 MB in it. The URL is used as written: it does not read `${VAR}`.
- An active answer is reused for `cacheSeconds` (60 by default, at most 300, and never past the token's `exp`), so a client's requests do not each cost a round trip. After that the token is introspected again: a revoked token is refused within `cacheSeconds`; with `cacheSeconds: 0` it is refused at once, and every request asks. Refusals are never cached, and a refused token is forgotten. The cache keeps the SHA-256 of each token, never the token, and at most 10,000 tokens.
- Requests that arrive together with the same new token share one introspection.
- At most `maxCallsPerMinute` introspections (600 by default) of new tokens in any minute, so a flood of made-up tokens cannot turn apitame into an amplifier against your authorization server. Past the limit, new tokens get a 500 and the log says why (once a minute). Tokens the server said were active are checked again (when their cached answer goes stale) within a second budget of the same size, which made-up tokens cannot use, so users who are signed in keep working through such a flood. That budget is used by real users only: each active token costs one introspection every `cacheSeconds`, so with the defaults 600 users can be active at once. Past it, their requests get a 500 too, and the log says to raise `maxCallsPerMinute` or `cacheSeconds`. In all, apitame makes at most twice `maxCallsPerMinute` introspections a minute.
- If the endpoint cannot be reached, times out, answers with another status than 200, or answers something that is not an introspection response, the token is refused with a 500 (a server problem, not a bad token, so clients do not sign the user in again), and the error is logged. Nothing is let through.
- At startup, before it listens, apitame asks about a random token that nobody issued, and logs whether the endpoint accepted its credentials. If the endpoint cannot be reached or refuses the credentials, apitame keeps running and logs the error; tokens that need introspection are refused until the endpoint works. If the endpoint says that random token is active, it would accept any token (a wrong URL, or a test double that says yes to everything), and apitame stops with an error.
- The client secret must be environment variable references only (`${INTROSPECTION_CLIENT_SECRET}`, no default, no text around it) and is hidden from logs and errors, like every other secret. `apitame doctor` reports a missing one.
- With Node's proxy support on (`NODE_USE_ENV_PROXY=1` and `HTTP_PROXY` or `HTTPS_PROXY` set), introspection requests go through the proxy, the client credentials and the token included, even to a loopback URL. Over `http` the proxy reads them in clear text. Use an `https` URL, or list the authorization server in `NO_PROXY`.

Which authorization servers offer it: Keycloak (`/realms/<realm>/protocol/openid-connect/token/introspect`, with a confidential client), Okta custom authorization servers (`/oauth2/<authorizationServerId>/v1/introspect`), Zitadel (`/oauth/v2/introspect`, with an API application that uses Basic authentication; Zitadel can issue opaque access tokens), and other servers that publish an `introspection_endpoint` in their metadata and accept a client secret there. Some do not: Google and GitHub issue opaque tokens but have no RFC 7662 endpoint (GitHub's "Check a token" API and Google's tokeninfo are their own formats), so apitame cannot check their tokens. Auth0 and Microsoft Entra ID have no introspection endpoint either, but issue JWT access tokens for your own APIs, which `verify: jwt` checks.

## Pinning and local builds

`add-to` pins the minor version (`apitame@0.3`) so a new release cannot change your server's behavior without you noticing. To run a local checkout instead:

```bash
npx apitame add-to claude-code --command "node /path/to/apitame/dist/cli.js"
```

## Elicitation and annotations

Destructive operations use MCP elicitation when the client supports it, so the approval prompt comes from the client, not from the agent. 2025-era clients get the prompt in the middle of the call; clients on protocol 2026-07-28 get it as the result of a first call and send the answer with a second one, which also works over stateless HTTP. An approval proves that the MCP client answered, not that a human did: it only means something when the agent cannot reach apitame itself, that is over stdio, or over HTTP with `APITAME_HTTP_TOKEN` or OAuth credentials that only the client holds, on a port the agent's sandbox cannot reach (see [safety.md](safety.md#what-an-approval-proves)). Tools also carry `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations, which some clients use to decide when to ask for permission or to run read-only tools in parallel.
