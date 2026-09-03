---
"@alexkroman1/aai-runtime": patch
"aai-server": minor
---

Give the workflow correlation-key index a platform backend, so a deployed run
stays findable by the caller who started it.

`(workflow, key) -> runId` is the only pointer from a caller to the durable run
their last call started, and it had two backends: the agent's own `DATABASE_URL`
and a `Map`. The platform provisions no tenant database, so on a typical deployed
agent `resolveKeyStore` fell to the `Map` — inside a sandbox that self-exits after
`AGENT_IDLE_EXIT_MS`. Since the journal gained its platform backend the RUN
outlives that sandbox and the pointer did not, so `find()` answered `[]` on the
caller's next call and the agent started a second run for somebody it had already
served. Nothing reported it: an empty index and a first-time caller are the same
answer, and the boot line printed `keyStore: "memory"` on every deployment.

The third implementation is `createPlatformKeyStore`, one `POST
/:slug/workflow-keys` per call over the per-sandbox bearer, against a new
slug-scoped `aai_platform.workflow_run_keys` under deny-all RLS. `selectKeyStore`
resolves platform, then postgres, then memory — the same preference
`selectJournal` makes, so the runs and the index cannot land in different homes —
and the boot line now names which one won. A new hourly pg_cron sweep collects a
key whose run the retention pass already deleted.
