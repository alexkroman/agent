---
"@alexkroman1/aai": major
---

Cut 21 documented-default constants and the workflow API's server half off the published authoring surface. The `DEFAULT_*`/`MAX_*` constants that used to sit on `@alexkroman1/aai` — every one except `DEFAULT_SYSTEM_PROMPT`, which an author composes against — are now on `@alexkroman1/aai/internal`, along with `clampWorkflowWait`, `MAX_WORKFLOW_WAIT_MS`, `TERMINAL_WORKFLOW_STATUSES` and `WORKFLOW_API_PREFIX` from `@alexkroman1/aai/workflow-api`. Every value, every doc comment and every default is unchanged; each field's own JSDoc still carries the value it defaults to. Code that reproduced a default or clamped a wait imports it from `/internal` instead. The root barrel is 102 exports to 81 and `/workflow-api` 35 to 31.
