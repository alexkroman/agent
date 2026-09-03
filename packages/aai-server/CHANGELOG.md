# @alexkroman1/aai-server

## 5.1.0

### Minor Changes

- 61fe5cd: An attempt charge becomes a lease that EXPIRES, so a dead walk cannot refuse a healthy step forever. claimAttempt charges an attempt before a step body runs and answers how many are outstanding; a crash burns one, which is the mechanism that stops a wedging step being redelivered forever. But a scalar counter cannot expire: the charge a dead walk left was indistinguishable from a live one, so it stood permanently and maxAttempts deaths on one step key refused that step for the life of the run, with StepAbandonedError reporting a run nobody could revive — the residual workflow-replay-step.ts named and said needed a heartbeat to close. claimAttempt and releaseAttempt now take the walk's own id as a holder, and claimAttempt takes the window a charge counts for; the store keeps one row per (run, key) holding a map of holder to when it claimed, prunes what has aged out on every claim, and answers the number of live holders. A re-claim by a holder that already has a charge answers the same number rather than a higher one, which also makes the call idempotent over an at-least-once transport. The window is an hour and there is no heartbeat, so it deliberately clears the longest walk that can legitimately be running — erring long is recoverable where erring short removes the ceiling. One row per key rather than one per holder is the atomicity: measured on a real Postgres, a row per holder answered [1, 1, 3] for three concurrent claims against a contract that no two ever agree.

### Patch Changes

- 61fe5cd: Align the platform server's keep-alive with the guest's client. serve({fetch,port}) set no keepAliveTimeout, so the server reaped idle sockets at Node's 5s default while the guest's egress pool holds its end for 30s - and the shorter side decides, so the client's value was unreachable and every journal call more than 5s after the previous one opened a fresh socket. A durable step taking longer than 5s is the ordinary case, so the guest-to-platform journal path paid that on essentially every appendStep. Measured on a real server with the guest's real client keep-alive: 5 POSTs 6s apart cost 5 TCP connections before and 1 after. The server's value is now DERIVED from EGRESS_KEEP_ALIVE_MS (newly exported on aai-runtime/internal) rather than restated, because the two being set independently in different packages is the defect; headersTimeout sits above it, since Node races the two.
- 61fe5cd: Split the queue's retry budget in two, so an infrastructure condition cannot drop a message. 'attempt' counted every way a delivery can go wrong, and two of them are not the same fact: a guest that answered has told us something about the message, and a guest that was never reached has not. With one counter the cheapest infrastructure condition there is — the broker answering 503 because a sandbox boot is still in flight, which is literally up-but-not-ready — spent the same attempt as a step that threw, and five of those inside ~380s dropped the message; the run then waited out STALL_GRACE_MS before reconcile brought it back, so a blip cost sixteen minutes and six sandbox boots. A delivery that sent no request now throws GuestUnreachableError and spends a second counter (unreachable_attempts) on a longer, more patient backoff table whose total lands just inside the reconcile grace, so reconcile follows that budget rather than racing it. A fetch that throws is deliberately not classified as unreachable, since the guest may have received the message and be running the step.
- 61fe5cd: Flatten the workflow queue claim's cost curve, and time the admin-pool acquire.
  
  The claim re-orders the whole due set before applying its limit — that ordering is what stops a busy tenant starving a quiet one — so database work per message delivered grew with how far behind the queue was: at 180,000 due it sorted 179,960 rows to return 8, costing 467ms and 13.3MB of temp spill per tick, on a pool of 15 server connections shared by the whole fleet. Three result-identical changes take that to 142ms and 3.3MB: `distinct on (slug, run_id)` becomes a group-minimum anti-join that can early-terminate, the `locked_at` OR is split into a `union all` of its two disjoint branches so the unclaimed one is an ordered index scan that stops at the limit, and the outer limit is pushed into each arm. A new index (`slug, run_id, kind, available_at, id`) makes the anti-join's probes seeks rather than scans of the busy tenant's backlog; it costs single-digit microseconds per queue write, so break-even is around 85,000 writes per tick. The idle tick — what a 1Hz sweep is doing almost always — is unchanged and halves its buffers.
  
  Equivalence is checked against a frozen copy of the old selection, at eight widths and over 24 randomised fixtures, in a new real-Postgres suite.
  
  Separately, `withReserved` now times the reservation every guest-called platform route takes: a wait past half a second warns and names the pool, an ordinary one logs at debug, a failed acquire warns with the wait it spent (it logged nothing at all before, because the reservation is taken outside the `try`), and a 503 carries `waitedMs` and `workMs` so a failure says whether it was pool contention or a slow statement.
- 61fe5cd: Carry a W3C traceparent on every guest-to-platform RPC, and read it at the route. The busiest of those calls costs ~840ms of server time and that was a total with no breakdown: withReserved measures the server's half (how long the admin reservation waited, how long the statement ran) and the rest of the wall clock — the proxy, the round trip, anything queued before the handler ran — was unaccounted. Both halves are now measured; what was missing was the ability to put one beside the other, since a busy replica writes hundreds of these lines a second and a timestamp cannot correlate them. The runtime mints one span per call and logs its elapsed at debug, the platform route puts the trace id on every line withReserved writes, and 863ms against a waited+work of 43ms is a conclusion neither side could reach alone. W3C rather than a private header so an OTEL collector later reads these spans for free. ReservedCall declares the trace as a required key with an optional value, so a new platform route cannot forget to look for one.
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
- Updated dependencies [61fe5cd]
  - @alexkroman1/aai-runtime@13.1.0
  - aai-guest@0.5.15
  - @alexkroman1/aai@13.1.0
  - @alexkroman1/aai-ui@13.1.0

## 5.0.0

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

### Minor Changes

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

### Patch Changes

- 9e12bb2: Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.
  
  Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
- 4647b84: The durable-workflow queue claim reads two new columns instead of re-deriving them every tick: `workflow_queue.run_id` (generated from the payload envelope) and `workflow_queue.kind` (written at enqueue from the DevKit queue-name grammar). A busy tick goes 516 ms to 20 ms and an idle one 1.7 ms to 0.9 ms on a 200,000-row queue, and the expression index the old spelling needed is dropped with nothing in its place. Also: a zero-delay re-park now notifies, so a guest parking a busy walk no longer waits out a whole poll interval; and `STEP_QUEUE_NAME_PATTERN`/`WORKFLOW_QUEUE_NAME_PATTERN` leave `@alexkroman1/aai-runtime/internal`, which existed only to cross into that SQL.
- 4647b84: Give the durable-workflow queue's NOTIFY listener its own session-mode connection. It was subscribing through the transaction-mode pooler, where a LISTEN cannot be held: the subscription established without error, received nothing, and the only symptom was every step-to-step hop paying the sweep's poll interval again.
- 4647b84: Record the measured disproof of the claim that INSERT ... ON CONFLICT DO NOTHING leaves a dead tuple on the read path, and re-justify workflow_sleeps_due_idx against the query that really uses it.
- Updated dependencies [9e12bb2]
- Updated dependencies [9e12bb2]
- Updated dependencies [4647b84]
- Updated dependencies [9584e2e]
- Updated dependencies [9584e2e]
- Updated dependencies [b94fdd1]
- Updated dependencies [ef6c39c]
- Updated dependencies [b94fdd1]
- Updated dependencies [4647b84]
- Updated dependencies [ef6c39c]
  - @alexkroman1/aai@13.0.0
  - aai-guest@0.5.14
  - @alexkroman1/aai-runtime@13.0.0
  - @alexkroman1/aai-ui@13.0.0

## 4.0.0

### Major Changes

- 4507050: Bound a durable run's journal growth, and answer the contended step read by key.
  
  A live run's journal could grow without limit. Retention only ever bounded the POPULATION — `sweep_terminal_workflow_runs()` deletes terminal runs after 30 days — and a live run is not eligible for it at any size, nor can its journal be truncated, because replay answers every settled key from it. The cost is O(N) per delivery and O(N squared) across a run, since every walk reads the whole journal, so a long run got monotonically slower at doing the next step and eventually became undeliverable with nothing said. `workflow-journal-bound.ts` now warns at 8,000 journaled steps naming the count and the ceiling, and refuses at 10,000 with a message naming the remedy, before a body runs.
  
  BREAKING: `JournalStore` gains a required `readStep(runId, key)`. A host supplying its own journal through `RuntimeOptions.journal` must implement it: it answers ONE settled step by key, or undefined when it has not settled. `settledSince` — the re-read on the contended path, reached when `claimAttempt` says another walk touched a key — used to read the whole journal and keep one entry, an O(N) scan for an O(1) question in exactly the runs where N is largest. Both shipped databases key the step table on (run_id, key), so it is an index seek and needs no migration.

### Patch Changes

- Updated dependencies [4507050]
  - @alexkroman1/aai-runtime@12.0.0
  - aai-guest@0.5.13
  - @alexkroman1/aai@12.0.0
  - @alexkroman1/aai-ui@12.0.0

## 3.7.3

### Patch Changes

- b0a8a80: Fall back to the broad us-east region for the web service: Modal rejects us-east-1 at deploy time ("Regions us-east-1 are not supported"), so the previous fallback list failed the deploy and shipped nothing.

## 3.7.2

### Patch Changes

- 200537a: Place the web server in us-east-2 first, where the platform database is. A durable run's journal calls are sequential by construction, so an unpinned container put ~460 ms of distance on each one — 14 calls and ~7.3 s for one 300 KB transcription, against 31.4 ms for the same calls in-region. Pinned as a FALLBACK LIST (us-east-2, then us-east-1): a bare single region is what once placed no container at all.

## 3.7.1

### Patch Changes

- f376585: Re-date the two workflow-journal migrations that merged behind an already-applied one, so `supabase db push` accepts them: #1360's `20260902000000_workflow_step_started_at.sql` and `20260902010000_workflow_run_code_version.sql` sorted BEFORE #1358's `20260902120000_workflow_run_abandonment.sql`, which production had already applied, and the push refuses a pending file older than the last remote row. Renamed to `20260902130000`/`20260902140000` rather than passing --include-all, which would leave the applied schema a function of merge order instead of filename order. Both are `add column if not exists` and independent of the migration they now follow, so the resulting schema is unchanged. The bump is what arms the deploy: the path diff arms `migrate` on its own, but the columns' READERS shipped in #1360 and have been sitting behind a blocked release.

## 3.7.0

### Minor Changes

- f10b6aa: Publish `@alexkroman1/aai/html` — `htmlToText`, `parseFeed` and `pageMetadata` over the htmlparser2 and html-to-text parsers the SDK already carried, so a step reading somebody else's markup gets a real parse instead of regexes. The `link-digest` and `podcast-digest` templates move onto it, dropping ~65 lines of hand-written scraping. Also: one `jitteredBackoff` in place of three byte-identical retry-delay copies (guard-invariants rule 31), and `aai-server`'s TTL cache moves from quick-lru to the lru-cache it already depended on, making its entry cap exact.

### Patch Changes

- 165f9b2: Make the durable-workflow journal's first-write-wins claims one statement each and retry the indeterminate answer, escape the characters PostgreSQL cannot store, and give the reconcile pass an end so a run its guest can never finish is failed rather than re-walked forever.
- 36a3f22: Record when a step STARTED. `StepEntry.startedAt` joins the journal, so `finishedAt - startedAt` is what the step cost.
  
  An entry carried `attempts` and `finishedAt` and no start, so the only elapsed time derivable from a run's history was the gap between one step's finish and the next's — which is the previous step's cost plus whatever the body did between them, and is nothing at all for the first step of a run or the first after a durable wait. The park-curve numbers in `packages/aai-runtime/CLAUDE.md` came off a log line because the journal could not be asked.
  
  An absolute instant rather than a stored duration: the difference is derivable and the instant is not, and the gap between one entry's finish and the next's start is DELIVERY latency — a different question from step cost, and the one that tells a slow step from a slow queue. The span covers the whole reach (every try and its backoff) and excludes time queued behind the step gate.
  
  OPTIONAL, and absence means the row predates the column: the rows already stored have no start, and `0` would report a long step as instant. All four backends carry it, the conformance table pins absence in both directions (a start of `0` is kept, so an arm cannot satisfy the absence case by coercing), and `20260902000000_workflow_step_started_at.sql` adds the platform column.
  
  No reader surfaces it yet — the public workflow API carries a run snapshot and no step history — so it is queryable from the database and nowhere else. A route and a CLI verb are the next move and are not in this change.
  
  Also widens `journal-ddl-parity.test.ts`, which read only the migration that CREATES these tables and was therefore blind to any later ALTER — the drift it exists to catch. It now reads every migration in filename order, applies `add column` on both sides, and scopes the parse to the five tables the pairing derives. That immediately surfaced three previously uncompared platform-only objects (`workflow_runs.reconciled_at` and the two reconcile indexes), each now declared with its reason.
- 623a8bb: Collapse duplicate workflow-journal round trips and widen the platform admin pool.
  
  A deployed run's every journal operation is one `POST /:slug/workflow-journal`, measured at ~840 ms of platform time each. Three things multiplied them: a fan-out's stale-snapshot check re-read the whole journal once per step, overlapping walks each opened with their own `getRun` and `readSteps`, and every delivery took three of those round trips sequentially before a body ran.
  
  Concurrent identical `getRun`/`readSteps` now share one round trip (a coalescer, not a cache — no caller is answered from a read that started before it asked), and a delivery's step read is issued beside the `running` compare-and-set rather than after it. `ADMIN_POOL_MAX` goes 4 to 16: guest platform routes reserve a connection for the whole request, so 4 was a hard ceiling of four in-flight guest calls per replica, and with `PLATFORM_POOLER_URL` in transaction mode the pool costs the instance's max_connections nothing.
