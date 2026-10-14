# Petstore example

The classic Swagger Petstore (OpenAPI 3.0, 19 operations), served by the public demo server at `https://petstore3.swagger.io/api/v3`. No credentials needed.

```bash
cd examples/petstore
npx apitame inspect      # 5 tools, about 850 tokens; 11 write operations blocked
npx apitame test         # every read against a local mock, plus the blocked-write check
npx apitame test --live  # the same against the public demo server
npx apitame serve        # stdio MCP server
```

The public demo server is shared by everyone who tries the Petstore, so expect `test --live` to report problems: some endpoints return HTTP 500, and records created by other visitors do not always match the spec (for example tags stored as plain strings). Finding that kind of drift is what `--live` is for; the mock run is the one that should always pass.

`apitame.config.yaml` and `skills/` were generated with `npx apitame init openapi.yaml`.

## Try write mode

Edit `apitame.config.yaml`:

```yaml
mode: read-write
writes:
  allow: [addPet, updatePet, deletePet]
```

Then regenerate the skill and inspect:

```bash
npx apitame init --skills-only
npx apitame inspect --verbose
```

`addPet` and `updatePet` now run directly (try `"dryRun": true` first), and `deletePet` asks for confirmation. The demo server resets its data regularly, so nothing you do here lasts.
