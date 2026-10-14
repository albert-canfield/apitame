# Tool-selection eval

apitame claims that a small set of task-level tools serves an agent better than one tool per endpoint (fewer tokens, clearer choices) and better than search and call alone (no extra round trips on every task). Token counts alone do not prove that. This eval measures what agents actually do: whether they finish real tasks, how many calls they need, how often they call the wrong thing, and what it costs.

It is development tooling. Nothing in `scripts/eval/` is part of the published package.

Status: the harness is ready and checked in CI with a scripted model. No results against a real model have been published yet (issue [#24](https://github.com/albert-canfield/apitame/issues/24)).

## What is measured

### Three surfaces, one variable

Every task runs on three tool surfaces built from the same spec, the same runtime and the same config. Only `tools` and `longTail` differ:

| Surface | Config | Petstore | GitHub subset |
| --- | --- | ---: | ---: |
| Curated | The example's committed `apitame.config.yaml` | 5 tools, ~855 tokens | 8 tools, ~2,087 tokens |
| One tool per endpoint | One group per operation, long tail off | 8 tools, ~882 tokens | 25 tools, ~4,390 tokens |
| Search and call only | `tools: []`, long tail on | 2 tools, ~356 tokens | 2 tools, ~355 tokens |

Token figures are apitame's estimates for the `tools/list` result plus the server instructions. All three surfaces run in read-only mode, so the one-tool-per-endpoint surface has one tool per read operation. That is why it is smaller than the "one tool per endpoint" column in the README, which counts writes too.

What stays the same on every surface:

- The spec, the runtime, read-only mode, argument validation and error messages.
- The server instructions, apart from the one sentence about `search_operations` that apitame adds only when the long tail is on.
- The system prompt, which is short and neutral: it says the agent is connected to the API through an MCP server, should base its answer on what the tools return, and should end with a short answer that states the values asked for. The server instructions follow it, as most MCP clients do.
- The client. The agent talks to apitame through the real MCP client over an in-memory transport, so the model sees exactly what `tools/list` returns and every call goes through `tools/call`.

### The API behind the tools

Calls go to apitame's mock server (`src/mock/server.ts`), not to the real API. Each task file describes one small, consistent world as fixtures: canned responses matched on path, query or body parameters. For the Petstore that is ten pets, two orders and a user; for the GitHub subset it is the repository `acme/rocket` with its issues, pull requests, reviews, releases and commits. Every task sees the same world, so an agent that makes an extra call to check something gets data that agrees with the rest. A task can add fixtures of its own, which are tried first. The mock records the operation id and arguments of every request, so grading is deterministic and needs no GitHub token. The rules:

- The first fixture whose `match` fits the request answers it.
- An operation that has fixtures, called with other arguments, gets a 404. Fixtures define the data for that operation.
- An operation without fixtures gets a sample response built from the spec.

The data is made up, so an agent cannot answer from memory.

### Tasks

Twelve tasks per API, in `scripts/eval/tasks/`:

| Kind | Petstore | GitHub subset | What it tests |
| --- | ---: | ---: | --- |
| `lookup` | 4 | 3 | One call with the right arguments. |
| `chain` | 3 | 3 | Two or more calls where a later call needs a value from an earlier result, for example "find the most commented open issue, then read its latest comment". |
| `long-tail` | 2 | 3 | Operations an agent rarely needs, such as repository languages, file contents or pull request reviews. |
| `blocked-write` | 3 | 3 | A write the read-only server refuses. Success means the agent explains and stops. |

### Grading

A run succeeds only if every check passes:

1. **Finished.** The agent stopped on its own with an answer, within the turn limit (12 model requests by default), without an error or a refusal.
2. **Required calls.** Each required operation reached the mock API with its key arguments. A requirement can list several routes to the same data (`anyOf`), for example listing a repository's issues or searching them.
3. **Nothing forbidden.** The agent did not attempt any write operation or any operation the task forbids. An attempt counts even when apitame blocks it: the server instructions and the search results already say the server is read-only, so a well-behaved agent never needs to try.
4. **Answer.** The final answer contains every `includes` substring, matches every `regex` and contains none of the `excludes` substrings (all case-insensitive).

Argument checks compare the request the mock received: a plain value must be equal (strings ignore case), a list must all be present (repeated query parameters or comma-separated values), and `{ contains: ... }` or `{ regex: ... }` look inside the value.

### Metrics

For each task, surface and model:

| Metric | Source |
| --- | --- |
| Success over N runs | The graders above. |
| Tool calls, and failed calls | The transcript. A failed call is one whose result is an error: blocked, invalid arguments, unknown operation or an HTTP error. |
| Input, output, cache read and cache write tokens | The provider's `usage` report, summed over the run. Input means uncached input. |
| Wall time | Model and tool time for the run, without time spent waiting to retry. |
| Estimated cost | Tokens times list prices (see below). An estimate, not a bill. |

The summary also shows "prompt tokens", the sum of uncached input, cache reads and cache writes: how much the model read, with or without caching.

## How to run

```bash
pnpm install
pnpm eval --provider fake                    # no key, no network: checks the harness and graders
ANTHROPIC_API_KEY=... pnpm eval --model claude-sonnet-5 --api github-subset --runs 5
ANTHROPIC_API_KEY=... pnpm eval --model claude-haiku-4-5-20251001 --runs 5
pnpm eval --help
```

| Option | Default | Description |
| --- | --- | --- |
| `--provider <name>` | `anthropic` | `anthropic`, or `fake` for the scripted model. |
| `--model <id>` | | Model id. Required for `anthropic`. |
| `--api <ids>` | all | `petstore`, `github-subset`, comma separated. |
| `--surface <ids>` | all | `curated`, `per-endpoint`, `search-only`, comma separated. |
| `--task <ids>` | all | Only these task ids. |
| `--runs <n>` | `1` | Runs per task and surface. Published results use 5. |
| `--concurrency <n>` | `1` | Runs in parallel. |
| `--max-turns <n>` | `12` | Model requests per run before it counts as a failure. |
| `--max-tokens <n>` | `16000` | `max_tokens` per model request. |
| `--effort <level>` | model default | `output_config.effort`, for models that support it. |
| `--no-cache` | | Turn prompt caching off. |
| `--price-input <usd>`, `--price-output <usd>` | | Prices per million tokens, for a model without a known price. |
| `--out <dir>` | `eval-results/<date>-<provider>-<model>` | Output folder (ignored by git). |

Each run starts a fresh mock API, runtime and MCP session, so runs never share state or rate limits. Jobs go in run-major order (every task and surface gets its first run before any second run), so a slow period on the provider's side does not land on one surface.

### Output

| File | Contents |
| --- | --- |
| `summary.md` | The header (date, provider, model, apitame version, commit, exact command), a table per API, success by task and the failed runs with the reason. |
| `summary.json` | The same numbers, for scripts. |
| `transcripts.jsonl` | One line per run: the checks, metrics, final answer, every request the mock API received, and the full conversation with tool calls, tool results and per-turn usage. |
| `surfaces.json` | Exactly what the model saw on each surface: the `tools/list` result and the server instructions. |
| `meta.json` | The run settings and the list prices used. |

### The Anthropic provider

It calls the Messages API with client-side tool use over plain `fetch` (no SDK dependency). The key is read from `ANTHROPIC_API_KEY` only, sent only in the `x-api-key` header, and never written to any output or log; every output file is also scrubbed for its value. Prompt caching is on by default, as in most agent clients: one breakpoint after the system prompt (which caches the tool list) plus automatic caching of the growing conversation. Thinking and effort follow the model's defaults unless `--effort` is set. Overloaded, rate-limited and server errors are retried with backoff; a refused key or an unknown model stops the eval.

`ANTHROPIC_BASE_URL` points it at another endpoint, such as a proxy.

### The scripted model

`--provider fake` replays the calls listed under `fake.steps` in each task, one per turn, translated to what the surface offers: the grouped tool, the single-operation tool, or `search_operations` followed by `call_operation`. Then it gives the scripted answer. Its token counts are apitame's estimates of what it was sent. It exists so that the harness, fixtures and graders keep working in CI without keys; its numbers say nothing about models. `tests/integration/eval-harness.test.ts` runs every task on every surface with it, and checks that the graders fail wrong answers, missing calls, wrong arguments, attempted writes and runs that hit the turn limit.

## Cost

A rough estimate for the full phase 1 set (24 tasks, 3 surfaces, 5 runs: 360 runs per model). It is an estimate, not a quote.

The scripted model makes the fewest possible calls, so pricing its token counts gives a floor: `pnpm eval --provider fake --model <id> --runs 5` prints it. At October 2026 list prices ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)), without caching, that floor is about $3.40 for `claude-sonnet-5`, $1.70 for `claude-haiku-4-5-20251001` and $6.90 for `claude-opus-5-5`.

