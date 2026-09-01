---
"@alexkroman1/aai-runtime": patch
---

Restore workflow progress streaming on deployed agents. The run context was a module-level AsyncLocalStorage, so the harness's copy of the runtime and the agent bundle's copy each had their own — a step's `report()` found no context, streamed nothing, and logged an empty context object.
