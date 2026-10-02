---
"@alexkroman1/aai-runtime": patch
"aai-studio-server": patch
---

Studio idle reaping binds the sandbox with `await using`, so it is terminated
even if a release step throws; the remaining hand-rolled waits use the shared
primitives.
