# GitHub API subset example

38 real GitHub REST endpoints (repositories, issues, pull requests, search, users and stars) with bearer auth, pagination and search. A good stress test for tool grouping: 38 endpoints become 8 tools.

```bash
cd examples/github-subset
cp .env.example .env     # then put a token in GITHUB_TOKEN
npx apitame inspect      # 8 tools, about 1,950 tokens instead of about 5,500
npx apitame test         # mock run, no token needed
npx apitame test --live  # real API, read operations only
npx apitame add-to claude-code --write
```

A [fine-grained personal access token](https://github.com/settings/personal-access-tokens) with read-only access to public repositories is enough for every read tool. apitame never shows the token to the agent.

Things to ask an agent once it is connected:

- "What are the five most starred TypeScript MCP servers updated this month?" (`search/repos`)
- "Summarize the open issues labelled bug in octocat/hello-world." (`issues/list-for-repo`, `issues/get`)
- "Which files changed in the latest pull request of this repo?" (`pulls/list`, `pulls/list-files`)
- "Close issue 12." The server is read-only, so the agent explains how to enable `issues/update` instead.

`apitame.config.yaml` and `skills/` were generated with `npx apitame init openapi.yaml --name github`.
