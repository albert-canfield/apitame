# Contributing to apitame

Thanks for helping. Bug reports with a spec or schema that breaks apitame are especially valuable, as are pull requests that make the safety model stronger.

## Development setup

Requirements: Node.js 22.14 or later, and pnpm 10.

```bash
git clone https://github.com/albert-canfield/apitame.git
cd apitame
pnpm install
pnpm build
pnpm test
```

Run the CLI from source without building:

```bash
pnpm exec tsx src/cli.ts init examples/petstore/openapi.yaml --out /tmp/petstore
pnpm exec tsx src/cli.ts inspect --config /tmp/petstore/apitame.config.yaml
```

Or link the built CLI so `apitame` works like the published package:

```bash
pnpm build && npm link
apitame --version
```

No Docker is needed for the test suite: PostgreSQL tests run against PGlite (PostgreSQL compiled to WebAssembly) over the real wire protocol. To try a full server, use `examples/postgres-shop`.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm build` | Bundle `dist/` with tsup. |
| `pnpm test` | Run unit, integration and end-to-end tests with vitest. |
| `pnpm test:coverage` | Same, with coverage. |
| `pnpm lint` | ESLint and Prettier check. |
| `pnpm format` | Prettier write. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `node scripts/render-demo.mjs` | Regenerate the README demo from real output (after `pnpm build`). |
| `pnpm eval` | Run the tool-selection eval ([docs/eval.md](docs/eval.md)). `pnpm eval --provider fake` needs no key. |

## Conventions

- **TypeScript, ESM, strict.** No `any` in new code without a reason in a comment.
- **Match the surrounding code**: naming, comment density, small functions with one job.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`, with an optional scope such as `feat(sql):`. Keep commits small.
- **Safety changes need tests.** Anything that touches `src/safety`, `src/sources/sql/guard.ts`, `src/sources/sql/lexer.ts`, auth or redaction must come with tests, including at least one case that should be refused.
- **Never log or return a secret.** Route any text that may contain one through the `Redactor`. Do not attach caught errors as `cause` when their message may hold credentials.
- **Logs go to stderr.** Stdout belongs to the stdio transport.
- **Docs style**: plain English, short sentences, no em dashes. Update the docs in the same pull request as the behavior.
- **Decisions**: when you make a choice someone would otherwise have to rediscover, add an entry to [docs/decisions.md](docs/decisions.md).
- **Never commit secrets.** Use `.env` (ignored) and keep `.env.example` up to date.

## Project layout

See [docs/architecture.md](docs/architecture.md). In short: `src/cli` (commands), `src/sources/openapi` and `src/sources/sql` (inputs), `src/server` (runtimes and MCP wiring), `src/safety` (policy, confirmation, redaction), `src/generator` (config and skills), `tests/` (unit, integration, e2e).

## Pull requests

1. Open an issue first for larger changes, so we can agree on the approach.
2. Make sure `pnpm lint && pnpm typecheck && pnpm test` passes.
3. Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-facing changes.
4. Describe what changed and how you tested it.

## Reporting a spec or database that breaks apitame

Open an issue with the smallest spec or schema that shows the problem, the command you ran and the output. If the spec is private, a reduced version with renamed fields is perfect.

## Security

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
