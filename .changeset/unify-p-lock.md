---
"@alexkroman1/aai-server": patch
---

Replace async-lock with p-lock for all per-slug concurrency control. Consolidate slug-lock.ts into sandbox-slots.ts with two named lock layers (slotLock for sandbox lifecycle, apiLock for deploy/delete serialization). Use AbortController to cancel stale idle-eviction callbacks. Use Promise.withResolvers() in sandbox.ts.