Real models take extra turns, write longer answers and may think before calling a tool. Plan for two to four times the floor: roughly $7 to $14 for Sonnet 5, $3.50 to $7 for Haiku 4.5 and $14 to $28 for Opus 5.5. Prompt caching lowers the input part. Try `--runs 1` on one API first and scale from its real cost.

List prices live in `scripts/eval/pricing.ts`. Check the provider's pricing page before publishing, and report the cost from the provider's usage report.

## How results are published

For each API and model, `docs/eval.md` will get a results table copied from `summary.md`, with:

- the date, the exact model ids, the apitame version and the commit,
- the exact command,
- success, tool calls, failed calls, tokens (input, cache reads, output), time and cost per surface, and success by task.

The raw `transcripts.jsonl`, `surfaces.json`, `meta.json` and `summary.json` go into a GitHub release as an asset, so anyone can check a number against the conversations behind it.

Results are published whatever they show, including runs where the curated surface does not win. If the eval finds that a surface or a default should change, that change gets its own pull request with the numbers.

## Writing tasks

Tasks written by someone other than the maintainer reduce bias, so contributions are welcome. A task file, `scripts/eval/tasks/<api>.yaml`, starts with the shared fixtures and then lists the tasks:

```yaml
api: petstore
fixtures:
  - operation: getOrderById
    match: { orderId: 5 }
    body: { id: 5, petId: 12, quantity: 1, status: approved, complete: false }
  - operation: getPetById
    match: { petId: 12 }
    body: { id: 12, name: Clover, status: pending, category: { id: 4, name: Rabbits } }
  # ...
tasks:
  - id: order-to-pet
    kind: chain
    prompt: Which pet was ordered in store order 5? Give me the pet's name and its category.
    required:
      - operation: getOrderById
        args: { orderId: 5 }
      - operation: getPetById
        args: { petId: 12 }
    forbidden: [] # writes are always forbidden (forbidWrites: true)
    answer:
      includes: [Clover, Rabbits]
    fake:
      steps:
        - operation: getOrderById
          params: { orderId: 5 }
        - operation: getPetById
          params: { petId: 12 }
      answer: Order 5 was for pet 12, Clover, in the Rabbits category.
```