- 0718b57: Sort the platform manifests to syncpack's format rules (key order and exports condition order). No behaviour change: every manifest is deep-equal across the reformat, verified before landing. The version bump is here because package.json is shipped source, so check:deploy-changeset requires a carrier to name the deploy rather than letting a manifest edit ride an unrelated release.
- 36a3f22: Ship the named-wait key grammar. The replay engine now journals a durable wait as `sleep!<label>#<occurrence>` / `hook!<token>#<occurrence>` rather than positionally, and those keys are written to `aai_platform.workflow_sleeps` and `aai_platform.workflow_hooks` — so the platform wants the release that carries them.
  
  No schema change and no statement change: `key` is `text` and the reconcile query was already grammar-independent by design (it reads `delivered`/`closed`/`wake_at`, never the key). Its comment naming the old `hook!<n>` shape is updated.
- 36a3f22: Record which CODE a durable run was started against. `RunRecord.codeVersion` joins the journal, and the divergence message uses it to state whether the code changed instead of handing the reader a test.
  
  A run outlives the process that started it — that is what durable means — so it also outlives the bundle: a `ctx.sleep("nextDigest", DAY_MS)` parks for a day, deploys land, and the delivery that wakes it replays the body from whatever bundle the sandbox now runs. The engine has always been honest that resuming a run against a changed body is unsupported and had no way to say whether that is what happened.
  
  The cost showed up in the sharpest error this engine produces. `workflow-replay-divergence.ts`'s message ends by handing the reader a test to run against their own source, because the two causes of an unreached step key — a redeploy mid-flight, or a non-deterministic body — want opposite fixes, and a journal holds what a value WAS and never how it was produced. One version per run settles half of it: an inequality states the redeploy and names both bundles, an equality ELIMINATES it and leaves the computed name as the only remaining cause. The two-cause fork stays in the text either way, because it is what tells a reader what to look for.
  
  It is a DIAGNOSTIC and never a gate. Nothing refuses a run whose version moved: a deploy touching a page, a tool, a prompt or an unrelated workflow leaves this body's step sequence identical while the bundle hash changes on every deploy, so refusing on inequality would fail nearly all such runs to catch the few that really diverged — and the divergence check already catches those precisely, at the step that proves it.
  
  The value is read from THIS PROCESS's environment (`AAI_BUNDLE_SHA256`), never the agent's, for the reason `platformGuestOptions` is a separate name from `resolvePlatformQueue`: `agentServerEnv` strips only `AAI_ALLOW_HOST`, so an agent may set any other `AAI_*` key as a secret. Read from a tenant env, an agent could pin its own version and every walk would then report the code unchanged — which is worse than no version at all, since the message would assert as a fact the one cause it had ruled out. Absence therefore means UNKNOWN in both directions and must never read as unchanged; only a deployed guest has a hash, so `aai dev` and a self-hosted server keep the original two-cause fork.
  
  All four journal backends carry it, `20260902010000_workflow_run_code_version.sql` adds the platform column, and three conformance cases pin the round trip — one of them asserting `listRuns` carries it and not only `getRun`, which caught two live instances of exactly that: the postgres arm's second select, and the unit platform arm's fake transport, whose run-row field list was written out twice and is now one function.
- Updated dependencies [36a3f22]
- Updated dependencies [0718b57]
- Updated dependencies [165f9b2]
- Updated dependencies [36a3f22]
- Updated dependencies [fe3b6d6]
- Updated dependencies [6bbef9b]
- Updated dependencies [63e1c8e]
- Updated dependencies [36a3f22]
- Updated dependencies [f10b6aa]
- Updated dependencies [623a8bb]
- Updated dependencies [7ab47cf]
- Updated dependencies [36a3f22]
- Updated dependencies [36a3f22]
- Updated dependencies [31459e8]
  - @alexkroman1/aai@11.0.0
  - @alexkroman1/aai-runtime@11.0.0
  - aai-guest@0.5.12
  - @alexkroman1/aai-ui@11.0.0

## 3.6.20

### Patch Changes

- f35bdf7: Fix a durable-workflow livelock and the park cadence that hid it.
  
  A workflow step longer than the guest's idle window never completed in production. The guest counted workflow work by HTTP RESPONSE, so the platform's 60s delivery abort read as an idle guest while the walk carried on; the sandbox self-exited mid-step `AGENT_IDLE_EXIT_MS` later and a fresh one restarted the same step, forever. Activity is now counted at the WALK — the promise the delivery door already awaits — so a running step keeps the guest alive and an idle one still exits promptly. A parked delivery is credited nothing, deliberately.
  
  The guest half reaches production through a platform DEPLOY rather than through its own version — the harness is baked into the guest image, whose content-addressed tag the server pins at deploy time — which is why `aai-server` is named alongside it.
  
  The park delay is also proportionate to the walk instead of a flat 5 seconds: `clamp(walkingForSeconds / 8, 5, 120)`, with the log line on the same curve. A 15-minute step now costs ~24 queue round trips and ~24 log lines rather than ~170 of each, while a brief race between two deliveries still gets its fast 5s retry.
- Updated dependencies [f35bdf7]
  - @alexkroman1/aai-runtime@10.0.1
  - aai-guest@0.5.11
  - @alexkroman1/aai@10.0.1
  - @alexkroman1/aai-ui@10.0.1

## 3.6.19

### Patch Changes

- dd699c7: Release the composer follow-up queue's dispatch latch when the send itself settles, not only when a render happens to observe a busy turn — a dispatched follow-up whose turn opened and closed inside one commit left the latch armed forever, wedging the composer and Publish until a reload
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
- Updated dependencies [dd699c7]
  - @alexkroman1/aai-runtime@10.0.0
  - @alexkroman1/aai@10.0.0
  - @alexkroman1/aai-ui@10.0.0
  - aai-guest@0.5.10

## 3.6.18

### Patch Changes

- Updated dependencies [1ad4977]
- Updated dependencies [bee46bc]
- Updated dependencies [1e5170a]
  - @alexkroman1/aai@9.2.0
  - @alexkroman1/aai-runtime@9.2.0
  - aai-guest@0.5.9
  - @alexkroman1/aai-ui@9.2.0

## 3.6.17

### Patch Changes

- Updated dependencies [041a5a2]
  - @alexkroman1/aai@9.1.0
  - aai-guest@0.5.8
  - @alexkroman1/aai-runtime@9.1.0
  - @alexkroman1/aai-ui@9.1.0

## 3.6.16

### Patch Changes

- Updated dependencies [dcb2050]
- Updated dependencies [cc317e4]
  - @alexkroman1/aai-runtime@9.0.2
  - aai-guest@0.5.7
  - @alexkroman1/aai@9.0.2
  - @alexkroman1/aai-ui@9.0.2

## 3.6.15

### Patch Changes

- Updated dependencies [533e217]
- Updated dependencies [533e217]
  - @alexkroman1/aai-runtime@9.0.1
  - aai-guest@0.5.6
  - @alexkroman1/aai@9.0.1
  - @alexkroman1/aai-ui@9.0.1

## 3.6.14

### Patch Changes

- Updated dependencies [444e209]
- Updated dependencies [65ad531]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [044236f]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [9d5e2a2]
- Updated dependencies [e888216]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [006cc1e]
- Updated dependencies [444e209]
- Updated dependencies [bccae5a]
- Updated dependencies [86398d7]
- Updated dependencies [fcb113c]
- Updated dependencies [e8bc7d9]
- Updated dependencies [1f21e37]
- Updated dependencies [444e209]
- Updated dependencies [f6be741]
- Updated dependencies [af284a7]
- Updated dependencies [af284a7]
- Updated dependencies [e20a992]
- Updated dependencies [9115625]
- Updated dependencies [4e2f9f3]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [bca2d99]
- Updated dependencies [444e209]
- Updated dependencies [7dd348f]
- Updated dependencies [01046b6]
- Updated dependencies [841f460]
- Updated dependencies [b238ba0]
- Updated dependencies [6796ae3]
- Updated dependencies [5bac92d]
- Updated dependencies [841f460]
- Updated dependencies [9e41442]
- Updated dependencies [841f460]
- Updated dependencies [18dfb1c]
- Updated dependencies [13b610f]
- Updated dependencies [044236f]
- Updated dependencies [841f460]
- Updated dependencies [841f460]
- Updated dependencies [95be1ca]
- Updated dependencies [c871232]
- Updated dependencies [857c3d9]
- Updated dependencies [6796ae3]
- Updated dependencies [6d360a7]
- Updated dependencies [841f460]
- Updated dependencies [af284a7]
- Updated dependencies [4743746]
- Updated dependencies [444e209]
- Updated dependencies [841f460]
- Updated dependencies [444e209]
- Updated dependencies [af284a7]
- Updated dependencies [444e209]
- Updated dependencies [9690f28]
- Updated dependencies [af284a7]
- Updated dependencies [777d0eb]
- Updated dependencies [35a57fb]
- Updated dependencies [841f460]
  - @alexkroman1/aai@9.0.0
  - @alexkroman1/aai-runtime@9.0.0
  - @alexkroman1/aai-ui@9.0.0
  - aai-guest@0.5.5

## 3.6.13

### Patch Changes

- aai-guest@0.5.4
  - @alexkroman1/aai@8.2.1
  - @alexkroman1/aai-runtime@8.2.1
  - @alexkroman1/aai-ui@8.2.1

## 3.6.12

### Patch Changes

- d703845: Fix five production failures found in one day of Modal logs. A pinned harness image now resolves from EITHER image source: setting GUEST_IMAGE_REGISTRY orphaned every `agents.harness_image_tag` recorded before the flip, because a tag is source-independent but the published IMAGE is not, so every agent deployed earlier answered 503 behind a Modal error whose exception text is empty. The boot capacity check now reads how the admin pool is ROUTED — with PLATFORM_POOLER_URL unset it printed `capacity ok — 0 spare` one line under the warning naming the 20 fleet-wide connections it was not counting, so the 53300 exhaustion those predict arrived unwarned. An unreachable Supabase Auth or Storage answers 503 rather than 500, and a storage failure keeps its cause instead of stopping at undici's `fetch failed`. And GET /robots.txt returns a policy rather than 400 from the slug validator.

## 3.6.11

### Patch Changes

- b5c23a0: Answer 503 when the platform database is unreachable, refuse Supabase's direct host as a pooler URL, and report a change stream that DROPS after joining. All three come from a production outage where a Modal secret pointed the admin pool at `db.<ref>.supabase.co`, which has no A record on a project without the IPv4 add-on: /studio/account answered an opaque 500 for 20+ minutes, the mode-only pooler guard could not see the wrong host, and the two agents-channel drops that evening were invisible to `health()` because one successful join marked a channel healthy forever.

## 3.6.10

### Patch Changes

- Updated dependencies [690a623]
- Updated dependencies [690a623]
  - @alexkroman1/aai-runtime@8.2.0
  - aai-guest@0.5.3
  - @alexkroman1/aai@8.2.0
  - @alexkroman1/aai-ui@8.2.0

## 3.6.9

### Patch Changes

- c8d7f07: Extract the two identical hand-rolled sweep schedulers into one `createIntervalSweep`, and correct the wake sweep's half-wired report from `error` to `warn`. The scheduler's overrun policy is DROP (not `createCoalescingRunner`'s coalesce, and not queueing), it always `unref`s, and moving the in-flight flag out of `start()` fixes a latent overlap on start/stop/start. The severity correction is because the half-wired state is unreachable in production — both bindings arrive together in one `...base` spread — while narrow spec compositions reach it legitimately, so `error` mislabelled twelve unrelated specs.
- Updated dependencies [2f899e1]
- Updated dependencies [1789a55]
  - @alexkroman1/aai@8.1.0
  - aai-guest@0.5.2
  - @alexkroman1/aai-runtime@8.1.0
  - @alexkroman1/aai-ui@8.1.0

## 3.6.8

### Patch Changes

- 6e104da: Wire the durable-run wake sweep to the per-app databases its hints live in. The orchestrator passed only `adminDb`, and `startWorkflowWakeSweep` needs `appDb` too since the hints moved into each app's own database — so the sweep returned a no-op and reported it at `debug`, which `consoleLogger` drops unless `AAI_DEBUG=1`. No durable run whose sandbox had exited was ever woken. The not-started branch is now three branches: absent together stays `debug` (local dev), exactly one absent is an `error` naming it, and the interval-0 kill switch is `info`.

## 3.6.7

### Patch Changes

- Updated dependencies [83edc89]
- Updated dependencies [1d58f53]
- Updated dependencies [6960bfa]
- Updated dependencies [c0e3d85]
- Updated dependencies [32bbb05]
- Updated dependencies [efa6152]
- Updated dependencies [01b790c]
- Updated dependencies [56b775c]
  - @alexkroman1/aai@8.0.0
  - @alexkroman1/aai-ui@8.0.0
  - @alexkroman1/aai-runtime@8.0.0
  - aai-guest@0.5.1

## 3.6.6

### Patch Changes

- 053b6f2: Build aai-runtime in the Modal image. The studio server imports @alexkroman1/aai-runtime/internal, which resolves to dist/internal.js in the image, but BUILD_COMMAND never built that package — so the image built green and the entry died at warm-up on ERR_MODULE_NOT_FOUND.

## 3.6.5

### Patch Changes

- abfc018: Stop teaching two imports that cannot resolve, and gate the docs that carried
  them.
  
  The studio's workflow preamble told its coding agent to bound a fan-out with
  `mapInBatches` from `@alexkroman1/aai/utils`. That name is on
  `@alexkroman1/aai/step`, so every workflow the studio generated from the
  instruction opened with an unresolvable import — and `mapInBatches` is itself
  the deprecated alias of `mapConcurrent`. The bullet also justified the bound by
  claiming a work-stealing pool "diverges on replay", which is the opposite of
  what `sdk/map-concurrent.ts` documents: a window over a shared cursor hands out
  the next index monotonically, so the Nth call issued is item N-1 however the
  calls settle, and that is why the batching it replaced could be dropped for a
  measured 6.7x p50 tail. The bullet now names `mapConcurrent`, the right
  subpath, and the rule that IS load-bearing — one step call per callback,
  issued synchronously.
  
  `@alexkroman1/aai/runtime` went away with the runtime package split, and four
  files kept importing it: both example servers, the host-server bench, and the
  prose in the root README. They name `@alexkroman1/aai-runtime` now, and each
  example's manifest declares what it actually imports at the version the
  workspace ships (they were pinned at `^5.10.0` against a 6.11.0 workspace, with
  no runtime dependency at all and `ws` — which the bench needs — undeclared).
  
  `check-doc-examples` could not have caught either. `SOURCE_GLOBS` never
  included `packages/aai-runtime`, so a published package's seven `@example`
  blocks were compiled by nothing, and `MARKDOWN_FILES` had one of the three
  runnable examples' READMEs plus none of that package's. All three are in now
  (160 examples, floor raised to 157), and `examples/host-server/README.md`'s
  opening fence — the one that carried the dead import — is checked rather than
  skipped as `js`.
  
  `UPLOAD_KEY_PREFIX` was declared twice with the same value, once in
  `aai-server/upload-bytes.ts` and once on `@alexkroman1/aai-runtime`'s root.
  The platform imports the runtime's now. The key SHAPES still differ on purpose
  — `uploadKey` interposes the slug because this route writes into a bucket
  shared by every tenant — but where uploads begin is one literal again.
- d98169a: Resolve the default client through `@alexkroman1/aai-ui/client-dir` instead of
  two more copies of the three-line `require.resolve` dance. `aai-ui`'s guide
  already claimed this consolidation had happened; `transport-websocket.ts` and
  `orchestrator.test.ts` were the copies it missed. Behaviour gains one thing: a
  missing install now says so, naming `@alexkroman1/aai-ui`, where the inlined
  copy threw `MODULE_NOT_FOUND` for a path nobody wrote and surfaced as a server
  answering 404 for `/`. The memo the local copy carried is
  `createCachedDirReader`'s already.
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
- ddbb905: Studio coding agent: a `read_logs` tool, so it can read what the agent it is building actually printed.
  
  A runtime failure — a tool throwing mid-call, a missing provider key, a response shape the code guessed wrong — only happens with a real caller on the line, and `test_agent` loads the bundle inside the coding agent's own sandbox where none of that is visible. The evidence existed (it is what the studio's Logs pane shows) and the agent's only route to it was asking the user to read it out.
  
  `read_logs` takes an ENVIRONMENT (`preview`, the default, or `production`) and never a slug: the guest RPCs the host, which resolves the project's own deployed agents from the workspace of the (scope, project) the sandbox is pinned to and reads the platform's owner-authenticated `GET /:slug/logs` with the account key those agents were deployed with. The host drains the guest's cursor-indexed ring forward and returns the TAIL, because the ring hands back its oldest lines first and "what just broke" is at the other end. Eviction is reported rather than swallowed, and each of the three empty states — never deployed, not running, running and silent — says which one it is, since they call for different next moves.
