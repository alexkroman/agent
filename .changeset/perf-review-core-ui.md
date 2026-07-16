---
"@alexkroman1/aai": minor
---

Performance pass across the SDK and UI.

Host runtime: client WebSocket audio sends are now guarded by a buffered-bytes cap (a stalled client is closed instead of accumulating unbounded audio in memory), pipeline TTS text is coalesced to clause boundaries after the first chunk instead of one message per word, the ElevenLabs STT opener batches mic audio to ~100 ms frames like AssemblyAI, the silence nudger keeps one long-lived timer instead of re-arming per STT partial, hot-path debug logs are gated behind `AAI_DEBUG` (new `createConsoleLogger` export), the in-memory vector store uses bounded top-K selection, and the default KV is constructed lazily.

UI: chat messages carry a monotonic `id` used as the render key (stable across the history-window slide), the chat list is memoized, new `useSessionSelector` export for narrow subscriptions, mic sends drop frames under WebSocket backpressure instead of queueing stale audio, the capture worklet batches ~100 ms of PCM per main-thread message (down from ~190/s), dedup hooks use watermarks instead of unbounded seen-sets, auto-scroll is rAF-deduped, and the playback worklet gained an aligned Int16 fast path.

Note one public type change in `@alexkroman1/aai-ui`: `ToolCallInfo.afterMessageIndex` (an index that drifted once history slid) is replaced by `afterMessageId`, and `ChatMessage` gained a required `id`. Nothing in the templates or repo consumed the old field, but custom client UIs reading `afterMessageIndex` must switch to `afterMessageId`.
