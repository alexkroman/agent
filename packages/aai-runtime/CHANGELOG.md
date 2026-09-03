# @alexkroman1/aai-runtime

## 13.2.0

### Minor Changes

- 93ea30c: eval: publish the four affordances every template eval was hand-rolling — `toolNames`/`describeToolCalls` and `describeTurn` (the turn diagnostic behind ten `expect(value, message)` sites across five templates), `EvalSession.sayAll` with `callsIn`/`turnCalling` (so a case asserts about the turn a mechanism fired in rather than pinning a turn index, which is a flake with a misleading name), and `EvalWorkflows.settleAll` — plus `close()` now warning about a run it abandons instead of letting a mid-flight body call out on the next case's fakes or a real key.

### Patch Changes

- 9cb7392: Keep millisecond precision in a durable workflow's wake delay: a sub-second `ctx.sleep` was ceiled to a whole second by the platform dispatcher, adding ~1,000 ms to every wake (a measured 100 ms sleep resumed at ~1,780 ms). The delay is now ceiled at MILLISECOND granularity, which still guarantees a delivery is never earlier than the deadline.
- Updated dependencies [4fb6b05]
  - @alexkroman1/aai@13.2.0

## 13.1.0

### Minor Changes

- 61fe5cd: An attempt charge becomes a lease that EXPIRES, so a dead walk cannot refuse a healthy step forever. claimAttempt charges an attempt before a step body runs and answers how many are outstanding; a crash burns one, which is the mechanism that stops a wedging step being redelivered forever. But a scalar counter cannot expire: the charge a dead walk left was indistinguishable from a live one, so it stood permanently and maxAttempts deaths on one step key refused that step for the life of the run, with StepAbandonedError reporting a run nobody could revive — the residual workflow-replay-step.ts named and said needed a heartbeat to close. claimAttempt and releaseAttempt now take the walk's own id as a holder, and claimAttempt takes the window a charge counts for; the store keeps one row per (run, key) holding a map of holder to when it claimed, prunes what has aged out on every claim, and answers the number of live holders. A re-claim by a holder that already has a charge answers the same number rather than a higher one, which also makes the call idempotent over an at-least-once transport. The window is an hour and there is no heartbeat, so it deliberately clears the longest walk that can legitimately be running — erring long is recoverable where erring short removes the ceiling. One row per key rather than one per holder is the atomicity: measured on a real Postgres, a row per holder answered [1, 1, 3] for three concurrent claims against a contract that no two ever agree.

### Patch Changes

- 61fe5cd: Split the runtime's own egress into two connection pools: rpcFetch for a platform route (a kilobyte of JSON, one per step transition, bursts StepGate bounds at 16) and blobFetch for an upload window's bytes (up to UPLOAD_PART_BYTES, 32 concurrent probes per part claim). They were one pool, so the byte path could occupy the sockets a journal write then queued behind, and one allowH2 answer served both shapes though the measurement behind it — 14 of 16 concurrent 17.66MB requests completing over HTTP/2 against 16 over HTTP/1.1 — is about multi-megabyte bodies exhausting a flow-control window, which a kilobyte of JSON cannot do. Both still default to HTTP/1.1; what changes is that the RPC pool's answer is a decision rather than inheritance, and AAI_EGRESS_RPC_HTTP2 lets an operator revisit it without a deploy. That switch raises the pool's in-flight stream gate in the same breath, because undici gates H2 streams behind pipelining and leaving it at the HTTP/1.1 answer of 1 would make the switch strictly slower than what it replaced. The byte pool takes no such switch: HTTP/2 there is the configuration that was measured failing.
- 61fe5cd: Carry a W3C traceparent on every guest-to-platform RPC, and read it at the route. The busiest of those calls costs ~840ms of server time and that was a total with no breakdown: withReserved measures the server's half (how long the admin reservation waited, how long the statement ran) and the rest of the wall clock — the proxy, the round trip, anything queued before the handler ran — was unaccounted. Both halves are now measured; what was missing was the ability to put one beside the other, since a busy replica writes hundreds of these lines a second and a timestamp cannot correlate them. The runtime mints one span per call and logs its elapsed at debug, the platform route puts the trace id on every line withReserved writes, and 863ms against a waited+work of 43ms is a conclusion neither side could reach alone. W3C rather than a private header so an OTEL collector later reads these spans for free. ReservedCall declares the trace as a required key with an optional value, so a new platform route cannot forget to look for one.
- @alexkroman1/aai@13.1.0

## 13.0.0

### Major Changes

- b94fdd1: Read an upload's record ONCE per read, not once per chunk.
  
  `UploadReader.info` and `UploadReader.read` each resolve the record for themselves and every reader needs both, so one logical read cost two look-ups of one row and the byte route cost one per `UPLOAD_CHUNK_BYTES` of the answer. On a deployed guest a look-up is a `POST /:slug/upload-records` across the platform and into the admin pool — measured over 48h of production at n=1428, mean 537ms, and within one 33-segment transcription it outnumbered the journal 515 to 212 for a run that moved 140 part windows.
  
  `UploadReader.open(id)` hands back the record AND a reader bound to the windows THAT record named. `readUpload` is 1 look-up where it was 2; `GET /workflows/uploads/:id` is 1 where it was N+1 for an N-chunk answer. It also PINS the window map for the operation, which the route's own `Content-Length` was already assuming: a part landing mid-download could previously answer bytes the header had promised were something else.
  
  BREAKING: `UploadStore` gains a required `open(id)`, so a host implementing that interface must supply one. `UploadReader.open` is OPTIONAL and `readUpload` falls back to `info` + `read`, so every two-method fake — `stubUploads` included — is unchanged.
  
  The claim path is deliberately untouched at two calls: `recordParts` reads before it writes because it validates every named window against the DECLARED total and decides the finished-upload refusal, neither of which the write can see.
