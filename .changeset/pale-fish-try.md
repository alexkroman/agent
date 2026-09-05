---
"@alexkroman1/aai": patch
---

Shrink the aai/host-internal seam: move the session-event and app-db budgets to their only consumer in aai-runtime, drop twelve unimported value exports, and stop double-publishing eighteen names that already sit on the zod-free /internal subpath.
