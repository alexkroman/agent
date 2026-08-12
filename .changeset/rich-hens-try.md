---
"@alexkroman1/aai": minor
---

A failed workflow run is no longer a dead end: ctx.workflows.retry(runId) sends a failed or cancelled run back to the queue, keeping its journal so it resumes from the last completed step rather than starting over. Reachable as POST /workflows/runs/:id/retry, and offered beside Stop in the studio's Settings pane.