- b94fdd1: Answer an ELAPSED durable wait from the walk's own snapshot, so a polling run's journal traffic stops being quadratic.
  
  A replay answered a settled `ctx.step` from the one `readSteps` it takes at the top of a walk, and round-tripped `claimSleep` for every elapsed `ctx.sleep` it walked past — an unconditional call whose answer was almost always "that finished several deliveries ago". A body that polls mints a new wait key per iteration, so delivery N re-claimed N-1 finished waits before doing any work. Measured on a deployed 34-segment transcription run: journal POSTs rose +1 per delivery, monotonically, across 69 consecutive deliveries — 2,675 in 25 minutes, the gap between deliveries growing 11s to 37s in step with the count, and the run never completed. Every call succeeded, so the only symptom was a run getting slower.
  
  BREAKING: `JournalStore` gains a required `readSleeps(runId)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers every durable wait of a run, ordered by key, as a `SleepEntry` (a `SleepRecord` plus its key). Both shipped databases key the sleeps table on (run_id, key), so it is a range scan already in that order and needs no migration. The engine issues it beside `readSteps`, concurrently, and hands it down as `ReplayOptions.sleeps`.
  
  The snapshot may only answer a wait it already HOLDS and that is over by a monotonic test — woken, or a deadline already past. `claimSleep` is a claim rather than a read, so a miss must still create the record, and a future-dated unwoken wait must still round-trip in case a wake landed since. A stale snapshot can therefore only ever cost a round trip it did not need.

### Patch Changes

- 4647b84: The durable-workflow queue claim reads two new columns instead of re-deriving them every tick: `workflow_queue.run_id` (generated from the payload envelope) and `workflow_queue.kind` (written at enqueue from the DevKit queue-name grammar). A busy tick goes 516 ms to 20 ms and an idle one 1.7 ms to 0.9 ms on a 200,000-row queue, and the expression index the old spelling needed is dropped with nothing in its place. Also: a zero-delay re-park now notifies, so a guest parking a busy walk no longer waits out a whole poll interval; and `STEP_QUEUE_NAME_PATTERN`/`WORKFLOW_QUEUE_NAME_PATTERN` leave `@alexkroman1/aai-runtime/internal`, which existed only to cross into that SQL.
- ef6c39c: Workflow engine performance and concurrency: the divergence check scans the journal with a cursor rather than re-scanning every journaled step per fresh step, the step gate dequeues waiters through a head cursor rather than an O(n) shift, a walk issues its two opening journal reads together rather than one after the other, the memory journal answers readStep from its key index rather than a scan, and the in-process dispatcher collapses deliveries that arrive during a walk into one deferred re-delivery instead of racing concurrent walks of the same run.
- 4647b84: Give the workflow correlation-key index a platform backend, so a deployed run
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
- ef6c39c: The self-hosted journal's boot-sweep query reads the wait table once instead of once per candidate run. resumableRuns computed each run's earliest wake with a correlated subquery inside a CTE, which Postgres inlines - so the expression was re-planned as a fresh index scan at each of its three sites (filter, sort key, output). A grouped left join plus a hashed anti-join takes it from 349-375ms and 123,102 shared buffers to 24-28ms and 1,194, result-identical over the whole answer, verified with EXPLAIN ANALYZE against a real Postgres holding 50,000 runs. It matters because aai dev rebuilds its runtime on every file save and each rebuild is a boot sweep.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
  - @alexkroman1/aai@13.0.0

## 12.0.0

### Major Changes

- 4507050: Bound a durable run's journal growth, and answer the contended step read by key.
  
  A live run's journal could grow without limit. Retention only ever bounded the POPULATION — `sweep_terminal_workflow_runs()` deletes terminal runs after 30 days — and a live run is not eligible for it at any size, nor can its journal be truncated, because replay answers every settled key from it. The cost is O(N) per delivery and O(N squared) across a run, since every walk reads the whole journal, so a long run got monotonically slower at doing the next step and eventually became undeliverable with nothing said. `workflow-journal-bound.ts` now warns at 8,000 journaled steps naming the count and the ceiling, and refuses at 10,000 with a message naming the remedy, before a body runs.
  
  BREAKING: `JournalStore` gains a required `readStep(runId, key)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers ONE settled step by key, or undefined when it has not settled. `settledSince` — the re-read on the contended path, reached when `claimAttempt` says another walk touched a key — used to read the whole journal and keep one entry, an O(N) scan for an O(1) question in exactly the runs where N is largest. Both shipped databases key the step table on (run_id, key), so it is an index seek and needs no migration.

### Patch Changes

- @alexkroman1/aai@12.0.0

## 11.0.0

### Minor Changes

- 36a3f22: Make a `createAgentServer` forwarding gap unrepresentable, and close the fourth one.
  
  `AgentServerOptions` is a hand-written subset of `RuntimeOptions` where every field is optional, so an option added to the runtime is silently unreachable through the door most deployments use. That is not a hazard to remember — it has happened FOUR times, and each was found by somebody needing the option rather than by anything checking: `telephony` mounted an unauthenticated `WS /phone` with no way to switch it off, `page` served a static agent the voice surfaces, `env` left `AAI_WORKFLOW_API_TOKEN` and `DATABASE_URL` doing nothing, and `journal` left a deployment that owns a database unable to say so.
  
  `journal` is forwarded now. And `agent-server-forwarding.ts` is what stops a fifth: every `RuntimeOptions` member is either on `AgentServerOptions` or on an explicit `UnforwardedRuntimeOption` deny-list carrying its reason, and `ForwardingGap` is the subtraction — `never` today, and the NAME of the offending member the moment one is added. It fails `turbo run typecheck` AND the build, since the module is compiled by `tsconfig.build.json` and a build failure cannot be skipped by a test filter. Same shape as `AgentConfigSchema`'s `HOST_ONLY_AGENT_FIELDS` subtraction one package over, for the same reason.
  
  Checked in BOTH directions, and the reverse one earned its place immediately: a `StaleExcuse` (an entry naming a member `RuntimeOptions` no longer has) and a `RedundantExcuse` (one the door now forwards) each fail the same way, and the first caught three wrong entries on its first run — a draft excused `name`, `greeting` and `hostBaseAgent`, none of which is a `RuntimeOptions` member at all.
