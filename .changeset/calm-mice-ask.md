---
"@alexkroman1/aai-runtime": patch
---

Fix durable workflow runs on the platform: carry Dates across the storage RPC (a Date arrived as an ISO string, so the DevKit computed `workflowStartedAt` as NaN, the step payload carried null, and every run stalled at `step_created`), and give the storage reply an explicit `ok` so a VOID method — every `report()` line — is not read as a protocol error. The queue path keeps the DevKit's own format, which is what its own reviver reads.
