---
"@alexkroman1/aai": patch
---

Split the pipeline transport's session lifecycle (provider open, greeting, provider-error teardown, stop) into pipeline-transport-lifecycle.ts, keeping pipeline-transport.ts to turn orchestration. No behaviour change.
