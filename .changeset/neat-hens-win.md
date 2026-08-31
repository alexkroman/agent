---
"@alexkroman1/aai-runtime": minor
---

Self-hosted agents run durable workflows. `createAgentServer` now configures a workflow world and mounts the DevKit's flow/step callback routes, off two new optional options (`workflowCode`/`stepCode`) that the scaffold's `server.mjs` reads from its built worker. Before this, only `aai dev` and the platform guest ever called `configureWorkflowWorld`/`startWorkflowWorldIfDeclared`, so a self-hosted server accepted a run and no world was ever started to execute it — it sat pending with nothing logged. Also splits the DevKit queue-name grammar into two exhaustive patterns (`WORKFLOW_QUEUE_NAME_PATTERN`, `STEP_QUEUE_NAME_PATTERN`) on `@alexkroman1/aai-runtime/internal`, so a name matching neither is refused rather than silently classified.
