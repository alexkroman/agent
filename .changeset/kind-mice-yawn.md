---
"@alexkroman1/aai-cli": patch
---

Scaffolded projects get a vitest.config.ts separate from vite.config.ts, so running tests no longer depends on the client build's plugin imports resolving, and globals work with or without an explicit vitest import.
