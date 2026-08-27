---
"@alexkroman1/aai-runtime": minor
---

Preserve turn-level durability without a tenant database: a third SessionStateBackend that keeps a session's slots and event log on the platform, reached over HTTP. It wins over a DATABASE_URL, so a deployed agent's durability no longer depends on whether it provisioned a database. SessionStateBackend.name gains "platform" (epoch 1 retained — widening a field an implementor supplies is not breaking).