- 6bbef9b: Add `@alexkroman1/aai-runtime/testing` — `runWorkflow`, which starts a declared workflow on the real replay engine over an in-memory journal so a spec can assert that a run suspended, resumed off its journal, retried, was answered by a signal, and survived a worker that died mid-step. The constraint the older helpers cite — that a body is only durable after a compile-time transform — has not been true since the Workflow DevKit was replaced.
- 36a3f22: Record which CODE a durable run was started against. `RunRecord.codeVersion` joins the journal, and the divergence message uses it to state whether the code changed instead of handing the reader a test.
  
  A run outlives the process that started it — that is what durable means — so it also outlives the bundle: a `ctx.sleep("nextDigest", DAY_MS)` parks for a day, deploys land, and the delivery that wakes it replays the body from whatever bundle the sandbox now runs. The engine has always been honest that resuming a run against a changed body is unsupported and had no way to say whether that is what happened.
  
  The cost showed up in the sharpest error this engine produces. `workflow-replay-divergence.ts`'s message ends by handing the reader a test to run against their own source, because the two causes of an unreached step key — a redeploy mid-flight, or a non-deterministic body — want opposite fixes, and a journal holds what a value WAS and never how it was produced. One version per run settles half of it: an inequality states the redeploy and names both bundles, an equality ELIMINATES it and leaves the computed name as the only remaining cause. The two-cause fork stays in the text either way, because it is what tells a reader what to look for.
  
  It is a DIAGNOSTIC and never a gate. Nothing refuses a run whose version moved: a deploy touching a page, a tool, a prompt or an unrelated workflow leaves this body's step sequence identical while the bundle hash changes on every deploy, so refusing on inequality would fail nearly all such runs to catch the few that really diverged — and the divergence check already catches those precisely, at the step that proves it.
  
  The value is read from THIS PROCESS's environment (`AAI_BUNDLE_SHA256`), never the agent's, for the reason `platformGuestOptions` is a separate name from `resolvePlatformQueue`: `agentServerEnv` strips only `AAI_ALLOW_HOST`, so an agent may set any other `AAI_*` key as a secret. Read from a tenant env, an agent could pin its own version and every walk would then report the code unchanged — which is worse than no version at all, since the message would assert as a fact the one cause it had ruled out. Absence therefore means UNKNOWN in both directions and must never read as unchanged; only a deployed guest has a hash, so `aai dev` and a self-hosted server keep the original two-cause fork.
  
  All four journal backends carry it, `20260902010000_workflow_run_code_version.sql` adds the platform column, and three conformance cases pin the round trip — one of them asserting `listRuns` carries it and not only `getRun`, which caught two live instances of exactly that: the postgres arm's second select, and the unit platform arm's fake transport, whose run-row field list was written out twice and is now one function.

### Patch Changes

- 165f9b2: Make the durable-workflow journal's first-write-wins claims one statement each and retry the indeterminate answer, escape the characters PostgreSQL cannot store, and give the reconcile pass an end so a run its guest can never finish is failed rather than re-walked forever.
- 623a8bb: Collapse duplicate workflow-journal round trips and widen the platform admin pool.
  
  A deployed run's every journal operation is one `POST /:slug/workflow-journal`, measured at ~840 ms of platform time each. Three things multiplied them: a fan-out's stale-snapshot check re-read the whole journal once per step, overlapping walks each opened with their own `getRun` and `readSteps`, and every delivery took three of those round trips sequentially before a body ran.
  
  Concurrent identical `getRun`/`readSteps` now share one round trip (a coalescer, not a cache — no caller is answered from a read that started before it asked), and a delivery's step read is issued beside the `running` compare-and-set rather than after it. `ADMIN_POOL_MAX` goes 4 to 16: guest platform routes reserve a connection for the whole request, so 4 was a hard ceiling of four in-flight guest calls per replica, and with `PLATFORM_POOLER_URL` in transaction mode the pool costs the instance's max_connections nothing.
- 36a3f22: Re-take the rollback property's coverage floors at `numRuns: 80`, because two of them were unsatisfiable at 20.
  
  `pipeline-history-rollback-property.test.ts` aggregates its five reach counters across the property's runs, so `numRuns` is what decides how heavy their left tail is. Measured over 24 consecutive runs at 20: `toolHealedAtCap` came out **0 twice** against a floor of `> 10` — a state the corpus simply failed to reach on ~8% of green runs, so no positive floor was settable at all — and `atCapConversation` produced the **144** that failed a real CI job against a floor of 200 whose recorded range started at 442.
  
  Neither recorded range was wrong when it was taken. Twenty draws was too few to describe the unluckiest run, which is the failure mode `AGENTS.md` warns about in the same paragraph that says to floor under the observed minimum: what one script reaches is correlated across all 260 of its steps rather than independent per step.
  
  So the fix is the draw count rather than lower numbers — a floor under a distribution whose minimum is zero cannot be set. Four times the draws costs 635ms → ~2.6s against the unit tier's 5s budget, and it moves `toolHealedAtCap`'s observed minimum from 0 to 672. Every floor is re-taken over 14 consecutive runs at 80 with its new range recorded in place.
- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [fe3b6d6]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [7ab47cf]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0

## 10.0.1

### Patch Changes

- f35bdf7: Fix a durable-workflow livelock and the park cadence that hid it.
  
  A workflow step longer than the guest's idle window never completed in production. The guest counted workflow work by HTTP RESPONSE, so the platform's 60s delivery abort read as an idle guest while the walk carried on; the sandbox self-exited mid-step `AGENT_IDLE_EXIT_MS` later and a fresh one restarted the same step, forever. Activity is now counted at the WALK — the promise the delivery door already awaits — so a running step keeps the guest alive and an idle one still exits promptly. A parked delivery is credited nothing, deliberately.
  
  The guest half reaches production through a platform DEPLOY rather than through its own version — the harness is baked into the guest image, whose content-addressed tag the server pins at deploy time — which is why `aai-server` is named alongside it.
  
  The park delay is also proportionate to the walk instead of a flat 5 seconds: `clamp(walkingForSeconds / 8, 5, 120)`, with the log line on the same curve. A 15-minute step now costs ~24 queue round trips and ~24 log lines rather than ~170 of each, while a brief race between two deliveries still gets its fast 5s retry.
- @alexkroman1/aai@10.0.1

## 10.0.0

### Major Changes

- dd699c7: Remove the Workflow DevKit's world, compiled surface and queue callbacks. `AgentServerOptions` loses `workflowCode`/`stepCode` and the `SweepSkip` type is gone; neither has a mechanism behind it now.

### Minor Changes

- dd699c7: Raise the workflow step-concurrency default from 3 to 16, measured against a guest rather than inherited from graphile-worker. A fan-out was capped at three whatever the body asked for, so a template's own measured width was inert. Sixteen is what a real libkrun microVM holds at Modal's guaranteed reservation (1 CPU / 1024 MB): a concurrent transcription segment costs 26.1 MB at 48 kHz stereo, putting sixteen at 576 MB of 982 MB usable. Also raises the workflow progress-poll default from 1s to 5s — two of those hooks on one run spend a page's entire per-IP request budget and contend with the upload for the same link.
- dd699c7: `SessionStateBackend.discard` now reclaims a session's EVENT LOG as well as its slots on every backend. `createPostgresStateBackend` dropped slots only and left the log to the retention sweep, so "discarded" meant two different things depending on whether a session ran self-hosted or on the platform; the append-only grant that justified the asymmetry no longer exists. One CTE, so the pair is atomic against a concurrent append, and the retention sweep stays as the backstop for a session whose guest died before it discarded.
- dd699c7: Persist durable workflow runs to Postgres when a `DATABASE_URL` is configured, so a run survives a restart instead of living in the process that started it.
- dd699c7: Make a deployed run's `ctx.sleep` come back: the platform's queue now holds a deployed workflow's schedule, instead of a `setTimeout` that dies with the sandbox.
- dd699c7: Make a DEPLOYED durable workflow run actually durable: its journal now lives in the platform's database rather than in a sandbox that self-exits.
- dd699c7: Bound how many workflow step bodies execute at once. The DevKit's world provided this and the replay engine did not, so a body's fan-out width became its execution concurrency and killed a guest.
- dd699c7: Share the workflow API's one-shot run reads, bound the platform pool's reserve, and answer a platform shortage as 503 rather than 500. `GET /runs/:id` and `/runs/:id/stream` each opened their own journal read, so N concurrent readers of one run cost N round trips against a four-connection admin pool; they now join the same coalesced read. `createPostgresDb` gains an optional `reserveTimeoutMs`, and an exhausted pool is reported rather than waiting forever behind a caller that has already given up.