- Updated dependencies [d98169a]
- Updated dependencies [12ead27]
- Updated dependencies [abfc018]
- Updated dependencies [028044a]
- Updated dependencies [429126e]
- Updated dependencies [76ca287]
- Updated dependencies [abfc018]
- Updated dependencies [43ceb43]
- Updated dependencies [8c9ce20]
- Updated dependencies [9b9051a]
- Updated dependencies [19c1ce4]
- Updated dependencies [55d5ec1]
- Updated dependencies [d98169a]
- Updated dependencies [ea0c9c9]
- Updated dependencies [b8a5529]
- Updated dependencies [abfc018]
- Updated dependencies [d1e7c56]
- Updated dependencies [b8a5529]
- Updated dependencies [abfc018]
- Updated dependencies [a7309a5]
- Updated dependencies [51d571d]
- Updated dependencies [43ceb43]
- Updated dependencies [ddbb905]
- Updated dependencies [6596e4b]
- Updated dependencies [abfc018]
- Updated dependencies [df8effa]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [abfc018]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
- Updated dependencies [23e8b3f]
  - @alexkroman1/aai-ui@7.0.0
  - @alexkroman1/aai-runtime@7.0.0
  - @alexkroman1/aai@7.0.0
  - aai-guest@0.5.0

## 3.6.4

### Patch Changes

- 279a986: Remove an unused logger left in service-config, surfaced by enabling noUnusedLocals repo-wide.
- Updated dependencies [11e4892]
- Updated dependencies [91364b0]
- Updated dependencies [3d20929]
- Updated dependencies [0397945]
- Updated dependencies [12deeec]
- Updated dependencies [8958dd1]
- Updated dependencies [1602a0e]
- Updated dependencies [0da62af]
- Updated dependencies [70e3ceb]
- Updated dependencies [f433015]
- Updated dependencies [298f3f2]
- Updated dependencies [1602a0e]
  - @alexkroman1/aai@6.11.0
  - aai-guest@0.4.31
  - @alexkroman1/aai-ui@6.11.0

## 3.6.3

### Patch Changes

- eda6060: Stage patchedDependencies patch files into the Modal deploy image's install layer, fixing `ENOENT: … open '/app/patches/<name>.patch'` at image build
- Updated dependencies [5556ed5]
  - @alexkroman1/aai@6.10.1
  - aai-guest@0.4.30
  - @alexkroman1/aai-ui@6.10.1

## 3.6.2

### Patch Changes

- Updated dependencies [1a76804]
  - @alexkroman1/aai@6.10.0
  - aai-guest@0.4.29
  - @alexkroman1/aai-ui@6.10.0

## 3.6.1

### Patch Changes

- 866d17f: Bound the wake sweep's per-app database reads and a deploy's blob writes to declared widths, correct the connection-budget invariant they rest on, and take the second rate-limit round trip off the run-start path.
- Updated dependencies [9d45c1e]
  - @alexkroman1/aai@6.9.1
  - aai-guest@0.4.28
  - @alexkroman1/aai-ui@6.9.1

## 3.6.0

### Minor Changes

- 46db894: The orphan-preview reap moves out of pg_cron into the server: a leader-elected in-process pass that reaps through deleteAgentResources, the same delete path DELETE /:slug uses. Deleting its SQL body removes the last second implementation of deprovisioning, along with dblink's whole support cast (platformDbDsn, PLATFORM_DB_DSN_SECRET, AAI_DBLINK_HOST) — and fixes the reap on sharded fleets, where the SQL version silently reclaimed nothing.
- 46db894: Per-app database create/drop now go through the Supabase Management API (supabase-management-js) instead of DDL on the platform admin connection. There is no SQL fallback: SUPABASE_ACCESS_TOKEN (plus a project ref, derived from SUPABASE_DB_URL or set via SUPABASE_PROJECT_REF) is required alongside SUPABASE_DB_URL outside local dev, and a local run without it has no per-app databases at all.

### Patch Changes

- 46db894: Local dev gets a loopback stand-in for the Supabase Management API (dev-management-api.ts, started by dev-server.mjs), so per-app databases work on the local stack while the server still takes the production create/drop code path. A scenario suite provisions and drops a real database through the real SDK over HTTP against it.
- Updated dependencies [ebd3c39]
- Updated dependencies [203c2d4]
- Updated dependencies [bbde9f9]
- Updated dependencies [a8e74a9]
  - @alexkroman1/aai-ui@6.9.0
  - @alexkroman1/aai@6.9.0
  - aai-guest@0.4.27

## 3.5.19

### Patch Changes

- Updated dependencies [c7bb199]
  - @alexkroman1/aai-ui@6.8.0
  - aai-guest@0.4.26
  - @alexkroman1/aai@6.8.0

## 3.5.18

### Patch Changes

- 7eb8b85: Refuse a workflow-upload window write under a slug no agent answers to.
  
  `slugMw` validates a slug's shape and its reserved names, never its existence, so `PUT /:slug/uploads/:id/:offset` accepted bytes under any slug at all — measured against production, `PUT /no-such-agent-here/uploads/upl_x/0` answered 201 and stored `uploads/no-such-agent-here/upl_x/0`, and a DELETED agent's prefix stayed writable indefinitely. The route is deliberately unauthenticated, like `/client-config` beside it, and its own doc argued the worst an unrecorded write achieves is an orphan — which only holds if the number of prefixes is bounded, and it was not. Nothing reclaims them either: `aai-sweep-blob-gc` matches `name like 'blobs/%'`.
  
  A write now costs one indexed column read (`getAgentVersion`) and answers the same 404 an unknown agent gets everywhere else. Reads are deliberately NOT gated: a read is the fan-out, so a lookup there is one query per window to establish what a miss already reports.
  
  This is the strongest check available at this layer and not the one you would want — the upload record lives in the app's own database, which only the guest can reach, so the platform cannot ask whether an id was ever claimed. Orphans under a real agent's prefix are unchanged.
- Updated dependencies [7f2637c]
- Updated dependencies [088eee6]
  - @alexkroman1/aai@6.7.2
  - @alexkroman1/aai-ui@6.7.2
  - aai-guest@0.4.25

## 3.5.17

### Patch Changes

- Updated dependencies [c46dac6]
  - @alexkroman1/aai@6.7.1
  - aai-guest@0.4.24
  - @alexkroman1/aai-ui@6.7.1

## 3.5.16

### Patch Changes

- Updated dependencies [9882411]
  - @alexkroman1/aai@6.7.0
  - aai-guest@0.4.23
  - @alexkroman1/aai-ui@6.7.0

## 3.5.15

### Patch Changes

- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
- Updated dependencies [6d6d71f]
  - @alexkroman1/aai@6.6.0
  - aai-guest@0.4.22
  - @alexkroman1/aai-ui@6.6.0

## 3.5.14

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- e2c2cda: Fix four production errors from an hour of Modal logs: a 30s proxy deadline that aborted healthy uploads (27 x 503), a parallel-upload part that treated a retryable 503 as a refusal, a 5xx whose cause was never logged, and an aborted request logged as an agent failure.
- Updated dependencies [58788ee]
- Updated dependencies [e2c2cda]
- Updated dependencies [153264f]
- Updated dependencies [153264f]
  - @alexkroman1/aai@6.5.1
  - aai-guest@0.4.21
  - @alexkroman1/aai-ui@6.5.1

## 3.5.13

### Patch Changes

- Updated dependencies [4da4327]
- Updated dependencies [4da4327]
  - @alexkroman1/aai@6.5.0
  - aai-guest@0.4.20
  - @alexkroman1/aai-ui@6.5.0

## 3.5.12

### Patch Changes

- Updated dependencies [5288539]
  - @alexkroman1/aai@6.4.0
  - aai-guest@0.4.19
  - @alexkroman1/aai-ui@6.4.0

## 3.5.11

### Patch Changes

- Updated dependencies [dd29277]
  - @alexkroman1/aai@6.3.1
  - aai-guest@0.4.18
  - @alexkroman1/aai-ui@6.3.1

## 3.5.10

### Patch Changes

- 5d99fa4: Terminate a sandbox that is still booting, so a delete cannot strand a guest against the database it just dropped
- Updated dependencies [b04af38]
- Updated dependencies [2e103d8]
  - @alexkroman1/aai@6.3.0
  - aai-guest@0.4.17
  - @alexkroman1/aai-ui@6.3.0

## 3.5.9

### Patch Changes

- Updated dependencies [295e8db]
  - @alexkroman1/aai@6.2.0
  - @alexkroman1/aai-ui@6.2.0
  - aai-guest@0.4.16

## 3.5.8

### Patch Changes

- c4791cc: Split the local-dev sentinel in two: SUPABASE_DB_URL decides where platform state lives (no memory tier beside a real database), AAI_LOCAL_DEV=1 declares a local run. pnpm dev:aai-server resolves the local Supabase stack and a repo-root .env itself; studio sign-in offers the methods GoTrue reports, so email+password works locally with no OAuth app; boot verifies pg_cron instead of creating it. Studio projects get a database by DEFAULT (absent means on; the opt-out is an explicit false), and `@workflow/world-postgres` is no longer bundled into the guest harness — it ships on-disk Drizzle migrations the bundle cannot carry, so the durable Postgres workflow world could never start.
- bb54679: Count app databases in the platform connection budget, check it against the real instance at boot, and cap concurrent SSE streams per caller scope. MAX_CONTAINERS drops to 5 while the per-container input caps rise to 200/400 — measured, one replica holds 2,000 concurrent streams with no degradation and they cost zero database connections, so a replica is cheap in the scarce resource.
- Updated dependencies [c4791cc]
- Updated dependencies [16bec88]
  - aai-guest@0.4.15

## 3.5.7

### Patch Changes

- Updated dependencies [df41665]
- Updated dependencies [24e8178]
  - @alexkroman1/aai@5.14.0
  - aai-guest@0.4.14
  - @alexkroman1/aai-ui@5.14.0

## 3.5.6

### Patch Changes

- Updated dependencies [4ba7ab3]
  - @alexkroman1/aai-ui@5.13.2
  - aai-guest@0.4.13
  - @alexkroman1/aai@5.13.2

## 3.5.5

### Patch Changes

- Updated dependencies [7e92c96]
  - @alexkroman1/aai@5.13.1
  - aai-guest@0.4.12
  - @alexkroman1/aai-ui@5.13.1

## 3.5.4

### Patch Changes

