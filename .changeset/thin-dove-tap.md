---
"aai-studio-client": patch
---

Studio chat no longer wedges on 'Starting sandbox…' when opened during a server restart: the session broker call now has a per-attempt timeout, transient failures retry with backoff, and the error state offers an in-place Try again instead of requiring a page reload.
