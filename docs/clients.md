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
      "args": ["-y", "apitame@0.1", "serve", "--config", "${CLAUDE_PROJECT_DIR:-.}/apitame.config.yaml"]
    }
  }
}
```

With the CLI:

```bash
claude mcp add --transport stdio --scope project github -- npx -y apitame@0.1 serve --config /abs/path/apitame.config.yaml
```

Skills: `.claude/skills/<name>/SKILL.md` for the project, or `~/.claude/skills/` for all projects. Claude Code asks you to approve project servers the first time.

## Codex

User scope (`~/.codex/config.toml`), or project scope (`.codex/config.toml`, read for trusted projects):

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "apitame@0.1", "serve", "--config", "/abs/path/apitame.config.yaml"]
```

With the CLI (writes the user config):

```bash
codex mcp add github -- npx -y apitame@0.1 serve --config /abs/path/apitame.config.yaml
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
      "args": ["-y", "apitame@0.1", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.1", "serve", "--config", "${workspaceFolder}/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.1", "serve", "--config", "/abs/path/apitame.config.yaml"]
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
      "args": ["-y", "apitame@0.1", "serve", "--config", "/Users/you/project/apitame.config.yaml"],
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
args:    -y apitame@0.1 serve --config /abs/path/apitame.config.yaml
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

The HTTP transport is stateless, so destructive operations are confirmed with the one-time token flow rather than an elicitation prompt (see [safety.md](safety.md#confirmation)).

## Pinning and local builds

`add-to` pins the minor version (`apitame@0.1`) so a new release cannot change your server's behavior without you noticing. To run a local checkout instead:

```bash
npx apitame add-to claude-code --command "node /path/to/apitame/dist/cli.js"
```

## Elicitation and annotations

Destructive operations use MCP elicitation when the client supports it, so the approval prompt comes from the client, not from the agent. Tools also carry `readOnlyHint`, `destructiveHint` and `openWorldHint` annotations, which some clients use to decide when to ask for permission or to run read-only tools in parallel.