- 2ec1efd: Close four more resilience findings. R3: the slug lock's 15s acquire deadline was unreachable for same-replica contention, because both paths take the in-process mutex before the Postgres one — the mutex now carries the same deadline and a waiter that gives up releases its place in the chain. R4: blob WRITES now retry transient network errors like reads do; the write path moves far more bytes and is idempotent by construction (content-hash key plus upsert). R6: MAX_PLATFORM_DB_CONNECTIONS plus platform-db-budget.test.ts pin MAX_CONTAINERS x the per-replica direct-connection pools, which spanned two files that never referred to each other. R7: a guest's idle self-exit now drops the whole slot, not just its sandbox, so the map no longer grows one shell per slug for the life of the container.
- 9303ba8: Supabase audit fixes: deprovision an app database on the cluster its stored locator names (a change to APP_DB_URLS otherwise dropped on the wrong one and stranded tenant data); join the orphan-preview sweep on a stored generated column so it stops detoasting every workspace document once an hour; cascade chat and session rows from their workspace; make the Vault put idempotent under a lost create race; cap the token verify cache at the token exp; report a never-joining Realtime channel; refuse boot on a missing or public Storage bucket; and add sweeps for unreferenced blobs, runaway tenant queries and pg_cron run history.
- 9303ba8: Resync resident sandboxes when the agents change stream rejoins. subscribe() only sends the join and realtime-js rejoins after any socket drop, so changes in either window reach nobody — and since this stream is the single mover of resident sandboxes, nothing later noticed: a deploy during a drop left the replica serving superseded code and a delete left it answering for a deleted agent, until the guest happened to self-exit on idle. watchAgents now takes a slug-less onResync handler, and watchAgentInvalidation answers it by re-running the same per-slug reconcile over every resident in the slot cache.
- 2ec1efd: Bound the shutdown teardown. createShutdownHandler armed its fallback timer only after onShutdown() settled, so the one deadline on shutdown covered waiting for connections to close and left sandbox teardown unbounded — and teardown is the half that hangs, since Sandbox.drain/shutdown reach a guest through the spawn's readiness promise (120s of boot budget). SANDBOX_TEARDOWN_READY_MS (5s, memoized per sandbox) caps that wait, and SHUTDOWN_TEARDOWN_TIMEOUT_MS (20s) is the general net over the untimed Modal control-plane calls beneath it.
- Updated dependencies [5cfe26b]
- Updated dependencies [90e5c15]
- Updated dependencies [cdc8e54]
- Updated dependencies [db4b0fb]
- Updated dependencies [ce45435]
- Updated dependencies [cdc8e54]
  - @alexkroman1/aai@5.13.0
  - aai-guest@0.4.11
  - @alexkroman1/aai-ui@5.13.0

## 3.5.3

### Patch Changes

- 49d63cd: Store jsonb columns as jsonb: the ::jsonb parameter cast made postgres.js double-encode every document, which broke all metadata stamps and blinded the orphan-preview sweep

## 3.5.2

### Patch Changes

- 6b18703: Collapse Modal's per-abandoned-SSE-stream proxy traceback to one line, so the container log is readable during an incident
- 65eab69: Fix the Modal container crash-loop: guard the image recipe's repo read behind modal.is_local(), and verify the rollout in CI instead of trusting modal deploy's exit code

## 3.5.1

### Patch Changes

- 9a7916a: Close three caching gaps on the Supabase-backed read paths.

  The agent shell is served `no-store`. It referenced content-hashed assets that
  only resolve through the current agents row, so a redeploy unmapped them and a
  cached shell 404'd its own entry script — a white page, with no stale-build
  reload on this surface to recover. It previously carried no cache headers at
  all, which lets a heuristically caching intermediary reuse it.

  The bundle store's row, version, and blob reads are single-flighted. The
  read-through caches only ever served a read that had already finished, so a
  cold replica answered a burst for one deploy with one Postgres read and one
  Storage download per request: measured at 61 backend round trips for 20
  browsers fetching a shell plus an asset, against 3.

  Blob uploads carry a one-year cache directive, matching the immutability their
  content-addressed keys already guarantee. Inert today — every read is an
  authenticated download or a per-call signed URL — but Storage stamps the
  directive at upload time and never revisits it.

- a7fc229: Cut latency from the deployed-agent sandbox spawn: write the bundle and env boot artifacts concurrently instead of serially, issue the tunnel lookup before those writes so its round trip overlaps the ~8 MB bundle upload, and tighten the guest readiness probe interval from 250ms to 100ms (the interval is dead time on every spawn — half of it on average — and the probe is a localhost TCP connect inside an idle container).
- 7cf76d3: Layer the Modal image dependencies-first: install from normalized workspace manifests before copying the source, so an ordinary code change reuses the installed node_modules instead of refetching the whole tree on every deploy.
- 7cf76d3: Keep the studio UI alive across a Modal deploy: serve the app shell no-store (it names content-hashed assets that only exist in the image it was built into, and those are served immutable), and recover a tab whose chunks were deleted by the rollout — one guarded reload on a failed lazy import or Vite modulepreload error instead of a blank page.
- a87bd05: Emit a workspace change event on `patch`, so the studio's Preview pane updates
  under `pnpm dev:aai-server`.

  `withWorkspaceEvents` — the dev/test decorator standing in for production's
  `postgres_changes` stream — wrapped `put` and `delete` but not `patch`. Every
  metadata stamp goes through `patch` (`stampWorkspaceMeta` is the only writer of
  `previewSlug`/`previewHash`/`previewError`, `deployedSlug`/`deployedHash`, and
  `databaseEnabled`), so in local dev a finished preview deploy pushed no
  `project` frame at all. With no polling loop behind those streams, the Preview
  pane sat on "Nothing to preview yet" / "Updating preview…" until the page was
  reloaded — and a failed preview's error banner, a Publish, and the database
  switch were silent the same way. Production was unaffected: it wraps nothing,
  because the row's own UPDATE is what Realtime streams.

  The studio SSE regression test modelled the preview stamp as a read-modify-write
  rather than calling `stampWorkspaceMeta`, which is why it stayed green.

- Updated dependencies [db3fb48]
- Updated dependencies [42cf8ab]
- Updated dependencies [c49f501]
- Updated dependencies [db3fb48]
- Updated dependencies [a91c3bc]
- Updated dependencies [db3fb48]
- Updated dependencies [c49f501]
- Updated dependencies [9fded19]
- Updated dependencies [348fa16]
- Updated dependencies [db3fb48]
- Updated dependencies [9fded19]
  - @alexkroman1/aai@5.12.0
  - @alexkroman1/aai-ui@5.12.0
  - aai-guest@0.4.10

## 3.5.0

### Minor Changes

- 443dbfc: Remove the split-services deployment. There is now ONE Modal app (aai-server-web) serving both surfaces from the aai-studio-server entry. Deletes the aai-studio-web app, the STUDIO_UPSTREAM_URL reverse proxy (createStudioProxy/gracefulEventStream), the AAI_SERVICE=studio mode, and aai-server's own entry point — aai-server is now a library with no build. The split was never wired in production, so the combined branch was the only one that ever ran. isStudioPath moves to aai-server/studio-paths.ts. CI now deploys when EITHER server package version bumps, since the one app runs the studio entry.

### Patch Changes

- 443dbfc: Unpin the Modal region for both web services so containers are placed by capacity. A pinned region (us-east-2) confined the always-warm agent replica to one region's spare capacity; when it ran dry Modal placed nothing and the app sat at deployed with zero tasks, requests hung with zero bytes, and no container logs existed at all because no container was ever created.

## 3.4.8

### Patch Changes

- Updated dependencies [e8d5e15]
  - @alexkroman1/aai@5.11.0
  - aai-guest@0.4.9
  - @alexkroman1/aai-ui@5.11.0

## 3.4.7

### Patch Changes

- f941665: Install pnpm with npm in the Modal service image instead of corepack. Node stopped shipping corepack in its official distributions at 25, so the 24 to 26 base-image bump broke every deploy at the first build step with 'corepack: not found' (exit status 127). aai init's dependency-install failure now points at npm install -g pnpm rather than a corepack command that does not exist on Node 25+.
  - aai-guest@0.4.8
  - @alexkroman1/aai@5.10.1
  - @alexkroman1/aai-ui@5.10.1

## 3.4.6

### Patch Changes

- 3a6a510: Surface a failed sandbox spawn as a retryable 503 instead of an opaque 500, and stop pinning guest sandboxes to one Modal region
- 6b4a6d8: Run the platform on Node 26: the Modal service image, the guest sandbox base image, the repo's pinned toolchain, and CI all move from 24 to 26, matching the `@types/node` major the workspace already type-checks against. Published SDK packages keep `engines.node: >=24` so consumers on the previous LTS are unaffected.
- Updated dependencies [b125465]
- Updated dependencies [1731876]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [fb7b545]
- Updated dependencies [b125465]
- Updated dependencies [c7617df]
- Updated dependencies [b125465]
- Updated dependencies [520900f]
- Updated dependencies [b125465]
- Updated dependencies [c524b76]
- Updated dependencies [b125465]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [6b4a6d8]
- Updated dependencies [ae9fd19]
- Updated dependencies [b125465]
- Updated dependencies [6ca79e0]
- Updated dependencies [b125465]
- Updated dependencies [fee8ece]
- Updated dependencies [ae9fd19]
- Updated dependencies [d8e34d8]
- Updated dependencies [a90296e]
- Updated dependencies [b125465]
- Updated dependencies [a82e54d]
- Updated dependencies [4b6e064]
- Updated dependencies [1c5056f]
- Updated dependencies [4b6e064]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [b125465]
- Updated dependencies [ae9fd19]
  - @alexkroman1/aai@5.10.0
  - aai-guest@0.4.7
  - @alexkroman1/aai-ui@5.10.0

## 3.4.5

### Patch Changes

- aai-guest@0.4.6
- @alexkroman1/aai@5.9.0
- @alexkroman1/aai-ui@5.9.0

## 3.4.4

### Patch Changes

- aai-guest@0.4.5
- @alexkroman1/aai@5.8.1
- @alexkroman1/aai-ui@5.8.1

## 3.4.3

### Patch Changes

- d140e9b: Bake the guest toolchain as a cached Modal image layer instead of an npm install exec
- d140e9b: Store deploy artifacts through Supabase Storage's own client instead of a generic S3 driver
- d140e9b: Serialize per-slug mutations with a Postgres advisory lock instead of a lease table
- d140e9b: Stop booting sandboxes once a replica is draining, and let the proxy observe the health 503 first
- d140e9b: Identify guest sandboxes by Modal name instead of a heartbeated lease table
- d140e9b: Use Modal readiness probes for guest boot, and lock the guest toolchain
- d140e9b: Declare the platform schema in Supabase migrations instead of creating it lazily per store
- Updated dependencies [d140e9b]
- Updated dependencies [d140e9b]
  - @alexkroman1/aai@5.8.0
  - aai-guest@0.4.4
  - @alexkroman1/aai-ui@5.8.0

## 3.4.2

### Patch Changes

- Updated dependencies [56efab9]
- Updated dependencies [1c034af]
  - @alexkroman1/aai@5.7.0
  - aai-guest@0.4.3
  - @alexkroman1/aai-ui@5.7.0

## 3.4.1

### Patch Changes

- fb288d2: Grant service_role SELECT on the Realtime-watched aai_platform tables so filtered postgres_changes subscriptions stop failing with 'invalid column for filter'

## 3.4.0

### Minor Changes

- 5cd6d50: Replace Supabase magic-link email sign-in with GitHub OAuth, and rework `aai login` as a device-link flow: the CLI no longer signs in (or creates accounts) itself — it opens the studio with a one-shot link code that a signed-in browser session approves, then exchanges the code for the account's stored API key. The `GET /studio/account/key` route is removed in favor of the one-shot exchange.
- 29fa487: Studio scope unification and workspace source sync: raw API keys stored via the account route reverse-map to the owning studio user (`key-user:<sha256(key)>`), so a linked CLI shares the browser's project scope; new `PUT /studio/projects/:project/source` replaces a workspace's file map atomically with a files-hash fast-forward token (`sourceHash` now returned by project GET/SSE payloads); deleting a studio project cascades to its deployed and preview agents through the shared `deleteAgentResources` core, ownership-gated per slug.

### Patch Changes

- 77b0a80: Cap the broker's wait on a booting sandbox (BROKER_READY_TIMEOUT_MS) instead of holding the client for the guest's full boot budget.
- 77b0a80: Log guest stderr on boot failure, validate the resume sessionId, and stop a bundle spoofing its own deploy-time config.
- f4ae66f: Two more guest-ownership moves: replica shutdown RETIRES agent guests
  (one awaited deadline-carrying drain each — live calls finish in the guests
  after the replica exits) instead of count-poll-terminate, deleting the whole
  shutdown session-drain machinery; and the client-config broker now PROXIES
  name/greeting from the guest's own `/client-config` (the bundle's live agent
  definition), making the stored config fully opaque to the host — no
  field-level reader remains.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- f4ae66f: Simplify sandbox management around guest-owned lifecycle: delete per-slug
  horizontal scaling and the cross-replica sandbox registry (one sandbox per
  slug per replica), delete host-side idle eviction (agent guests self-exit
  after 5 idle minutes), make retirement fire-and-forget (one
  deadline-carrying `POST /manage/drain`; the guest enforces the deadline),
  replace the control-channel `bundle/load`/`tool/execute` RPCs with a
  one-shot describe-mode harness exec for deploy-time config extraction, and
  fail loudly on an unresolvable pinned harness image
  (`SANDBOX_IGNORE_IMAGE_PINS=1` is the operator kill switch).
- c3f3c9a: Pin `SANDBOX_POOL_SIZE=0` in both Modal apps' image env: the warm sandbox pool stays disabled in production (no pre-warmed guest sandboxes). The `aai-server` Secret must not set `SANDBOX_POOL_SIZE`, since Secret values override image env and would silently re-enable the pool.
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [753665a]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [8b622e8]
- Updated dependencies [f4ae66f]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
- Updated dependencies [f4ae66f]
- Updated dependencies [77b0a80]
  - @alexkroman1/aai@5.6.0
  - aai-guest@0.4.2
  - @alexkroman1/aai-ui@5.6.0

## 3.3.1

### Patch Changes

- Updated dependencies [1a6f800]
  - @alexkroman1/aai@5.5.1
  - aai-guest@0.4.1
  - @alexkroman1/aai-ui@5.5.1

## 3.3.0

### Minor Changes

