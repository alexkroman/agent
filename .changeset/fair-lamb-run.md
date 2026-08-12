---
"@alexkroman1/aai": minor
---

`aai dev` runs workflows with no database. Provisioning Postgres just to try `workflow()` was friction with no upside — the store was already a seam and an in-memory implementation already existed as a test fake modelling the claim rules faithfully, which is exactly what a dev backend needs. It now ships (`createMemoryWorkflowStore`) and the dev server passes it when the project has no `DATABASE_URL`, warning that runs are lost on restart. `ctx.db` inside such a run still throws the enablement message rather than getting a second in-memory thing pretending to be a database, so the durability primitives (`step`, `sleep`, `waitFor`) are exercisable locally and the moment a run touches a table it is told what to set. The CLI passes the store and the SDK never chooses it (`RuntimeOptions.workflowStore`): the SDK cannot tell a dev machine from a deployed guest, and a durability guarantee that depends on that guess would only fail on the day you ship.
