---
"@alexkroman1/aai-runtime": minor
"aai-server": minor
"aai-studio-server": minor
---

A dialog state's or persona's demanding `toolChoice` now lets go, for the rest of the reply, once a step sent with it has made the call it demanded. The AI SDK now fails a pinned step that answers in text (`ToolChoiceViolationError`), so a pin held after its tool ran left a compliant model nothing to do but call it again until the final step. Also updates dependencies: vitest 5 (`aai-cli`'s optional vitest peer is now `^5.0.1`), dotenv 18, and minor/patch releases across the workspace. cbor-x moves to 1.6.6 with the native-extractor guard carried forward, and jsdom is held on 30.0.x until vitest 5.0.3 clears the release-age window.
