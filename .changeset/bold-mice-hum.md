---
"aai-server": patch
---

Close four more resilience findings. R3: the slug lock's 15s acquire deadline was unreachable for same-replica contention, because both paths take the in-process mutex before the Postgres one — the mutex now carries the same deadline and a waiter that gives up releases its place in the chain. R4: blob WRITES now retry transient network errors like reads do; the write path moves far more bytes and is idempotent by construction (content-hash key plus upsert). R6: MAX_PLATFORM_DB_CONNECTIONS plus platform-db-budget.test.ts pin MAX_CONTAINERS x the per-replica direct-connection pools, which spanned two files that never referred to each other. R7: a guest's idle self-exit now drops the whole slot, not just its sandbox, so the map no longer grows one shell per slug for the life of the container.
