---
"@alexkroman1/aai-runtime": minor
"@alexkroman1/aai-cli": minor
"aai-server": patch
---

One copy of the runtime per process, and one decision for where workflow state lives.

A worker bundle no longer inlines `@alexkroman1/aai-runtime`: `buildWorker` keeps it an import (`RUNTIME_EXTERNAL`), the guest harness keeps it external too, and a bundle is evaluated beside the install that provides it — beside the harness in a guest, under the project's `.aai/` for `aai dev`/`aai build`/`aai deploy`, and inside a self-contained target's entry, which now imports `.aai/worker.mjs` statically and passes it to `createProjectServer({ worker })`. The server shell and the agent's sessions are one module instance, so the runtime's process-wide registries (metrics sinks, workflow run context, shared run reads, client event feed, app pool registry) are plain module values rather than `globalThis` slots, and `WorkflowRequestError` is recognised by `instanceof`. A process that loads a second copy anyway warns, naming both paths. Deployed bundles shrink from ~8 MB to the agent's own code; `BuildWorkerOptions.runtime` is gone.

`resolveStorageHome` decides platform, then the agent's `DATABASE_URL`, then local, once; the run journal, the correlation-key index, the upload record and the owed DDL are each built from the `StorageHome` it returns. `createUploadStore` takes `{ home }`, and a deployed guest with no `DATABASE_URL` now advertises `directParts` (its records are the platform's and its bytes are brokered).