### Patch Changes

- dd699c7: Roll an injected prompt back completely when the conversation window is full. `dropTrailingUser` popped where the push had already trimmed, so a resume prompt, silence nudge or `injectTurn` rolled back at the 200-message cap permanently cost the oldest real conversation turn. The LLM view could lose two, since capping can orphan a `tool` result its removal split.
- dd699c7: `createRuntime` now refuses `executeTool` without `toolSchemas` (and the reverse) instead of silently running the in-process tool path with no tools. A lone `executeTool` used to discard the caller's relay entirely and answer every call with `Unknown tool`.
- dd699c7: Refuse a session event the platform cannot read instead of dropping it from the page. A read of the session event stream is a cursor, so a skipped entry was an event silently gone rather than a degraded answer — and an entry whose index coerced to `0` was worse, taking the place of the session's real first event. Both ends of the wire now refuse what they cannot read.
- dd699c7: A streamed upload whose body dies now keeps the window it was filling. The growing window cut buffered up to 8 MiB against its next target and discarded it when the body failed, so a torn stream published less than had actually arrived.
- dd699c7: Restore workflow progress streaming on deployed agents. The run context was a module-level AsyncLocalStorage, so the harness's copy of the runtime and the agent bundle's copy each had their own — a step's `report()` found no context, streamed nothing, and logged an empty context object.
- dd699c7: Fix the in-memory workflow correlation-key index to record each run id at most once, matching the Postgres store's `on conflict (run_id) do nothing`. A retried `record` after a lost connection used to list the same run twice, promote it past a newer run, and index it under a second key — found by the new shared WorkflowKeyStore conformance table.
- dd699c7: A malformed base64 audio frame is now reported — one warning per 10s per logger, carrying the running count — instead of being dropped silently. The three callers that own a session log there; the three provider openers use the default logger.
- dd699c7: Bound a step's outbound HTTP again. The step fetch pool had undici's header and body timeouts disabled, justified partly by a step budget the DevKit removal deleted, so a `stepFetch` call passing no signal had a deadline from no layer at all. Both are set to a 10-minute INACTIVITY bound — undici's timers are phase timers, not total-duration ones, so the number does not scale with the payload — and the walk's `AbortSignal` now reaches every step request, so a cancelled run stops its in-flight I/O instead of finishing an upload nobody is waiting for.
- dd699c7: A step that suspends no longer spends its own retry budget. An attempt is now a lease: tries are counted in the walk, and the durable charge is given back when a body suspends, so overlapping deliveries of one run can no longer exhaust a budget between them and journal `failed` over a step that had succeeded. The refusal is a verdict about the walk rather than a journal entry, so only a walk whose own body threw can write a `failed` entry.
- dd699c7: A completed run's snapshot falls back to `WdkAdapter.readOutput` when the record carries no `output`, which is legal for an adapter written against a retained epoch. Such adapters silently reported `output: undefined` for every completed run.
- dd699c7: Remove the Workflow DevKit adapter, which the replay engine replaced.
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai@10.0.0

## 9.2.0

### Patch Changes

- 1e5170a: Stop an author's own data from forging a typed-JSON envelope, and decode base64 strictly.
  
  The workflow wire codec tagged binary as `{ __type: "Uint8Array", data }` and dates as
  `{ __type: "Date", iso }`, and both revivers recognised one structurally — so a plain
  object of that shape, written by an author, decoded as a `Uint8Array` or a `Date` at any
  nesting depth with nothing raised. A run's input arrives over public HTTP, so that was
  reachable type confusion. An author's reserved keys are now escaped on the way out and
  unescaped on the way in, which makes the round trip total for every JSON value.
  
  Decoding a malformed base64 payload used to return arbitrary bytes, because
  `Buffer.from(s, "base64")` drops characters outside the alphabet; it now throws. A date
  envelope whose `iso` will not parse throws rather than reviving the `NaN` that previously
  stalled durable runs.
  
  A bare `__type` envelope still decodes exactly as before, so data already on the wire is
  unaffected — deploy the decoder first.
- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
  - @alexkroman1/aai@9.2.0

## 9.1.0

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0

## 9.0.2

### Patch Changes

- dcb2050: Pin the runtime's own outbound fetch to HTTP/1.1, and answer a transport failure as a 503.
  
  Every call the runtime made of its own — the upload broker's byte operations, the operator-bucket ones beside them, every platform RPC, and the run-event stream read — used `globalThis.fetch`, which undici 8 lets negotiate HTTP/2. A deployed guest's concurrent requests to one origin were therefore multiplexed onto one connection, where a capacity limit arrives as a stream reset carrying no HTTP status: a part claim's bucket probes and an unrelated run-event stream failed with `fetch failed` in the same instant, and the claim answered `500 Internal server error`, so the browser re-sent windows it had already stored into the same fault. They now share one HTTP/1.1 keep-alive pool, the same fix `stepFetch` already had, and a transport failure answers 503 with a `Retry-After` instead of an opaque 500.
- cc317e4: Read a plain-text tool result as text in the eval helpers instead of throwing a SyntaxError
- @alexkroman1/aai@9.0.2

## 9.0.1

### Patch Changes

- 533e217: Cut a batched upload part claim from three record round trips and eight probe rounds to one read, one write, and probes that run alongside them.
- 533e217: Retry a transient guest-to-platform upload byte operation instead of failing a whole batched part claim with a 500.
- @alexkroman1/aai@9.0.1

## 9.0.0

### Major Changes

- 1f21e37: Retire the durable-workflow wake hint. The platform's delivery sweep IS the wake now: it claims due messages from a table with a slug and an available_at and brokers a sandbox to deliver them, which is the query the DevKit's own schema could not answer and the whole reason a per-app hint table existed. Removes createWakeHintPublisher, WakeHintOptions, WakeHintPublisher and WORKFLOW_WAKE_TABLE from /internal — a removal from a published subpath, hence major, though that subpath carries no capability contract by construction.

