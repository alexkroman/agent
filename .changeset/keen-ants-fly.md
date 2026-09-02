---
"@alexkroman1/aai-runtime": patch
---

Fix the in-memory workflow correlation-key index to record each run id at most once, matching the Postgres store's `on conflict (run_id) do nothing`. A retried `record` after a lost connection used to list the same run twice, promote it past a newer run, and index it under a second key — found by the new shared WorkflowKeyStore conformance table.
