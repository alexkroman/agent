---
"@alexkroman1/aai": patch
---

Stop re-exporting test-only conformance suite from runtime barrel; this previously pulled `vitest` into the production bundle and crashed the deployed server with ERR_MODULE_NOT_FOUND.
