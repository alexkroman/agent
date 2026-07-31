---
"@alexkroman1/aai": minor
---

Extract shared concurrency primitives and adopt them across the stack: new `createEpoch` (staleness guard for async continuations) and `createOwnedMap` (map entries released by ownership token, so a stale teardown can't evict a successor's entry) exports, adopted in the host runtime's session/sink maps, the WebSocket handler, the platform slot cache, and the browser session core's generation counters. The pipeline transport's turn lifecycle (`turnController`/`turnSpoke`/`ttsAudioOpen`) is now an explicit state machine (`pipeline-turn-state.ts`) whose named transitions are the only mutation path, per-turn abort wiring uses native `AbortSignal.any` instead of the hand-rolled `linkAbort`, and the bespoke `Promise.race` timeout implementations were consolidated onto `p-timeout`.
