---
"aai-server": patch
"@alexkroman1/aai-runtime": patch
---

Collapse duplicate workflow-journal round trips and widen the platform admin pool.

A deployed run's every journal operation is one `POST /:slug/workflow-journal`, measured at ~840 ms of platform time each. Three things multiplied them: a fan-out's stale-snapshot check re-read the whole journal once per step, overlapping walks each opened with their own `getRun` and `readSteps`, and every delivery took three of those round trips sequentially before a body ran.

Concurrent identical `getRun`/`readSteps` now share one round trip (a coalescer, not a cache — no caller is answered from a read that started before it asked), and a delivery's step read is issued beside the `running` compare-and-set rather than after it. `ADMIN_POOL_MAX` goes 4 to 16: guest platform routes reserve a connection for the whole request, so 4 was a hard ceiling of four in-flight guest calls per replica, and with `PLATFORM_POOLER_URL` in transaction mode the pool costs the instance's max_connections nothing.
