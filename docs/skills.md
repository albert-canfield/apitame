# Skills

Tool schemas tell an agent what it can call. They do not tell it which call answers a question, in what order, or what not to do. apitame generates [Agent Skills](https://agentskills.io/specification) for that: a `SKILL.md` per source, written from the same config the server runs, so the instructions always match the tools.

## What is generated

`init` writes one skill per source into `skills/` (configurable with `skills.dir`):

```text
skills/
  github-api/
    SKILL.md                    # when to use it, tools, workflows, safety rules
    references/operations.md    # every operation with its parameters
  shop-db/
    SKILL.md                    # tools, schema overview, example joins, query rules
    references/schema.md        # every column of every table
```

`SKILL.md` follows the Agent Skills format: YAML frontmatter with `name` (equal to the folder name) and `description` (under 1,024 characters), then Markdown. Long reference material lives in `references/` and is only read when needed, which keeps the always-loaded part small.

### For OpenAPI sources

- A table of tools with what each one is for and which operations it contains.
- The call shape for grouped tools.
- Workflows inferred from the API's structure, each with copy-ready JSON arguments: list a collection then open one item, search with filters, page through long lists, create safely with a dry run, delete with confirmation, and find an operation that has no dedicated tool. Only workflows that the current mode allows are included.
- Safety rules that match the mode: in read-only mode, do not look for workarounds and tell the user how writes can be enabled; in read-write mode, dry-run first and never send a confirmation token the user did not approve.

### For SQL sources

- The tools, including named queries.
- A schema table: tables, approximate row counts, primary keys and foreign-key links.
- Example queries built from the real relationships: joins to the most readable related table, a count per parent row, and the latest rows by timestamp.
- Query rules: one SELECT, always LIMIT, describe before querying, prefer aggregates and named queries.

## Keeping skills current

Skills reflect the config at the time they were generated. After you change the mode, the allowlist or the tool groups, regenerate them:

```bash
npx apitame init --skills-only
```

The output is deterministic (no model is involved), so regenerated skills produce clean diffs.

## Installing skills in a client

`npx apitame add-to <client> --write` copies the skills to the folder each client reads:

| Client | Folder |
| --- | --- |
| Claude Code | `.claude/skills/` (or `~/.claude/skills/` for all projects) |
| Codex | `.agents/skills/` (or `~/.agents/skills/`) |
| Cursor | `.agents/skills/` (Cursor also reads `.cursor/skills/` and `.claude/skills/`) |
| VS Code | `.agents/skills/` (also `.github/skills/` and `.claude/skills/`) |
| Gemini CLI | `.agents/skills/` |
| Claude Desktop | upload `skills/<name>.zip` (created by `add-to claude-desktop --write`) in the app's settings |

## Skills over MCP

`apitame serve` also serves the skills in `skills.dir` through the MCP Skills extension (`io.modelcontextprotocol/skills`). Clients that support it can discover them with `skills/list` and read them with `resources/read` on `skill://<name>/SKILL.md`, with a SHA-256 digest and size for every file. No copying is needed, and the skill always comes from the same server as the tools. Support in clients is still rolling out; installing the files with `add-to` works everywhere today.

## Writing your own

You can edit generated skills or add new skill folders next to them; `serve` serves every valid skill folder in `skills.dir`. Note that `init --skills-only` overwrites the files it generates (`SKILL.md` and `references/` of the generated skill), so put hand-written skills in their own folder.
