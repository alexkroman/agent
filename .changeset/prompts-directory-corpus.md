---
"aai-studio-server": patch
"@alexkroman1/aai": patch
---

Make two gate corpora directory-derived instead of hand-listed.

The studio's prompt modules move to `packages/aai-studio-server/src/prompts/`, so `check-doc-examples` reads that directory rather than four paths written out in the script. That list carried the cost in its own comment — a module with no code fence was listed anyway "so the first example added is checked rather than discovered by a user" — and unlike its `MARKDOWN_FILES` neighbour, which two gate specs floor at eight, nothing floored it: a fifth prompt module would have compiled under no gate. The script floors the count now.

In the SDK, the LLM stage's three non-vendor modules move to `providers/llm/shared/` and the channel shape and dispatcher to `channels/shared/`, which lets `konsistent.json` drop five `!` exclusions. A file directly under `providers/llm/` or `channels/` is a vendor or a channel because of where it sits, rather than because nobody forgot to exclude it.

No published symbol moves: every one of these modules is reached through a barrel, and the subpath exports are unchanged.
