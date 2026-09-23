---
"@alexkroman1/aai-cli": patch
"@alexkroman1/aai-runtime": patch
"@alexkroman1/aai-ui": patch
---

Tighten promise handling found by the new type-aware lint: `aai start` awaits tracing shutdown inside an async stop routine, the in-process workflow engine's `dispatch` option now types the promise the engine already awaited, and `useCopy` checks for a missing clipboard explicitly.
