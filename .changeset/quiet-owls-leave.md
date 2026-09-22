---
"aai-studio-server": patch
"aai-studio-client": patch
---

Remove the studio's "Work locally" card — the `npm i -g` / `aai login` / `aai pull <project>` / `aai dev` command list on the Settings pane — and the `cli-commands.tsx` component that existed only to render it.

GitHub sync is the one way out of the studio the product points at, and a second, copy-pasted path beside it split the answer to "how do I get this code?" in two. The Settings pane is now Sync to GitHub (when the platform has a GitHub App) and Danger zone; `settings.test.tsx` asserts no `aai pull` renders so the list does not come back in a follow-up. The CLI's own `pull` subcommand and the server routes behind it are untouched — this changes what the studio advertises, not what the platform serves.

`aai-studio-server` is named because `aai-studio-client` ships only as a side effect of a server release (`guard-invariants` rule 20).
