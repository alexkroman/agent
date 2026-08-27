---
"@alexkroman1/aai-cli": minor
---

Add `aai storage enable --tier <storage|workflow>`, so an agent with no durable workflows is provisioned with a smaller per-role Postgres connection entitlement (4 rather than 10). Re-running with a different tier reconciles an existing database's limit without rotating the credential the resident guest is holding.