### Minor Changes

- 006cc1e: Add the guest's HTTP Storage client and the JSON-with-binary wire codec both sides of platform-owned run storage use. The codec reads a value's raw form before toJSON, which is what carries a Buffer across the wire as bytes instead of {type:"Buffer"} — the Postgres world returns Buffers for every bytea column.
- bccae5a: Add the guest-side platform queue client: `queue()` becomes one authenticated POST to the agent's own `/:slug/workflow-enqueue` instead of a graphile-worker job against the tenant's database. No new credential — the per-sandbox bearer the guest already holds to verify inbound platform requests proves the reverse outbound, and it is bound to one sandbox name so it authorizes exactly one slug.
- fcb113c: Add the live stream read: GET /:slug/workflow-stream on the platform and the guest client for readFromStream. The HTTP body IS the stream; the response is bounded so a stream whose run died cannot hold a connection forever, and the guest resumes with startIndex.
- 9115625: Add the platform's queue-delivery door: a host-only `POST /workflow-queue` that dispatches a delivered message to the flow or step entrypoint by the DevKit's queue-name grammar. One door rather than widening the loopback gate on the two callbacks, so that grammar is parsed on the side that depends on the DevKit; refused unless the composition vouches for the caller, which `aai dev`, host mode and a self-hosted server do not.
- 7dd348f: A deployed guest's durable-workflow world is now the platform's: journal, streams and queue all reached over HTTP, with only the DevKit's createQueueHandler kept locally. The platform world wins over a DATABASE_URL, so a workflow agent opens no database of its own for runs.
- 9e41442: Self-hosted agents run durable workflows. `createAgentServer` now configures a workflow world and mounts the DevKit's flow/step callback routes, off two new optional options (`workflowCode`/`stepCode`) that the scaffold's `server.mjs` reads from its built worker. Before this, only `aai dev` and the platform guest ever called `configureWorkflowWorld`/`startWorkflowWorldIfDeclared`, so a self-hosted server accepted a run and no world was ever started to execute it — it sat pending with nothing logged. Also splits the DevKit queue-name grammar into two exhaustive patterns (`WORKFLOW_QUEUE_NAME_PATTERN`, `STEP_QUEUE_NAME_PATTERN`) on `@alexkroman1/aai-runtime/internal`, so a name matching neither is refused rather than silently classified.
- 95be1ca: Bound platform-facing Postgres access so a network partition sheds load instead of hanging: createPostgresDb gains optional connectTimeoutSeconds and queryTimeoutMs (a client-side per-pooled-query deadline — the only bound that survives a silent partition, where a server statement_timeout's cancellation notice is blackholed too; reserved/advisory-lock connections are exempt). The self-hosting createServer also sets an explicit headers timeout and keep-alive timeout to reap slowloris connections on its public surface.
- c871232: Compose the platform-owned queue into the DevKit's Postgres world: a deployed guest now enqueues through the platform and never subscribes graphile-worker. Storage and the streamer stay in the tenant's own database, so this gives back graphile's held LISTEN connection and its worker concurrency rather than the whole workflow surcharge.
- 857c3d9: Move workflow upload records to the platform's own database, so a deployed guest keeps nothing durable on local disk. createUploadStore chose an upload's home from whether the agent had a ctx.db, on the premise that a database meant durable runs — which the platform workflow world falsified. A deployed guest with no DATABASE_URL therefore got durable runs with their uploads in a directory that recycles, which is how one sandbox filled its filesystem and ENOSPC'd every write. The platform arm is now checked first, ahead of a DATABASE_URL, the same way the workflow world is.
- 6d360a7: Preserve turn-level durability without a tenant database: a third SessionStateBackend that keeps a session's slots and event log on the platform, reached over HTTP. It wins over a DATABASE_URL, so a deployed agent's durability no longer depends on whether it provisioned a database. SessionStateBackend.name gains "platform" (epoch 1 retained — widening a field an implementor supplies is not breaking).
- 4743746: Durable-workflow delivery is NOTIFY-driven. enqueue announces on a Postgres channel when a message is due now and a replica listens, so a step-to-step hop no longer pays the poll interval — the same thing graphile-worker does with jobs:insert. The interval stays as the timer for PARKED messages, which a notification cannot express, and as the mechanism that makes delivery eventual when a listener is reconnecting. CloseableDb gains a required listen() member; aai-runtime:db epoch 2 is RETAINED, since adding a member to a type a caller receives is not breaking for a consumer, and a frozen example proves it.
- 9690f28: Add the guest's Streamer client (six of seven members; readFromStream's live stream needs its own route) and per-tenant stream names on the platform. Their readFromStream looks a stream up by name alone with no run filter, so in one shared schema two agents sharing a name would share a stream — the platform qualifies the name on the way in and strips it on the way out.
- af284a7: Publish ensureSessionStateSchema and call it from the scaffold's server.mjs, so a self-hosted agent with a DATABASE_URL creates its own session-state tables instead of failing every session at start.

### Patch Changes

