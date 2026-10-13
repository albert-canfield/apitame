# Landscape

This page surveys the open-source and commercial projects that turn an OpenAPI spec, a REST API or a SQL database into an MCP server, and checks apitame's five claimed differentiators against them. Star counts and last push dates come from the GitHub API, and download figures come from the npm and PyPI public APIs (week of 6 to 12 October 2026). Feature claims are taken from each project's README, docs or source; anything that could not be confirmed is marked "unverified".

Last checked: 13 October 2026

## OpenAPI to MCP

| Project | Stars | Last push | Language | Approach | Safety | Notes/gaps |
| --- | --- | --- | --- | --- | --- | --- |
| [PrefectHQ/fastmcp](https://github.com/PrefectHQ/fastmcp) (`FastMCP.from_openapi`) | 28,067 | 2026-10-13 | Python | Runtime proxy inside a Python framework. Every route becomes a tool by default; `RouteMap` (method, path pattern, tags) maps routes to tool, resource or exclude. Since 3.1 (March 2026): regex and BM25 tool search transforms that replace the catalog with `search_tools` + `call_tool`, plus Code Mode. | No read-only default (GET-only is a `RouteMap` choice). `Approval` provider (3.2) adds a confirmation card, but its docs call it "an advisory gate, not an enforcement mechanism". Auth is whatever headers you put on the httpx client, in code. | Strongest feature overlap on tool surface, but you write Python. Skills Provider serves existing skill folders as MCP resources; nothing is generated from the spec. No token report. |
| [awslabs/mcp](https://github.com/awslabs/mcp/tree/main/src/openapi-mcp-server) (openapi-mcp-server) | 9,777 (whole monorepo) | 2026-10-12 (folder: 2026-09-08) | Python | Runtime proxy, one tool per operation, tag include/exclude filters, several specs in one server. | No read-only mode found. Auth: basic, bearer, API key, Cognito, with per-spec credential isolation. | Generates MCP prompts per operation plus an API documentation prompt (not SKILL.md files) and claims a 70 to 75% token reduction for that prompt text. AWS oriented. |
| [UsefulSoftwareCo/executor](https://github.com/UsefulSoftwareCo/executor) | 4,173 | 2026-10-13 | TypeScript | Local daemon, desktop app or hosted gateway for OpenAPI, GraphQL and MCP sources. Default surface is code mode (sandboxed execution); `?mode=passthrough` exposes only `integrations`, `skills`, `search` and `invoke`. | Per-tool policy: allow, require approval, or block, with defaults "derived from the spec" (GET allowed). Executions pause for approval and resume. Credentials are stored by Executor and "never reach" the agent. | Closest competitor on safety and tool surface. It is a service with a web UI and background daemon, not a reviewable config in your repo. No SQL database input. Serves its own built-in guides, not per-API generated skills. No dry-run found. ~30k npm downloads/week. |
| [harsha-iiiv/openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator) | 639 | 2026-09-26 | TypeScript | Codegen: scaffolds a Node project with one tool per operation and zod validation. Filtering via the `x-mcp` extension or a `filterFn`. stdio, SSE, streamable HTTP, Cloudflare Workers. | No read-only default. Auth: API key, bearer, basic and OAuth2 client credentials, all from env vars. | Same auth list as apitame. No grouping, no search tool, no write tiers, no skills, no token report. ~9.7k npm downloads/week. |
| [mattt/emcee](https://github.com/mattt/emcee) | 332 | 2026-07-04 | Go | Runtime proxy, one tool per operation. | No read-only mode found. Bearer, basic or raw `Authorization` header; values can be 1Password secret references. | Simple and polished; no curation, no safety tiers, no skills. |
| [ivo-toby/mcp-openapi-server](https://github.com/ivo-toby/mcp-openapi-server) | 299 | 2026-06-15 | TypeScript | Runtime proxy. `--tools` modes: all (default), dynamic, explicit. Dynamic mode exposes only `list-api-endpoints`, `get-api-endpoint-schema` and `invoke-api-endpoint`. Filters by tag, path prefix and HTTP method. | All operations by default; GET-only via `--operation get`. The README notes that tag filters "are tool-surface controls, not authorization". Static headers or a custom `AuthProvider` with token refresh. | Already ships the search plus call pattern. Prompts and resources are user supplied, not generated. ~11.4k npm downloads/week. |
| [speakeasy-api/gram](https://github.com/speakeasy-api/gram) (plus Speakeasy generated MCP servers) | 273 | 2026-10-13 | Go (AGPL-3.0) | Hosted control plane with an open-source stack: curated toolsets and a dynamic mode with `search_tools`, `describe_tools`, `execute_tool` (Speakeasy reports 90%+ token reductions). Speakeasy's generated TypeScript servers support `x-speakeasy-mcp` scopes and MCP tool annotations. | Read-only is opt-in: tag operations with a `read` scope, then start with `--scope read`. RBAC, OAuth 2.1, token and cost observability. | Enterprise platform rather than a local zero-config CLI. Distributes skills; generating skills from a spec is unverified. |
| [Stainless](https://www.stainless.com/docs/mcp/index.md) (closed source) | n/a | n/a | TypeScript (generated) | Codegen alongside SDKs. Current default is code mode: a code execution tool plus a docs search tool. Earlier versions offered per-endpoint tools with `--resource` and `--operation read` filters and a "dynamic tools" mode for APIs above 50 endpoints. | All SDK methods allowed by default. `allow_http_gets`, `allowed_methods` and `blocked_methods` restrict the code tool; the docs warn the checks rely on static analysis and "determined users can bypass" them. OAuth flow for remote servers. | Commercial and tied to Stainless SDK generation. No skills, no token report found. |

Also checked: [tadata-org/fastapi_mcp](https://github.com/tadata-org/fastapi_mcp) (12,020 stars, last push 2025-11-24, FastAPI apps only), [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) (4,622, enterprise gateway that virtualizes REST as MCP), [AmoyLab/Unla](https://github.com/AmoyLab/Unla) (2,239, gateway), [cloudflare/mcp](https://github.com/cloudflare/mcp) (946, a single-API code mode server whose README reports about 1,100 tokens for 3 tools versus 1,170,523 tokens for 2,594 native tools), [janwilmake/openapi-mcp-server](https://github.com/janwilmake/openapi-mcp-server) (903; the old snaggle-ai/openapi-mcp-server URL now redirects here; it explores specs and does not call APIs), [higress-group/openapi-to-mcpserver](https://github.com/higress-group/openapi-to-mcpserver) (290, emits Higress gateway config) and [cnoe-io/openapi-mcp-codegen](https://github.com/cnoe-io/openapi-mcp-codegen) (42, Python codegen with optional LLM-written docstrings, a LangGraph agent and evals).

## Database MCP servers

| Project | Stars | Last push | Language | Approach | Safety | Notes/gaps |
| --- | --- | --- | --- | --- | --- | --- |
| [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) (MCP Toolbox for Databases, formerly genai-toolbox) | 16,658 | 2026-10-13 | Go | Runtime server. Curated tools are hand-written parameterized SQL in `tools.yaml`, grouped into toolsets. `--prebuilt=postgres` loads dozens of generic tools, including `execute_sql`. | The prebuilt `execute_sql` does not restrict writes (it relies on the database role). Hand-written tools limit what SQL can run. IAM auth, OpenTelemetry. | `toolbox skills-generate` (since February 2026) turns a toolset into a SKILL.md plus one Node script per tool. dbhub's README measures a Toolbox default config at 19.0k tokens for 28 tools. No OpenAPI import found. ~75k npm downloads/week for `@toolbox-sdk/server`. |
| [bytebase/dbhub](https://github.com/bytebase/dbhub) | 3,639 | 2026-10-13 | TypeScript | Runtime server described as "token conscious": 2 tools by default (`execute_sql`, `search_objects` with progressive disclosure) plus custom parameterized tools in `dbhub.toml`. Six engines including PostgreSQL and SQLite. | `readonly` defaults to false for the CLI and TOML; the Claude Code plugin and MCP Bundle ship read-only with `max_rows = 1000`. Read-only is enforced by "a keyword classifier and the database's own read-only mode". Query timeout, SSH tunnels, TLS. | The PostgreSQL example in the Claude Code MCP docs. Ships hand-written skills (`/dbhub:setup`, `/dbhub:explore`). Publishes its tool-list token cost (1.4k) in the README. ~40k npm downloads/week. |
| [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) (Postgres MCP Pro) | 3,396 | 2026-08-17 | Python | Runtime server for PostgreSQL only: SQL execution plus explain plans, index tuning and health checks. | `--access-mode=restricted` runs read-only transactions, parses SQL with pglast to reject `COMMIT` and `ROLLBACK`, and limits execution time. README examples use `unrestricted`. | Already validates SQL with a real parser. PostgreSQL only; no skills; no token report. ~143k PyPI downloads/week. |
| [supabase/mcp](https://github.com/supabase/mcp) (formerly supabase-community/supabase-mcp) | 2,949 | 2026-10-13 | TypeScript | Platform server over the Supabase management API and SQL, with feature groups and project scoping to trim the tool list. | `read_only=true` is opt-in (default false). Cost confirmation for `create_project` and `create_branch` via MCP elicitation or a `confirm_cost` step. | Supabase only. A good reference for elicitation-based confirmation. ~82k npm downloads/week. |
| [Azure/data-api-builder](https://github.com/Azure/data-api-builder) (SQL MCP Server) | 1,526 | 2026-10-12 | C# | A fixed family of seven DML tools (`describe_entities`, `read_records`, `create_record`, `update_record`, `delete_record`, `execute_entity`, `aggregate_records`) over configured entities. Deliberately no NL2SQL or raw SQL. | Role-based permissions per entity and field; a read-only role refuses every write; per-tool toggles (for example, disabling `delete_record`). | Strong safety model, but you configure each entity and run the .NET engine. No skills, no token report. |
| [centralmind/gateway](https://github.com/centralmind/gateway) | 547 | 2025-07-18 | Go | Uses an LLM at discovery time to generate a curated API (MCP or OpenAPI) from the schema and sampled rows. | PII redaction plugins, Lua row-level security, API key and OAuth plugins. | The closest idea to "curated from schema", but no push since July 2025, and discovery sends samples to an LLM. |
| [modelcontextprotocol/servers-archived](https://github.com/modelcontextprotocol/servers-archived) (reference `postgres` and `sqlite`) | 305 | 2025-05-28 (archived) | TypeScript (postgres), Python (sqlite) | Postgres: one `query` tool run inside a READ ONLY transaction, plus schema resources. SQLite: `read_query`, `write_query`, `create_table` and others. | Datadog Security Labs (August 2025) showed that `COMMIT; DROP SCHEMA public CASCADE;` escapes the read-only transaction. | The npm package is deprecated yet still had ~128k downloads in the week to 12 October 2026: clear demand for a safe successor. |

Also checked: [neondatabase/mcp-server-neon](https://github.com/neondatabase/mcp-server-neon) (651 stars, Neon only, installs hand-written agent skills through `neon init`), [benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql) (2,157, MySQL only), [runekaagaard/mcp-alchemy](https://github.com/runekaagaard/mcp-alchemy) (420), [executeautomation/mcp-database-server](https://github.com/executeautomation/mcp-database-server) (386) and [pgEdge/pgedge-postgres-mcp](https://github.com/pgEdge/pgedge-postgres-mcp) (235, read-only transactions by default).

## Differentiators, checked

### 1. Curated tool surface

**Verdict: Partly.**

- The `search_operations` + `call_operation` pattern is now table stakes. ivo-toby/mcp-openapi-server has a dynamic mode with three meta-tools, FastMCP 3.1+ ships `search_tools` + `call_tool` transforms, Gram has `search_tools`, `describe_tools` and `execute_tool`, Executor has a search-and-invoke mode, and Stainless offered "dynamic tools" before moving to code mode. Stainless, Cloudflare, Executor and FastMCP also offer code mode, which shrinks the surface even further.
- The target clients now reduce the problem on their side. Claude Code enables MCP tool search by default on current models. Cursor's "dynamic context discovery" (January 2026) loads tool schemas on demand and reported a 46.9% drop in total agent tokens in runs that called MCP tools. Codex contains a BM25 `tool_search` tool; a third-party write-up says it became the default for MCP servers in June 2026 (unverified in official docs).
- What was not found in any OpenAPI tool checked: automatic grouping of endpoints into a capped set of task-level tools, generated from the spec and editable in a config file. Curation elsewhere is manual (Gram toolsets, MCP Toolbox `tools.yaml`, Data API builder entities) or LLM driven and unmaintained (centralmind/gateway).
- Recommendation: drop "most generators flood your context" as the headline. Claim "good task-level tools out of the box, search for the long tail", and back it with a small published eval of tool-selection accuracy and token use against 1:1 mapping and search-only.

### 2. Safe by default

**Verdict: Partly. The individual pieces exist; the full combination in a local generator was not found.**

- Read-only by default: Executor allows GET by default and can gate or block writes; the dbhub plugin and MCP Bundle are read-only; pgEdge and the archived reference server use read-only transactions. Most generators expose every operation by default (FastMCP, harsha-iiiv, ivo-toby, emcee, AWS Labs, Stainless).
- Opt-in read-only: Stainless `allow_http_gets`, Speakeasy `--scope read`, Supabase `read_only=true`, postgres-mcp `restricted`, ivo-toby `--operation get`.
- Confirmation: Executor enforces approval policies in the proxy and pauses executions. Supabase confirms costs through MCP elicitation. FastMCP's `Approval` is explicitly advisory. Speakeasy emits `readOnlyHint` and `destructiveHint` annotations, which leaves the decision to the client.
- Dry-run for writes: not documented by any project checked (unverified beyond those projects).
- SQL side: a real parser is good practice but not unique. postgres-mcp parses with pglast and runs read-only transactions; dbhub uses a keyword classifier plus the engine's read-only mode; Data API builder avoids raw SQL entirely. The Datadog finding on the reference server (multi-statement `COMMIT` escape) is the strongest argument for combining parser validation, single-statement execution, a read-only transaction and a read-only role.
- Recommendation: make "safe by default" the headline. Default-deny writes, an explicit allowlist, server-enforced confirmation for destructive operations (MCP elicitation when the client supports it, a confirmation token otherwise) and dry-run on every write, all in a config file that can be reviewed in a pull request.

### 3. Generated skills

**Verdict: Partly.**

- MCP Toolbox's `skills-generate` (February 2026) already generates SKILL.md files with one script per tool from a toolset. Skill_Seekers (15,141 stars) generates skills from OpenAPI files (`skill-seekers create openapi.yaml`) as documentation, without an MCP server.
- dbhub and Neon ship hand-written skills; Executor serves built-in guides through a `skills` tool; AWS Labs generates MCP prompts per operation; cnoe-io generates a system prompt with an LLM.
- Serving skills over MCP is now standard: the MCP Skills extension (SEP-2640) is Final, Cloudflare's server already serves skills through it, and FastMCP has a Skills Provider.
- Not found: deterministic workflow skills generated from the same source as the server, naming the real curated tools, the safety mode and the confirmation flow, with examples that are tested.
- Recommendation: position skills as "workflow recipes that match your server exactly", write them for Claude Code, Codex and Cursor, also serve them through the MCP Skills extension, and credit MCP Toolbox and Skill_Seekers in the comparison.

### 4. Auth handled properly

**Verdict: Challenged as a differentiator.**

- harsha-iiiv/openapi-mcp-generator supports the same set (API key, bearer, basic, OAuth2 client credentials) from env vars. AWS Labs adds Cognito, ivo-toby offers a pluggable `AuthProvider` with token refresh, emcee resolves 1Password references, Stainless and Gram handle OAuth, and Executor keeps credentials out of the agent entirely.
- Explicit, tested redaction of secrets in logs, errors, tool results and dry-run output is rarely documented (Executor states credentials never reach the agent).
- Recommendation: keep it as a quality bar, not a headline. Publish the redaction tests and a short threat model.

### 5. Token cost visibility

**Verdict: Partly.**

- Cloudflare and dbhub publish tool-list token counts in their READMEs, Gram tracks token use and cost in production, and Claude Code warns when a single MCP tool output exceeds 10,000 tokens.
- No local CLI command was found that reports the tool-list token cost of a generated server before it is connected (unverified beyond the projects listed).
- With client-side tool search now common, tool-list size alone matters less than it did in 2025.
- Recommendation: keep `apitame inspect`, but make it compare modes (1:1, curated, search-only), include response-size budgets, label the numbers as estimates (tokenizers differ by model) and support a CI threshold.

## Positioning

- Lead with safety: "a safe MCP server and agent skills for any OpenAPI spec or SQL database, in one npx command". Read-only by default, explicit write allowlist, server-enforced confirmation for destructive operations and dry-run everywhere. Executor is the closest match, but it runs as a daemon or hosted service; apitame is a CLI plus a config file that lives in the repo.
- Treat search plus call as table stakes and say so in the README comparison. Compete on automatically generated task-level tools with a hard cap, and prove it with a published eval rather than by claiming everyone else floods the context.
- Present skills as recipes that exactly match the generated server: deterministic, tested, written to the skills folders of Claude Code, Codex and Cursor, and also served through the MCP Skills extension.
- Pitch the SQL side as the safe successor to the deprecated reference Postgres server (still about 128k npm downloads a week) for PostgreSQL and SQLite: parser-validated SELECT-only queries, single statements, read-only transactions, row limits and timeouts. Credit postgres-mcp and dbhub for prior work.
- One TypeScript CLI covers both OpenAPI and SQL with no Python, framework code, daemon or account. Most alternatives cover only one input type or need a framework or platform.
- Treat auth and `inspect` as hygiene: document the redaction tests and the CI token budget rather than headlining them.

## Sources

- https://github.com/PrefectHQ/fastmcp
- https://gofastmcp.com/integrations/openapi
- https://gofastmcp.com/servers/transforms/tool-search
- https://gofastmcp.com/apps/providers/approval.md
- https://gofastmcp.com/llms.txt
- https://pypi.org/project/fastmcp/
- https://github.com/awslabs/mcp/tree/main/src/openapi-mcp-server
- https://github.com/UsefulSoftwareCo/executor
- https://github.com/UsefulSoftwareCo/executor/blob/main/apps/docs/mcp-proxy.mdx
- https://github.com/UsefulSoftwareCo/executor/blob/main/apps/docs/concepts/policies.mdx
- https://github.com/harsha-iiiv/openapi-mcp-generator
- https://github.com/mattt/emcee
- https://github.com/ivo-toby/mcp-openapi-server
- https://github.com/speakeasy-api/gram
- https://github.com/speakeasy-api/gram/blob/main/server/internal/mcp/dynamic_tool_calling.go
- https://www.speakeasy.com/docs/standalone-mcp/customize-tools
- https://speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2
- https://www.stainless.com/docs/mcp/index.md
- https://www.stainless.com/docs/mcp/permissions/index.md
- https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs
- https://app.stainless.com/docs/guides/generate-an-mcp-server
- https://github.com/tadata-org/fastapi_mcp
- https://github.com/IBM/mcp-context-forge
- https://github.com/AmoyLab/Unla
- https://github.com/cloudflare/mcp
- https://github.com/janwilmake/openapi-mcp-server
- https://github.com/higress-group/openapi-to-mcpserver
- https://github.com/cnoe-io/openapi-mcp-codegen
- https://github.com/googleapis/mcp-toolbox
- https://github.com/googleapis/mcp-toolbox/blob/main/docs/en/documentation/configuration/skills/_index.md
- https://github.com/bytebase/dbhub
- https://github.com/bytebase/dbhub/blob/main/docs/tools/execute-sql.mdx
- https://github.com/bytebase/dbhub/blob/main/docs/claude-code-plugin.mdx
- https://github.com/crystaldba/postgres-mcp
- https://github.com/supabase/mcp
- https://github.com/supabase/mcp/blob/main/packages/mcp-server-supabase/src/tools/confirmation.ts
- https://github.com/Azure/data-api-builder
- https://learn.microsoft.com/azure/data-api-builder/mcp/overview
- https://github.com/centralmind/gateway
- https://github.com/modelcontextprotocol/servers-archived
- https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/
- https://github.com/neondatabase/mcp-server-neon
- https://github.com/benborla/mcp-server-mysql
- https://github.com/runekaagaard/mcp-alchemy
- https://github.com/executeautomation/mcp-database-server
- https://github.com/pgEdge/pgedge-postgres-mcp
- https://github.com/yusufkaraaslan/Skill_Seekers
- https://modelcontextprotocol.io/extensions/skills/overview
- https://code.claude.com/docs/en/mcp
- https://cursor.com/blog/dynamic-context-discovery
- https://github.com/openai/codex
- https://codex.danielvaughan.com/2026/06/25/codex-cli-mcp-tool-search-default-livemcpbench-retrieval-bottleneck-scalable-discovery/
- https://api.npmjs.org/downloads/point/last-week/@modelcontextprotocol/server-postgres
- https://pypistats.org/api/packages/postgres-mcp/recent
