# Demo script

The README shows `docs/assets/demo.svg`, an animated terminal built from the real CLI output by `scripts/render-demo.mjs`. This page describes how to regenerate it and how to record a real 30-second GIF of the same story.

## The story (30 seconds)

1. **0 to 8 s.** `npx apitame init ./openapi.yaml --name github`: 38 GitHub endpoints become 8 tools, writes are blocked, about 60% fewer tokens, config and skills written.
2. **8 to 15 s.** `npx apitame inspect`: the tool table, the token comparison, blocked operations, the skill.
3. **15 to 22 s.** `npx apitame test`: every read operation passes against the mock, and the blocked-write safety check passes.
4. **22 to 30 s.** `npx apitame add-to claude-code --write`, then in Claude Code ask: "Which open issues in octocat/hello-world mention docs?" The agent calls `issues`, then asks to close one and is told the server is read-only.

## Regenerate the animated SVG

```bash
pnpm build
node scripts/render-demo.mjs   # writes docs/assets/demo.svg
```

It runs the commands in a temporary folder with the GitHub example and lays the output out as three scenes. No recording tools are needed.

## Record a GIF with VHS

[VHS](https://github.com/charmbracelet/vhs) records terminal sessions from a script.

```bash
brew install vhs            # or see the VHS README for other platforms
pnpm build && npm link      # makes `apitame` available like the published package
vhs docs/demo.tape          # writes docs/assets/demo.gif
```

`docs/demo.tape` contains:

```text
Output docs/assets/demo.gif
Set FontSize 16
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Env NO_COLOR ""

Hide
Type "cd $(mktemp -d) && cp ~/src/apitame/examples/github-subset/openapi.yaml . && clear" Enter
Show

Type "npx apitame init ./openapi.yaml --name github" Sleep 400ms Enter
Sleep 4s
Type "npx apitame inspect" Sleep 300ms Enter
Sleep 5s
Type "clear && npx apitame test | tail -6" Sleep 300ms Enter
Sleep 4s
Type "npx apitame add-to claude-code --write" Sleep 300ms Enter
Sleep 4s
```

Adjust the `cp` path to your checkout. Keep the GIF under 5 MB (GitHub renders larger files slowly): `gifsicle -O3 --lossy=60 docs/assets/demo.gif -o docs/assets/demo.gif`.

## Record the agent part

The last step needs a real client, so record it separately:

1. Set `GITHUB_TOKEN` (a fine-grained token with read access is enough).
2. In the temporary folder run `claude` and ask the question above.
3. Record the terminal with your screen recorder of choice at 1200x640, trim to 8 seconds, and convert with `ffmpeg -i in.mov -vf "fps=12,scale=1200:-1:flags=lanczos" -loop 0 agent.gif`.
4. Concatenate with the VHS output (for example in any GIF editor) or show it as a second image under the first.

## Checklist before publishing a new demo

- Numbers in the demo match the README (tools, tokens, percentage).
- No real token appears anywhere on screen.
- The terminal is at least 100 columns wide so tables do not wrap.
- The final frame shows `add-to` succeeding.
