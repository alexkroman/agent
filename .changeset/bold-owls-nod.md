---
"@alexkroman1/aai-cli": patch
---

Internal cleanup of the CLI: shared slug-scoped API request helper (secret/storage now share the not-deployed 404 hint), shared package-bin resolution, aai build moved to its own entry point owning the test/typecheck gates, single source for the agent.ts entry name and repo URL, and assorted dead-weight removal (duplicated error helpers, copy-paste spinner branches, misleading lazy import in the dev server).
