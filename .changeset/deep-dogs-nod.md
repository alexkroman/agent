---
"@alexkroman1/aai": patch
---

Publish the greeting transcript once instead of twice: the fixed-phrase turns (greeting, start-failure line) reach TTS in a single call, so their interim `agent_transcript` was a byte-identical copy of the final — emitted final-first, the inverse of the documented partial-then-final order.
