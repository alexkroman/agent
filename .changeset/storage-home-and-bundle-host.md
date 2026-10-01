---
"@alexkroman1/aai-runtime": major
"@alexkroman1/aai-cli": minor
"aai-server": patch
---

One decision for where workflow state lives, and one runtime copy per guest.

`resolveStorageHome` decides platform, then the agent's `DATABASE_URL`, then local, once; the run journal, the correlation-key index, the upload record and the owed DDL are each built from the `StorageHome` it returns. `createUploadStore` takes `{ home }`, and a deployed guest with no `DATABASE_URL` now advertises `directParts` (its records are the platform's and its bytes are brokered).

The guest harness no longer bundles `@alexkroman1/aai-runtime`. A deployed agent still runs the runtime its own bundle ships, and now the harness drives it entirely through that copy: the worker wrapper attaches `GUEST_HOST` (`createRuntimeServer`, the workflow delivery door, tracing, the session gate) to `__aaiCreateRuntime` as `host`, a typed, versioned contract the harness checks at load. Studio previews are served by the loaded bundle's own server; only the studio coding agent imports the image's runtime, lazily. With the server and the sessions one copy, the run context, shared run reads, app pool registry and `WorkflowRequestError` are module-level; the metrics sinks stay a registered cross-copy slot because an agent's own code may register one from its bundle's copy under a self-hosted host. `parseBearer`/`isBlankSecret` and the guest log ring (`createLogBuffer` and its types) move to `@alexkroman1/aai/host-internal`; the log ring is no longer on the runtime root barrel (`logging` epoch 2). The guest contract is v5.
