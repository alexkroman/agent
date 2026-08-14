---
"@alexkroman1/aai": patch
---

Clear orphaned workflow queue locks at startup. A hard-killed process (or one whose Postgres died) left its in-flight steps `locked_by` graphile-worker pool workers that no longer exist, and `get_job` selects on `is_available = true` — so the replacement pool polled straight past them and recovery waited on graphile-worker's four-hour reclaim, with the run sitting `running` and a page showing "Working…" indefinitely. One kill was enough. The world now clears those locks between its migration and the runner starting, gated on a session advisory lock so it only ever runs when no other pool is alive: unlocking a job a live worker is executing would run that step twice, which is worse than the wedge.
