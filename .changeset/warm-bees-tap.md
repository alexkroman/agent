---
"@alexkroman1/aai-cli": minor
---

Ship the agent templates inside the CLI tarball instead of fetching them from GitHub at init time. `aai init` now works offline, and templates are pinned to the installed CLI version rather than tracking `main`. This also puts them inside the studio's guest sandbox, where the coding agent can read them for worked examples.