- 65ad531: Refuse boot without AAI_PUBLIC_ORIGIN on a platform tier, and stop treating a full disk as transient. The origin was optional on the reading that only durable webhook URLs needed it; it is now the only source of the base URL a guest needs to install the platform workflow world, so unset meant every durable run silently ran on the DevKit's local world and died with its sandbox. ENOSPC now maps to 507 with no Retry-After, instead of falling through to a 500 that three layers retried.
- 841f460: The local-storage boot announcement tells the truth in both compositions it is reachable from: under `aai dev` a run and its upload survive a restart, under a per-process data directory they do not.
- 841f460: Clamp the session-events startIndex so a huge value is a page, not a 500
- 044236f: Fix durable workflow runs on the platform: carry Dates across the storage RPC (a Date arrived as an ISO string, so the DevKit computed `workflowStartedAt` as NaN, the step payload carried null, and every run stalled at `step_created`), and give the storage reply an explicit `ok` so a VOID method — every `report()` line — is not read as a protocol error. The queue path keeps the DevKit's own format, which is what its own reviver reads.
- 9d5e2a2: Serve every route from a table, and let the platform's guest-route map import it instead of re-typing it. `SERVER_ROUTES` and `WORKFLOW_CALLBACK_ROUTES` (on `/internal`) name every path this package serves; `createServer` dispatches off them, and `aai-server`'s `GUEST_ROUTES` composes ten of its seventeen entries from them rather than transcribing the strings. A renamed path is a compile error, and a new one fails a test instead of only a grep.
- af284a7: Answer `cancelled: false` rather than a 500 when a workflow run is already over, and print the eval mode on a green `aai eval` run.
- 841f460: Fix `GET /workflows/runs/:id/events` holding a silent stream for five minutes on an empty run id, and bound the stream's retry so a persistently failing read hands the client back to its poll instead of looking idle.
- 841f460: An unsafe run id in a path is a 400 rather than a 500
- 86398d7: Fix a Buffer nested in an array being serialized as Node's own `toJSON` shape instead of a binary envelope on the workflow storage wire. The replacer guarded its holder read with `isRecord`, which excludes arrays, so `{ chunks: [buf] }` crossed as `{type:"Buffer",data:[...]}` and the peer decoded a plain object rather than bytes.
- e8bc7d9: AssemblyAI streaming TTS: keep the final segment's word timings, and recognize a sentence closed by a curly quote. A `WordBoundaries` frame trails its own flush's `FlushDone` (~20 ms, measured against the sandbox host), so guarding on `turn.inFlight()` dropped the last segment's timings on every reply — the tail then degraded to the proportional heard-cursor estimate over exactly the span where per-flush padding makes it worst. The sentence-boundary and coalescer closer classes now carry `’` and `”`, which is what an LLM emits by default; a straight-only class cut mid-sentence and tripled the run-to-run duration spread (18% -> 6%) at identical time-to-first-audio.
- 4e2f9f3: Fix a guest dialling itself for every platform call under the local microVM backend: split the URL a third party dials (AAI_PUBLIC_BASE_URL) from the URL the guest dials (AAI_PLATFORM_BASE_URL), which resolvePlatformQueue now reads.
- 841f460: cancel() on a run that does not exist resolves false on every world, not just Postgres
- 841f460: A NUL in a request path segment is a 400, not a 500
- bca2d99: Answer 503 with a short `Retry-After` when a workflow request cannot get an app-database connection, instead of a generic 500 — a caller can back off on the first and not the second. A workflow app whose durable-run world cannot start now fails its boot rather than serving a guest that reports healthy and 500s forever; a voice agent keeps today's behaviour, since a broken world does not stop it answering the phone.
- 01046b6: Template evals now use the published createVmRunCode() executor instead of four byte-identical hand-rolled copies.
- 841f460: A part re-sent while its first attempt is still draining no longer fails with a 500: the local blob and record stores give each write attempt its own temp path instead of sharing a fixed one.
- 18dfb1c: Platform RPC clients share one HTTP body: a non-2xx whose reply cannot be read now still names the status, and every timeout names the deadline that elapsed.
- 13b610f: No SDK change. Platform groundwork for running the durable-workflow world on the platform's own database: a run-ownership table (the tenant boundary the DevKit's schema has no column for) and the world constructed against the platform's connection string with its pool pinned.
- 044236f: Make a deployed agent's session state durable, and stop reporting an absent run as a server error. The runtime read the platform pair (`AAI_PUBLIC_BASE_URL`/`AAI_GUEST_TOKEN`) out of the AGENT's env, where the platform never puts it, so every deployed agent fell back to the memory backend and a session did not survive its sandbox restarting; uploads fell back to local for the same reason. A 404 from platform run storage now becomes the DevKit's own `WorkflowRunNotFoundError`, so GET/DELETE/wake on an unknown run answer 404/`cancelled:false`/`woken:0` instead of 500. The browser client reports a refusal close's own reason instead of discarding it, and a dev-mode `aai init` pins the third-party deps it shares with the linked workspace so two copies of xstate cannot fail the typecheck gate.
- 841f460: The session-event stream reported `tail: 0` for a session this process never handled, so a cold read of a DURABLE stream answered with a full page of events beside a cursor of zero — and `startIndex=-N` counted back from that zero and returned the whole stream.
- 6796ae3: Complete the workflow HTTP API's stated auth posture, and pin it on the routes that
  matter. The module doc reasoned only about the COST of failing open — which is the one
  exposure the platform's per-IP limits already bound — and said nothing about the two
  that nothing bounds: the unkeyed arm of `GET /workflows/runs`, which converts knowing a
  slug into knowing run ids, and `DELETE /runs/:id` / `POST /runs/:id/wake`, which change
  a run somebody else started and rest on those ids being unguessable. The posture and the
  argument now live in `workflow-api-auth.ts`, and the token gate is covered on the run
  listing, cancel and wake rather than only on `GET /workflows` — a check that moved
  inside a route would have left the destructive verbs open with the suite green. No
  behaviour change: open-by-default is unchanged, and closing the enumeration arm
  independently is recorded as the open question rather than taken.
  
  Also corrects `WorkflowApiOptions.engine`'s doc, which still argued that an undefined
  client has two causes and that naming one would be "a confident false statement".
  `buildWorkflowClient` returns undefined on exactly one condition, and the message it
  answers with was corrected to say so; this doc was the holdout arguing that was a
  mistake.
- 841f460: cancel() on an already-cancelled run now resolves false, matching its documented contract
- 841f460: A fatal session error now ends a phone call instead of leaving dead air
- af284a7: Fix telephony: the bridge configured itself on a `config` frame the runtime never emits (it sends `session.configured`), so both resamplers stayed null and a phone call connected with neither end able to hear the other.
- 777d0eb: No SDK change. The platform's run-storage route: one bearer-gated POST that scopes every DevKit Storage call to the calling agent, with the five methods whose lookup key is not a run id each handled by name.
- 35a57fb: Refuse the durable-workflow queue callbacks from any peer that is not loopback. `POST /.well-known/workflow/v1/flow` and `/step` were declared `guest-internal` on the argument that "loopback is the whole gate", and nothing checked: a deployed guest binds every interface behind a public Modal tunnel whose origin the public `/:slug/client-config` hands to any browser, so `step` would execute one of the tenant's registered step functions with a caller-supplied payload. The gate lives in `handleWorkflowRequest`, so it covers `aai dev`, host mode, studio mode and a self-hosted `createAgentServer` alike. The webhook route is deliberately untouched — its URL is handed to third parties and the DevKit's path token is its authorization.
- 841f460: An expired workflow webhook token answers 404 instead of 500, so a third party stops retrying a dead callback; and a refused upload part offset names its real reason instead of always reporting misalignment.
- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [e888216]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
  - @alexkroman1/aai@9.0.0

## 8.2.1

### Patch Changes

- @alexkroman1/aai@8.2.1

## 8.2.0

### Minor Changes