- 6cca475: Storage redesign: each agent is one Postgres row (aai_platform.agents) — slug, credential hashes, config, content hashes, deploy version — committing content-addressed immutable blobs (blobs/<sha256>) in Storage. The row upsert is the deploy's atomic publish point; manifest.json/config.json and the slug_epochs table are gone (the deploy version is the cross-replica invalidation signal). Secret and storage changes no longer restart sandboxes: they take effect on the next deploy or sandbox rebuild.
- ae89dd9: Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.

### Patch Changes

- afe0b6d: Fix two Supabase-era gaps: the agents change-event handler no longer drops invalidations that land mid-rebuild (the pre-filter now checks slot existence and rebuilds claim the slot before a fresh record read), and the pg_cron orphan-preview sweep deprovisions the app database schema/role before deleting its Vault credentials.
- b425548: Simplify platform server internals: shared memoized-async helper, one broker dependency set, workspace lock moved inside mutateWorkspace, studio project middleware, cached user-key resolution, and dead-code removal
- Updated dependencies [a57905b]
- Updated dependencies [030b55f]
- Updated dependencies [966aeed]
- Updated dependencies [6cca475]
- Updated dependencies [d303cfb]
- Updated dependencies [4de0abe]
- Updated dependencies [41d53ae]
- Updated dependencies [ae89dd9]
  - @alexkroman1/aai@5.5.0
  - @alexkroman1/aai-ui@5.5.0
  - aai-guest@0.4.0

## 3.2.6

### Patch Changes

- Updated dependencies [cb2de62]
- Updated dependencies [08dbc81]
- Updated dependencies [2198e2e]
- Updated dependencies [2198e2e]
- Updated dependencies [1d76583]
- Updated dependencies [5174cb2]
- Updated dependencies [aafe175]
  - @alexkroman1/aai@5.4.0
  - @alexkroman1/aai-ui@5.4.0
  - aai-guest@0.3.3

## 3.2.5

### Patch Changes

- Updated dependencies [27c5963]
- Updated dependencies [27c5963]
  - @alexkroman1/aai@5.3.0
  - aai-guest@0.3.2
  - @alexkroman1/aai-ui@5.3.0

## 3.2.4

### Patch Changes

- 99f3655: Stop cutting live calls on deploy, and make a deploy reach every replica.

  - A deploy/secret/storage mutation now **retires** the superseded sandbox
    instead of terminating it: it is detached from its slot synchronously (so no
    new session can be brokered onto it) and its remaining calls drain in the
    background before it shuts down, bounded by `SANDBOX_RETIRE_DRAIN_MS`.
  - The slot's idle timer now checks the slug epoch as well as the session
    count, so a deploy that landed on another replica is picked up within
    `IDLE_SANDBOX_MS` instead of only at that replica's next session broker.
    Previously a sandbox with continuous traffic was never reclaimed at all.
  - The shutdown drain counts sessions inside the guest sandboxes, not just
    WebSockets to the server process. Sessions dial the sandbox tunnel
    directly, so the old count always read zero and scale-in tore down live
    calls immediately despite a 120s drain budget.

- Updated dependencies [2cedec1]
  - aai-guest@0.3.1
  - @alexkroman1/aai@5.2.0
  - @alexkroman1/aai-ui@5.2.0

## 3.2.3

### Patch Changes

- ee903c5: Give guest sandboxes a burst range (reserve idle, cap for builds) so studio builds and Publish stop wedging at the cgroup ceiling

## 3.2.2

### Patch Changes

- b4cec81: Simplify aai-server internals: shared matchAnyHash/withLock/sleep/answerUpgrade/brokerSessionUrl helpers, epoch-guarded cache helper with in-flight manifest sharing, safeJsonParse adoption, OwnedMap.owns at slot identity checks, and removal of dead options and stale comments
- 31cdbaf: Tag Modal sandboxes with a role (agent, preview, studio, studio-publish, inspect, pool) alongside the slug, and re-tag pooled sandboxes on acquire, so the Modal dashboard distinguishes production agents from previews, studio sessions, and warm-pool spares
- Updated dependencies [e47a187]
- Updated dependencies [b829155]
- Updated dependencies [b1bf017]
- Updated dependencies [c745865]
- Updated dependencies [a96e9f8]
- Updated dependencies [ab577dc]
- Updated dependencies [8b8249e]
  - @alexkroman1/aai-ui@5.1.1
  - @alexkroman1/aai@5.1.1
  - aai-guest@0.3.0

## 3.2.1

### Patch Changes

- 38c1b97: Auto-create studio projects from the first chat message with server-generated v0-style names (prompt-derived base + random suffix) at shareable /studio/chat/<name> URLs; slugless CLI deploys now generate slugs from the agent's config name via the same shared generator.
- 0b39214: Pass matching cpu/memoryMiB reservations alongside cpuLimit/memoryLimitMiB when creating Modal sandboxes — modal 0.9.0 rejects a bare hard cap ("must also specify cpu when cpuLimit is specified"), which broke every guest sandbox spawn in environments setting SANDBOX_CPU_LIMIT/SANDBOX_MEMORY_LIMIT_MB.

## 3.2.0

### Minor Changes

- 3bc83bb: The API URL shown in the studio preview (and every default client) is now the
  long-living platform endpoint (`wss://host/:slug/websocket`) instead of the
  ephemeral sandbox tunnel URL, which dies on idle eviction or redeploy. The
  platform endpoint upgrades callers to the sandbox API itself: a plain
  WebSocket upgrade on `/:slug/websocket` resolves the agent's live sandbox
  (booting it on demand, like the client-config broker) and answers a 302
  redirect to the sandbox's current session URL, query preserved so
  `?sessionId=` resumes survive the hop.

### Patch Changes

- fa3f3fd: Enable per-slug guest-sandbox autoscaling in the production Modal deploy (8 sessions per sandbox, 4 replicas) with pinned 1-core/1-GiB guest resource limits
- 57c8b03: Forward Modal container stop signals to the node server so guest-sandbox teardown actually runs on scale-in/redeploy — orphaned sandboxes no longer linger as 2-3 MiB sleep-infinity shells for the ~20-minute orphan + idle window on every deploy
- Updated dependencies [8fb0a0d]
- Updated dependencies [ac21a90]
- Updated dependencies [3bc83bb]
- Updated dependencies [d1fc1c0]
  - @alexkroman1/aai@5.1.0
  - @alexkroman1/aai-ui@5.1.0
  - aai-guest@0.2.2

## 3.1.2

### Patch Changes

- fb4c14c: Resolve the public origin through aai-server/public-origin instead of the in-container request URL, so studio Publish deploys over https and keeps its Authorization header, and the bare-slug redirect stops downgrading the scheme. Version bump so both Modal apps redeploy.
- Updated dependencies [fb4c14c]
  - @alexkroman1/aai-ui@5.0.1
  - aai-guest@0.2.1
  - @alexkroman1/aai@5.0.1

## 3.1.1

### Patch Changes

- 23a3a5d: Fix Modal containers crashing at startup with ModuleNotFoundError: mount scripts/modal_image.py into the container image via add_local_python_source so the deploy script's import resolves when Modal re-imports it inside the container.

## 3.1.0

### Minor Changes

- fdd64ef: Per-tenant database caps (role connection limit 4, best-effort temp_file_limit 64MB) and a database locator per app: app-db:<slug> now records the cluster URL, provisioning places new apps deterministically across APP_DB_URLS clusters (cellular sharding), and openAppDb follows the stored locator.
- c36ad60: Deploy-time credential preflight: deploys are rejected (400) when the agent's config requires a credential its stored env doesn't hold, derived from the provider descriptors plus the new optional `requiredEnv` field on `agent()`. The studio publishes with a warning instead (it has no secrets UI). `aai dev` now also warns when a required key resolved from the shell only, since it won't survive `aai deploy`.
- fdd64ef: Stateless server: move cross-replica coordination into Supabase Postgres — per-slug deploy/delete/secret/storage mutations now serialize through a lease-based lock in aai_platform.slug_locks, and studio rate limits live in aai_platform.studio_rate_limits so they hold across replicas.
- fdd64ef: Split the studio backend from the agent backend: AAI_SERVICE selects combined (default), agent (reverse-proxies the studio surface to STUDIO_UPSTREAM_URL, keeping one public origin for the preview iframe), or studio (standalone service). Cross-service sandbox invalidation via slug epochs in aai_platform.slug_epochs — deploy/delete/secret/storage mutations bump, resolveSandbox rebuilds resident sandboxes on mismatch, which also closes the pre-existing replica-to-replica deploy staleness.
- fdd64ef: Cross-replica session resume: a session's resumable state (guest ctx.state via the new session/export RPC, remember notes) is persisted to aai_platform.session_state on disconnect and hydrated on a ?sessionId resume, so a reconnect landing on a different replica keeps the agent's working memory. Restore is set-if-absent on both sides so same-replica resume state always wins.
- fdd64ef: Extract the studio into its own package (aai-studio-server): aai-server is now the agent service plus the shared platform core, with wildcard TS exports for the sibling service. The combined entry moves to aai-studio-server; per-service Modal apps deploy independently, gated by changesets in CI.
- 293da11: The studio coding agent is now a Claude-Code-style agentic agent that runs
  INSIDE the project's own Modal sandbox, with the browser connected to it
  directly — mirroring the voice path. `POST /studio/projects/:project/
session` boots (or reuses) a guest sandbox through the same warm-pool
  machinery deployed agents use and returns the sandbox's public chat URL;
  turns stream browser→sandbox over SSE and never pass through the platform
  host. The loop runs in the guest on the caller's own key with tools over a
  real filesystem workspace — list/read (windowed)/write/edit/delete, glob,
  grep, bash (a real shell in the container), todo_write, test_agent, and
  the keyless web builtins — each with a user-friendly label served by the
  sandbox (`GET /studio/tools`) and rendered in the studio UI. End of turn,
  the guest syncs workspace edits and the conversation back over the
  authenticated control channel; test_agent builds via a guest→host RPC to
  the out-of-process build runner. The host-side chat loop, scan worker
  thread, and host tool implementations are removed — the SDK's
  `createServer` gains a `request` hook so the harness can serve the chat
  surface without a second HTTP server.
