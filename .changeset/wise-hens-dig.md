---
"@alexkroman1/aai-ui": patch
"@alexkroman1/aai-cli": patch
---

Workflow hooks report a failure's own message rather than `[object Object]` when a rejection is message-bearing without being an `Error` — `useWorkflowRun` and `useWorkflows`/`useWorkflowSubmit` now unwrap it with the SDK's `errorMessage` instead of a local `instanceof Error` ternary.
