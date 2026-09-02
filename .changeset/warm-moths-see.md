---
"@alexkroman1/aai-runtime": minor
"aai-server": patch
---

Record which CODE a durable run was started against. `RunRecord.codeVersion` joins the journal, and the divergence message uses it to state whether the code changed instead of handing the reader a test.

A run outlives the process that started it — that is what durable means — so it also outlives the bundle: a `ctx.sleep("nextDigest", DAY_MS)` parks for a day, deploys land, and the delivery that wakes it replays the body from whatever bundle the sandbox now runs. The engine has always been honest that resuming a run against a changed body is unsupported and had no way to say whether that is what happened.

The cost showed up in the sharpest error this engine produces. `workflow-replay-divergence.ts`'s message ends by handing the reader a test to run against their own source, because the two causes of an unreached step key — a redeploy mid-flight, or a non-deterministic body — want opposite fixes, and a journal holds what a value WAS and never how it was produced. One version per run settles half of it: an inequality states the redeploy and names both bundles, an equality ELIMINATES it and leaves the computed name as the only remaining cause. The two-cause fork stays in the text either way, because it is what tells a reader what to look for.

It is a DIAGNOSTIC and never a gate. Nothing refuses a run whose version moved: a deploy touching a page, a tool, a prompt or an unrelated workflow leaves this body's step sequence identical while the bundle hash changes on every deploy, so refusing on inequality would fail nearly all such runs to catch the few that really diverged — and the divergence check already catches those precisely, at the step that proves it.

The value is read from THIS PROCESS's environment (`AAI_BUNDLE_SHA256`), never the agent's, for the reason `platformGuestOptions` is a separate name from `resolvePlatformQueue`: `agentServerEnv` strips only `AAI_ALLOW_HOST`, so an agent may set any other `AAI_*` key as a secret. Read from a tenant env, an agent could pin its own version and every walk would then report the code unchanged — which is worse than no version at all, since the message would assert as a fact the one cause it had ruled out. Absence therefore means UNKNOWN in both directions and must never read as unchanged; only a deployed guest has a hash, so `aai dev` and a self-hosted server keep the original two-cause fork.

All four journal backends carry it, `20260902010000_workflow_run_code_version.sql` adds the platform column, and three conformance cases pin the round trip — one of them asserting `listRuns` carries it and not only `getRun`, which caught two live instances of exactly that: the postgres arm's second select, and the unit platform arm's fake transport, whose run-row field list was written out twice and is now one function.