- cc71fab: Workers ship their own SDK runtime, and all studio builds run in the guest sandbox through the aai CLI's bundlers.

  - `buildWorker`'s wrapper entry now bundles the user's installed SDK runtime behind an `__aaiCreateRuntime` export; the guest harness builds sessions through that factory and embeds no runtime of its own, so platform SDK drift can no longer break deployed agents. Bundles without the factory are rejected at `bundle/load`.
  - The studio's out-of-process build subsystem (build runner/entry/protocol/cache, the import-allowlist worker build, the host client build, and the `studio_build` Modal Function) is deleted. `test_agent` builds the live workspace in the guest; Publish builds via the new host→guest `workspace/build` RPC, which also returns the bundle's config self-description — no throwaway inspection sandbox on the studio path.
  - The guest snapshot image now bakes the build toolchain (`@alexkroman1/aai-cli` + workspace-facing packages) next to the harness; versions derive from aai-guest's own dependencies.
  - `MAX_WORKER_SIZE` rises to 30 MB; `evalWorkerBundle` imports workers via a temp `file:` URL (the bundled runtime's CJS interop rejects `data:` URLs); the dev server opts out of runtime inlining to keep watch rebuilds fast.
  - Studio Publish now runs the literal `aai deploy` CLI inside the project's sandbox (`workspace/deploy`), and the CLI's output is posted into the chat so the coding agent sees deploy errors. `aai deploy` gains `--allow-missing-secrets` (server-side `credentialPolicy: "warn"` in the deploy body), and deploy responses now carry preflight `warnings`.
  - The studio's storage toggle and routes are removed — storage is CLI-only (`aai storage enable`). Deployed-agent secrets move to their own Secrets panel backed by the platform's `/:slug/secret` routes; every change posts a note into the chat (key names only).
  - `aai build` and `aai deploy` now type-check the project (`tsc --noEmit` with its own tsconfig and compiler; `--skipTypecheck` opts out), as does the studio's `test_agent`. Studio workspaces are completed into real projects in the guest (package.json, tsconfig.json, global.d.ts, vite.config.ts — scaffold-mirroring, existing files win).

### Patch Changes

- 6fb3bc3: Fix hot-path concurrency bugs: TTS reconnect deadline + clean-close mute + stale FlushDone pairing, session resume takeover/overlap races, host-mode handshake frame loss + per-connection runtime leak, post-stop transport events, client-cancel tool abort, drain-window barge-in classification, false-interruption resume vs committed final, S2S error-before-close and tool.result redelivery after resume, tool timeout firing ctx.signal, per-agent tool-fetch concurrency parity, sandbox teardown closing live session sockets, orchestrator re-resolve identity re-check, NDJSON/pool/cold-spawn hardening
- 55e045b: Replace hand-rolled patterns with newer Node built-ins: util.styleText instead of picocolors in the CLI (dependency removed), one-shot crypto.hash() for SHA-256 digests, node:timers/promises for the dev-server listen retry, and an async-disposable WarmHarness (Symbol.asyncDispose + await using) that unifies the sandbox teardown triple across describeBundle, configureSandbox failure paths, and the studio sandbox.
- a2c387a: Move the studio_build Modal Function into the studio app (aai-studio-web) so the build entry's code and its deployment version together — a changeset touching aai-studio-server previously redeployed the studio service but left the agent app's studio_build function running the old entry.
- 338a61e: Horizontal guest-sandbox scaling: least-connections routing across per-slug sandbox replicas (SANDBOX_MAX_SESSIONS / SANDBOX_MAX_REPLICAS), scale-out at capacity, idle scale-in
- fdd64ef: Autoscale the Modal web service: target/max input concurrency with min/max/buffer container bounds, coupled to the server's per-replica MAX_CONNECTIONS websocket cap so Modal scales out before any replica starts refusing upgrades.
- 293da11: The studio LLM now runs exclusively on the caller's own AssemblyAI API key
  (the request bearer) via the LLM Gateway — the platform holds no studio LLM
  credential: the `ASSEMBLYAI_API_KEY`/`ANTHROPIC_API_KEY` host fallbacks,
  `STUDIO_LLM_PROVIDER`, and the chat 503-when-unconfigured path are removed
  (`STUDIO_LLM_MODEL`/`STUDIO_LLM_REGION` remain as host model config). With
  `web_search` now keyless, the dev-boot key check (`assertDevKeys`) is
  removed from both services.
- 78af4d2: Developer mode on macOS now runs guest sandboxes in local Apple containers (via the container CLI) instead of Modal; SANDBOX_BACKEND overrides the selection.
- Updated dependencies [c36ad60]
- Updated dependencies [9b95fc9]
- Updated dependencies [5a599b2]
- Updated dependencies [e8fef4b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [25938b2]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [6fb3bc3]
- Updated dependencies [55e045b]
- Updated dependencies [0c2bdbd]
- Updated dependencies [293da11]
- Updated dependencies [0c2bdbd]
- Updated dependencies [30914c9]
- Updated dependencies [0c2bdbd]
- Updated dependencies [0c2bdbd]
- Updated dependencies [01cecc1]
- Updated dependencies [d4c2a10]
- Updated dependencies [0c2bdbd]
- Updated dependencies [e8fef4b]
- Updated dependencies [293da11]
- Updated dependencies [e8fef4b]
- Updated dependencies [30914c9]
- Updated dependencies [fdd64ef]
- Updated dependencies [0c2bdbd]
- Updated dependencies [cc71fab]
  - @alexkroman1/aai@5.0.0
  - @alexkroman1/aai-ui@5.0.0
  - aai-guest@0.2.0

## 3.0.3

### Patch Changes

- 34b40f7: Switch the pipeline-simple template's TTS from Cartesia to AssemblyAI so all templates use AssemblyAI TTS
- 4de94cb: Default the studio coding agent's pipeline LLM to qwen3-next-80b-a3b on the AssemblyAI LLM Gateway (studio prompt, chat model list, and codegen evals); pipeline mode remains the default over the S2S voice agent API, and the evals now assert the default gateway model id
- 9509b0f: Studio starter project now defaults to a pipeline agent: AssemblyAI STT, qwen3-next-80b-a3b on the AssemblyAI LLM Gateway, and AssemblyAI TTS
- 77bc03a: Remove the legacy PBKDF2 credential-verify fallback and the orphaned base64url helpers; credential hashes are argon2id only. Secrets are stored in Supabase Vault with no app-layer encryption; stale comments claiming AES-GCM/HKDF encryption are corrected.
- Updated dependencies [3e21af9]
- Updated dependencies [9ad4e51]
- Updated dependencies [b50b0e9]
- Updated dependencies [b50b0e9]
- Updated dependencies [577b17a]
- Updated dependencies [527c401]
- Updated dependencies [3125c8d]
  - @alexkroman1/aai@4.0.0
  - @alexkroman1/aai-ui@4.0.0
  - @alexkroman1/aai-cli@4.0.0

## 3.0.2

### Patch Changes

- 444879c: Remove the studio coding agent's MCP integration (AssemblyAI docs MCP server and its tools, including the docs search tool); the agent looks up docs via visit_webpage instead
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
- Updated dependencies [9c9eadb]
  - @alexkroman1/aai@3.2.0
  - @alexkroman1/aai-ui@3.2.0
  - @alexkroman1/aai-cli@3.2.0

## 3.0.1

### Patch Changes

- 369f950: Ship a favicon.ico on the studio and voice agent pages: the AssemblyAI mark is bundled with the studio client and the default agent client, served at /favicon.ico (studio) and /:slug/favicon.ico (agents, with a custom client's own favicon taking precedence).
- 76b6f60: Default the studio coding agent to a cascaded pipeline (AssemblyAI STT, gpt-5.5 on the LLM Gateway, AssemblyAI TTS); the S2S voice agent API is now used only when the user asks for it. Codegen evals updated to grade the new default.
- 7d6b627: Pin Modal guest sandboxes to the platform server's region. Unpinned, Modal placed the web server in us-east-1 (AWS) and guest sandboxes in uk-london-1 (OCI), so every host↔guest RPC (ctx.db, Vector, guest fetch proxy, bundle/load) paid a transatlantic RTT inside voice turns. `modal-sandbox.ts` now passes `regions` to `sandboxes.create` from a new `MODAL_SANDBOX_REGION` env var (comma-separated for multiple regions; unset means unpinned, so local dev is unchanged), and `modal_deploy.py` pins the web server and studio_build functions to a single `REGION` constant and exports it as `MODAL_SANDBOX_REGION` — host and guests are co-located by construction.
- Updated dependencies [369f950]
- Updated dependencies [76b6f60]
- Updated dependencies [1749ca4]
  - @alexkroman1/aai-ui@3.1.0
  - aai-studio-client@0.1.10
  - @alexkroman1/aai@3.1.0
  - @alexkroman1/aai-cli@3.1.0

## 3.0.0

### Major Changes

- 2236275: Migrate all sandboxing and deployment to Modal.

  Agent guest sandboxes now run as remote Modal Sandboxes (`modal-sandbox.ts`,
  via the `modal` SDK): network-blocked containers running the Deno harness,
  speaking the same NDJSON JSON-RPC protocol over the exec'd process's stdio.
  The gVisor (runsc) OCI backend, the dev-mode child-process fallback, and the
  fake-VM harness are all removed — Modal credentials (`MODAL_TOKEN_ID` /
  `MODAL_TOKEN_SECRET`) are now required to run sandboxes in dev and prod alike.

  The server itself also deploys to Modal (`modal_deploy.py`,
  `pnpm --filter aai-server deploy:modal`); the production Dockerfile, the
  Docker test image, and the Fly.io configuration/deploy pipeline are removed.

- 2236275: Move the platform to Supabase and replace KV with an opt-in per-app database.

  - **Blob storage**: agent bundles now live in Supabase Storage via its
    S3-compatible endpoint (`SUPABASE_S3_ENDPOINT` / `SUPABASE_S3_ACCESS_KEY_ID`
    / `SUPABASE_S3_SECRET_ACCESS_KEY` / `SUPABASE_STORAGE_BUCKET`), replacing
    Tigris.
  - **Secrets**: agent env vars are stored in Supabase Vault over
    `SUPABASE_DB_URL` (service-role Postgres). The master-key envelope
    encryption and `KV_SCOPE_SECRET` are removed.
  - **KV support is removed** — `ctx.kv`, the `@alexkroman1/aai/kv` providers
    (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`), the `kv:` agent config field, the
    `/:slug/kv` HTTP API, and the guest `kv/*` RPC are all gone. The
    `remember`/`recall` builtins keep working, now backed by in-memory
    per-session notes.
  - **New: opt-in app storage (`ctx.db`)** — enabling storage gives an app its
    own Postgres schema + role in the platform's Supabase database, exposed to
    tool code as `ctx.db.query(sql, params)` (proxied over the `db/query` guest
    RPC). Enable it with the new `aai storage enable|disable|status` CLI
    command or the studio's Storage toggle; under `aai dev`, set `DATABASE_URL`
    in the project `.env`. Templates needing persistence (solo-rpg saves,
    debrief-workflow records) now use `ctx.db`; session-scoped template state
    moved to `ctx.state`.

### Patch Changes

- 6c79521: Studio builds run out of process: a Modal Function build worker in production, a local build subprocess in dev — never in the server process
- d917095: Fix session resume losing the agent's context (ctx.state): the browser client now reconnects with the server-issued sessionId instead of a bare resume=1 (so the server resumes the same session rather than minting a new id), and per-session tool state survives a disconnect for a resume grace window (SESSION_RESUME_GRACE_MS) on both the self-hosted runtime and the platform sandbox (deferred guest session/end) instead of being wiped the moment the old session stopped.
- 63af436: Guest sandboxes now set Modal's `idleTimeoutMs` (default 15 min, override
  with `SANDBOX_IDLE_TIMEOUT_SECS`), so sandboxes orphaned by a host crash
  self-terminate once their harness exec exits instead of billing until the
  4h lifetime cap. Healthy sandboxes are unaffected — the harness exec runs
  for the sandbox's whole life, so its idle timer never starts.
- d3f3ebb: Fix orphaned Modal sandboxes surviving for hours: the guest harness now self-exits after 5 minutes without host traffic (fed by per-harness host heartbeats) and hard-exits on stdin EOF, so Modal's idleTimeoutMs can actually reap sandboxes whose host died without teardown. Also sets TINI_SUBREAPER=1 in guest sandboxes to silence the denoland/deno image's tini warning.
- 57e1807: Remove the studio's per-request LLM model picker — chat always runs on the host-configured default model (gpt-5.5 on the AssemblyAI LLM Gateway)
- 3722a9f: Improve the studio coding-agent prompt: concrete design guidelines for custom client.tsx UI (color, typography, layout, Tailwind, accessibility) in the scaffold guide, plus parallel tool-call and context-gathering rules in the studio preamble
- Updated dependencies [bb02ded]
- Updated dependencies [2b395b3]
- Updated dependencies [d917095]
- Updated dependencies [08f2937]
- Updated dependencies [bb02ded]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [2236275]
- Updated dependencies [eb9f662]
- Updated dependencies [57e1807]
- Updated dependencies [6cac47f]
  - @alexkroman1/aai@3.0.0
  - aai-studio-client@0.1.9
  - @alexkroman1/aai-cli@3.0.0
  - @alexkroman1/aai-ui@3.0.0

## 2.0.0

### Major Changes

- e17fdc4: Remove the text-only agent mode: an agent is always a voice conversation, and a workflow never speaks.

  - `agent()` with `tts: none()` is now rejected at parse time (parseManifest, toAgentConfig, and the platform's IsolateConfigSchema) — speech-in, text/action-out apps are workflows.
  - `workflow()` no longer accepts a `tts` parameter; it always sets the internal `none()` sentinel.
  - aai-ui: `TextControls` is removed and `ChatView` always renders the voice `Controls`. `SessionCore`'s programmatic audioOut-aware APIs (`startRecording`, `sendAudioFile`) remain.
  - The `pipeline-text-only` template and the studio's text-only starter are removed.

### Minor Changes

- 4051d7a: Two app modes — agents and workflows: new workflow() definition (audio in, action out: push-to-talk or uploaded audio runs one agentic loop over the sync transport with its own workflow system prompt, rendered by the default client's new run surface), plus ctx.generate (host-executed one-shot LLM generation for tool code, proxied out of the sandbox via the llm/generate guest RPC) and the @alexkroman1/aai/workflow combinators: sequential, parallel, route, orchestrate, evaluatorOptimizer.

### Patch Changes

- e17fdc4: Studio prompt: a "workflow" request builds workflow(), not agent()
- Updated dependencies [377ecd3]
- Updated dependencies [e17fdc4]
- Updated dependencies [e17fdc4]
- Updated dependencies [4051d7a]
- Updated dependencies [6047231]
- Updated dependencies [7fc476d]
- Updated dependencies [41b5dad]
- Updated dependencies [ed4f2e7]
- Updated dependencies [89a032d]
- Updated dependencies [158d5d5]
  - @alexkroman1/aai@2.0.0
  - aai-studio-client@0.1.8
  - @alexkroman1/aai-ui@2.0.0
  - @alexkroman1/aai-cli@2.0.0

## 1.3.7

### Patch Changes

- 7043302: Add a studio codegen eval for the slack-translator shape (text-only pipeline plus send: slack()), and let SandboxLoadJudge assert the generated config's send channel.
- Updated dependencies [c261662]
- Updated dependencies [da2662a]
- Updated dependencies [5ea4cba]
  - @alexkroman1/aai@1.16.0
  - @alexkroman1/aai-ui@1.16.0
  - @alexkroman1/aai-cli@1.16.0

## 1.3.6

### Patch Changes

- Updated dependencies [9ffec74]
- Updated dependencies [f87ff84]
  - @alexkroman1/aai@1.15.0
  - @alexkroman1/aai-cli@1.15.0
  - @alexkroman1/aai-ui@1.15.0

## 1.3.5

### Patch Changes

- cf4b51f: Studio chat can switch models per request: the chat body accepts an optional `model` validated against the host-configured provider's own model list (LLM Gateway list, region-filtered), /studio/status advertises the list, and the studio client renders a model picker in the chat header. Providers and keys remain host-owned.
- Updated dependencies [1c57e05]
- Updated dependencies [4469856]
- Updated dependencies [f389673]
- Updated dependencies [cf4b51f]
  - @alexkroman1/aai@1.14.0
  - @alexkroman1/aai-ui@1.14.0
  - aai-studio-client@0.1.7
  - @alexkroman1/aai-cli@1.14.0

## 1.3.4

### Patch Changes

- 06b3ec0: Fix S3 key listing: the stock unstorage s3 driver's getKeys ignores the prefix and reads only the first ListObjects page (1000 keys), so studio projects vanished from the picker once the production bucket grew past 1000 objects, and the KV wipe on agent delete stopped short. Production storage now overrides getKeys with a signed ListObjectsV2 loop that passes the prefix and follows continuation tokens.

## 1.3.3

### Patch Changes

- Updated dependencies [f662e45]
  - @alexkroman1/aai@1.13.1
  - @alexkroman1/aai-cli@1.13.1
  - @alexkroman1/aai-ui@1.13.1

## 1.3.2

### Patch Changes

- Updated dependencies [2b3c0e0]
- Updated dependencies [cbb8b71]
  - @alexkroman1/aai@1.13.0
  - @alexkroman1/aai-ui@1.13.0
  - @alexkroman1/aai-cli@1.13.0

## 1.3.1

### Patch Changes

- d92a182: Grade the studio coding agent against the aai-templates templates. The studio
  eval suite gains six one-shot codegen cases whose prompts are the studio's own
  starter prompts, each judged for functional parity against the hand-written
  template it was modeled on (`TemplateParityJudge`, a 5-criterion rubric over
  mode, capability coverage, kv/session state, assets, and persona constraints),
  plus a guard test that every template is either evaluated or explicitly excused.

  Two fixes came out of running it: the studio prompt now tells the coding agent
  to cover every capability the user enumerated rather than folding several into
  one tool, and `transport-websocket.test.ts` no longer leaks a pending
  `aai_sessions_active` decrement across test boundaries — teardown waited on the
  client socket, not the server-side close that owns the metric, so the gauge
  could read -1 in whichever test ran next.

- ddd2aa6: Default the studio coding agent to gpt-5.5 on the LLM gateway and show the configured model as a chip in the studio chat header
- Updated dependencies [83be5b2]
- Updated dependencies [ddd2aa6]
- Updated dependencies [bd4405a]
  - @alexkroman1/aai@1.12.0
  - aai-studio-client@0.1.6
  - @alexkroman1/aai-cli@1.12.0
  - @alexkroman1/aai-ui@1.12.0

## 1.3.0

### Minor Changes

- a6bb262: Make `allowedHosts` declarable in `agent()` and enforce the same tool-fetch policy in `aai dev` as in production, from one shared implementation. Adds the missing `send`/`state` fields to the `agent()` parameter type.

### Patch Changes

- 0f95e0c: Rename the studio's user-facing brand name to AssemblyAI App Builder
- fbcb755: Drop the direct esbuild dependency: the CLI now bundles with Rolldown end to end.

  - `aai dev`'s fast worker builds (`_dev-bundler.ts`) run on Rolldown — the native bundler Vite 8 itself uses, so the dependency dedupes to zero extra install weight. Fresh builds land in tens of ms, so the old incremental esbuild context is no longer needed; non-compile failures still fall back to the cold Vite path.
  - Deploy/studio worker minification switches from `minify: "esbuild"` (which loaded esbuild as Vite's optional peer) to Vite 8's native `"oxc"` minifier. The studio inherits this automatically via `@alexkroman1/aai-cli/worker-bundler`.
  - The scaffold keeps its pnpm build-script approval for esbuild: the CLI no longer pulls it in, but esbuild remains an optional peer of vite, so projects whose lockfile ever resolved it (upgrades from an older CLI) still install it and need its postinstall approved.

- 2144b6d: Fix the deployed `send:` channel: carry the descriptor onto the runtime agent so the `send_message` builtin is registered, and derive the channel's webhook host into the sandbox's `allowedHosts` so guest tool code can post through `openSender`.
- 9fc7f4e: Add LLM-in-the-loop one-shot codegen evals for the studio coding agent (vitest-evals): a WorkerBuildJudge that requires generated workspaces to survive the production worker bundler, and a SandboxLoadJudge that loads the built worker in a real studio sandbox and validates the agent config. Run with pnpm --filter aai-server test:evals; skips without an LLM key.
- 8699bb4: Studio: a hung tool call no longer hangs the chat turn, and the user can cancel one.

  - Every coding-agent tool (studio, web, and MCP) now runs under a per-call deadline (`STUDIO_TOOL_TIMEOUT_MS`, default 120s) — a dead sandbox RPC or silent MCP server resolves to an error tool result instead of leaving the tool row shimmering forever.
  - The studio composer's send button becomes a Stop button while a turn streams; stopping aborts the SSE request, which cancels the server-side LLM stream, in-flight tool calls, and the session sandbox. Tool rows abandoned by a stop no longer shimmer.
  - A failed sandbox provisioning is no longer cached for the rest of the turn — one transient spawn failure used to answer "Sandbox unavailable" to every later `test_agent` call. Provisioning failures are now also logged host-side.

- Updated dependencies [0f95e0c]
- Updated dependencies [857c7d3]
- Updated dependencies [310eedb]
- Updated dependencies [fbcb755]
- Updated dependencies [a6bb262]
- Updated dependencies [d72c86b]
- Updated dependencies [8699bb4]
- Updated dependencies [163cb6f]
  - aai-studio-client@0.1.5
  - @alexkroman1/aai@1.11.0
  - @alexkroman1/aai-cli@1.11.0
  - @alexkroman1/aai-ui@1.11.0

## 1.2.3

### Patch Changes

- 99caf69: Server review fixes: studio chat abort no longer leaks sandboxes, edit_file fuzzy matches map back to the original text, per-scope studio rate limiting, host-mode upgrades skip sandbox spawn, request-body size caps, graceful shutdown closes sockets, redeploy preserves platform-default KV, NDJSON line-length cap, plus test and simplification cleanups.
- 2f667da: Studio coding agent prompt: add working-style and chat-reply guidance (act with tools instead of pasting code, root-cause minimal edits, respect user edits made in the code editor, no file dumps in chat, custom-UI design direction)
- 5ddca41: Fix race conditions and concurrency issues across the stack:

  - **Session registry** (host): reconnect-resume no longer lets an old session's delayed teardown delete the resumed session's registry entries (delete-by-identity); idle timer can no longer re-arm after `stop()`; `remember` serializes its KV read-modify-write; OpenAI Realtime transport no longer double-emits `cancelled`.
  - **Pipeline transport**: turn epochs gate queued turns so they can't run after `stop()`/`reset()`/`cancelReply()`; interrupted-turn persistence no-ops after `reset()`; the dead-air cover timer is abort-aware; late TTS audio after a barge-in is dropped instead of re-advancing the playback clock; tool-call repair captures its own turn's abort signal; `cancelReply()` resets the endpoint settler.
  - **AssemblyAI TTS**: `cancel()` now actually cancels — the adapter drops the connection (suppressing stale audio/done/error events) and reconnects, so barge-in works and cancelled text can't splice into the next turn.
  - **Sandbox platform** (aai-server): slot session releases are identity-bound so a stale release can't idle-evict a redeployed agent's new sandbox mid-call; sessions re-validate the sandbox before starting; a failed sandbox VM start detaches from the slot instead of poisoning it; dead warm-pool harnesses fall back to a cold spawn; gVisor cleanup is properly idempotent.
  - **Studio**: all workspace mutations run under a per-project keyed lock (no more lost writes from concurrent tool calls or editor saves), and Publish re-reads the workspace instead of writing back a stale pre-build snapshot.
  - **Browser client** (aai-ui): a stale audio init can no longer unlock a newer one (orphaned live mic); the greeting replay respects turn boundaries; a server-initiated `reset` discards in-flight file uploads; stale playback-stop events can't resolve a later turn's drain early.
  - **CLI**: `NODE_ENV` preservation around Vite builds is refcounted (concurrent builds can't leak `production` into the process); config writes are atomic (temp+rename); a slug-less first deploy is no longer retried (no duplicate agents); the dev server watcher starts before the initial build, shutdown is idempotent, and restart retries a busy port; `fsKv` writes are atomic.

- Updated dependencies [5dc18a2]
- Updated dependencies [c147d23]
- Updated dependencies [3fe3eff]
- Updated dependencies [51d0e61]
- Updated dependencies [5ddca41]
- Updated dependencies [133642f]
- Updated dependencies [fec3fa2]
- Updated dependencies [678556f]
- Updated dependencies [8a5ee8f]
  - @alexkroman1/aai-cli@1.10.0
  - @alexkroman1/aai-ui@1.10.0
  - @alexkroman1/aai@1.10.0
  - aai-studio-client@0.1.4

## 1.2.2

### Patch Changes

- Updated dependencies [fff8cc1]
  - @alexkroman1/aai-cli@1.9.2
  - @alexkroman1/aai@1.9.2
  - @alexkroman1/aai-ui@1.9.2
  - aai-studio-client@0.1.3

## 1.2.1

### Patch Changes

- Updated dependencies [713025a]
  - @alexkroman1/aai@1.9.1
  - @alexkroman1/aai-cli@1.9.1
  - aai-studio-client@0.1.2
  - @alexkroman1/aai-ui@1.9.1

## 1.2.0

### Minor Changes

- c5a5351: Add pipeline-mode silence nudge: new silenceTimeoutMs and silencePrompt agent config fields make the assistant proactively take a turn after a period of user silence (capped at 3 consecutive nudges until the user speaks again)
- 82f8253: Performance pass on the platform server: guest fetch requests use guest-generated ids so rejection notifications can no longer race the RPC ack (previously a disallowed-host fetch stalled 30s and leaked a pending entry), the warm sandbox pool recovers from spawn failures with exponential-backoff cooldown instead of disabling itself permanently, worker bundles are TTL-cached like manifests, the guest NDJSON line splitter is linear instead of quadratic on large bundle loads, PBKDF2 hashing is skipped for requests to nonexistent slugs, tool-call RPC responses no longer round-trip unused session state, NDJSON writes respect stream backpressure (host drain-aware queue, guest full-write loop), keyed slug locks free their map entries when released (p-lock dependency removed), custom-event size caps measure UTF-8 bytes, and deploy uploads accept gzip-compressed bodies with a decompressed-size limit.
- d718fe9: The platform server root now serves a browser studio: a coding agent (Vercel AI SDK `streamText` loop, streamed to a React `useChat` client as the AI SDK UI message stream) that edits per-API-key server-side workspaces and builds, tests, and deploys voice agents directly from the browser. The agent's code-executing work runs in per-session sandboxes provisioned through the same warm-pool/gVisor infrastructure as deployed agents: bundles are built in-memory with esbuild (import allowlist), loaded and trial-run in the sandbox (`test_agent`), and config extraction happens in-guest via a self-describing `__aaiConfig` export — user code is never evaluated on the host. Chat LLM defaults to the AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`) with Anthropic fallback, configurable to any pipeline-mode provider via `STUDIO_LLM_PROVIDER`/`STUDIO_LLM_MODEL`; the system prompt embeds the CLI's scaffold CLAUDE.md authoring guide. `studio` and `studio-assets` are now reserved slugs.

### Patch Changes

- 38a2553: Replace hand-rolled HTTP, retry, cache, and child-process plumbing with ofetch, p-retry + is-network-error, quick-lru, and execa
- 8817f3f: Remove unused code and fallback paths: legacy host-guest RPC schemas, backward-compat aliases (`pendingKvRequests`, `handleKvResponse`), unused exports (`jsonLogger`, `touchSlot`, `S2sEvent`, `DEFAULT_THEME`, unused metric label types), legacy OpenAI Realtime beta event-name fallbacks, inert CLI flags (`--server`/`--yes` on commands that never read them), and over-exported internal types.
- a252842: Bump dev dependencies: `tsdown`, `@biomejs/biome`, `@changesets/cli`, `knip`,
  `markdownlint-cli2`, `publint`, `turbo`, `@tailwindcss/vite`,
  `@vitejs/plugin-react`, `react`/`react-dom` (also widening the `aai-ui` peer
  range to `^19.2.8`), and the `@pinecone-database/pinecone` peer range to
  `^8.1.0`.
- bbb9d73: Bump production dependencies: `@ai-sdk/*` providers, `ai`, `assemblyai`,
  `@cartesia/cartesia-js`, `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`,
  `hono`, `@hono/node-server`, and `vite`.
- cf56703: Use `AbortSignal.timeout` for the sandbox fetch timeout, `Promise.withResolvers` for NDJSON/guest RPC correlation, and `structuredClone` for per-session state isolation.
- 0c57887: Use the SDK's relocated SSRF module, drop the now-redundant local safeFetch wrapper, and check slug ownership on generated-slug deploys so a humanId collision can't overwrite an existing agent.
- 3db093f: Internal refactor: split oversized modules at natural seams (no behavior change). `host/runtime.ts` → transport construction extracted to `host/runtime-transport.ts`; `host/transports/pipeline-transport.ts` → STT/TTS provider lifecycle extracted to `host/transports/pipeline-providers.ts`; `aai-server/sandbox-vm.ts` → guest KV/Vector/fetch RPC surface extracted to `sandbox-guest-rpc.ts`. Oversized test files split alongside.
- Updated dependencies [0235618]
- Updated dependencies [4758dfc]
- Updated dependencies [0f72bef]
- Updated dependencies [56e96b5]
- Updated dependencies [bc62b75]
- Updated dependencies [7e67c24]
- Updated dependencies [38a2553]
- Updated dependencies [8817f3f]
- Updated dependencies [394867e]
- Updated dependencies [8004ff8]
- Updated dependencies [262f1e7]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [0bdb115]
- Updated dependencies [578a840]
- Updated dependencies [c5a5351]
- Updated dependencies [0235618]
- Updated dependencies [0235618]
- Updated dependencies [a252842]
- Updated dependencies [bbb9d73]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [a413caf]
- Updated dependencies [d718fe9]
- Updated dependencies [2898f21]
- Updated dependencies [882e7d9]
- Updated dependencies [e2ee4fd]
- Updated dependencies [9750db7]
- Updated dependencies [0d024e0]
- Updated dependencies [cb2821c]
- Updated dependencies [9aed108]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [ab38293]
- Updated dependencies [d718fe9]
- Updated dependencies [968c917]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [860bb7d]
- Updated dependencies [82f8253]
- Updated dependencies [d718fe9]
- Updated dependencies [7240ce5]
- Updated dependencies [f22b0f4]
- Updated dependencies [0bb1a20]
- Updated dependencies [7d4a193]
- Updated dependencies [5bf4d41]
- Updated dependencies [ad295be]
- Updated dependencies [d22d9f8]
- Updated dependencies [8f2093b]
- Updated dependencies [296a874]
- Updated dependencies [752af3d]
- Updated dependencies [38f02fa]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [82f8253]
- Updated dependencies [257a372]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [2fd1078]
- Updated dependencies [711edeb]
- Updated dependencies [fd5a54e]
- Updated dependencies [a413caf]
- Updated dependencies [3db093f]
- Updated dependencies [0c57887]
- Updated dependencies [79e51cb]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
- Updated dependencies [578a840]
- Updated dependencies [0235618]
- Updated dependencies [cf56703]
- Updated dependencies [115a88e]
- Updated dependencies [d718fe9]
- Updated dependencies [d718fe9]
  - @alexkroman1/aai@1.9.0
  - @alexkroman1/aai-cli@1.9.0
  - @alexkroman1/aai-ui@1.9.0
  - aai-studio-client@0.1.1

## 1.1.9

### Patch Changes

- Updated dependencies [6b61892]
  - @alexkroman1/aai-ui@1.8.3
  - @alexkroman1/aai@1.8.3

## 1.1.8

### Patch Changes

- Updated dependencies [bb06b4e]
  - @alexkroman1/aai@1.8.2
  - @alexkroman1/aai-ui@1.8.2

## 1.1.7

### Patch Changes

- 88269e9: Pass agent.s2s through IsolateConfigSchema and into the sandbox createRuntime call so OpenAI Realtime opt-in actually reaches the running runtime instead of being silently stripped during deploy validation
- ba8effb: Allow ':' in KV keys. The previous ban was stale (from when keys used ':' as a namespace separator); the prefix scheme is now 'agents/${slug}/kv' using '/'. Banning ':' broke any agent using Redis-style hierarchical keys like 'incident:INC-0001'.
- Updated dependencies [ba8effb]
- Updated dependencies [f4cc5ef]
  - @alexkroman1/aai@1.8.1
  - @alexkroman1/aai-ui@1.8.1

## 1.1.6

### Patch Changes

- 31736fe: Simplify aai-server modules: dedupe helpers, prune dead code, strip narration comments. No behavior changes.
- Updated dependencies [a7384ad]
- Updated dependencies [cc013df]
  - @alexkroman1/aai@1.8.0
  - @alexkroman1/aai-ui@1.8.0

## 1.1.5

### Patch Changes

- Updated dependencies [3c711da]
  - @alexkroman1/aai@1.7.1
  - @alexkroman1/aai-ui@1.7.1

## 1.1.4

### Patch Changes

- 898f012: Rewrite capacity dashboard around saturation %; add aai_machine_memory_bytes and aai_machine_cpu_cores gauges
- Updated dependencies [07b4263]
- Updated dependencies [b79855d]
  - @alexkroman1/aai@1.7.0
  - @alexkroman1/aai-ui@1.7.0

## 1.1.3

### Patch Changes

- Updated dependencies [da84b47]
  - @alexkroman1/aai@1.6.1
  - @alexkroman1/aai-ui@1.6.1

## 1.1.2

### Patch Changes

- 5085a71: Cache gVisor rootfs prep, async fs, off-thread pool replenish; fixes 13s event-loop block on first sandbox spawn that failed Fly healthchecks. Also adds per-phase timing logs and enables SANDBOX_POOL_SIZE=2 in production.
- Updated dependencies [149786b]
- Updated dependencies [fd3a167]
- Updated dependencies [c8707d6]
- Updated dependencies [877348c]
  - @alexkroman1/aai@1.6.0
  - @alexkroman1/aai-ui@1.6.0

## 1.1.1

### Patch Changes

- 6478e5e: Redeploy: pick up aai tool-schema fix that adds type:"function" to S2S session.update payload.
- 6d81154: Redeploy aai-server to pick up tool-schema fix from aai patch release.
- Updated dependencies [fbb3816]
  - @alexkroman1/aai@1.5.1
  - @alexkroman1/aai-ui@1.5.1

## 1.1.0

### Minor Changes

- 97b3834: Add warm Deno harness pool for fast cold starts. Set SANDBOX_POOL_SIZE to pre-spawn idle harnesses ready to receive bundle/load on first session.

### Patch Changes

- Updated dependencies [58c5c75]
- Updated dependencies [868b85e]
- Updated dependencies [a361363]
- Updated dependencies [58c5c75]
- Updated dependencies [58c5c75]
  - @alexkroman1/aai@1.5.0
  - @alexkroman1/aai-ui@1.5.0

## 1.0.21

### Patch Changes

- Updated dependencies [07dc8fb]
- Updated dependencies [2ca5d1f]
  - @alexkroman1/aai@1.4.5
  - @alexkroman1/aai-ui@1.4.5

## 1.0.20

### Patch Changes

- Updated dependencies [9bd219f]
- Updated dependencies [74341a4]
  - @alexkroman1/aai-ui@1.4.4
  - @alexkroman1/aai@1.4.4

## 1.0.19

### Patch Changes

- Updated dependencies [62d5a99]
  - @alexkroman1/aai@1.4.3
  - @alexkroman1/aai-ui@1.4.3

## 1.0.18

### Patch Changes

- Updated dependencies [f877a6f]
  - @alexkroman1/aai@1.4.2
  - @alexkroman1/aai-ui@1.4.2

## 1.0.17

### Patch Changes

- Updated dependencies [63de397]
  - @alexkroman1/aai@1.4.1
  - @alexkroman1/aai-ui@1.4.1

## 1.0.16

### Patch Changes

- @alexkroman1/aai@1.4.0
- @alexkroman1/aai-ui@1.4.0

## 1.0.15

### Patch Changes

- @alexkroman1/aai@1.3.2
- @alexkroman1/aai-ui@1.3.2

## 1.0.14

### Patch Changes

- Updated dependencies [5a9f3d5]
  - @alexkroman1/aai@1.3.1
  - @alexkroman1/aai-ui@1.3.1

## 1.0.13

### Patch Changes

- Updated dependencies [c95212a]
- Updated dependencies [f1a9764]
- Updated dependencies [f1a9764]
- Updated dependencies [0231114]
- Updated dependencies [8a79282]
- Updated dependencies [f1a9764]
  - @alexkroman1/aai@1.3.0
  - @alexkroman1/aai-ui@1.3.0

## 1.0.12

### Patch Changes

- Updated dependencies [6a44b5b]
  - @alexkroman1/aai@1.2.3
  - @alexkroman1/aai-ui@1.2.3

## 1.0.11

### Patch Changes

- Updated dependencies [534122c]
  - @alexkroman1/aai@1.2.2
  - @alexkroman1/aai-ui@1.2.2

## 1.0.10

### Patch Changes

- Updated dependencies [7af69b8]
  - @alexkroman1/aai@1.2.1
  - @alexkroman1/aai-ui@1.2.1

## 1.0.9

### Patch Changes

- Updated dependencies [ed0dfbb]
- Updated dependencies [231ebc1]
  - @alexkroman1/aai@1.2.0
  - @alexkroman1/aai-ui@1.2.0

## 1.0.8

### Patch Changes

- db7a96c: Replace host / rootfs with empty directory + bind mounts in gVisor sandbox; tighten dev mode env vars and filesystem access
- a6bf890: Defer sandbox VM startup until first tool call for faster WebSocket connections

## 1.0.7

### Patch Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

- Updated dependencies [5cda7c5]
- Updated dependencies [41fab1a]
- Updated dependencies [f342260]
  - @alexkroman1/aai@1.1.0
  - @alexkroman1/aai-ui@1.1.0

## 1.0.6

### Patch Changes

- 27faac9: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.6
  - @alexkroman1/aai-ui@1.0.6

## 1.0.5

### Patch Changes

- b3bafa7: Fix missing CSS in scaffolded agents: remove client.tsx and index.html from scaffold, serve pre-built default UI when no custom client exists, provide fallback index.html via Vite plugin for custom clients
  - @alexkroman1/aai@1.0.5
  - @alexkroman1/aai-ui@1.0.5

## 1.0.4

### Patch Changes

- @alexkroman1/aai@1.0.4
- @alexkroman1/aai-ui@1.0.4

## 1.0.3

### Patch Changes

- @alexkroman1/aai@1.0.3
- @alexkroman1/aai-ui@1.0.3

## 1.0.2

### Patch Changes

- 76d25d4: Deploy server: picks up @alexkroman1/aai fix that stops vitest from leaking into the runtime barrel bundle.
- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.
- Updated dependencies [76d25d4]
- Updated dependencies [a3d3835]
  - @alexkroman1/aai@1.0.2
  - @alexkroman1/aai-ui@1.0.2

## 1.0.1

### Patch Changes

- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases
- Updated dependencies [5517333]
- Updated dependencies [5d55c12]
- Updated dependencies [b4ff42e]
  - aai@1.0.1
  - aai-ui@1.0.1

## 1.0.0

### Major Changes

- 874001a: Replace Firecracker with gVisor sandbox + vscode-jsonrpc (no KVM, works on Fly.io)
- 36a8e75: Replace secure-exec V8 isolates with per-agent Firecracker microVMs for hardware-level cross-agent isolation

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- 1f5bbb1: Replace HTTP sidecar and RPC server with secure-exec bindings IPC
- 7b451c7: Extract agent config at build time and defer V8 isolate boot until custom tool/hook execution

### Patch Changes

- 3bd18a9: Fix security vulnerabilities: run_code sandbox escape, SSRF wiring, credential key enforcement, DNS rebinding, path traversal, harness auth bypass, timing-safe hash comparison
- b9b5c02: Deduplicate shared utilities, fix N+1 KV list, async static serving, and race timer leak
- d890d04: Remove backward compatibility in agent config launching — agentConfig is now required
- dc9d402: Remove deprecated terminate() backwards compat alias on Sandbox type
- a3fde24: Remove redundant validateWorkerBundle from deploy handler
- 5cc9550: Security hardening: deploy ownership check, SSRF DNS fail-closed + hostname blocking, timing-safe auth tokens, run_code timer cleanup, WebSocket payload limits, message buffer cap, clientFiles size limits, HTML escape completeness, KV error sanitization
- 0da527e: Add adversarial chaos tests, lower jail memory limit, plug sandbox eviction leaks, validate agent bundles at deploy time
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 061a04f: Update secure-exec to 0.2.1, replace virtual hosts with real sidecar server
- 1678546: Simplify codebase: use p-timeout for shutdown, html-to-text for HTML conversion, deduplicate secret key validation
- d6ad61e: Harden nsjail: restrict socket() to AF_UNIX, add cgroup namespace and rlimit_nproc, add post-escape integration tests
- fa7b928: Change default dev server port from 8787 to 8080
- Updated dependencies [8ecb7d1]
- Updated dependencies [3bd18a9]
- Updated dependencies [befca9a]
- Updated dependencies [9211c65]
- Updated dependencies [b9b5c02]
- Updated dependencies [99db30d]
- Updated dependencies [5cc9550]
- Updated dependencies [4c1cd20]
- Updated dependencies [ab98c61]
- Updated dependencies [837e34f]
- Updated dependencies [f6e7a5c]
- Updated dependencies [7669733]
- Updated dependencies [14d0653]
- Updated dependencies [9d2141b]
- Updated dependencies [05f8759]
- Updated dependencies [486fb23]
- Updated dependencies [1678546]
- Updated dependencies [5fd5cb3]
- Updated dependencies [64d83b6]
- Updated dependencies [6d3ec72]
  - aai@1.0.0
  - aai-ui@1.0.0

## 0.9.16

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform
- Updated dependencies [4ebd7b6]
- Updated dependencies [68f4d84]
  - @alexkroman1/aai@0.12.3

## 0.9.15

### Patch Changes

- @alexkroman1/aai@0.12.2

## 0.9.14

### Patch Changes

- 1b8b757: Fix changesets version command and sync scaffold versions during release
- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability
- 1b960da: Remove zod dependency
- Updated dependencies [f4762a1]
  - @alexkroman1/aai@0.12.1

## 0.9.13

### Patch Changes

- Updated dependencies [99e62c3]
  - @alexkroman1/aai@0.12.0

## 0.9.12

### Patch Changes

- 79fe82c: Replace async-lock with p-lock for all per-slug concurrency control. Consolidate slug-lock.ts into sandbox-slots.ts with two named lock layers (slotLock for sandbox lifecycle, apiLock for deploy/delete serialization). Use AbortController to cancel stale idle-eviction callbacks. Use Promise.withResolvers() in sandbox.ts.

## 0.9.11

### Patch Changes

- c25ee7e: Trigger deploy for SDK and server
- Updated dependencies [c25ee7e]
  - @alexkroman1/aai@0.11.1

## 0.9.10

### Patch Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

  - Remove `generate` and `run` commands and AI SDK dependencies
  - Unify CLI output to use @clack/prompts style consistently
  - Add template descriptions shown as hints in `aai init` select prompt
  - Fix deploy slug mismatch between bundle and deploy steps
  - Clean deploy error messages (no stack traces)
  - Add `@alexkroman1/aai-cli` to scaffold devDependencies
  - Remove fly.toml from scaffold
  - Use cyanBright for all URLs in CLI output
  - Remove eventsource-parser patch
  - Add link-workspace-packages to .npmrc
  - Fix Dockerfile: run esbuild install script, remove patches references

- 3a86d28: Fix isolate boot: run esbuild install script in Docker prod image
- 0fc9bb8: Fix isolate boot failure: run esbuild install script in Docker prod image
- Updated dependencies [491ec37]
  - @alexkroman1/aai@0.11.0

## 0.9.9

### Patch Changes

- 5deaf04: Increase isolate boot timeout to 15s for Fly.io cold starts
- 8816cfe: Increase isolate boot timeout to 15s for Fly.io cold starts

## 0.9.9

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

- Updated dependencies [6f6a43e]
  - @alexkroman1/aai@0.10.4

## 0.9.8

### Patch Changes

- Updated dependencies [8d5f616]
  - @alexkroman1/aai@0.10.3

## 0.9.7

### Patch Changes

- Updated dependencies [9de059e]
- Updated dependencies [1397f37]
  - @alexkroman1/aai@0.10.2

## 0.9.6

### Patch Changes

- Updated dependencies [aa23a1c]
  - @alexkroman1/aai@0.10.1

## 0.9.5

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.10.0

## 0.9.4

### Patch Changes

- Updated dependencies
  - @alexkroman1/aai@0.9.4

## 0.8.9

### Patch Changes

- Fix dependencies
  - @alexkroman1/aai@0.9.3
