---
"@alexkroman1/aai": patch
---

Remove duplication between the agent and workflow subsystems: share one JSON/500 responder across both HTTP surfaces, bound workflow run listings with mapInBatches instead of an unbounded Promise.all, and give both workflow Postgres stores one create-table memo that no longer caches a failure as done.
