---
"@alexkroman1/aai-runtime": patch
---

A part re-sent while its first attempt is still draining no longer fails with a 500: the local blob and record stores give each write attempt its own temp path instead of sharing a fixed one.
