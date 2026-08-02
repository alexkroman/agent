---
"@alexkroman1/aai-ui": patch
---

Internal cleanups: prefetch audio modules at connect time so the chunk load overlaps the WebSocket handshake, remove per-frame Uint8Array view allocations on both audio hot paths, memoize the streaming message bubble and Markdown renderer map, drop the default console.warn audio diagnostics wiring, and dedupe URL/base-path helpers.
