---
"@alexkroman1/aai": minor
---

workflow() no longer throws when its body carries no compiler workflowId; the check moved to ctx.workflows.start, where the id is needed. A declaration-time throw made an agent module unimportable wherever the Workflow DevKit transform had not run — including its own unit tests.
