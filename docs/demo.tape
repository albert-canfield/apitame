# Records docs/assets/demo.gif with VHS (https://github.com/charmbracelet/vhs).
# See docs/demo-script.md. Adjust the path to your checkout in the hidden setup step.
Output docs/assets/demo.gif
Set FontSize 16
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "cd $(mktemp -d) && cp ~/src/apitame/examples/github-subset/openapi.yaml . && export GITHUB_TOKEN=demo && clear" Enter
Show

Type "npx apitame init ./openapi.yaml --name github" Sleep 400ms Enter
Sleep 4s
Type "npx apitame inspect" Sleep 300ms Enter
Sleep 5s
Type "clear && npx apitame test | tail -6" Sleep 300ms Enter
Sleep 4s
Type "npx apitame add-to claude-code --write" Sleep 300ms Enter
Sleep 4s
