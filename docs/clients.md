# Client setup

`npx apitame add-to <client>` prints the right configuration; add `--write` to write it into the current project and install the skills. This page shows what it produces and how to do it by hand.

In the examples the server is called `github` and the config sits at the project root. apitame reads secrets from the environment or from `.env` next to `apitame.config.yaml`, so none of these files contain credentials.

## Claude Code

Project scope, shared through git (`.mcp.json` at the project root):

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "apitame@0.2", "serve", "--config", "${CLAUDE_PROJECT_DIR:-.}/apitame.config.yaml"]
    }
  }
}
```

With the CLI:

```bash
claude mcp add --transport stdio --scope project github -- npx -y apitame@0.2 serve --config /abs/path/apitame.config.yaml
```

Skills: `.claude/skills/<name>/SKILL.md` for the project, or `~/.claude/skills/` for all projects. Claude Code asks you to approve project servers the first time.

## Codex

User scope (`~/.codex/config.toml`), or project scope (`.codex/config.toml`, read for trusted projects):

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "apitame@0.2", "serve", "--config", "/abs/path/apitame.config.yaml"]
```

With the CLI (writes the user config):

```bash
codex mcp add github -- npx -y apitame@0.2 serve --config /abs/path/apitame.config.yaml
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
      "args": ["-y", "apitame@0.2", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.2", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.2", "serve", "--config", "/abs/path/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.2", "serve", "--config", "/Users/you/project/apitame.config.yaml"],
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
args:    -y apitame@0.2 serve --config /abs/path/apitame.config.yaml
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

By default the HTTP transport is stateless, so destructive operations are confirmed with the one-time token flow rather than an elicitation prompt (see [safety.md](safety.md#confirmation)). With `--sessions`, each client keeps a session (`Mcp-Session-Id`) and clients that support elicitation show the approval prompt to the human:

```bash
npx apitame serve --transport http --sessions
```

Sessions without requests or open streams are closed after 30 minutes, and at most 100 are kept (the oldest idle one makes room). A client whose session was closed gets a 404 and starts a new one.

### OAuth

Instead of one shared token, apitame can accept OAuth 2.1 access tokens issued by your own authorization server (your identity provider). apitame is only the resource server: it never issues tokens, shows a login page or registers clients. Clients learn from apitame which authorization server to use, sign the user in there, and send the access token with every request. apitame checks each token locally against the authorization server's published keys.

```yaml
# apitame.config.yaml
http:
  oauth:
    issuer: https://login.example.com/realms/tools   # exactly as in the tokens' iss claim
    resource: https://mcp.example.com/mcp            # the public URL clients connect to
    scopes: [mcp:tools]                              # optional: scopes every token must have
```

```bash
npx apitame serve --transport http --host 0.0.0.0
```

All the keys are described in [configuration.md](configuration.md#http). On every request to `/mcp`, apitame checks that:

- the token is a JWT signed by one of the authorization server's keys (RS, PS, ES or EdDSA algorithms; `none` and shared-secret HMAC are refused). The keys come from the JWKS named in the server's metadata (RFC 8414 or OpenID Connect discovery), or from `jwksUri`;
- `iss` is `issuer`, `aud` contains `resource` (or one of `audiences`), and `exp` has not passed;
- the token carries every scope in `scopes`. A token without one gets 403 `insufficient_scope`.

A request without a valid token gets a 401 whose `WWW-Authenticate` header points to `https://mcp.example.com/.well-known/oauth-protected-resource/mcp`. That document (RFC 9728) is public and names the authorization server, so MCP clients that support OAuth start the sign-in on their own. Clients register with the authorization server (dynamic client registration, a client ID metadata document, or a client created there by hand), never with apitame.

Which authorization servers work: any that issues JWT access tokens and puts this server in `aud`. That includes Keycloak (with an audience mapper), Auth0 (an API whose identifier is the resource URL), Okta custom authorization servers and Microsoft Entra ID (an exposed API; list its audience in `audiences`). Servers that only issue opaque tokens, which need token introspection, are not supported yet.

Good to know:

- `http.oauth` and `APITAME_HTTP_TOKEN` cannot be used together; apitame refuses to start with both. Either one allows `--host 0.0.0.0`.
- At startup apitame loads the signing keys and logs how many it found. If the authorization server cannot be reached, it logs the error and keeps running; tokens are refused until the keys load, which it tries again when requests arrive. It fetches the keys again when a token names an unknown key (at most once a minute), so key rotation needs no restart.
- Changes to `http.oauth` need a restart, even with `--watch`.
- If apitame listens on `127.0.0.1` behind a reverse proxy on the same machine, the Host check also accepts the host name of `resource`.
- With `--sessions`, a session belongs to the client and user that started it. The audit log records the token's client id and subject (`client`, `subject`).
- `--log-level debug` logs why a token was refused. The 401 body says it too.

## Pinning and local builds

`add-to` pins the minor version (`apitame@0.2`) so a new release cannot change your server's behavior without you noticing. To run a local checkout instead:

```bash
npx apitame add-to claude-code --command "node /path/to/apitame/dist/cli.js"
```

## Elicitation and annotations

Destructive operations use MCP elicitation when the client supports it, so the approval prompt comes from the client, not from the agent. Tools also carry `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations, which some clients use to decide when to ask for permission or to run read-only tools in parallel.
