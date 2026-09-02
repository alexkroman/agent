---
"@alexkroman1/aai-runtime": minor
---

Add `@alexkroman1/aai-runtime/testing` — `runWorkflow`, which starts a declared workflow on the real replay engine over an in-memory journal so a spec can assert that a run suspended, resumed off its journal, retried, was answered by a signal, and survived a worker that died mid-step. The constraint the older helpers cite — that a body is only durable after a compile-time transform — has not been true since the Workflow DevKit was replaced.