- 690a623: Retry a failed workflow-world start, because its commonest failure is transient.
  
  A blue-green handover boots the replacement guest while the old one drains, so
  for a few seconds two guests share the app role's `APP_DB_CONNECTION_LIMIT` — a
  boundary `app-db-budget.ts` states outright. What it did not say, because it is
  `startWorkflowWorldIfDeclared`'s business, is what losing that race COST:
  `migrateAndSubscribe` ran once, the catch logged, and the replacement then
  served its entire life with NO QUEUE WORKER — while answering `/client-config`
  and voice sessions normally, so nothing looked wrong and every durable run for
  that agent was stranded.
  
  Measured on a real redeploy mid-run: the replacement logged `too many
  connections for role "app_…"` 300ms after listening, and a flow job that came
  due 15s later sat unlocked at `attempts 0/3`, claimable, with a live guest that
  was not polling. With a bounded backoff (five retries, ~62s, covering a
  draining predecessor's exit) the same scenario now recovers on attempt 3 in
  6.5s. Exhausting the budget still logs and returns rather than throwing — an
  agent whose workflows are broken should still answer the phone.

### Patch Changes

- 690a623: Tell the POSTGRES workflow world its callback base URL, not just the local world.
  
  `configureWorkflowWorld` set `WORKFLOW_LOCAL_BASE_URL` only on the local
  branch. The name reads like a local-world setting and is in fact the FIRST
  branch of world-postgres's own `getExecutionBaseUrl()` — the origin its queue
  dispatches `flow` and `step` callbacks to. Unset, that function fell through to
  health-probe port AUTO-DETECTION on every dispatch.
  
  Measured at ~45ms per dispatch, steady, against ~7ms of step work and ~1ms for
  graphile-worker's whole enqueue-to-handler path. Two dispatches per step-to-step
  hop made it ~90ms of a ~120ms hop, so a durable run spent roughly 40% of its
  latency rediscovering a constant. A six-step run goes from 1.3-1.7s to 72ms on
  the microVM backend (a 17x improvement in hop latency), and measured throughput
  from 3.6 to 24.6 steps/sec. Nothing errored, which is why it is now pinned by a
  test.
- @alexkroman1/aai@8.2.0

## 8.1.0

### Patch Changes

- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0

## 8.0.0

### Minor Changes

- 32bbb05: Add the eval harness: `@alexkroman1/aai-runtime/eval` and `/eval/vitest`.
  
  `openEvalSession` drives a real session from TEXT — this runtime, the pipeline
  transport, the tool executor, `ctx` and the session event stream, with only the
  two speech stages faked — and `say()` returns the turn it provoked.
  `describeEval` gates a suite on a credential and, without one, runs it against a
  SCRIPTED model rather than skipping: the same code below the model, so a keyless
  run checks the wiring for free. `describeWorkflowEval` / `openEvalWorkflows` do
  the same for a workflow app, over the real workflow client and key store (no
  durability — the engine's doc says so at the seam). `run_code`, `fetch`,
  `toolTimeoutMs` and `workflows` are all suppliable per case, and `saidIn` /
  `toolCallsIn` / `toolResultIn` / `lastStateIn` / `customEventsIn` read the
  answers out of the event stream.
  
  `RuntimeOptions.toolTimeoutMs` is new and applies beyond evals: the tool
  executor always accepted a per-call deadline and the session path passed none,
  so a session's 30s voice-turn budget was unreachable from any caller.
  
  New `aai eval` command runs a project's `agent.eval.test.ts`, and every shipped
  template now has one.

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0

## 7.0.0

### Major Changes

- 76ca287: **BREAKING — the last 76 `@internal` names come off the two packages' public
  barrels: 68 to `@alexkroman1/aai-runtime/internal`, 8 to a new
  `@alexkroman1/aai-ui/internal`.** Both `contracts/internal-surface.json`
  ratchets are now at zero, which is where `@alexkroman1/aai` already stood.
  
  The exemption those files record is the one hole in the capability contracts: a
  name tagged `@internal` at its declaration site but reachable anyway from a
  public subpath belongs to no capability, gets no epoch and no frozen compiling
  template, and is held to nothing but a comment. It is a ratchet that may shrink
  and may never grow, and counting it is what got it paid off — `aai` went 71 to
  0, `aai-runtime` 68 to 0, `aai-ui` 8 to 0.
  
  A release tag cannot close it from the barrel. API Extractor reads `@internal`
  at the DECLARATION site, so the tag on a re-export clause member is silently
  ignored and the name stays `@public` in the report. A deny-listed subpath is the
  mechanism, and it is the third time this repo has reached for it.
  
  **`@alexkroman1/aai-runtime`** — the second tranche off that root barrel, after
  the 31 host-internal pass-throughs that made the subpath exist. These 68 are the
  package's OWN host infrastructure: the host-mode server and its tool relay, both
  transports and the `Transport` contract they satisfy, the session core, the
  session-state backends and the table names and DDL they own, the workflow
  serving half (API handler, surface, world, install), the wake hint, the
  queue-lock sweep, the step-slot publishers, and the two shipped `Logger` values.
  What stays on the root barrel is exactly what a capability covers.
  
  Where a type is contracted and its constructor is not, the two now split: the
  `SessionCore`, `SessionStateBackend`, `SessionStateStore`, `SessionEventPage`,
  `SessionEventStream`, `Logger` and `S2SConfig` TYPES — the shapes a host
  implementing one has to name — stay on the root barrel; `createSessionCore`,
  `createMemoryStateBackend`, `createSessionStateStore`, `createSessionEventStream`
  and `consoleLogger` move. The 17-name OPENER CONTRACT deliberately did not move,
  for the reason it did not move last time: relocating it would make a custom
  speech provider import from two subpaths, one labelled not-semver-covered.
  
  **`@alexkroman1/aai-ui`** gains its first `./internal` subpath, carrying
  `SessionProvider`, `ThemeProvider`, `ToolConfigContext`, the three URL chips
  (`ApiUrlChip`, `SessionUrlChips`, `UiUrlChip`), `buildAgentUrl` and
  `loadClientConfig` — none of which a `client.tsx` names, and all of which sat in
  a client author's autocomplete beside `client()` and `useAgentState`.
  
  `aai-server`, `aai-guest`, `aai-cli`, `aai-evals` and `aai-studio-server` import
  the moved names from the new subpaths — the cross-package consumers the seam
  exists for.
  
  Both barrels now state the rule in their module docs, so the next name does not
  re-open the ratchet: a name on `/internal` that wants to become public gets its
  `@internal` tag REMOVED at the declaration site and joins a capability under
  `contracts/entrypoints/`, which is what buys it an epoch. It is never
  re-exported from the public barrel with the tag still on it.
- b8a5529: **BREAKING — 31 names move off `@alexkroman1/aai-runtime`'s root barrel to
  `@alexkroman1/aai-runtime/internal`.**
  
  Every one is a re-export of `@alexkroman1/aai/host-internal`, which the SDK
  itself deny-lists from its contracted surface as "not semver-covered". That
  exemption is per SUBPATH, so re-publishing the names on this package's root
  barrel defeated it — fifty not-semver-covered names sat on the one surface an
  embedder autocompletes over, one package along, and no contract could cover them
  without promising epochs on the SDK's internals.
  
  A release tag cannot fix it from here: API Extractor reads `@internal` at the
  DECLARATION site, so a `/** @internal */` on a re-export clause member is
  silently ignored (verified — the name stayed `@public` in the regenerated
  report). A subpath is the mechanism, and `NON_AUTHORING_SUBPATHS` now names this
  one so a name arriving there joins no capability contract.
  
  What moved: the builtins resolver, the SSRF-safe fetch pair, the four step-slot
  publishers, and the upload byte constants and id grammar. `aai-server`,
  `aai-cli` and `aai-guest` import them from the new subpath — the cross-package
  consumers the seam exists for.
  
  The 17-name OPENER CONTRACT deliberately did NOT move. `registerSttKind`/
  `registerTtsKind` are on the root barrel, and relocating their parameter types
  would make a custom speech provider — the documented use — import from two
  subpaths, one labelled not-semver-covered.
  
  Two dead mocks came out with it, both of which had stopped covering anything
  while every spec kept passing: `aai-guest`'s `vi.mock("@alexkroman1/aai-runtime")`
  replacing `safeFetch` (the import had moved, so the real function ran), and the
  CLI dev-server factory's `publishStepEnv`.

### Minor Changes

- 19c1ce4: createAgentServer now forwards the agent env to the server it builds, so AAI_WORKFLOW_API_TOKEN and AAI_SESSION_EVENTS_TOKEN close their routes through that door and DATABASE_URL reaches the upload store (AAI_ALLOW_HOST is filtered out, as in the guest). A malformed upload id answers 400 naming the grammar on every /uploads/:id route instead of 500 on the two reads. SESSION_EVENTS_TOKEN_ENV is exported, so a host can spell the variable that closes that surface.
- abfc018: `createAgentServer` can now express what `createRuntime` + `createServer` can, and the LLM registry's writer is published.
  
  - **`telephony` is reachable from the front door.** `createServer` defaults it to on for a voice agent, and `createAgentServer` forwarded neither it nor `page` — so every server built through the documented door, the scaffold's own `server.mjs` included, mounted an unauthenticated `WS /phone` with no way to switch it off short of abandoning the wrapper and restating by hand every field it derives. `telephony`, `page` and `uploadBroker` are forwarded now, and `page` DEFAULTS TO THE AGENT'S OWN: a `page: "static"` agent used to get the voice surfaces and a voice `GET /client-config`, because nothing carried the declaration through — the same silent drop `createAgentServer` exists to prevent for `name` and `greeting`.
  - **A `PassthroughServerOptions` bag can be spread into `ServerOptions`.** Its three fields were optional without `| undefined`, so `{ ...hooks }` widened each and `exactOptionalPropertyTypes` rejected the whole object (TS2379) — the one bag that exists to reach all three front doors could not be handed to any of them. `ServerOptions`' `logger`, `upgrade` and `request` accept `undefined`; existing callers are unaffected.
  - **`registerLlmKind` and `LlmRegistryEntry` are on `@alexkroman1/aai-runtime`**, beside `registerSttKind` and `registerTtsKind`. All three are one mechanism, and the LLM one was published from no subpath at all while `resolveLlm` — which reads the registry it writes — was public and contracted. A host wiring a model the SDK does not ship no longer has to reach past the descriptor path.
  - **`@alexkroman1/aai-runtime/internal` drops 63 re-exports nothing imports**, taking it from 99 names to 36. Every removed name is `@internal` at its declaration and was reachable only through that subpath; intra-package use is relative imports, so nothing in the repo changes. The three that stay unimported (`WakeHintOptions`, `WakeHintPublisher`, `WorldKind`) are kept because a name that IS imported has one of them in its signature.
  
  This subpath carries no semver promise, but the removal is listed here because it is the visible half of the change.
- abfc018: Add `withToolsDir` to `@alexkroman1/aai-runtime`: a self-hosted Node process can now discover an agent's `tools/` directory at startup, so a tool is registered by existing on that path too rather than only where a bundler enumerates it.

### Patch Changes

- d98169a: **Breaking (nominally): `@alexkroman1/aai-ui/default-client/*` is removed.** It
  had no consumer in any form — not one import specifier in the repo, the
  templates, the scaffold, or any README — because every real consumer reaches
  those files by filesystem path through `./package.json` (`client-dir.ts`,
  `aai-server/transport-websocket.ts`). `files: ["dist"]` still ships them, so
  nothing that worked stops working. `aai-studio-client`'s `./dist/*` goes for the
  same reason: both of its consumers `require.resolve` the manifest and join
  `"dist"` themselves.
  
  Also widens `check:attw`. `aai-ui` pinned `--entrypoints .`, which silently
  excluded `./client-dir` — a typed, contracted subpath — and `aai-runtime`
  inherited the same pin. `aai-ui` now uses `--exclude-entrypoints styles.css`
  (a CSS entry point has no type declarations, which is the only reason the pin
  existed) and `aai-runtime` drops it entirely, so a NEW subpath defaults into
  being checked instead of out.
- b8a5529: Version `@alexkroman1/aai-runtime`'s published surface in epochs, like `aai` and
  `aai-ui`. Twelve capabilities — `server`, `runtime`, `session`, `session-state`,
  `providers`, `telephony`, `uploads`, `db`, `keys`, `workflow`, `logging`,
  `text` — partition all 122 public names, each with a committed epoch and a
  frozen, compiling authoring example. `pnpm check:api-contracts` now reports 42
  contracts across 3 packages.
  
  The split shipped a published package with no `contracts/` tree, so 221 exports
  could move with nothing recording it while its two siblings could not change a
  parameter without a gate asking which. `contracts/internal-surface.json` opens
  at 68 and may only shrink — the ratchet that took `aai` from 74 to 0.
  
  Two gate-test parsers had never seen shapes this package introduces, and both
  reported a healthy tree as broken. A capability whose every name is a type
  collapses to `export type { … } from` under Biome, which
  `api-contracts-gate.test.ts` read as "declares something of its own" — so
  `session` and `session-state`, the two most obviously correct roots, failed. And
  an entry point can be ALL re-export (`/internal` passes on 31 names and declares
  nothing), which `api-surface-file.test.ts` read as an empty report —
  indistinguishable there from a parser that stopped working. The gate tests also
  pin the three-way `:workflow` ambiguity now, plus `:session` and `:uploads`,
  which is what makes the CLI's refusal to guess load-bearing.
- Updated dependencies [12ead27]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [d1e7c56]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [6596e4b]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai@7.0.0