Guidelines:

- Write the prompt the way a user would. Do not name operations or tools.
- Use made-up data, so the answer cannot come from the model's memory.
- Add the data to the shared fixtures and keep it consistent: a pet listed as sold must be sold when fetched by id too. YAML anchors (`&rex`, `*rex`) help.
- Give fixtures for every route a reasonable agent might take, and list those routes under `anyOf`. A fixture's `match` uses the same matchers as `args`, so `{ q: { regex: 'is:pr' } }` works.
- Keep answer checks to the facts that matter, and allow reasonable formats (`4,?821` for "4821" and "4,821").
- `pnpm test` checks that every operation id exists in the spec and that the scripted model passes the task on all three surfaces.

## Adding a provider

A provider implements `Provider` in `scripts/eval/types.ts`: `session(task, surface)` returns an object whose `next({ system, tools, messages })` returns the text, the tool calls, the usage and the stop reason for one model request. The conversation format is provider-neutral; see `scripts/eval/providers/anthropic.ts` for the conversion to one provider's API. Keys come from environment variables only.

## Limits

- Both example APIs are small and fit easily in context. Differences between surfaces should grow with the size of the spec. Phase 2 adds the full Stripe spec (with a fourth surface that matches what clients do today: one tool per endpoint with provider-side tool search) and the shop database.
- The API is a mock with fixtures. It checks tool selection and arguments, not how agents cope with real API quirks.
- Answer checks are substrings and regular expressions. A correct answer worded in an unexpected way can fail, so read the failed runs before drawing conclusions.
- One provider so far. A second one is a small file.
