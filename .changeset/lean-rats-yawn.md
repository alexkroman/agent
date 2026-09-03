---
"aai-server": patch
---

Record the measured disproof of the claim that INSERT ... ON CONFLICT DO NOTHING leaves a dead tuple on the read path, and re-justify workflow_sleeps_due_idx against the query that really uses it.
