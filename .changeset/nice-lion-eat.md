---
"@alexkroman1/aai-runtime": patch
---

No SDK change. Platform groundwork for running the durable-workflow world on the platform's own database: a run-ownership table (the tenant boundary the DevKit's schema has no column for) and the world constructed against the platform's connection string with its pool pinned.
