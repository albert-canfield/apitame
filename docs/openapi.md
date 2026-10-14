# OpenAPI sources

apitame reads an OpenAPI 3.0 or 3.1 document (or a Swagger 2.0 one, converted on the fly) and serves the API as a small set of MCP tools. Requests go straight from the apitame process to the API; there is no generated code and no proxy service.

## Inputs

```bash
npx apitame init ./openapi.yaml                      # JSON or YAML file, external $refs allowed
npx apitame init https://api.example.com/openapi.json
npx apitame init https://api.example.com             # base URL: apitame looks for the spec
```

Given a base URL, `init` tries the URL itself, then `/openapi.json`, `/openapi.yaml`, `/swagger.json`, `/v3/api-docs`, `/api-docs`, `/api/openapi.json`, `/docs/openapi.json` and `/.well-known/openapi.json`.

Swagger 2.0 documents are converted to OpenAPI 3 in memory every time they are loaded; the file itself is never changed. The conversion covers what apitame uses:

- `host`, `basePath` and `schemes` become the server URL (https preferred);
- `body` parameters become a request body for each type in `consumes`;
- `formData` parameters become an `application/x-www-form-urlencoded` body, or `multipart/form-data` when there is a `file` field;
- `collectionFormat` becomes `style` and `explode` (`csv`, the Swagger 2.0 default, is not exploded; `multi` is);
- response schemas are attached to each type in `produces`;
- `securityDefinitions` become security schemes, so `init` can suggest auth;
- `x-nullable` becomes `nullable`, and `type: file` becomes a binary string.

Swagger 1.x is not supported.

## Base URL

Requests go to, in order of preference:

1. `source.baseUrl` in the config (or `--base-url` at init time). It may use `${VAR}`.
2. The first entry in `servers`, with server variables replaced by their defaults.
3. A relative server URL resolved against the spec URL, when the spec was loaded from a URL.

If none is available, tool calls return an error asking you to set `source.baseUrl`.

## From operations to tools

### Normalization

For each operation apitame builds:

- an id: the `operationId`, or one generated from the method and path (`GET /repos/{owner}/{repo}` becomes `getReposByOwnerByRepo`). Duplicates get a numeric suffix.
- an input schema: one property per path, query, header and cookie parameter, plus `body` for the request body. Path-level and operation-level parameters are merged. Headers handled by auth (and `Authorization`, `Content-Type`, `Accept`, `Cookie`) are not exposed.
- a compact JSON Schema: `nullable` becomes a type union, `oneOf` is relaxed to `anyOf`, simple `allOf` compositions are merged, `readOnly` properties are dropped from requests, recursive schemas are cut at the first repetition, nesting deeper than six levels collapses, and descriptions are trimmed to 160 characters. This keeps tool definitions small without losing what the agent needs to build a valid call.
- an access level: read, write or destructive (see [safety.md](safety.md#access-levels)).

Request bodies are sent as JSON, `application/x-www-form-urlencoded` or text. Operations whose only body types are `multipart/form-data` or `application/octet-stream` are marked unsupported for now; they appear in `search_operations` with that status.

### Grouping

`init` groups operations into task-level tools:

1. Each operation goes to the group of its first tag, or of the first meaningful path segment when it has no tags (`/v1/api/invoices/{id}` groups under `invoices`).
2. Groups are ranked by how many read operations they have. The top ones become tools, up to `limits.maxTools` (default 12, counting `search_operations` and `call_operation`).
3. Inside a group, reads come first, then writes, then destructive operations; shorter paths before longer ones. At most `limits.maxOperationsPerTool` (default 15) stay in the tool.
4. Everything else, including deprecated operations, goes to the long tail.

The result is written to `tools:` in the config. It is a starting point: rename tools, move operations, split or merge groups, or delete entries. apitame never regenerates this section unless you run `init --force`.

A tool with one operation takes that operation's parameters directly. A tool with several takes:

```json
{ "operation": "issues/list-for-repo", "params": { "owner": "octocat", "repo": "hello-world", "state": "open" } }
```

Its description lists each operation as a one-line signature, for example `issues/get(owner: string, repo: string, issue_number: integer): Get an issue`. When the agent sends invalid params, the error includes the full schema of that operation, so it can correct itself in one step.

### The long tail

With `longTail.enabled: true` (the default) two more tools are added:

- `search_operations` (`query`, `limit?`): keyword search over every operation, including ones in other tools and blocked ones. Each result has the id, method, path, summary, access level, status (`available`, `blocked: ...`, `unsupported: ...`), the tool it belongs to, and a signature. The best three results also include the full input schema.
- `call_operation` (`operationId`, `params`, plus `dryRun` and `confirm` when writes are enabled): calls any available operation by id, under the same rules as the grouped tools.

## Responses

Every tool that reads JSON accepts an optional `fields` argument: a list of dot paths to keep. Arrays are handled transparently, so on a search result

```json
{ "operation": "search/repos", "params": { "q": "mcp language:typescript" }, "fields": ["total_count", "items.full_name", "items.stargazers_count"] }
```

returns `total_count` and, for every item, only `full_name` and `stargazers_count`. Selection happens before the size cap, so more items fit. If an operation has its own parameter called `fields` (common in Google and JSON:API style APIs), the API parameter wins in single-operation tools; in grouped tools it lives inside `params` and there is no clash.

Results are compact JSON: `{"status": 200, "data": ...}`. Non-2xx statuses are returned with `isError: true` and the API's error body, so the agent can read the reason. Responses larger than `limits.maxResponseBytes` are trimmed (arrays are cut to the items that fit) with a `note` explaining what happened.

## Auth

```yaml
auth:
  type: bearer
  token: ${GITHUB_TOKEN}
```

| Type | Fields |
| --- | --- |
| `none` | |
| `bearer` | `token` |
| `apiKey` | `in` (`header`, `query` or `cookie`), `name`, `value` |
| `basic` | `username`, `password` |
| `oauth2` | `tokenUrl`, `clientId`, `clientSecret`, `scopes`, `audience?`, `clientAuthMethod` (`client_secret_basic` default, or `client_secret_post`). Client credentials flow only. |

Secret fields must be `${ENV_VAR}` references. `init` reads `components.securitySchemes` and pre-fills the auth block with variables named after the server (`GITHUB_TOKEN`, `STRIPE_API_KEY`, ...), and adds them to `.env.example`.

OAuth2 tokens are fetched on first use, cached until 30 seconds before they expire, shared between concurrent calls, and refreshed once automatically when the API answers 401.

Operations with `security: []` in the spec are called without credentials. Static extra headers can be set with `source.headers` (values may use `${VAR}` and are treated as secrets).

## Testing against a mock

`apitame test` starts a local HTTP server that answers every operation with a sample built from its response schema (using `example`, `default`, enums and formats), points the runtime at it, and calls every read operation through the same tool the agent would use. It then calls every blocked write and checks that each one is refused without a request being sent. Credentials that are not set are replaced by placeholders, so you can run it before configuring auth.

`apitame test --live` calls the real API instead (reads only) and validates each response against the spec, which is a quick way to find spec drift. 404 with sample arguments is reported as a warning, 401, 403 and 5xx as failures.
