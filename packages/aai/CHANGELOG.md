# @alexkroman1/aai

## 13.1.0

## 13.0.0

### Minor Changes

- 9584e2e: ctx.waitFor and ctx.step take an optional Standard Schema, the first check over the two values a durable workflow body handles that it did not compute. A hook payload arrives over public HTTP and reached the body as a cast; a step's journaled output is read back days later, possibly by a different bundle, and reached it as another. waitFor validates the delivered payload and refuses a bad one fatally, leaving the window as the delivery found it - answered, never reopened, since the same bytes are what every redelivery reads. step validates on BOTH sides of the journal: on the write, where a rejection is the step's own failure and spends an attempt, and on the read, where it is a verdict about the journal in the family of a divergence and journals nothing over a step that succeeded. Durable slot values have been checked structurally in both backends for a long time; a step's output is exactly as durable and had no check at all.
- 9584e2e: Workflows can declare an `output` schema beside `input`: what a completed run answers with, validated where the engine records the run — a body that misses its own declaration fails the run rather than reporting `completed` with an output the declaration denies — served to a page as `WorkflowSummary.outputSchema`, and read by `WorkflowOutputOf`, which now derives from the declared schema rather than from inferring the body. That fixes `WorkflowOutputOf` resolving to `never` for an annotated def, and lets an annotated `agent.ts` state its output type once, in the schema.

### Patch Changes

- 9e12bb2: Bump dependencies across the workspace: the ai SDK and its provider adapters, zod, vite, vitest, hono, the Supabase clients, xstate, undici, modal, @cartesia/cartesia-js and the build/lint toolchain.
  
  Two source changes come with it. The scripted fake language model emitted a bare-string stream finish reason where the v3 provider spec declares a { unified, raw } pair — harmless until ai@7.0.70 made automatic tool execution conditional on that value, after which a scripted tool call never ran; the fake's doGenerate half already had the pair. And protocol-compat.test.ts moves off zod's deprecated ZodTypeAny to ZodType.
- 9e12bb2: Bound turbo's task concurrency on every fan-out test door, and take biome 2.5.12.
  
  `pnpm test` and five sibling scripts ran `turbo run <task>` with no TURBO_CONCURRENCY, so turbo's default of 10 tasks each took vitest's full `cores - 1` worker budget — ~40 processes on 4 cores. The two halves of that budget are one mechanism and only bound the machine when the variable is set, and only `scripts/check.mjs` set it. A/B on one commit: unbounded times out three aai-cli bundler and dev-server specs, bounded passes all 16 tasks.
  
  biome moves to ^2.5.12 under the release-age quarantine's one exemption. 2.5.9-2.5.11 report an already-awaited `await pTimeout(…)` as a floating promise across nine call sites; 2.5.12 fixes that and also retires the suppression the same defect had already cost at 2.5.8, lowering the escape-hatch baseline to 124.

## 12.0.0

## 11.0.0

### Major Changes

- 36a3f22: Key durable waits by NAME rather than by position. `ctx.sleep` now takes a label as its first argument — `ctx.sleep("review-window", 6 * 60 * 60 * 1000)` — and a wait is journaled as `sleep!<label>#<occurrence>` / `hook!<token>#<occurrence>`, exactly as a step is keyed `name#occurrence`.
  
  Waits were keyed positionally off a counter that advances only when a wait is reached, so a body reaching a different NUMBER of waits read its predecessor's record. Measured: a week-long `ctx.sleep` behind an `if` was skipped in full with the clock unmoved and the run reported `completed`; the `ctx.waitFor` version hands the body another wait's payload. Both are unrepresentable now.
  
  BREAKING: every `ctx.sleep(until)` call needs a label. `RecordedSleep` (`@alexkroman1/aai/testing`) and `EvalSleep` (`@alexkroman1/aai-runtime/eval`) each carry the label too, so a case can assert WHICH wait a body reached. Runs suspended when this ships resume against the new key space and fail with the replay engine's divergence message rather than silently reading the wrong record — drain in-flight runs before deploying.
- 63e1c8e: Durable-workflow SUSPENSION is no longer observable by a workflow body. `ctx.sleep` and `ctx.waitFor` used to suspend by THROWING a branded signal, so a `catch` in a body caught it — one shipped template did, unwound its compensation stack and deleted the transcript its run was waiting for, then re-threw, and the engine recorded the run as healthily suspended. A wait now returns a promise that never settles and the engine races the body against an out-of-band interruption channel, so there is nothing for a `catch` to catch and nothing for a `finally` to run on. `isWorkflowSuspend` is removed (there is nothing left for it to test) along with the internal suspend brand. Concurrent waits are also aggregated now: a `Promise.race` or `Promise.all` over several waits suspends ONCE, carrying the earliest outstanding timer deadline, so racing a hook against a sleep composes where it previously stopped the body at whichever wait was reached first.

### Minor Changes

- fe3b6d6: Add ctx.now(), ctx.random() and ctx.uuid() to WorkflowCtx — three journaled non-deterministic reads, so a workflow body gets the same value on every replay instead of a determinism bug. Each is keyed in its own positional journal space, takes no step attempt lease, and is refused inside a ctx.step. The transcription-workflow and call-audit templates drop their hand-rolled clock steps.
- 36a3f22: Add `stepInfo()` to `@alexkroman1/aai/step`: which step a body is running as, which ATTEMPT of it, the ceiling that attempt is counted against, and whether it is the last.
  
  The engine already tracked the number — it is where a `report()` line's `(attempt N)` suffix comes from — and nothing else could read it, so the one decision a retry policy cannot make for an author was unavailable: degrade rather than fail. A smaller model on the final try beats a failed run, and only the body knows what cheaper means for its own work.
  
  It is the Workflow DevKit's `getStepMetadata()` with two differences. It answers `undefined` outside a step rather than throwing, because an exported step is also an ordinary async function and every workflow template's tests call one directly. And it carries `maxAttempts`, without which `isLastAttempt` is a number the body restates from the `ctx.step` call site — two literals in two files whose disagreement makes a step degrade early on every run and still return an answer.
  
  `stubStepInfo` (`@alexkroman1/aai/testing`) is how a spec reaches that branch at all; it derives `isLastAttempt` from the two numbers rather than accepting it, so a test cannot assert a body against attempt 1 of 3 calling itself the last.
- f10b6aa: Publish `@alexkroman1/aai/html` — `htmlToText`, `parseFeed` and `pageMetadata` over the htmlparser2 and html-to-text parsers the SDK already carried, so a step reading somebody else's markup gets a real parse instead of regexes. The `link-digest` and `podcast-digest` templates move onto it, dropping ~65 lines of hand-written scraping. Also: one `jitteredBackoff` in place of three byte-identical retry-delay copies (guard-invariants rule 31), and `aai-server`'s TTL cache moves from quick-lru to the lru-cache it already depended on, making its entry cap exact.
- 7ab47cf: Carry Map and Set across the durable-workflow journal, which JSON.stringify silently answered {} for

### Patch Changes

- 0718b57: Declare MIT license terms in the published packages: every tarball shipped with no license field and no LICENSE file of its own, which registries and license scanners read as all-rights-reserved. Also declare sideEffects - false for aai and aai-runtime, and the css entries for aai-ui, whose styles.css consumers import for effect.
- 31459e8: Extract three duplicated internals into shared helpers: one `missingEnvMessage` behind `requireEnv`/`requireStepEnv`, one `createLlmModelCache`/`isLlmDescriptor` behind `ctx.generate` and `ctx.delegate`, and one `credentialVerdict` behind the two eval credential checks. No behaviour change — each pair had a verbatim copy of the string or the memo, which is how the two halves come to disagree.

## 10.0.1

## 10.0.0

### Major Changes

- dd699c7: Remove the Workflow DevKit entirely. No package declares `workflow` or `@workflow/*` any more; the replay engine owns durable execution end to end.
- dd699c7: Replace the Workflow DevKit's durable-execution engine with one this repo owns, and take its two error classes with it.
  
  A workflow body is now an ordinary async function of `(input, ctx)` — no `"use workflow"` directive, no compile-time transform, and no `workflowId` a WASM SWC plugin stamps onto the function. Durability is `ctx.step(name, fn)`: the engine runs a step once, journals what it returned, and answers it from the journal on every later replay. Step identity is `(name, occurrence)`, which is stable under inserting a step elsewhere and correct inside a loop, where a monotonic ordinal is the first and a bare name the second.
  
  `@alexkroman1/aai/step-errors` now OWNS `FatalError` and `RetryableError` rather than re-exporting `@workflow/errors`'. Membership is a non-enumerable brand read by `FatalError.is` / `RetryableError.is`, never `instanceof`: a guest bundle can hold two copies of the module, and across them `instanceof` answers false — which would silently downgrade a `FatalError` to "unclassified, so retry", the exact failure the class exists to prevent and the one that costs money. The brand's VALUE is validated rather than trusted, `Symbol.for` being a registry anyone can mint from. `RetryableErrorOptions.retryAfter` no longer accepts a duration string; no call site passed one.
  
  `ctx.sleep(until, { correlationId })` is durable suspension: the body stops, the
  process is freed, and the engine re-delivers the run when the time comes — so a
  wait may be days long and survives a redeploy, an idle reclaim and a crash. A
  sleep's wake time is journaled on the FIRST reach, because a deadline recomputed
  from the clock on every replay moves further out each time and the run never
  wakes. `ctx.workflows.wake(runId, [correlationId])` cuts one short, and reports
  how many waits it actually stopped rather than how many it looked at.
  
  `ctx.waitFor<T>(token)` parks the run on somebody else's answer, with no deadline
  at all: nothing but `ctx.workflows.signal(token, payload)` or a webhook at
  `publicWebhookUrl(token)` ends it. It replaces the DevKit's `createHook()`, whose
  token was generated body-side — which is the wrong place, since whoever hands the
  URL out is a tool and cannot see the body's locals. The token is the author's now,
  derived so both sides agree. A token two waits share is refused rather than
  resolved arbitrarily: one signal would end whichever the store found first and the
  other would wait forever.
  
  ## The eight workflow templates are migrated
  
  Every shipped template's body is `(input, ctx)` now, its steps are ordinary
  exported functions called through `ctx.step`, and its `sleep`/`createHook` use is
  `ctx.sleep`/`ctx.waitFor`. `@alexkroman1/aai` and `aai-templates` no longer depend
  on `workflow` at all.
  
  Three things the migration bought rather than merely moved:
  
  - **A retry policy is an argument, not a property.** `fn.maxRetries = 5` became
    `ctx.step(name, fn, { maxAttempts: 6 })` at the call, which is where it
    belongs — the same function called from two sites may deserve different
    patience, and a property could not say so. `research-workflow` has exactly that
    case, its two `investigate` waves.
  - **`recap-workflow`'s retention gate lost forty lines of scaffolding.** It was
    `vi.mock("workflow")` over `createHook` and `sleep`, a hand-built `Hook`
    assembled by hanging members on a real promise, and a never-resolving `sleep`
    so the two sides of a `Promise.race` could not settle in an order that decided
    the test instead of the branch. It is one `ctx.waitFor(token, { timeoutMs })`,
    so an answer is a `hooks` entry and the closed window is its absence.
  - **`createWorkflowCtx` (`@alexkroman1/aai/testing`) is new**, because a body
    takes a `ctx` only an engine constructs and three templates had hand-rolled
    one. It runs the steps and records what the body asked for, so a spec can
    assert a policy that is otherwise observable nowhere.
  
  `ctx.waitFor` takes a `timeoutMs` for the same reason, and it is a parameter
  rather than a race deliberately: both `waitFor` and `sleep` suspend, and a
  suspend unwinds the stack, so `Promise.race([waitFor, sleep])` stops the body
  before the other side has been reached. Worse, it DIVERGES — the body returns
  `undefined` and moves on, and a signal landing a second later would make the next
  replay read a payload and take the answered branch. The engine closes the hook as
  the window shuts, so the answer stays a fact.
  
  `@alexkroman1/aai` no longer depends on `workflow` at all.
  
  Eighteen capability epoch classifications in all, every one a `--drop`: `workflow`, `workflow-api` and `step-errors` for the signature changes above, `aai-runtime:eval` for the eval engine's own `WorkflowCtx`, and the rest collaterally — their reports name `ToolContext.workflows`, so the changed body type reaches them.
  
  ## Two defects the review found, both severe
  
  **A body that swallowed its own suspend was recorded as healthy.** `ctx.sleep` and
  `ctx.waitFor` suspend by THROWING, and JavaScript `catch` catches everything — so
  `recap-workflow`'s saga, which wraps its whole body in a `try`/`catch` that unwinds
  a compensation stack, ran its failure path on the first poll that had to wait: it
  DELETED the transcript the run was waiting for, journaled the deletion as
  successful, re-threw, and the engine saw its own signal come back out and recorded
  the run as suspended. The data was gone and every signal said fine.
  
  Two defences, because one is not enough. `isWorkflowSuspend` (`@alexkroman1/aai`)
  is what a body's `catch` tests before doing anything else. And the engine checks
  too: if a suspend went out and something else came back — or the body simply
  returned — the run FAILS naming the remedy, because that cannot be enforced at
  build time (whether a `catch` re-throws is a runtime property).
  
  **`lastLine` returned the OLDEST progress line.** `WorkflowClient.lastLine` asks
  for `startIndex: -1` meaning "the last chunk alone", the DevKit's count-back-from-
  the-end semantics. The new store implemented an unsigned floor, so `-1` meant
  "everything after index -1" and the client took the first chunk — the exact thing
  that method exists to avoid. `StreamRead.startIndex` is signed now, and a read is
  `slice` arithmetic rather than a filter over the whole ring.

### Minor Changes

- dd699c7: Tell a recovery phrase apart from a reply on the wire, so it stays out of history. `agent-transcript.committed` carries an optional `recovery` (`"turn-failed"` | `"session-failed"`), set on the two phrases the pipeline transport speaks when the model cannot. Both are still spoken and still captioned — the caller heard them — and they no longer enter the conversation: they used to reach `ctx.messages` on the same call and the model's context again on every reconnect, which is how an agent learns that its own replies open with apologies. An event with no `recovery` is an ordinary reply, so an older reader and an older log are unaffected.
- dd699c7: Refuse to transcribe or copy an upload that is still arriving. `UploadInfo.size` is the contiguous READABLE PREFIX, not the final length, so five call sites could silently work on part of a recording and report success — `stepTranscribeUpload` uploaded the prefix with a chunked body so no `content-length` existed for the provider to reject, `readUploadToFile` defaulted its byte count to that prefix (the very number a polling caller reads to learn the store came back short), and a template derived its whole segment plan's width from it, fanning out over half a recording. All now go through `requireCompleteUpload`, published on `@alexkroman1/aai/step` with `UploadIncompleteError`, whose `retryable = false` makes it fatal rather than burning a file-sized step's retry budget.

### Patch Changes

- dd699c7: Re-enqueue durable runs the queue has lost. Abandonment was backed by the DevKit world's boot-time re-enqueue, which went with it, so a stalled run stayed stalled forever.
- dd699c7: Retire eleven `no-check` doc fences that already compile, and measure the pipeline fuzz's history-cap coverage floor. Documentation and test floors only — no runtime behaviour changes.
- dd699c7: Name the directory, the ask and the mount's capacity when a step's `readUploadToFile` runs out of disk, instead of reporting a bare ENOSPC
- dd699c7: Drop the Workflow DevKit's `workflow` schema and the run-ownership table it needed. Corrects `ctx.waitFor`'s doc: the webhook route reaches it now.

## 9.2.0

### Minor Changes

- 1ad4977: Make a workflow step able to read an upload window that has landed ahead of the contiguous prefix, so `transcription-workflow`'s streaming flow works against the browser's default parallel upload instead of degenerating into the classic one.

### Patch Changes

- bee46bc: Add an always-on `invariant()` oracle, and classify seven environmental errors that answered 500.
  
  `@alexkroman1/aai/internal` now publishes `invariant(condition, name, detail?)`. It throws a
  named `InvariantViolation` rather than logging, and its `detail` thunk runs only on the failing
  path, so a violation reports the actual numbers for free. Two properties are stated against it:
  a session event page cannot contain events its own `tail` says do not exist, and the terms a
  boot capacity line names must compose the total it prints.
  
  The workflow API's error classification is now swept rather than extended one incident at a
  time: every environmental code a Node service can meet must be mapped to a status or declared,
  with a reason, as one a 500 is right for. That found eight unclassified codes. `ENETDOWN`,
  `ENOTCONN` and `EAGAIN` are ordinary transport failures and now answer 503. `EMFILE`, `ENFILE`,
  `ENOBUFS` and `ENOMEM` are a fourth condition the table had no entry for — this process out of a
  local resource, neither the database being full nor the network being unreachable — and answer
  503 with their own message, checked before the transport entry because a descriptor limit
  surfaces on a socket operation.
  
  Also fixes a boot line that overstated the platform's own database claim by the size of the
  unpooled admin pool: it said `platform budget=42 (plus 12 …)` where the 12 was already inside
  the 42, on the configuration production runs.

## 9.1.0

### Minor Changes

- 041a5a2: Stop a durable fan-out discarding work it has already paid for, and stop the platform answering a permanent storage failure with a retry.
  
  `mapConcurrent` now drains the calls already in flight before propagating a rejection. `Promise.all` rejected the instant one slot did, which abandoned siblings mid-call — in a workflow those are steps whose provider call had often already succeeded, so their journal entries never landed and the resume re-issued and re-billed them. The DevKit reported them as "run failed with N uncommitted operation(s)".
  
  The platform's `POST /:slug/workflow-storage` now classifies permanent world failures instead of letting them fall through to the blanket 503. A `RunExpiredError` (a write to a run in a terminal state) answers 410 and an `EntityConflictError` answers 409, and the guest turns those back into the DevKit's own classes so its runtime stops rather than retrying a call that can never succeed.
  
  The transcription-workflow template no longer cuts a heavy WAV as-is: a file that parses but is denser than 16 kHz mono is converted first, because a 48 kHz stereo segment is six times the upload per request and was timing out against the sync endpoint's 30s deadline.

## 9.0.2

## 9.0.1

## 9.0.0

### Major Changes

- 444e209: One name per concept: `agent({ system })` and `SubagentDef.instructions` are both `systemPrompt`; `TextTurnOptions.system` too. `webSearch` takes `maxResults` in the options bag and nowhere else. The workflow hooks' def type parameter is required.
- e888216: Remove per-app databases from the platform entirely. The platform provisions no database for a tenant: `aai storage enable/disable/status`, the studio's Database card and pane, the `/:slug/storage` routes and the eleven app-db modules behind them are gone. An author who wants a database puts a DATABASE_URL in their own secrets, pointing at their own provider, and it now reaches the guest untouched — it used to be overlaid LAST, so enabling storage silently beat whatever the author had set. Durable state did not go with it: durable workflow runs and turn-level durability (session slots, the session event log) are on the platform's own database, reached over HTTP with the sandbox's bearer. The connection budget loses its only tenant-scaled term, which was 28 of 40 spoken for by two apps.
- 444e209: `@alexkroman1/aai/testing/vite` serves `virtual:aai/agent` — the agent lowered the way `aai build` lowers it, so a spec imports one module instead of rebuilding it from a glob, a `?raw` read and `deployedAgent`. `withDiscoveredTools` is no longer exported.
- f6be741: Remove ctx.db. The platform provisions no database and no longer hands tool code one either: a tool or an event hook that wants SQL brings its own client and its own credential. Db survives as an @internal type — the shape the runtime's own Postgres consumers take — and createUnusedDb goes with it. Ten capability epochs were dropped, and solo-rpg loses save_game/load_game: a shipped template cannot reach a database, so no template demonstrates cross-session persistence.

### Minor Changes

- 444e209: Reject unknown fields in `agent()` instead of silently dropping them, and type `ctx.env` as `Partial` so an undeclared credential is `string | undefined`. Adds `requireEnv(ctx, name)`, the `ToolContext` twin of `requireStepEnv`.
- 444e209: `agent({ temperature })` tunes the main conversational loop, in pipeline and text modes. S2S rejects it rather than dropping it.
- 444e209: A throwing tool now emits a non-fatal `tool` error frame; `aai dev` typechecks in the background; and the workflow-app compile-error messages no longer appear in a voice agent's diagnostics.

### Patch Changes

- 444e209: Warn at build time when `region: "eu"` sits beside a TTS stage that has no EU endpoint.
- af284a7: Fix a two-second stall on every `aai dev` session handshake behind a `client.tsx`.
  
  `viteDevConfig`'s proxy targets named `localhost`, and Vite opens a FRESH
  upstream connection for every WebSocket upgrade — an HTTP request reuses a
  pooled keep-alive socket and so resolves rarely. That made a hostname one
  `getaddrinfo` per session handshake, on libuv's four-thread pool, shared with
  every other fs and DNS call in a process that is also serving the agent. Under
  load that lookup intermittently stalls for almost exactly two seconds.
  
  Measured on the `retail` template, handshakes to `session.configured`:
  
  | Target | conc | rps | p50 | p99 |
  | --- | --- | --- | --- | --- |
  | `localhost` | 1 | 12-18 | 8-11 ms | 2.0 s |
  | `localhost` | 10 | 0.6 | 16.7 s | 16.7 s |
  | `127.0.0.1` | 1 | 89-207 | 4-9 ms | 23-49 ms |
  | `127.0.0.1` | 20 | 260 | 73 ms | 166 ms |
  
  The `localhost` rows are a queue rather than a slow proxy: one handshake in
  thirty stalled on its own, and at concurrency 10 the stalls piled up until a
  sustained burst left the proxy refusing upgrades entirely until the dev server
  was restarted. With the literal it recovers from a burst and sits within ~1.5x
  of the backend port.
  
  Localized by timing the handshake phases separately — TCP connect and the first
  frame were always fast, the 101 was not — and then by comparing the instant the
  client sent its upgrade against the backend's own log line for it: 23.808 out,
  25.796 in, answered in 5 ms, so the two seconds were spent before Vite dialled.
  
  Not a behaviour change: `localhost` resolved to loopback anyway, so this removes
  the lookup and nothing else. A test now asserts every target in the table is an
  IP literal, so a route added later cannot reintroduce it.
- af284a7: Classify a step's Response failures again: `toStepError` recognised a `Response` with `instanceof`, which is false inside a step bundle's own realm, so every fatal status was retried to exhaustion and every `Retry-After` ignored.
- e20a992: Cleanup pass over the platform-workflow change: skip binary fields in the storage egress run-id walk (a 1 MiB Buffer cost 716ms of synchronous event loop, now 0.2ms), pre-swap Buffers for zero-copy views before typed-JSON encoding (1.7-2.8x on every binary-carrying call), batch the per-page ownership lookups behind one `ownsRuns`, and single-source the five platform route paths and the guest credential pair in `platform-endpoint.ts`. Removes dead code the change left behind (`APP_DB_WORLD_LISTEN`, `BundleStore.listSlugs`, `ToolSetupDeps.resolvedDb`) and corrects the studio prompt, which still taught the deleted `ctx.db` and a Database pane that no longer exists.
- 841f460: Four runtime error messages told you to import `withDiscoveredTools` from `@alexkroman1/aai/testing`, which does not export it. They now name what a spec actually uses: `virtual:aai/agent` under vitest, or `deployedAgent` under any other runner.
- b238ba0: Move the orphan-preview reap back into pg_cron and delete the connection-pressure sweep. With no per-app database to drop, a reap is a Vault row and an agents row — both plain SQL — so the two reasons it left pg_cron are gone. It takes the same advisory lock a deploy takes, verified against a real Postgres from a second connection, and a parity test fails if deleteAgent grows a step the SQL body lacks. platform-db-pressure.ts is deleted: its whole argument was the tenant-scaled budget term, which no longer exists.
- 6796ae3: Drop two dangling `db` references from `ToolContext`'s published docs. `ctx.generate`
  and `ctx.delegate` described themselves as executing "on the host, like `db`" — a field
  removed outright, so the comparison pointed at nothing.
- 5bac92d: Fix the user-facing copy that still told people to run 'aai storage enable' or click Settings → Database. Neither exists: the platform provisions no tenant database, so ctx.db is a DATABASE_URL an author points at their own Postgres. Two messages were wrong about more than the command — the workflows-unavailable error blamed missing storage when the only cause is an app declaring no workflows, and the local-uploads notice claimed runs were ephemeral without a database when a deployed app's runs are the platform's.
- 841f460: SSRF: screen the IPv4 address a NAT64 or 6to4 IPv6 address carries
- 841f460: Bound the host-mode config frame's sample rates at MAX_AUDIO_SAMPLE_RATE
- af284a7: Fix three failures found while load-testing the template agents.
  
  **`aai dev` with a `DATABASE_URL` could not start a session.** Session state
  resolved to Postgres and reported `durable: true`, but nothing created
  `aai_session_state` / `aai_session_events` — the tables come with whoever owns
  the database, and under `aai dev` that is the developer, with no migration step
  to hang the DDL off. Every session died at start with a fatal 1011 the client
  reads as "Session failed to start", the real cause
  (`relation "aai_session_events" does not exist`) reaching only the dev log —
  while the workflow world migrated itself on the same boot and said so. `aai dev`
  now applies the SDK's own `sessionStateDdl` once at boot, before the runtime
  opens its pool. Best-effort: a role that may not CREATE because a real migration
  already ran gets one warning, not a refused boot.
  
  **A platform with no upload records answered every upload with a bare 500.** The
  platform returns `501 platform upload records not configured`, which is a named
  configuration condition, but the guest's records client let it fall to its
  generic throw — so the upload routes discarded it as
  `500 {"error":"Internal server error"}` and the actionable sentence stayed in the
  platform's log. It is classified as `UploadsUnavailableError` now, which those
  routes already answer as a 501 carrying its message. (`uploads-handler.ts` also
  claimed the guest "falls back to its local store"; no such path exists, and the
  comment said so for longer than it was true.)
  
  **Guest readiness polled every 250 ms.** That interval is pure added latency on
  every non-Modal cold spawn — the guest becomes ready between two attempts, so
  measured boot time is the real one rounded up to a multiple of it. At 25 ms the
  harness floor drops from 1021 ms to 884 ms (median 1025 → 915) in a back-to-back
  A/B, and the same bundle stops timing 1310 ms or 1580 ms run to run.
  
  Also documents, in `viteDevConfig`, that a session benchmarked through the Vite
  dev port carries a multi-second tail that belongs to the proxy rather than the
  agent, with the measurement and the port to use instead.
- 444e209: `StaticAgentParams` is derived from the arm `AgentParams` names rather than sharing a third base with it. The shape is identical; what it removes is the second undocumented type on a public signature, which `treatWarningsAsErrors` refuses.

## 8.2.1

## 8.2.0

## 8.1.0

### Minor Changes

- 2f899e1: Validate a dialog's graph at declaration — a state nothing can reach, or a non-final leaf nothing can leave, is now refused rather than silently accepted. Model the OpenAI Realtime connection and one client socket's session lifecycle as XState statecharts, and refuse a dev-server adopt after teardown instead of orphaning the built server.
- 1789a55: `formatSchemaIssues` now descends into a union's per-branch issues. Standard Schema declares a flat `{ message, path }`, so a validator with alternatives has nowhere to record why each branch was rejected; zod passes an off-spec `errors` array through the `~standard` interface and sets the parent issue's own message to the placeholder `"Invalid input"`. Rendering only the parent meant a union failure reported the field name and nothing else — `when: Invalid input` for a tool whose argument the model got wrong, which is the message the MODEL reads to correct itself. `StandardSchemaIssue` gains an optional `errors` field, typed `unknown` because the shape is a vendor's rather than ours, and every read of it is structural so an unexpected shape degrades to the old output instead of throwing out of a formatter that error paths call. The platform's error handler also answers a `ZodError` with that one line now, where it used to send the error's own `message` — which is `JSON.stringify(issues, null, 2)`.

## 8.0.0

### Major Changes

- 1d58f53: Remove legacy and deprecated code, and tighten the types that only existed to
  tolerate it.
  
  **Removed outright.** The deprecated `mapInBatches` alias is gone from
  `@alexkroman1/aai/step` — use `mapConcurrent`. The `aai eject` command is gone:
  every `aai init` and `aai pull` already layers in `server.mjs` and the
  `prestart`/`start` pair, so no project needs retrofitting. `startAndWait` no
  longer re-reads a run for an agent that predates `wait`. The parts-upload path no
  longer treats a 404/405 as "this agent has no `/parts` routes".
  `TransportCallbacks.onSessionReady` is gone — it had no production
  implementation.
  
  **Now required on the wire.** `error.reported.fatal` and
  `ClientConfigResponse.page` are no longer optional. Absent used to mean "fatal"
  and "voice"; every emitter and every server states it instead, so a turn-level
  failure can no longer end a session by omission.
  
  **One name per concept.** `@alexkroman1/aai/protocol` no longer publishes the
  direction-named aliases `ClientMessage`, `ClientMessageSchema`,
  `CLIENT_MESSAGE_TYPES`, `ServerMessage` and `ServerMessageSchema`. Use
  `SessionCommand`, `SessionCommandSchema`, `SESSION_COMMAND_TYPES`,
  `SessionEvent` and `SessionEventSchema`.
  
  **A fix that came with it.** `toStepError` recognises a carried verdict
  STRUCTURALLY rather than with `instanceof`, so a `retryable: false` refusal that
  arrives rehydrated from the durable journal is still terminal instead of being
  retried to exhaustion.
  
  Platform-internal: the double-encoded-jsonb self-heal and the string-vs-object
  read tolerance are gone (settled by the 2026-08-09 normalizing migration), as are
  the pre-per-app-database schema drop, the pre-v2 harness-image bundle-URL gate,
  and the studio account key-mapping backfill.
- efa6152: Close the seven API shapes that produced contract churn, and generalize the channel API.
  
  Provider factories, options types and resolve helpers are stage-qualified — `deepgramStt`, `cartesiaTts`, `openaiLlm`, `openaiS2s`, `ElevenLabsSttOptions` — so a vendor taking a second stage adds a name instead of renaming one. Every provider options interface extends `ProviderCredentialOptions`, so `apiKeyEnv` is spellable on all thirteen rather than the four the runtime had always honoured. Each LLM vendor has its own `*LlmOptions` extending `ModelOptions`.
  
  Value-carrying constants now carry literal types, so their values are in the published .d.ts and cannot change unnoticed; the AssemblyAI voice catalog is typed by `AssemblyAITtsVoiceInfo` so re-accenting a voice is not an API change. An `async` slot mutation body is a compile error rather than a runtime throw.
  
  Channels: `ChannelKind` and `registerChannelKind` make a destination a self-contained module, and `slack()` is `slackChannel()`.

### Minor Changes

- 83edc89: Add a channels concept to the API: `@alexkroman1/aai/channels` publishes a serializable channel descriptor, a platform-neutral `ChannelMessage`, and `sendToChannel`, which renders and posts one and classifies the refusal. Slack is the first channel — `slackChannel({ webhookUrl })` covers both incoming webhooks (Block Kit) and workflow triggers (flat variables), with `isSlackWebhookUrl` published so the destination can be refused at the form's edge. `sendToChannelClassified` on `/step-errors` is the pre-classified caller.
- 6960bfa: Session event handlers can maintain session state: `SessionEventContext` carries `slots`, and every `sessionSlot`/`dialog` accessor now takes a `SlotHolder` (a `ToolContext` still satisfies it, so no call site changes). The runtime commits a hook's write — the `syncState` push plus the store flush — and does not re-run hooks for the events a commit emits. A handler still has no `send`, so the event stream stays a record of the turn rather than a second way to drive it.
- 01b790c: Add subagents: `subagent()` and `ctx.delegate`.
  
  A subagent is a second tool loop started from inside a tool's `execute` — its
  own instructions, model, tools and, above all, its own context window. Only
  what it concludes crosses back into the conversation, so a run that reads tens
  of thousands of tokens of web pages costs the caller a paragraph. Runs are
  ordinary promises, so several fan out with one `Promise.allSettled`.
  
  - `subagent({ name, instructions, llm?, tools?, builtinTools?, maxSteps?, … })`
    declares one; `ctx.delegate(sub, { task, context?, maxSteps? })` runs it and
    answers `{ text, steps, toolCalls }`.
  - A subagent's tools run through the same executor as every other tool call —
    argument coercion, schema validation, the per-call deadline, a real
    `ToolContext` — and its last step is spent with tools withheld, so a capped
    run answers instead of stopping mid-chain.
  - Delegation is one level deep: a subagent's own tools get a `ctx.delegate`
    that refuses, naming the rule.
  - `stubDelegate` (`@alexkroman1/aai/testing`) fakes the capability, routed by
    subagent name; `createToolContext` defaults `delegate` to a rejection.
  - The `briefing-desk` template is the worked example.
- 56b775c: Deduplicate and simplify shared logic across the workspace: byte-buffer joins, a bounded-concurrency worker pool, upload pause/resume, and the guest base-image tag each now have one definition instead of two to four hand-written copies.
  
  Note one user-visible change: aai-ui's upload progress now formats byte counts with the SDK's formatBytes, so a KB value renders as `512 KB` rather than `512.0 KB`. The SDK helper is otherwise strictly more robust (NaN/negative guard, carries 1024 KB up to 1.0 MB, and has a TB step).

## 7.0.0

### Major Changes

- ea0c9c9: Cut the authoring surface to what an agent.ts writes, and fix the docs that contradicted the code.
  
  **Docs that were telling authors false things.** `preemptiveGeneration` said `Defaults to true` in its first paragraph and `turned the default OFF` in its sixth (the runtime default is `false`); `DEFAULT_MAX_TURN_SILENCE_MS` rendered as 3500 while its own prose argued for 3000 three times; and `workflow()`'s example showed `agent({ tools })`, which `InlineToolsMisuse` makes a compile error. Every field default is now an `@defaultValue` tag carrying the literal value instead of a link to follow.
  
  **Endpointing is reachable without replacing a stage.** `agent({ maxTurnSilenceMs })` — the pause-tolerance knob — desugars to `stt: assemblyAIStt({ … })`, the same way `voice` already did. It used to cost a whole descriptor, which silently opted the stage out of the default fill. `assemblyAIPipeline()` takes the pair too.
  
  **`flow()` is `dialog()` and `graph()` is `procedure()`.** `dialog` / `procedure` / `workflow` names the three by their jobs; `flow` sat in one barrel beside `workflow` meaning something else entirely.
  
  **Three subpath moves, all by AUDIENCE.** `@alexkroman1/aai/step` is new and holds the `"use step"` vocabulary; `/utils` keeps the fifteen helpers a tool body writes (it was 79 serving three readers); the platform contracts and wire helpers are on `/internal`, which is now zod-free; and the workflow RUN vocabulary is on `/workflow-api`, whose reader is a page or a script. The ten types behind `AgentParams`' arms left the root barrel — they implement a compile error and every message is unchanged. Root exports: 120 → 94.
- d1e7c56: **BREAKING — the host runtime moved to its own package, `@alexkroman1/aai-runtime`.**
  
  `@alexkroman1/aai/runtime` no longer exists. Everything it exported is now the
  root export of the new package:
  
  ```diff
  -import { createAgentServer, createRuntime } from "@alexkroman1/aai/runtime";
  +import { createAgentServer, createRuntime } from "@alexkroman1/aai-runtime";
  ```
  
  Add the dependency alongside `@alexkroman1/aai`; it releases in lockstep, so the
  versions always match. A scaffolded project's `server.mjs` is the one place most
  users will hit this, and `aai init` now writes it that way.
  
  **Nothing about authoring changed.** `agent()`, `tool()`, `sessionSlot()`,
  `workflow()`, the provider factories and every other subpath are untouched. If
  your project only contains an `agent.ts` and a `client.tsx`, there is nothing to
  migrate.
  
  Why, in one line each:
  
  - **The authoring install sheds 20 dependencies.** `@alexkroman1/aai` went from
    32 runtime dependencies to 12. Every `@ai-sdk/*` adapter, the Deepgram,
    ElevenLabs, Cartesia and AssemblyAI vendor SDKs, plus `ai`, `postgres`, `ws`,
    `ulid` and `@workflow/world-postgres` are the host's, not an agent author's —
    a provider factory returns a pure descriptor and imports no vendor code, so
    they were only ever needed by whatever resolved that descriptor.
  - **The API reference shrank 22.7%** (32,334 → 24,999 lines). The runtime is
    ~220 exports against the SDK's ~90, and it was the majority of a reference
    whose readers are people writing agents.
  
  One new subpath comes with it: `@alexkroman1/aai/host-internal`, carrying the
  155 SDK internals the runtime needs across the package boundary. Like
  `./internal` it is not authoring API and carries no semver promise — it exists
  so the runtime can reach them without them landing in an agent author's
  autocomplete.
- abfc018: Cut 21 documented-default constants and the workflow API's server half off the published authoring surface. The `DEFAULT_*`/`MAX_*` constants that used to sit on `@alexkroman1/aai` — every one except `DEFAULT_SYSTEM_PROMPT`, which an author composes against — are now on `@alexkroman1/aai/internal`, along with `clampWorkflowWait`, `MAX_WORKFLOW_WAIT_MS`, `TERMINAL_WORKFLOW_STATUSES` and `WORKFLOW_API_PREFIX` from `@alexkroman1/aai/workflow-api`. Every value, every doc comment and every default is unchanged; each field's own JSDoc still carries the value it defaults to. Code that reproduced a default or clamped a wait imports it from `/internal` instead. The root barrel is 102 exports to 81 and `/workflow-api` 35 to 31.
- 6596e4b: Stop erasing types the SDK already computed, own the helpers the templates had
  copied past the third time, and change one signature that had to break.
  
  **BREAKING — `stubUploads` returns `StubUploads`, not a bare `() => void`.**
  `const restore = stubUploads(files); restore();` becomes
  `const uploads = stubUploads(files); uploads.restore();`. It was the only fake
  in its family whose shape a spec had to remember was different, and the only
  way to assert that a step WROTE something was to read it back through
  `uploadInfo`/`readUpload` — through the seam the write went out on, so a broken
  write and a broken read were indistinguishable. `writes` is the log and `read`
  is a synchronous peek beside `restore`.
  
  **Result types.** `dialog.tool`, `slot.tool` and `slot.updateTool` each bound a
  result type parameter and returned `ToolDef<P>` — that is, `unknown` — where
  `tool()` had kept it all along, so `InferToolOutput` was useless for exactly
  the tools a stateful agent writes. They answer
  `ToolDef<P, Promise<DialogToolResult<R> | ToolFailure>>` and `ToolDef<P, R>`
  now. `DialogToolDef.sendFrom` takes `Exclude<NoInfer<R>, ToolFailure>`: `R` was
  inferred from two positions, so whether the parameter meant anything depended
  on whether `sendFrom` was written above or below `execute` in the object
  literal — above it, the parameter was `unknown` and its narrowing silently
  stopped checking anything while still compiling.
  
  **A dialog can be a plain state map.** `dialog(key, { initial, states })` takes
  `instruction`, `on`, `final`, `initial` and nested `states`, builds the same
  XState machine (so a persisted dialog resumes across the change), and
  synthesizes the event union from the `on` keys. `instruction` is a typed field
  rather than an untyped `meta` lookup that failed silently when misspelled. The
  machine overload stays for everything the spec form deliberately cannot express.
  
  **New on `@alexkroman1/aai/step-files`:** `withTempDir`, `readUploadToFile`,
  `writeUploadFromFile` and `STEP_FILE_WINDOW_BYTES`, for the upload/local-file
  round trip ffmpeg needs a real path for. Its own subpath rather than `/step`,
  because `/step` is held at module scope by every workflow file and a `node:fs`
  import there dies at replay.
  
  **New on `@alexkroman1/aai/step-errors`:** `throwFfmpegStepError`, plus six
  pre-classified callers (`stepGenerateClassified`, `stepGenerateJsonClassified`
  and the four `stepTranscribe*Classified`) — the same step calls with the
  `.catch(throwStepError)` every project was writing beside them, and forgetting
  on the arm where a `TranscribeError`'s `retryable: false` is the difference
  between reporting a bad recording and re-uploading it until the attempts run out.
  
  **New on `@alexkroman1/aai/utils`:** `formatBytes`, `formatDuration`,
  `countWords` and `plural`. Non-localized, with every documented output pinned —
  one template printed the same 64-minute recording as `1:04:09` from its workflow
  and `64:09` from its page.
  
  **New on `@alexkroman1/aai/workflow-api`:** `WorkflowInputOf` and
  `WorkflowRunOf`, beside `WorkflowOutputOf`. `WorkflowInputOf` is the schema's
  OUTPUT type, so a field with a `.default()` is required after parsing and a body
  has nothing left to re-implement with `??`.
  
  **New on `@alexkroman1/aai/testing`:** `ok`/`okPosition` (unwrap what a tool
  answered on the registry-lookup path, throwing and QUOTING a refusal rather than
  casting past it), `parseToolInput`/`toolInputIssues` and
  `parseSchemaInput`/`schemaInputIssues` (ask a schema what it accepts without
  reaching through `~standard`), `stubTranscribe` (the four transcription
  endpoints answered in memory, refusing by HTTP STATUS so the SDK's own
  classification is exercised rather than replaced), and `ToolContextOverrides` —
  `createToolContext` took a `Partial<ToolContext>`, which under
  `exactOptionalPropertyTypes` refuses an explicitly-undefined value, so callers
  wrote a conditional spread to pass an optional one. `runTool`'s `args` is
  optional now, which sixty-six call sites were passing `{}` to satisfy.
  `@alexkroman1/aai/testing/vitest` gains `installStubUploads`,
  `installStubStepFetch`, `installStubReporter`, `installStubSpeech` and
  `installStubTranscribe` — the same fakes with `onTestFinished(restore)` done.
  
  **`WorkflowClient.lastLine(runId)`** reads a run's newest progress chunk, or
  `undefined`. The composition it replaces HANGS: a progress channel is never
  closed, so `stream()` on a run that has written nothing waits forever, and a
  voice agent's tool call stops mid-turn with no error and nothing in a log.
  
  **`buildSystemPrompt` strips a leading verbatim `DEFAULT_SYSTEM_PROMPT`.** The
  constant's own doc used to say `agent({ systemPrompt })` replaced the shipped
  prompt and gave a worked example interpolating it; it is APPENDED, so following
  that example sent ~10,000 characters twice, under two different precedence
  headers. The doc says appended now, and an agent shipping the doubled form is
  corrected on upgrade.
  
  `@alexkroman1/aai-ui` moves with the fixed release group and gains
  `ConsoleShell` (public, because every custom chrome rebuilt the frame without
  the `role="alert"` the error banner needs once the fatal latch has fired),
  `useConversation` (the message/tool-call interleave, the streaming bubble, the
  live transcript row and the thinking rule, headless — three template chromes
  dropped all four at once and one rendered none of its fifteen tools),
  `useDownloadUrl` (the object-URL lifecycle, revoke included),
  `WORKFLOW_STATUS_LABELS`, `wake`/`cancel` on both workflow submissions,
  `<WorkflowProgress lines>`, and four display fields on `ClientConfig`.
- 23e8b3f: **BREAKING — the STT/TTS opener contract moved off `@alexkroman1/aai/stt` and `@alexkroman1/aai/tts` to `@alexkroman1/aai/runtime`.**
  
  Eleven types are affected. If your build broke with `has no exported member`, change the import path — nothing about the types themselves changed:
  
  | moved from | moved to | names |
  | --- | --- | --- |
  | `@alexkroman1/aai/stt` | `@alexkroman1/aai/runtime` | `SttOpenOptions`, `SttSession`, `SttEvents`, `SttError`, `SttTurnMeta`, `Unsubscribe` |
  | `@alexkroman1/aai/tts` | `@alexkroman1/aai/runtime` | `TtsOpenOptions`, `TtsSession`, `TtsEvents`, `TtsError`, `TtsWordTiming`, `Unsubscribe` |
  
  ```diff
  -import type { SttEvents, SttOpenOptions, SttSession } from "@alexkroman1/aai/stt";
  +import type { SttEvents, SttOpenOptions, SttSession } from "@alexkroman1/aai/runtime";
  ```
  
  These are the types a HOST application implements a speech provider against, and they now sit beside `registerSttKind`/`registerTtsKind` — the seam you hand the opener to — instead of on the subpath an agent author imports a factory from. Writing an agent needs none of them. `SttProvider` and `TtsProvider`, which are what a factory RETURNS, stay on `/stt` and `/tts`.
  
  Also in this release, all non-breaking:
  
  - `ProviderDescriptor` — the base of `SttProvider`, `TtsProvider`, `S2sProvider` and `LlmProvider` — is now exported from `/stt`, `/tts` and `/s2s` as well as `/llm`, so a page showing `SttProvider = ProviderDescriptor<…>` defines the type it names.
  - Every provider page now opens with what it is FOR and a compiling example of putting that stage in front of an agent, instead of an internal note about `noReExportAll` budgets. All 18 factories (`assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox`, `anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway`, `assemblyAILlm`, `assemblyAITts`, `cartesia`, `rime`, `assemblyAIS2s`, `openaiRealtime`) gained an `@example`.
  - The `/stt` page now states what an unset language field means for each of the four vendors, and `DeepgramOptions.language` says out loud that unset means **English** — `deepgram()` is the one STT provider here that pins a language where the other three auto-detect, so moving an agent onto it silently drops non-English transcription with no symptom but a plausible-looking mis-hearing.
  - `DEFAULT_DEEPGRAM_ENDPOINTING_MS` and the root's `DEFAULT_MIN_TURN_SILENCE_MS`/`DEFAULT_MAX_TURN_SILENCE_MS` now cross-reference each other as the one end-of-turn knob seen from two vendors.
  - `@alexkroman1/aai/runtime`'s own page now leads with the handful of names a host application actually imports, rather than with the enumerated-exports rationale.
- abfc018: Cut the published provider surface to what an agent author writes.
  
  **The four stage subpaths go from 118 exports to 49.** Counted in
  `API-EXPORTS.json`: `/stt` 24 → 11, `/llm` 56 → 18, `/tts` 25 → 14, `/s2s`
  13 → 6. `/ffmpeg` goes 21 → 15, and the `/llm` reference report drops from 454
  lines to 81.
  
  - **The eighteen `*_KIND` and eighteen `*_API_KEY_ENV` constants moved to
    `@alexkroman1/aai/host-internal`**, beside the `resolve*Settings` helpers
    that read them. An author never typed one — a factory returns the `kind`,
    and the host resolves the credential out of the agent's env — and four of
    each set were one string under four names.
  - **The eighteen narrowed `*Provider` aliases are gone.** `deepgram()` returns
    `SttProvider`, `anthropic()` returns `LlmProvider`, and so on. They had no
    reference outside their own modules, nothing narrowed on `.kind`, and the
    stage-mismatch guarantee they were credited with comes from the base types'
    `__stage` phantom. `assemblyAIPipeline()` returns the three base types too.
  - **Eight byte-identical `{ model: string }` interfaces became one
    `ModelOptions`** (`AnthropicOptions`, `OpenAIOptions`, `GoogleOptions`,
    `GroqOptions`, `MistralOptions`, `XaiOptions`, `OpenRouterOptions`,
    `GatewayOptions`). The STT/TTS option types, which differ, are unchanged.
  - **The root barrel exports the five descriptor types its own signature
    names** — `SttProvider`, `LlmProvider`, `TtsProvider`, `S2sProvider`,
    `ProviderDescriptor`. All five were FORGOTTEN exports there: declared in the
    rollup because `AgentDef` references them, exported by nothing, so an author
    typing two stages imported from two subpaths and the shipped authoring
    guide's `agent()` signature block named types no import path could supply.
    `ProviderDescriptor` leaves the four stage subpaths, where one interface had
    four reference pages; the four stage types stay on theirs as well.
  - **`ASSEMBLYAI_TTS_VOICES` and `AssemblyAITtsVoice` are on the root too**, for
    the same reason: `agent({ voice })` is typed against them and both were
    forgotten exports. `ASSEMBLYAI_TTS_DEPRECATED_VOICES` went the other way, to
    `/host-internal` — no template read it, and its 21 literals were inlined into
    the published `.d.ts` for nobody.
  
  **Renames.** `AssemblyAIOptions` → `AssemblyAISttOptions`,
  `ASSEMBLYAI_STREAMING_EU_URL` → `ASSEMBLYAI_STT_EU_URL`, `ASSEMBLYAI_KIND` →
  `ASSEMBLYAI_STT_KIND`, `ASSEMBLYAI_API_KEY_ENV` → `ASSEMBLYAI_STT_API_KEY_ENV`
  (the AssemblyAI STT module was the one stage keeping bare names while the other
  three infixed theirs); `DEFAULT_DEEPGRAM_ENDPOINTING_MS` →
  `DEEPGRAM_DEFAULT_ENDPOINTING_MS`, matching every other provider constant; and
  `elevenlabs()` → `elevenLabsStt()`, so the bare name is free for the TTS stage
  ElevenLabs is better known for.
  
  **Two option fields.** `elevenLabsStt({ languageCode })` is `{ language }` and
  `soniox({ languageHints })` is `{ languages }`, leaving one spelling per
  cardinality across the four STT vendors instead of four. Each vendor's own wire
  name is still applied host-side, so nothing on the wire changes.
  `assemblyAIS2s()` gained `apiKeyEnv`, a field the host had always read off any
  descriptor generically — S2S honoured an override its own options type could
  not spell — and `AssemblyAIS2sOptions`/`OpenaiRealtimeOptions` are interfaces
  now, like the other three stages'.
  
  **`@alexkroman1/aai/ffmpeg`.** Two exported type names collided with DOM
  globals and are renamed: `MediaStream` → `MediaStreamInfo` and `MediaSource` →
  `FfmpegSource`. API Extractor was already emitting them as
  `MediaStream_2`/`MediaSource_2` to produce a report at all. Six operator knobs
  moved to `/host-internal` — `FFMPEG_PATH_ENV`, `FFPROBE_PATH_ENV`,
  `DEFAULT_FFMPEG_TIMEOUT_MS`, `DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`,
  `FFMPEG_STDERR_TAIL_CHARS` and `ffmpegVersion` — since a `.d.ts` an author
  imports is the wrong place to publish where the binaries live on this machine.
  
  **The gateway catalog stopped being a published data table.**
  `ASSEMBLYAI_GATEWAY_MODELS`, `GatewayModelInfo` and `gatewayModelIds` are on
  `/host-internal`; `AssemblyAIGatewayModel` stays public, and
  `gen-gateway-models.mjs` now emits it as an explicit string-literal union
  instead of `keyof typeof`. The catalog's 30 rows were inlined into the
  published `.d.ts` to express that one type — roughly 190 of the 454 lines the
  `/llm` report used to be — so regenerating the catalog, which is routine ops,
  moved a contract hash and demanded a classification for a change no author
  could see.
- 23e8b3f: Make `InferToolOutput` actually infer, curate two constants off the root barrel, and name the session event types.
  
  **`ToolDef` and `tool()` take a second, defaulted type parameter `R`.** `execute` was declared `Promise<unknown> | unknown`, so a tool body's real return type was erased at the `tool()` call and `InferToolOutput<typeof myTool>` resolved to `unknown` for every tool in existence — a published inference helper whose own doc promises `useToolResult` a single source of truth and delivered none. `ToolDef<P, R>` captures it, `R` defaults to `unknown` so `ToolDef<typeof schema>` keeps its old meaning, and a sync body and an `async` one now infer alike. Source-compatible: every existing annotation still compiles, and the frozen epoch-9 authoring example compiles unchanged. `tool()`'s parameter is now declared as `ToolDef<P, R>` rather than re-stating the shape inline, so the reference finally shows that `execute` takes `(args, ctx)`.
  
  **BREAKING — `ASSEMBLYAI_S2S_KIND` and `ASSEMBLYAI_S2S_API_KEY_ENV` are no longer exported from `@alexkroman1/aai`.** They reached the root only through an `export *` and fail the barrel's own membership test: an `agent.ts` writes `s2s: assemblyAIS2s()` and never names either — the descriptor sets the kind, and credentials resolve server-side. Import them from `@alexkroman1/aai/s2s`, where their eleven `*_KIND`/`*_API_KEY_ENV` peers already live. Nothing else moved.
  
  **New: `SessionEventType`**, the union of every name an `agent({ events })` map may be keyed by. The key set was previously readable only inside the wire schema's own type expression.
  
  Also in this release, all documentation:
  
  - The root entry point now renders as a module page with orientation and a subpath map instead of opening on `KeyedLockTimeoutError`, and `dialog()`, `procedure()` and `workflow()` each state the rule for choosing between the three.
  - Both `@alexkroman1/aai/testing` examples that called `agent()`'s default export directly — which always throws, because a tool is a file — route through `withDiscoveredTools`, and `toolOf` now says so when the tool record is empty.
  - `AgentDef` says it is what `agent()` returns rather than what you write, and each `*AgentParams` arm says its long string-literal field types are compile-error messages, not accepted values.
  - `DEFAULT_GREETING`, `DEFAULT_SILENCE_PROMPT` and `DEFAULT_START_FAILURE_PHRASE` render their actual text instead of `string` (values unchanged), and `DEFAULT_SYSTEM_PROMPT` documents its five sections and how to extend rather than replace it.
  - The README lists every published subpath by who reads it, gains a "Testing an agent" section, and shows a multi-field `agent()` configuration.
  - Published doc comments no longer navigate by repo-internal file path or name `@internal` symbols a consumer cannot import.

### Minor Changes

- 429126e: Authoring-surface fixes found by manually testing the SDK.
  
  **Wrong or unsafe**
  
  - `multipartBody` escapes a part's `name` and `filename`. An uploader-supplied
    filename (`uploadInfo().name`, which `stepTranscribeSync` forwards) could
    close the quoted header value and append headers of its own to a step's
    request.
  - An AssemblyAI TTS `language` the declared voice cannot speak is now a config
    error naming the voices that can, instead of an agent that connects, reports
    ready and never speaks. Includes the pair the SDK built itself:
    `assemblyAITts({ language: "fr" })` filled in the English default voice. A
    voice this release's catalog does not list is still passed through — and
    `aai build`/`aai dev` now WARN about it (`agentConfigWarnings`), since
    refusing one would refuse a voice AssemblyAI shipped after this release while
    saying nothing left a typo to surface as a silent agent. A deprecated voice
    gets its own line.
  - `pcmDurationMs` refuses a `Uint8Array` where a byte count goes rather than
    answering `NaN`, and names itself instead of `encodeWav` in the format check
    the two share.
  
  **Silent**
  
  - Every `ctx.send` drop is logged. The two wire caps — an over-long event name
    and an over-64 KB payload — returned silently while `ToolContext.send`
    documented "dropped (with a warning log)".
  - `createToolContext()`'s `send` applies that same rule, so `ctx.sent` records
    what the client would receive. It used to record events production throws
    away, passing a spec for a notification nobody ever got.
  - Two `sessionSlot`s on one key that disagree about the shape they store are
    refused per session, instead of silently reading and writing each other's
    value. Two declarations that AGREE still share a key, which is how `dialog()`
    works.
  - `aai build` and `aai dev` warn when a `"use workflow"` body calls `Date.now()`,
    `new Date()`, `Math.random()`, `crypto.randomUUID()` or `fetch()` — each
    replays differently on every resume. Step bodies are exempt by construction.
  - A builtin made inert by a `tools/` file of the same name is logged. The file
    still wins.
  
  **Reported as a sentence**
  
  - A config-shape mistake (`agent({ maxSteps: 0 })`, a bad `builtinTools` entry)
    reached the author as a raw dump of zod issue objects at `aai build`.
    `toAgentConfig` now throws one line naming each bad field, and `errorMessage`
    renders any validation error's issues rather than its JSON-dump `message`.
  - `toolOf`/`runTool` say what they were handed when it is a tool def or
    `undefined`, instead of `Cannot read properties of undefined`.
  - `dialog(spec)` — the one-object shape every other authoring function takes —
    names the signature instead of dying on an `in` check, and a `dialog()` whose
    `initial` names no declared state is refused rather than silently stuck.
  
  **Refused earlier**
  
  - `agent({ silencePrompt })` with no `silenceTimeoutMs` is a compile error; it
    was a config error at build time.
  - `agent({ tools })` reports the file-is-a-tool rule on every arm. On a voice
    agent tsc used to print the workflow-app message first.
  - A `tools/` file whose name is longer than a provider accepts (64), and a
    `tools/index.ts` barrel, are named at build instead of failing at the first
    turn or reaching the model as a tool called `index`.
  - A blank agent `name`, and a `requiredEnv` entry no environment could hold, are
    rejected.
- abfc018: Widen the authoring surface without moving it: `withDiscoveredTools` is now generic over `ToolBearingAgent` (the parameter widens, the return narrows, no call site changes), which takes `AgentDef` and the sixteen declarations behind it — the zod session-event union included — off the `/testing` contract; and `isRecord`, `omitUndefined` and `responseErrorMessage` join the root barrel, so everything on `@alexkroman1/aai/utils` is reachable from the root too.
- 43ceb43: Add procedure() — run a state machine to completion as one unit of work inside a tool call, the sibling of dialog(). A flow is where a conversation is (persisted in a slot, moved by the caller's turns); a graph is one piece of work (never stored, driving itself through invoked actors). run(input, { signal }) takes ctx.signal so a long multi-stage loop stops on a barge-in, and rejects with ProcedureNotFinishedError for a run that did not finish — xstate's own toPromise resolves undefined for a stopped actor, which hands a half-built output back typed as a finished one.
- 8c9ce20: Add `stepFetchOk` to `@alexkroman1/aai/step-errors` — `stepFetch` plus the non-2xx branch three templates had each hand-rolled, carrying the far side's own error text into the message and leaving the retryable/terminal verdict with `toStepError`. Adds a `podcast-digest` template: a scheduled workflow app that transcribes new podcast episodes and posts a Slack digest on a repeating durable sleep.
- a7309a5: Batch the upload claims: one `PUT …/parts?offset=&offset=…&stored=1` names every window that has landed, instead of one body-less round trip per part.
  
  On the direct path a part was two serialized requests — the window to the platform, then a receipt telling the agent it landed. The receipt carries no bytes and measured 1604-1969 ms against a deployed agent, per part, about half of an upload's wall clock. The client now hands landed offsets to a coalescing claimer (one claim in flight, everything landing during it collapses into one trailing claim, so the batch sizes itself) and a fan-out slot goes straight from its bytes to the next window's. The guest's `recordParts` pays one record read, one lock acquisition and one whole-array write per REQUEST rather than per part, and probes the bucket for every named window concurrently — all-or-nothing, so a batch holding one bad offset records none of itself.
  
  A client only batches when the agent advertised `claimBatch` on the claim; it is never inferred from `directParts`, because an agent reading a single `?offset=` would record the first window and leave the rest as holes that read as silence.
  
  Breaking only for a direct implementor of `UploadStore` from `@alexkroman1/aai/runtime`: `recordPart(id, offset)` is now `recordParts(id, offsets)`.
- 51d571d: Add decodeHtmlEntities to /utils, toolRunner to /testing, and mockWorkflows to /testing/vitest — the three helpers the templates were each re-deriving. decodeHtmlEntities replaces two byte-identical entity decoders whose whole content was the ordering rule that `&amp;` decodes last; it is a single pass, so no order of the table can produce a different answer. toolRunner is runTool with the agent bound, replacing ten template wrappers. mockWorkflows answers a WorkflowClient's reads from one fixture with a vi.fn per method.
- 43ceb43: Add dialog() — a dialog statechart primitive, so what a voice agent may do next is declared rather than asked for in prose. A flow is an xstate machine persisted in a session slot; a flow tool declares the states it may run in and refuses at execution when the conversation is elsewhere, returning a ToolFailure that names where the caller actually is. Every flow tool's result carries the position it landed in, so the active state's instruction reaches the model on every call.

### Patch Changes

- 12ead27: Finish the direct upload path on a RESUME, instead of silently falling back to sending bytes to the agent.
  
  A resume re-declares an id the store already holds, which is answered 409 — and a 409 carries no body, so the client had nowhere to read `directParts` from and read nothing. Every resumed upload therefore abandoned the direct path and sent each remaining window's bytes THROUGH the agent: it works, it is the topology the direct path exists to avoid, and it is the one the platform's forward measures to decide whether a guest has stalled. `GET …/uploads/:id/info` now answers the same two capability fields the claim does, which the resume already fetches, so this costs no extra round trip.
  
  Also: the sweep script writes its minted upload ids unconditionally rather than only under `--json`. Those uploads are permanent and nothing reclaims them, so the ids are the only handle a cleanup could have.
- 028044a: Resume a paused upload instead of restarting it: a caller-named upload (`uploadStream`, which every workflow form uses) is now cut into parts even when the file fits in one, so pausing a recording under 8 MiB and resuming it sends the missing windows rather than the whole file — which the store then refused as a taken id.
- 9b9051a: Model the pipeline turn state, the S2S connection lifecycle, the outward speaking-edge gate, and the browser session's agent state as XState statecharts, replacing the boolean latches whose illegal combinations were reachable.
- 55d5ec1: Name the workflow-api and ffmpeg entry modules with `@module` tags, so they document under their published subpath rather than their emitted file path, and fix an unresolvable `{@link spawnFfmpeg}` in the ffmpeg module comment.
- d98169a: Publish `dist` and nothing else. `@alexkroman1/aai` had no `files` field, and
  `.npmignore` excludes only repo artifacts (`etc/`, `coverage/`, `.turbo/`,
  `contracts/`) — so every tarball carried the whole `host/` and `sdk/` TypeScript
  source and 219 test files: 961 entries, 2,049 kB packed, 7,632 kB unpacked,
  against 209/505/1,476 now. Consumers were downloading the SDK's test suite.
  
  `AGENT_GUIDE.md` and `skills/` stay (both ship deliberately); `CHANGELOG.md`
  does not, matching `aai-ui` and `aai-cli`. Nothing supported breaks — every
  `exports` target is under `dist`, and the `@dev/source` condition that points at
  `.ts` source is activated only by this monorepo's own `customConditions`.
  
  `published-files-gate.test.ts` is the guard: every publishable package declares
  a non-empty `files`, and every `exports` target is covered by it. The two things
  that should have caught this and did not are worth naming — the artifact-size
  report compares against the PR base, so a package that has ALWAYS shipped its
  source never trips a delta gate, and `publint` files it as a *suggestion*, which
  `check:publint` passes over.
- df8effa: Stop over-subscribing an app database's connection limit. A workflow guest opened four separate Postgres pools on the same app role — `ctx.db`, the workflow upload store, the wake-hint publisher and the lock sweep's presence connection — on top of the DevKit world's pool and its `LISTEN` client, for a ceiling of 13 against a role limited to 10, and postgres.js never gave an idle connection back, so a guest booting beside a draining sibling could not connect at all: `Workflow wake hint not published { error: 'too many connections for role "app_…"' }`. The first three now share one leased pool per process, pooled connections idle out after 30 seconds (a reserved one, like the presence lock, is exempt), step concurrency is one below the world pool so it stops competing with graphile-worker's own `LISTEN` connection, and the whole budget is one table (`guestAppDbConnections()`) the platform's limit is tested against rather than a comment that had gone stale.
- 23e8b3f: Reference and doc fixes across `/protocol`, `/manifest`, `/runtime`, `/step`,
  `/step-errors` and `/workflow-api`.
  
  - `/protocol`: `ServerMessage`/`ServerMessageSchema` and
    `ClientMessage`/`ClientMessageSchema` are now re-export aliases of
    `SessionEvent*`/`SessionCommand*` rather than separate declarations. The names
    and their runtime values are unchanged; the reference no longer documents the
    same two unions twice under two names each.
  - `/manifest`: `assertProviderTriple` is no longer exported. One overload
    carried `@internal` and the rest did not, so it was listed as a published
    export while the reference denied it existed; every caller is inside the SDK.
  - `/runtime`: `SessionWebSocket`, `TransportEventBody`, `UploadReader`,
    `SessionStateBackend` and `SessionCore` are documented rather than hidden —
    each is already named by a public runtime signature, so the reference could
    not be used to satisfy one. `WorkflowApiOptions` is now `@internal`, matching
    the `createWorkflowApi` it configures.
  - `/step`: the doc comments that pointed at unpublished module prose now carry
    it, and `stepSpeak`, `readUpload`, `stepTranscribeSync` and the async
    transcribe trio gained examples. `/step-errors`' "why its own subpath"
    rationale is restated against `/step`, the sibling it actually has.
  - `SessionErrorCode` documents its eight values and how `fatal` relates to them.

## 6.11.0

### Minor Changes

- 11e4892: Calling a deployed agent is now one client, and the studio's API page is written
  in it. `createAgentClient` (`@alexkroman1/aai/workflow-api`) is a superset of
  `createWorkflowApiClient`: every workflow route plus `config()`, the front-door
  read (`GET /client-config`) that had no client at all — so a caller stops
  building two things, one of which was a `fetch` and a hand-written URL join.
  
  Two new calls cover the streams. `follow(runId)` and `followOutput(runId)` are
  async iterables — `for await (const run of agent.follow(id))` — and they hold the
  two protocol rules a hand-written SSE loop gets wrong, neither of which looks
  like a bug when it goes wrong: the state stream hands the client back with an
  `idle` frame after its own duration cap (a run may sleep for hours, so that is a
  re-open, not an ending), and one output read is bounded by the tail it saw (so the
  next read has to resume from an absolute index). A stream that ends with the run
  unsettled throws rather than reading as a run that finished. `watch` and
  `streamOutput` still resolve the raw `Response`, which is what a caller writing
  its own polling fallback needs; there is deliberately no fallback inside the
  iterators. `readEventStream` is the SSE parser under them, now public — the
  browser client's private copy is deleted rather than duplicated.
  
  `WorkflowApiClientOptions.token` and `.timeoutMs` accept an explicit `undefined`,
  so `token: process.env.AAI_WORKFLOW_API_TOKEN` compiles under
  `exactOptionalPropertyTypes` instead of needing a `!`.
  
  The API pane and the public page at `/studio/api/<slug>` now lead with the SDK in
  every section, with `curl` and `aai workflow` one disclosure away, and each route
  row names the call that makes it. An upload-carrying input renders as the
  `agent.upload(...)` call and a reference to its id rather than as a placeholder
  string, and the page reads the agent through the same client it documents.
- 3d20929: Add `@alexkroman1/aai/ffmpeg`: run ffmpeg from a step with a bounded, abortable child (`runFfmpeg`), read a file's streams with `probeMedia`, and convert anything to linear-PCM WAV with `transcodeToWav`. Guest sandboxes now ship the ffmpeg binary, so a workflow can transcode and probe media in-pipeline instead of asking the caller to do it first.
- 0da62af: Export the HTTP methods the guest's proxied routes answer (WORKFLOW_API_METHODS, CLIENT_CONFIG_METHODS), so the platform's route declaration is checked against the guest's own dispatch rather than written from memory.
- 298f3f2: A workflow can now produce AUDIO, and a page can play it. Three additions on
  `@alexkroman1/aai/utils` close the return trip that a `"use step"` body could
  not make before: `stepSpeak(text, opts?)` synthesizes an utterance from inside a
  step and hands back a complete WAV (the session TTS surface cannot be used
  there — a `TtsSession` is an event stream wired into a live pipeline's playback,
  and a step has no turn to be part of and has to return a value); `writeUpload`
  is `readUpload`'s other direction, so a step can store a file the run's JSON
  output could never carry and return its id instead; and `encodeWav` /
  `pcmDurationMs` are the 44 bytes of container arithmetic every project was
  otherwise copying, with `byteRate` and `blockAlign` derived rather than passed.
  `WorkflowApi.download(id)` is the browser half — a `Blob` rather than a URL,
  because the byte route takes the same bearer every other route does and neither
  `<audio src>` nor `<a href>` can send one.
  
  For tests: `stubSpeech()` fills the speech slot and records what a step asked to
  say, and `stubUploads(files, { writable: true })` accepts writes and mints
  assertable ids (read-only by default, so a step that stored a file nobody meant
  it to still fails).
  
  The new `spoken-summary` template is the reference use, and it is the whole
  round trip: upload a recording, it is transcribed by the async API, summarized
  through the LLM Gateway, and read back as a WAV the page plays and offers as a
  download.
- 1602a0e: Add stepTranscribeUpload/Submit/Poll and stepTranscribeSync: AssemblyAI's async job API and sync endpoint as step-callable helpers, with TranscribeError carrying the retry verdict toStepError reads

### Patch Changes

- 91364b0: Update dependencies: ai 7.0.65, assemblyai 4.36.7, hono 4.13.2, @ai-sdk/google 4.0.44, @ai-sdk/xai 4.0.38, @ai-sdk/react 4.0.68
- 0397945: Fix a TypeDoc link in stepTranscribeSync's options that failed the docs build
- 12deeec: Stop advertising `directParts` on an agent whose upload store is not the platform's bucket. A databaseless agent keeps its uploads in its own directory, so the direct-parts claim sent every window over 8 MiB to the platform and then asked the agent to record bytes it had never been given — failing every parts upload with `No bytes are stored for the part at <offset>`.
- 8958dd1: Cancel the readable `streamTail` builds to ask for a run's chunk index. `getReadable()` is not lazy — a background pump opens a world-local stream reader immediately — so every tail read leaked a `chunk:`/`close:` listener pair, once per `GET /workflows/runs/:id/stream` and once per progress tool call.
- 1602a0e: Allow blob: and data: media in the agent CSP, so a workflow app's inline audio player and caption track load
- 70e3ceb: Opt the pipeline session's `AbortSignal` into Node's max-listeners warning. Node's leak warning covers `EventEmitter` only, so an abort listener that outlives its turn accumulated on a call-lifetime signal with nothing reported.
- f433015: Stop leaking a world stream reader on every workflow progress poll: a cancel arriving before the DevKit's background connect resolved detached nothing, and a caught-up page polls once a second.

## 6.10.1

### Patch Changes

- 5556ed5: Pipeline TTS: remove the 32-character cap that ended a coalesced provider send. Terminal punctuation is now the only thing that ends a batch, so a long sentence is no longer cut mid-clause into a fragment the provider reads with a falling final intonation — which was heard as an obvious pause a few words in.

## 6.10.0

### Minor Changes

- 1a76804: Workflow uploads no longer need a database: with no `DATABASE_URL` the store now follows the local workflow world into its own data directory, so a databaseless agent's uploads are exactly as durable as the runs that read them. A database with no bucket is the one configuration that still refuses.

## 6.9.1

### Patch Changes

- 9d45c1e: Run databaseless workflows in the local world with a data directory of their own, and rebuild a deployed agent when its database is provisioned

## 6.9.0

### Minor Changes

- bbde9f9: Add an agent log surface: a bounded ring in the guest, `GET /:slug/logs`, a studio Logs pane, and `aai logs`.
  
  `aai` gains `createLogBuffer` on `/runtime` — the cursor-indexed ring both ends of the wire derive from. The guest tees its own stdout/stderr into it and serves `GET /manage/logs`; the platform reads that and answers `GET /:slug/logs` without booting a sandbox. The session event log is append-only to the app role now, so `ctx.db` can no longer delete an agent's own audit trail, and a discarded session's events are reclaimed by the retention sweep rather than by the runtime.

### Patch Changes

- 203c2d4: Overlap the upload byte pipeline with itself: a whole-file write now puts several windows while the next one is still arriving, and the byte route reads chunks ahead of the socket instead of paying a round trip per megabyte. A window is still buffered whole before its write starts, so a failed write is still re-sendable. Also stops the read route leaking a `close` listener per chunk it paces.

## 6.8.0

## 6.7.2

### Patch Changes

- 7f2637c: Double the default parallel-upload width to 8, because a part's cost is half fixed.
  
  On a deployed agent every part is two requests: the window goes to the platform, and a body-less `PUT …/parts?offset=…&stored=1` tells the agent it landed. Measured per 4 MiB part against a deployed agent — byte PUT 926-2121ms, the body-less claim 1604-1969ms. Roughly half a part's wall time is a round trip carrying nothing, and it is per-PART rather than per-byte, so the only thing that hides it is overlap. Extrapolated over a 660 MB recording, ~77s at four wide against ~38s at eight.
  
  The part size stays 8 MiB. A first attempt halved it to 4 on the grounds that a smaller window makes a reset cheaper — true, but the trade only pays if a part's cost is mostly its bytes, and it is not; halving it doubles how many times the fixed toll is paid. 16 MiB measures ~28% quicker per byte with a far tighter spread and is deliberately not taken: at eight wide it would ask a shared memory-bounded process to buffer 128 MiB for one upload, it sits on the reset shoulder, and it raises the size below which a file gets no parallel upload and no retry at all from 16 MB to 32 MB.
  
  `UPLOAD_PART_CONCURRENCY`'s doc also DELETES the table that used to justify 4. It reported a cliff at width 16 that did not exist: the sweep reused one connection with a 1s gap and the platform penalises a connection after it trips, so every cell inherited the previous cell's penalty and the widest cells, run last, looked catastrophic. Re-measured with a fresh connection per run, 16 wide completes 16 of 16.

## 6.7.1

### Patch Changes

- c46dac6: Fix parallel workflow uploads storing a file nothing can read, on any deployment behind a proxy that compresses responses.
  
  `UploadBlobs.size` measures a window by reading `Content-Length` off a body-less `HEAD`, and `Number(null)` is `0` — a perfectly safe non-negative integer — so a response that stated no length at all was read as an EMPTY object rather than an unmeasurable one. Measured against a deployed agent: Node's `fetch` advertises `zstd`, the platform's proxy honoured it, and a `content-encoding: zstd` reply carries no `Content-Length` (`identity`, `gzip` and `gzip, deflate, br` all answered `content-length: 8388608` where `zstd` answered nothing).
  
  So `recordPart` recorded every window of every parts upload as a zero-length range: well formed, summing to a contiguous `size` of 0, and completely unreadable. A 660 MB recording uploaded successfully and then read back as nothing — the transcription desk's header probe reported "That is not a WAV file", and its streaming flow never reached the 64 KB it plans from, so the page showed an empty progress panel for the whole upload. The single-request path was unaffected because it counts bytes as they stream through and never asks a bucket.
  
  Three fixes, because each layer had a chance to catch it and none did: a missing header now reads as ABSENT rather than as zero (an explicit `0` still reads as zero), both blob clients ask for the response unencoded, `recordPart` refuses a zero-length window on an upload that declares bytes, and the client no longer reports success over a record the agent never completed.

## 6.7.0

### Minor Changes

- 9882411: Answer an upload on a deployment with no upload backend as 501, naming what is missing, instead of an opaque 500 the client then retries four times. Adds `UploadsUnavailableError` to `@alexkroman1/aai-runtime`, which is what makes this a minor rather than a patch.

## 6.6.0

### Minor Changes

- 6d6d71f: Publish which windows of an unfinished parts upload have landed (UploadInfo.ranges), and add UploadOptions.resume so a dropped upload finishes rather than starting over. useWorkflowStream resumes once before cancelling the run.
- 6d6d71f: Make workflow uploads faster and recoverable. Part retries back off with jitter and honour `Retry-After` instead of re-sending at once, the claim and the closing record read are retried too, the first failure aborts the parts still in flight, and a file is cut into parts by default — the single-request path cannot retry at all.
- 6d6d71f: Store an upload's bytes as objects in a bucket rather than as `bytea` rows in the app's own database, and send them there straight from the browser.
  
  Postgres charged for those bytes four ways: 6x the storage cost, every byte in the WAL and the heap and then in every base backup and the whole PITR window, the app's own queries sharing a connection pool with them (measured: p50 1.34s against 0.43s while a part was in flight), and — because bytes crossed the platform to reach the guest, whose body-drain rate is what the forward reads as liveness — an upload that was storing perfectly well being aborted as a stall.
  
  There is one store now: the record is a row, the bytes are one object per window, and a deployed agent's parts go to a platform route the guest never holds a credential for. `UploadStore.recordPart` is the write that names a window whose bytes are already stored; its size is asked of the store, never taken from the caller. `UploadInfo.ranges` now also rides on a part's own response.
  
  Two removals, neither of which was ever released: the file backend (`aai dev` with no `DATABASE_URL`) and the chunk table. A deployment with no database or no bucket has no uploads at all and says so by name — locally, `AAI_UPLOAD_STORAGE_URL`, `AAI_UPLOAD_STORAGE_KEY` and `AAI_UPLOAD_STORAGE_BUCKET` in the project's `.env` alongside `DATABASE_URL`.

## 6.5.1

### Patch Changes

- 58788ee: Internal quality pass: give repeated shapes one home each, remove stranded code, and hoist redundant work out of render and streaming paths. No API or behaviour change.
- e2c2cda: Fix four production errors from an hour of Modal logs: a 30s proxy deadline that aborted healthy uploads (27 x 503), a parallel-upload part that treated a retryable 503 as a refusal, a 5xx whose cause was never logged, and an aborted request logged as an agent failure.
- 153264f: Answer a workflow input-validation failure with 400 rather than 500. A guest runs two copies of the SDK by design — the harness bundles one, the agent's runtime comes from its own bundle — so the route's `instanceof WorkflowRequestError` check was false across that seam and every caller mistake was rethrown as an opaque server error. The guard is a registered-symbol brand now, which crosses it.

## 6.5.0

### Minor Changes

- 4da4327: Make the workflow fan-out concurrent and a run's results streamable. `mapConcurrent` (formerly `mapInBatches`, still exported) replaces sequential batches with a window over a cursor, so a slow item no longer holds back a whole round — the replay property needs the issue ORDER to be a pure function of the list, which a monotonic cursor gives at any width. New `emit(namespace, chunk)` writes structured partial results into a named stream that `streamOutput`/`useWorkflowProgress` already read, and `stubReporter()` on `/testing` is how a spec asserts either channel. The transcription template streams its transcript as each segment lands.
- 4da4327: Add an opt-in parallel upload: the browser can split a file into parts and send them at once. `api.upload(file, { parallel: true })`, `useWorkflowSubmit(w, { parallel })` and `useWorkflowStream(w, { parallel })` cut the file into megabyte-aligned windows and fan them out over the new `POST|PUT /workflows/uploads/:id/parts` routes; the store publishes the contiguous prefix as `size`, so readers and the streaming flow are unchanged. Falls back to the single request for a small file, an uncuttable body, or an agent that does not serve the routes.

## 6.4.0

### Minor Changes

- 5288539: Start a workflow run before its file has finished uploading. `PUT /workflows/uploads/:id` stores a file under an id the CALLER chose, so the id is valid before the bytes are sent: the upload record exists from its first byte with `complete: false` and a `size` that grows, `uploadInfo` reports both, and `readUpload` already clamped its window to what has arrived. `useWorkflowStream` is the browser half (start, then one streaming PUT, then wake). `stepFetch` takes an async-iterable body so a step can forward a file it must not hold in memory, and `stubUploads` can stage an upload that is still arriving. Measured on a 10-minute 115 MB recording at 2 MB/s: six of seven segments were transcribed before the upload finished.

## 6.3.1

### Patch Changes

- dd29277: AssemblyAI TTS: cancel a turn with the protocol's own `Cancel` frame instead of dropping and rebuilding the WebSocket. The adapter's doc claimed no cancel frame existed; probing the live service showed it does, and that it both discards buffered text and aborts synthesis in progress. Barge-in no longer pays a reconnect. The socket now survives a cancel, so the abandoned turn's trailing audio and acks are suppressed until the service's `Cancelled` frame marks the boundary; an unsendable or unacknowledged cancel still falls back to the reconnect.

## 6.3.0

### Minor Changes

- 2e103d8: Report upload progress from the workflow API client and render it with the new <UploadProgressBar>, so a form storing a large file shows a bar instead of a disabled button.

### Patch Changes

- b04af38: Flush pipeline-mode TTS sends only on sentence-terminal punctuation (.!?…). Clause marks (,;:) no longer end a batch: a comma is mid-sentence, and flushing there handed the provider a fragment to synthesize with a falling final intonation. The 32-character coalescing cap still bounds how long an unterminated batch waits.

## 6.2.0

### Minor Changes

- 295e8db: Tune the TTS playback path against a recorded reply: one fill target instead of two, a smaller pacer burst, a larger pacer lead, and a heard-cursor ear-lag that is no longer double-counting the client's buffer.
  
  `PLAYBACK_JITTER_MS` is deleted. It was redundant by construction: on a turn's first render the ring buffer is empty, so the underrun branch fires before any audio exists and arms the REFILL target — every turn already waited for that number, and the separate startup target could only act by being larger. Measured, `{jitter: 0, refill: R}` renders byte-identically to `{jitter: R, refill: R}`. One `PLAYBACK_FILL_MS` (200) takes 16-208 ms off time-to-first-audio depending on link quality, with concealment unchanged at zero.
  
  `PACER_BURST_MS` drops 200 to 100 and `CLIENT_AUDIO_LEAD_MS` rises 1000 to 1500. Together the longest link freeze the client rides out with no concealment goes 820 ms to 1453 ms, at no latency cost — time-to-first-audio is identical at every lead. What bounds the lead is bandwidth rather than correctness: a mid-reply barge-in discards ~1.3 s of pushed speech instead of ~0.85 s.
  
  `HEARD_AUDIO_LAG_MS` drops 750 to 150. It is applied on top of the playback clock, whose `endsAtMs` already tracks the client's unplayed backlog, so sizing it against the buffer depth double-counts it — which both its old derivation (the deleted fill target plus a network hop) and a first attempt at a new one (`CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2`) did. Measured against the audio the ear actually received, the old value left the heard cursor ~694 ms early on a typical link, roughly ten words, which pushed toward the repetition `buildTailResumePrompt` exists to prevent. What is left for the term is the one-way network hop.
  
  `PIPELINE_PLAYBACK_GRACE_MS` is unchanged at 750, now with the measurement recorded: barge-in requires 15-138 ms of grace depending on the link, and does not scale with the pacer's lead.

## 6.1.0

### Minor Changes

- c4791cc: A page reload now resumes its voice session: the default client remembers the session id per tab, so the server's syncState push reconstitutes the UI instead of coming back empty. A resume that recovers no history and no slot state is treated as a new session and greets, rather than connecting silently — PipelineTransportOptions.skipGreeting accepts a thunk for that late decision.
- c4791cc: Give every app its own Postgres database instead of a schema, so durable workflows work at all: the Workflow DevKit's `workflow` and `graphile_worker` are database-level schema names it cannot create inside a shared database, and its migration was failing with a permission error. Session state and the wake hint move to the app's own `public`; per-app maintenance runs as a cron job inside that database.

### Patch Changes

- 296b6c3: Fix the README examples: the SDK README documented `ctx.state`, `agent({ state })` and `agent({ tools })`, none of which exist — a reader following it wrote code that does not compile and that `agent()` throws on. Replaced with the `sessionSlot` + tool-is-a-file shape. The aai-ui README passed an ELEMENT to `client({ sidebar })`, which takes a component.

## 6.0.0

### Major Changes

- 0e99e1d: Fix 79 correctness findings and 133 cleanups from a whole-repo review sweep. BREAKING: slot.get() and the slot reading half now return DeepReadonly<T> rather than a shallow Readonly<T>. freezeStorable already deep-froze the value on every write, so mutating one always threw at runtime; the type simply did not say so, which moved the failure from compile time to first call. Two shipped templates were mutating a frozen slot value on every invocation, and the stricter type surfaced 37 more sites across the template suite. A domain helper typed over the mutable shape will now fail to compile: type it over DeepReadonly<T> (exported from the root). slot.set() also stores a copy rather than freezing the caller's own object in place.
- ae9e607: Cut the root entry point down to the authoring API, and give `sessionSlot` the
  two methods a slot-backed tool module was writing by hand.
  
  **Breaking.** `@alexkroman1/aai` exported 175 symbols, 71 of them `@internal`,
  and 160 of them unused by any of the fourteen shipped templates — eleven
  distinct symbols covered every one. It exports 92 now, and none is `@internal`.
  Nothing is deleted; everything subtracted moved to the subpath that owns it:
  
  - Framework budgets with no `agent()` field to set (the client-audio constants,
    provider connect deadlines, wire caps, `AGENT_CSP`, `WS_OPEN`, the
    `WS_NORMAL_CLOSURE`/`MAX_*_BYTES` family) → `@alexkroman1/aai/internal`.
  - The slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS`, `MAX_SLUG_LENGTH`,
    `PREVIEW_SLUG_SUFFIX`), `linkConfirmationCode`, and the wire helpers
    (`capToolResult`, `toArgsRecord`, `isTextAssetPath`, `normalizeSpeechText`,
    `omitUndefined`) → `@alexkroman1/aai/utils`, where the CLI and the platform
    already read them.
  - `StandardSchemaV1`, `StandardSchemaResult` and `StandardSchemaIssue` are the
    ecosystem spec `tool()` accepts rather than something an agent declares;
    `ToolInputSchema` and `InferSchemaOutput` stay on the root.
  
  **`toolError` is renamed `serializeToolFailure` and is `@internal` on
  `/utils`.** It returns the pre-serialized wire string, so
  `isToolFailure(toolError(m))` was `false` — a trap under a name that read as
  the constructor for the shape the guard tests, and used by none of the
  templates despite its own doc pointing authors at it. The new `toolFailure(message)`
  is that constructor, and pairs with `isToolFailure`.
  
  **New:** `slot.tool()` and `slot.updateTool()` hand `execute` the live slot
  value as its second argument, so a tool in its own module needs neither a
  `ToolContext<SlotStateOf<typeof slot>>` annotation nor an opening
  `slot.get(ctx)` — the two lines that opened every tool in every stateful
  template. `updateTool` runs the body inside `slot.update`, for a body that
  awaits. `slot.state` is the `AgentDef.state` factory, so
  `state: cartSlot.state` replaces the hand-written
  `() => ({ [slot.key]: slot.create() })` that four of the five slot-backed
  templates had omitted.
  
  Three capability epochs move with it (`pnpm check:api-contracts`): `tool` and
  `defaults` to v2 with v1 DROPPED — their frozen examples no longer compile, and
  the recorded reasons say why — and `state` to v2 with **v1 retained**, since
  `slot.state`/`slot.tool`/`slot.updateTool` are additions and the epoch-1 example
  still compiles beside the epoch-2 one. The `internal-surface` ratchet falls from
  74 to 3: the only `@internal` names still reachable from a public subpath are
  `capToolResult`, `isTextAssetPath` and `toArgsRecord` on `/utils`.
- 3df649f: The three network builtins (`fetchJson`, `visitWebpage`, `webSearch` on `@alexkroman1/aai/tools`) now return `T | ToolFailure`. Their failure has always been an ANSWER rather than a throw — a model-facing contract that is not changing — but `Promise<T>` hid it, and all three callers in this repo wrote `?? []` / `?? ""`, which turns a refusal into an empty answer. Measured: DuckDuckGo answered 403 to both endpoints, so `research-workflow` and `plan-and-execute` reported "No results." for every search with the refusal nowhere; research-workflow even had a `catch` for it, which a returned value never reaches. Narrow with `isToolFailure`. An UNTYPED call is unaffected (`DefaultToolResult` is `any`), so only call sites precise enough to name a shape are asked to handle the failure they were already receiving. `aai:builtins` epoch 1 is dropped.
- e923c72: A tool is only ever a FILE: `agent({ tools })` is gone. `tools/incident_create.ts` that default-exports `tool({ … })` IS the tool `incident_create`, enumerated where the bundle is assembled and named by nothing. The parameter now types `tools` as a message naming the file to create, and `agent()` throws on the key as well — neither bundler type-checks user code, so the type alone would leave the rule true of this repo and of no user's project. A resolved registry attaches with `withTools`, which is what the build and `withDiscoveredTools` both call; `sessionSlot()` is what carries the state shape into a tool's own module now that a map no longer checks it.
- 0f7c4da: A session takes two vocabularies, not nineteen callbacks. `SessionCore` and `TransportCallbacks` (on `@alexkroman1/aai-runtime`) replace their per-event `on*` methods with `command(cmd)` for the client's command vocabulary and `report(event)` for the transport's event vocabulary — the same names `sdk/protocol-commands.ts` and `sdk/protocol-events.ts` already carry. Breaking for anything implementing either type; the authoring surface is untouched. `TransportEventBody`/`TransportEventType` are new exports, `host/session-commands.ts` is a new internal module, and `guard-invariants` rule 16 holds the per-file count.
- 02d90e3: Session state is durable: a sessionSlot owns its own value and stores it, over Postgres when the app has a database and memory otherwise. `ctx.state` and its `any` are gone, along with `AgentDef.state`, the state type parameter on `ToolContext`/`ToolDef`/`AgentDef`, `InferAgentState` and `SlotState`/`SlotStateOf`. `slot.update` is synchronous and hands the body a mutable draft that is committed when it returns; `slot.get` returns a frozen `Readonly<T>`; `syncState` takes `slot.projection(view)`, which is callable so a client derives its own empty state from the same function.
- 61c6630: A session's events are one vocabulary, one stream, and an agent can observe them. The wire is renamed onto a single discriminated union of stamped events — `config` is `session.configured`, `audio_done` is `audio.completed`, `speech_started` is `speech.started`, `user_transcript` is `user-transcript.committed` — each carrying a `meta` envelope with a stable id, and the `history` client command is gone: a reconnecting client no longer pushes its own memory back, because the server restores from its own retained stream. `ServerMessage` and `ClientMessage` remain as aliases of the schemas that now declare the two unions, `SessionEventSchema` and `SessionCommandSchema`. `agent({ events })` is the new authoring surface over that stream: a handler per event type plus a `"*"` catch-all, observe-only, non-fatal on throw, keyed on `meta.id` for at-least-once delivery — the first time an agent author could observe their own agent at all. `SessionEventHandlers`, `SessionEventHandler` and `SessionEventContext` are exported from the root, so a handler extracted out of the object literal into a function of its own has a type to name.

### Minor Changes

- d81c752: Workflow apps can take a FILE. `POST /workflows/uploads` stores one, `readUpload` reads a byte window of it from inside a `"use step"` function, and `workflow({ uploads })` is what makes a form render a picker and store the file before the run starts — a run's input is journaled and replayed, so bytes may never travel in it. Steps also narrate now: `report()` writes to the run's stream AND the server log, with the attempt number appended past the first, and `isTransientStatus`/`retryAfter` let a rate-limited step retry when the provider asked to be called back.
- 3df649f: Add `stepFetch`/`multipartBody` — a step's HTTP, pinned to HTTP/1.1. Node's `fetch` offers h2 in ALPN, so a workflow fan-out multiplexes every concurrent request onto one connection: measured at 8 concurrent 17.66 MB uploads it lost 2 of 16 to NGHTTP2 stream resets at p50 8094ms, against 16 of 16 at p50 3037ms over HTTP/1.1. A reset carries no HTTP status, so `isTransientStatus`/`retryAfter` cannot classify it and a bounded batch retries in lockstep until the run dies. `stepGenerate` routes through it, `StepTransportError` names the whole cause chain, and `stubStepFetch` (`/testing`) is how a spec answers it.
- 263d86a: Wake durable workflow runs whose sandbox has exited: guests publish the earliest time their queue needs a process, and the platform boots one when it comes due.
- b5fdd60: Replace three hand-rolled parsers with the libraries already in the tree: the workflow run event stream now parses with `eventsource-parser` (the parser aai-studio-client already uses, and a transitive dependency besides), `web_search` extracts DuckDuckGo results with `htmlparser2` instead of six regexes, and tool-call argument salvage repairs with `jsonrepair` in place of a hand-written control-character escaper and fence regex.
  
  This fixes three silent failures. A CRLF event stream parsed as zero frames, so every workflow run fell back to polling; `web_search` dropped results whose markup used single quotes and could lift `<script>` text into a description; and tool-call arguments with an unquoted key were handed to the tool as an EMPTY object, reported as success, because `parsePartialJson` calls that a repaired parse. Repairing now also covers single-quoted strings, unquoted keys, Python `None`/`True`/`False`, comments, and fences that are not anchored to the whole payload.
  
  The `entities` dependency is removed from `@alexkroman1/aai` — htmlparser2 decodes text and attributes itself.
- 8c3c835: Extract the step-authoring helpers the workflow templates had duplicated: `@alexkroman1/aai/step-errors` (`toStepError`/`throwStepError`/`throwFatalStepError`) turns a Response or a StepGenerateError into the FatalError/RetryableError the Workflow DevKit reads — and reads the retryAfter the gateway already reported, which nothing did before; `stepGenerateJson` on /utils asks a model for JSON and validates it against a Standard Schema; and `stubGateway` on /testing is the fake LLM gateway for testing a step that calls one.
- e923c72: `system-prompt.md` beside `agent.ts` IS the system prompt. The build discovers it, so an agent declares no `systemPrompt` and writes no import — a prompt is markdown, and inline it becomes that document spelled as escaped newlines inside one string literal, which diffs as a single line no matter which bullet changed. Declaring a DIFFERENT prompt while the file sits unread is a build error, because "I edited the prompt and nothing changed" is the silent-absence failure tool discovery exists to kill, pointing the other way; an empty file is an error too. Composing stays legal and is the one case you write the import — the build sees its own text inside your prompt and leaves what you built alone. `greeting` and `sttPrompt` stay fields: a document goes in a file, a value stays in the call.
- 8cf6ffa: Publish the workflow HTTP API's client as `@alexkroman1/aai/workflow-api`.
  
  `createWorkflowApiClient({ baseUrl, token?, timeoutMs? })` is one implementation of
  all ten routes — `streamOutput` and `wake` included — that the browser client,
  `aai workflow` and the studio's Workflows card had each written a different subset
  of — disagreeing on whether a 404 from `GET /runs/:id` is an answer, whether an
  absent `limit` is encoded, and whether the agent's own `{ error }` sentence is
  unwrapped or reported still wrapped in its JSON.
  `timeoutMs` is new to all three: a per-request deadline that exempts the event
  stream and adds a waiting read's own `wait` budget on top of itself.
  
  `WORKFLOW_API_PREFIX` is declared beside the client so the server, the `aai dev`
  proxy table and the client all resolve one literal; `@alexkroman1/aai-runtime`
  re-exports it unchanged.
  
  `createWorkflowApi` in `@alexkroman1/aai-ui` is now a wrapper that supplies the
  page's own base URL, and its public surface is unchanged — `WorkflowApi` is
  re-exported from the SDK rather than declared, so a client from either factory is
  the same type (`aai-ui:workflow` epoch 5, epochs 1-4 retained).
  
  Two message changes: a failure whose body is not the API's `{ error }` shape is now
  labelled (`Workflow API 502: <html>` rather than `502: <html>`), and
  `aai workflow show` reports `No run <id>` for a 404 instead of the agent's
  sentence, which cannot distinguish an unknown id from an agent that serves no
  workflow API.
- 0f7c4da: Export registerSttKind/registerTtsKind (plus OpenerRegistryEntry, SttOpener, TtsOpener) from @alexkroman1/aai-runtime: the speech-stage substitution seam a host application needs to drive a real pipeline session with faked STT and TTS. SttOpener and TtsOpener lose their @internal tags, being that seam's parameter type.
- d5667c4: workflow() no longer throws when its body carries no compiler workflowId; the check moved to ctx.workflows.start, where the id is needed. A declaration-time throw made an agent module unimportable wherever the Workflow DevKit transform had not run — including its own unit tests.
- 0f7c4da: Add ctx.workflows.publicWebhookUrl(token) — the PUBLIC callback URL a durable run hands a third party, built from a new publicUrl option on createRuntime/createAgentServer. The Workflow DevKit's own hook.url is composed from getWorkflowMetadata().url, which is http://localhost:<port> off the running process, so a deployed agent was handing out the inside of a sandbox that has self-exited by the time the callback arrives. Unconfigured, the accessor throws naming the option rather than minting a localhost URL that fails days later at somebody else's server.
- f086dfe: Add mapInBatches, the replay-safe bounded fan-out a workflow body needs, and let WorkflowFields resolve a workflow by name so a page no longer plumbs the listing itself.
- d2a6b0d: Add `isRecord` to `@alexkroman1/aai/utils` — a type predicate narrowing an unknown to `Record<string, unknown>`, so the `typeof v === "object" && v !== null` check no longer needs a follow-up cast to read a field. Arrays are excluded.
- 0c411f4: Ship the agent-authoring guide and an agent skill inside the package, so guidance is version-matched to the installed SDK rather than frozen at scaffold time. Adds AGENT_GUIDE.md and skills/aai/SKILL.md to the tarball.
- d764fc6: A durable run can now tell the caller it finished: `ctx.workflows.start(def, input, { notify })` makes the session that started it take an unprompted, interruptible turn built from the run's own output — the promise a voice agent used to make ("I'll let you know") with no way to keep it. Pipeline mode only; S2S has no verb for an unprompted turn and logs a no-op. Uploads now accept 2 GiB by default (`AAI_MAX_UPLOAD_BYTES` moves it) — the old 256 MB cap refused an ordinary stereo recording — and `useWorkflowRuns` renders a workflow's history so a page need not ask for a run id.
- d764fc6: research-workflow is a real deep-research pass: a brief, a planned fan-out, one researcher step per angle that searches and reads the web through the SDK's own builtins, a gap pass, then a written report. `host/ssrf.ts` no longer reads `dispatcher` off the ambient `RequestInit`, so `@alexkroman1/aai/tools` compiles in a project whose tsconfig includes the DOM lib.
- cd03641: Durable workflow steps can do real work. A `"use step"` body is handed no tool context, so until now nothing in one could authenticate an outbound call and every workflow template's I/O was a fixture. Two additions on `@alexkroman1/aai/utils` close it: `stepEnv`/`requireStepEnv` read the agent env (published by the guest at bundle load and by `aai dev` on every rebuild), and `stepGenerate` is `ctx.generate`'s counterpart for a step — one request to the AssemblyAI LLM Gateway on the agent's own key and default model, with `StepGenerateError.retryable` saying whether another attempt is worth it. All three workflow templates are real on top of them: `transcription-workflow` splits a WAV recording into chunks the sync transcription API accepts, transcribes each chunk in its own step and stitches the overlapping results together; `research-workflow` plans angles, investigates each one and writes them up; `link-digest` fetches a page and reduces it.
- 714cb82: One sleep, not six: sleep(ms, { signal, unref }) on @alexkroman1/aai/internal replaces six spellings across five packages at 22 call sites. The families differed in whether vi.useFakeTimers() could drive them — the global setTimeout can be faked, node:timers/promises cannot — so the spelling silently decided whether a poll loop was testable, and one caller had already grown an injectable seam to work around it. unref is now opt-in rather than a shared default, which surfaced a shutdown grace that could skip its own drains. Also escapes a raw NUL byte in host/workflow-notify.ts that made the file binary to git grep, exempting it from every gate in the repo.
- eb0da5f: Add testing fakes for a tool's collaborators (stubGenerate, createRunSnapshot, createProgressStream, toolOf/runTool), installStubGateway on the new @alexkroman1/aai/testing/vitest subpath, spoken-reference resolution (resolveOne, spokenDigits, spokenOrdinal) on the root, and WorkflowProgress + useUserTranscript in aai-ui.
- 5e568e0: Add `ctx.workflows.signal(token, payload?)` — deliver an answer to a durable run
  parked on `createHook({ token })`, resolving `false` when no hook holds the
  token.
  
  This is the half of the Workflow DevKit's waitpoint mechanism a voice agent
  could not reach. A run that has to wait for a PERSON — an approval, a choice, a
  "yes, go ahead" — parks on a hook, and the only way to feed one was the public
  URL `createWebhook()` mints, which is addressed to a third party with a callback
  to make rather than to the caller already on the line. `wakeUp` is not the same
  thing: it ends a pending `sleep()`, where a signal carries a payload, and a body
  that races a hook against a `sleep` — a decision with a deadline — needs both.
  
  `false` is an answer rather than a failure, matching `cancel` resolving false
  and `wakeUp` resolving `0`: the run has moved past its hook, finished, or was
  never started.
- 304347b: Fix the test review sweep: correctness and quality findings across every
  package, plus the gates that decide whether the tests mean anything.
  
  The one published behaviour change: `publishStepEnv(undefined)` now
  unpublishes the step env instead of publishing an undefined record, so a
  test teardown can restore the unpublished state. An empty record and an
  unpublished env are now distinguishable, and both are pinned.
  
  The rest is tests and repo machinery. Highlights, all of which were
  false-green before: the two flagship SSRF redirect tests made zero fetch
  calls (both were satisfied by an NXDOMAIN lookup, so redirect
  re-screening to 127.0.0.1 and 169.254.169.254 was covered by nothing);
  an SSE fuzz property called its subject zero times across 200 runs; the
  `as any` escape-hatch budget was entirely JSDoc prose because the gate
  had no comment filter; and the required CI check reported success when
  the build failed, because it omitted `setup` from its `needs` and
  accepted `skipped` as a pass.
- 50282d6: Add workflow apps: agent({ page: "static" }), the workflow HTTP API (/workflows/*), page()/createWorkflowApi()/useWorkflowRun() in the browser client, and `aai workflow` for reading and steering runs from a terminal.
- 6182917: Add workflowApp() and a workflow-app arm to AgentParams. A page: "static" agent has no session and no LLM loop, so systemPrompt, tools, maxSteps, state, syncState, the provider triple and the voice knobs were all accepted and inert on one; they are now compile errors naming the rule, and the three voice arms refuse page: "static" from their side. workflowApp({ name, workflows }) is agent() with the discriminant set, returning the same AgentDef.
- 9f74c34: Add a text session mode to the agent API, and drive the studio coding agent through it.
  
  `agent({ text: true })` declares an agent with no audio path — an LLM, a system prompt and its tools — and `createTextAgent` (`@alexkroman1/aai-runtime`) runs it over a message list, returning the AI SDK's own `streamText` result. Every other `AgentDef` field means what it means in a voice agent, so a tool runs unchanged in either; `stt`/`tts`/`s2s`, `sttPrompt` and the voice-UX knobs are compile errors on it. The mode is explicit for the same reason `s2s` is, and `createRuntime`/`createTextAgent` refuse each other's agents by name.
  
  The studio's coding agent is now such an agent rather than a hand-assembled `streamText` call, so model resolution, the keyless web builtins, the tool executor and its `ctx`, the per-call deadline, the reserved final-answer step and tool-call repair all come from the SDK. Tool-call repair gained the studio's cheap JSON-salvage tier, which now benefits the voice pipeline too, and `executeToolCall` takes a `timeoutMs`.
- 16bec88: Add `responseErrorMessage(res, label?)` to `@alexkroman1/aai/utils`: read a failed `Response`'s `{ error }` sentence — the shape every route this SDK serves answers with — falling back to the status plus a capped preview of any other body. Four callers had hand-written it, and none of the four agreed: two never unwrapped `{ error }` at all, and one dropped the body whenever it was valid JSON that was not that shape.
- 97339d9: Add a synchronous wait mode to the workflow HTTP API, and form components for workflow apps.
  
  `POST /workflows/runs` accepts a `wait` budget and `GET /workflows/runs/:id` a `?wait=` query: the request is answered when the run reaches a terminal status or when the budget expires, whichever is first. An expired budget answers the running snapshot at 202 rather than an error, so waiting degrades to the asynchronous behaviour that was already there. On the client this is `api.startAndWait()` and `api.get(runId, { wait })`.
  
  aai-ui gains `Form` and its field components (`TextField`, `NumberField`, `TextAreaField`, `SelectField`, `CheckboxField`, `FileField`, `SubmitButton`, `Field`), `WorkflowFields` — one control per scalar property of a workflow's declared input schema — and the `useWorkflows` / `useWorkflowSubmit` hooks.
  
  The `transcription-workflow` template is now a workflow app: an upload form over a run that parks on `createWebhook()` and fans out over what the callback delivered.
- c48f243: Default the AssemblyAI LLM Gateway model to qwen3-next-80b-a3b (was gpt-5.6-terra). qwen is outside TOOLS_REQUIRE_NO_REASONING, so a bare assemblyAILlm() no longer carries an implicit reasoningEffort none and sends no reasoning_effort at all; the default pipeline is unchanged because assemblyAIPipeline() passes it explicitly.
- d5667c4: Add durable workflows built on the Vercel Workflow Development Kit: workflow() declares a schema, description and a "use workflow" body, and ctx.workflows starts and inspects runs. Correlation keys (start(wf, input, { key })) are indexed by the SDK so a voice agent can find a run again after the session that started it is gone.
- e4fd8c5: Durable runs gain two capabilities the Workflow DevKit already had and this SDK did not expose, plus a gateway fix.
  
  `ctx.workflows.wakeUp(runId, options?)` interrupts a run's pending `sleep()` calls and reports how many it ended, so "send it now" stops being the same button as `cancel`. `ctx.workflows.stream(runId, options?)` reads what a run has WRITTEN through `getWritable()` — the only way a long run can report progress, since a snapshot carries a status and, once terminal, an output, and nothing in between — and `ctx.workflows.streamTail(runId, options?)` says how far that stream currently goes. All three are served over HTTP too (`POST /workflows/runs/:id/wake`, `GET /workflows/runs/:id/stream`) and reachable from a page through `api.wake()` / `api.streamOutput()`; the platform already proxies both verbs, so no deployment change is needed. `research-workflow` is the worked example for each.
  
  `streamTail` is what makes reading a progress stream terminate, and it is not an optimization. A workflow stream reports its end only once CLOSED, and a progress channel written by one step after another is never closed — no step knows it is the last one — so a reader that waits for the end waits forever, *including on a finished run*. Every reader here bounds itself by the tail instead: the HTTP route serves the chunks that existed when the request arrived and then ends, reporting on its `done` frame whether the RUN was terminal.
  
  `useWorkflowProgress(runId)` is the browser half, and the sibling of `useWorkflowRun`: that hook reports where a run got to, this one reports what it said. Because each read is bounded, it re-opens from the index it reached until a read comes back complete — a cheap poll, since a quiet run answers with a bare `done` rather than the whole log again. `supported` goes false when the agent serves no stream at all, which is what lets a page hide the section rather than wait forever on something absent, and chunks replay, so a reload mid-run catches up. Both page templates now render progress (`link-digest` the newest line, `transcription-workflow` the whole log) and `link-digest` grows a "File it now" button over `wake`.
  
  `createStubWorkflows()` joins `@alexkroman1/aai/testing`: a complete `ctx.workflows` whose unstubbed methods reject by name. A hand-written stub of an eight-method client is a type assertion, which keeps compiling when the client gains a method and leaves it missing at runtime — which is exactly what these two additions surfaced in two shipped templates.
  
  The AssemblyAI LLM Gateway's Gemini tool-schema repair is now `transformParams` middleware instead of a `fetch` wrapper. It used to parse and re-serialize every request body containing `"tools"` — the whole conversation, on every step of every turn — to delete two keywords from the tool schemas near the end of it. Middleware is handed those schemas as structured parameters before anything is serialized. The gateway's response-side repairs stay in the `fetch` wrapper, where bytes are genuinely the only place to catch them.

### Patch Changes

- 4afb67c: Fix two durability bugs found by the turn/workflow durability audit.
  
  **The Postgres workflow world never started.** `@workflow/world-postgres`'s
  `setupDatabase` puts its `process.exit(0)` inside its own `try`, so the
  `process.exit` stand-in's throw landed in that function's own `catch`, which
  reported the migration as failed and exited 1 — every SUCCESSFUL migration read
  as `exit 1`. The caller then threw before `getWorld().start?.()`, so a booting
  guest never subscribed its queue and never ran `reenqueueActiveRuns`: a run
  parked in a `sleep` or on a webhook was not picked up when its guest was woken,
  and the orphaned-lock sweep was dead code on every boot. Runs started in the same
  process still dispatched, which is why it went unnoticed. The stand-in now keeps
  the FIRST exit code — a second `exit` is the CLI reacting to our own
  interception.
  
  **The session-state size cap counted UTF-16 code units against a byte budget.**
  `json.length > MAX_SESSION_STATE_BYTES` let multi-byte content through at up to
  ~3x its real size — a slot the cap read as under 1 MiB writing 3 MiB into the
  tenant's own schema, with the log naming the wrong number `bytes`. Now
  `Buffer.byteLength`, the rule `_fetch-capped.ts` already states. Slots holding
  CJK or emoji within ~3x of the cap that previously stored will now be refused and
  reported, which is the cap doing what it documents.
- 9fe4d07: Remove duplication between the agent and workflow subsystems: share one JSON/500 responder across both HTTP surfaces, bound workflow run listings with mapInBatches instead of an unbounded Promise.all, and give both workflow Postgres stores one create-table memo that no longer caches a failure as done.
- a9497a3: Clear orphaned workflow queue locks at startup. A hard-killed process (or one whose Postgres died) left its in-flight steps `locked_by` graphile-worker pool workers that no longer exist, and `get_job` selects on `is_available = true` — so the replacement pool polled straight past them and recovery waited on graphile-worker's four-hour reclaim, with the run sitting `running` and a page showing "Working…" indefinitely. One kill was enough. The world now clears those locks between its migration and the runner starting, gated on a session advisory lock so it only ever runs when no other pool is alive: unlocking a job a live worker is executing would run that step twice, which is worse than the wedge.
- d325a71: Fix workflow run listings and let a workflow app run without a provider credential. `ctx.workflows.recent()` (and `GET /workflows/runs` with no key, and `aai workflow runs`) filtered the DevKit's run store by the declared workflow name where it stores the compiler's identifier, so it reported no runs for every workflow; run snapshots reported that identifier as their `workflow` instead of the declared key. An agent with `page: "static"` no longer requires a provider credential it never dials — it was demanding an AssemblyAI key, which stopped `aai dev` from starting a workflow app at all.
- a9497a3: Stop the workflow HTTP API answering 400 with raw internal errors. `POST /workflows/runs` and `GET /workflows/runs` wrapped their whole engine call in a catch that returned the error text at 400, so a database outage answered a form submission with the connection string (`connect ECONNREFUSED host:port`) and a run listing with its full SQL statement — on a surface that is unauthenticated unless AAI_WORKFLOW_API_TOKEN is set, and with a status that tells clients not to retry. Caller mistakes (an unknown workflow name, input failing the schema) now throw a distinct type and keep their 400 and their message; everything else reaches the router, which logs the cause and answers an opaque 500.
- 49ac025: Install a studio workspace's own package.json dependencies before building it.
  
  A workspace's declared runtime dependencies only existed on disk as a side
  effect of `add_dependency` having run in that exact directory, so they were
  lost whenever the directory was rebuilt: `materializeWorkspace` opens with
  `rm -rf` (session refresh, replica takeover), and Publish builds a fresh
  directory from the store snapshot. Because the worker bundle is built with
  `noExternal`, the absent package was not externalized but a hard build failure
  naming a dependency the manifest plainly declares — so an agent could test fine
  and then fail to publish, and a project pushed from a laptop could not build at
  all. `npm install --omit=dev` now runs in the workspace whenever something it
  declares is missing.
  
  That is viable because the workspace manifest no longer declares the platform's
  own packages. It used to pin them so they could be read, and npm reifies
  whatever manifest it reads — so every install re-fetched the whole SDK tree.
  Dropping them takes adding one package from 25s/156 MB to 451ms/28 KB, takes
  `add_dependency` from 28s/202 MB to 3.8s/28 MB, and retires
  `reconcileWorkspacePins`, whose only job was keeping those pins fresh. Both
  readers the declaration served are covered elsewhere: the studio prompt lists
  what is preinstalled, and `aai pull` fills the manifest in per entry from the
  scaffold.
  
  Also: `Cannot find module` (TS2307) now carries a hint pointing at
  `add_dependency`, and the guest no longer syncs package-manager lockfiles into
  the project — `npm install` leaves a ~100 KB `package-lock.json` that was the
  bulk of every turn's sync payload and landed in pnpm projects via `aai pull`.
- f037d0b: `sttPrompt` defaults to empty again — contextual biasing stays opt-in in both session modes. The generic spelled-identifier default (added after the last release, never shipped) is reverted: its measured FDB-v3 win does not transfer to a line whose callers never spell anything, where the same prose biases the transcript toward alphanumeric codes that were never said. Only the agent author knows the vocabulary, so only they can set a prompt that helps — `DEFAULT_STT_PROMPT` documents what an effective one looks like.
- 8ecbe38: Update dependencies, and fix the scaffold manifest a release would have shipped
  unusable.
  
  `aai init` writes `packages/aai-templates/scaffold/package.json` into every new
  project, and it is bundled into the `@alexkroman1/aai-cli` tarball to do it.
  `scripts/sync-scaffold-versions.mjs` keeps it matching the workspace — and since
  shared versions moved into the pnpm catalog, it had been copying the literal
  `"catalog:"` into that manifest instead of the range the catalog holds. `catalog:`
  is a pnpm workspace protocol with no meaning to npm, so the next release to run
  it would have shipped a scaffold that cannot install, failing `aai init` at its
  own install step. It resolves the catalog now, refuses any workspace protocol
  left in the shipped manifest, and `pnpm check:scaffold` runs in `pnpm check` and
  CI — previously the only thing that ran the script at all was the release.
  
  Dependency updates: the six `@ai-sdk/*` providers, `ai` 7.0.62, `assemblyai`,
  `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`, `undici`,
  `ws`, `hono`, `@hono/node-server`, the three `@supabase/*` clients, `vite` 8.2.1,
  and the React type packages; `eventsource-parser` 4, `htmlparser2` 12, and
  `jsdom` 30 across the majors.
  
  `ctx.generate`'s structured-output path moved from the AI SDK's `generateObject`,
  which `ai` 7.0.62 deprecates, to `generateText` with an `output` setting. The
  resolved object and the `{ text, object }` result are unchanged; a generation
  that produces no parsable object now surfaces the SDK's `NoOutputGeneratedError`
  rather than `NoObjectGeneratedError`.
- 742bebf: One spelling for splitting a request target, and it is the correct one. `req.url` was cut three different ways at fourteen sites, and the most common of the three — `split("?")[1]` — keeps only the segment between the first and second question mark, so a query value carrying a literal `?` was silently truncated. `requestPath`/`requestQuery` on `@alexkroman1/aai/internal` replace all of them, along with the four different dead `?? "/"` fallbacks that only ever existed to satisfy `noUncheckedIndexedAccess`. The workflow API's two SSE routes also share one header block and one frame encoder instead of byte-identical copies.

## 5.14.0

### Minor Changes

- df41665: Add a telephony front door: agents now serve `WS /phone` for carrier media streams (Twilio, Telnyx), so a phone call runs as an ordinary session on the existing turn-taking, barge-in and pacing stack. Includes G.711 mu-law transcoding and anti-aliased sample-rate conversion at the edge.
- 24e8178: Extract five patterns the templates had each re-implemented into the SDK, and
  convert the templates to them.

  - `sessionSlot(key, create, { after? })` (root export) — a typed named slot
    inside `ctx.state`, with `get`/`set`/`reset`, `read`/`projection` for the
    `syncState` side, and `update` for a serialized mutation. Every stateful
    template declared its own `type StateSlot = { x?: T }` and a
    `ctx.state as StateSlot` cast with a lazy `??=` init; a slot moves that
    narrowing into one seam, and `SlotStateOf<typeof slot>` is the one spelling of
    the state type.

    `slot.update(ctx, mutate)` holds a per-slot, per-session lock for the mutation
    and then runs the optional `after` hook — the shape dispatch-center and retail
    had each hand-rolled as `createKeyedLock()` plus
    `withLock(lock, ctx.sessionId, () => mutator(slot.get(ctx)))`, with
    dispatch-center's copy additionally pruning and recalculating afterwards. It is
    NOT re-entrant, and `after` does not run when the mutator throws; both are
    documented on the method. `createKeyedLock`/`withLock` stay public for
    serialized work that is not a slot mutation (and for `timeoutMs`, which
    `update` has no equivalent for), and are now allowlisted as unexercised by any
    template.

  - `ToolFailure` / `isToolFailure` (root + `/utils`) — the `{ error: string }`
    shape tools return for a recoverable failure, and the guard that narrows a
    propagated one. Distinct from `toolError`, which returns the host's
    pre-serialized wire string; its doc now says so.
  - `pushCapped(list, item, max)` (root + `/utils`) — append to a `ctx.state`
    list holding a cap, in place.
  - `@alexkroman1/aai/testing` — a new subpath exporting `createToolContext` and
    `createUnusedDb` for testing a tool's `execute` in isolation. Replaces the
    hand-rolled `{ … } as unknown as ToolContext` stub, which omits fields and
    stops reporting when one is added.
  - `useAgentState(fallback)` (`@alexkroman1/aai-ui`) — a new overload returning
    the fallback instead of `null` before the first push, so a client that
    supplies the empty projection needs no branch for that frame. The no-argument
    overload is unchanged.
  - `AutoScroll` (`@alexkroman1/aai-ui`) — the stick-to-bottom scroll container
    `MessageList` already used, exported for clients that render their own chat
    chrome. Replaces a `scrollIntoView` effect, which fights a reader who scrolls
    up and misses growth that is not a new message.

  Also fixes an unbounded `ctx.state` list in the `infocom-adventure` template:
  its command history was appended to on every move and never capped.

## 5.13.2

## 5.13.1

### Patch Changes

- 7e92c96: Fix two silent-default footguns: ctx.state is now one memoized object per session even when the agent declares no state factory (writes were discarded on every tool call, and syncState projected an empty object), and agent() no longer lets a spread key whose value is undefined clobber the greeting, systemPrompt and maxSteps defaults.

## 5.13.0

### Minor Changes

- cdc8e54: Close four places where the SDK's types contradicted its own runtime.

  - **`sttPrompt` is now declarable on an S2S agent.** The transport has forwarded
    it as `input.transcription_prompt` since the S2S dropped-field fix, and
    `AgentDef.sttPrompt` documents it as honoured in both modes, but
    `PipelineOnlyField` still listed it — so `agent({ s2s, sttPrompt })` was a
    compile error naming a rule that was no longer true, and the measured win (a
    spelled first name going from 1 of 6 attempts correct to 6 of 6) was reachable
    only by skipping `agent()` for a raw config object. Purely widening; no
    existing agent changes behaviour.

  - **`ctx.generate({ schema })` now types `object` as required.** The host runs
    `generateObject` and returns `{ text, object }` unconditionally on that path,
    but the optionality survived the typed overload, so the one spelling the
    overload exists to reward needed a `!` or an `if` before any field could be
    read. `GenerateResult` is now text-only (with `object?: unknown` for plain
    JSON Schema calls) and a Standard Schema call returns the new
    `GenerateObjectResult<T>`.

  - **`ctx.signal` is now non-optional.** The executor builds a per-call
    `AbortController` on every path and no context has ever lacked one, so the `?`
    only bought a `?.` on every `ctx.signal.aborted`. Contexts that genuinely
    cannot cancel supply a signal that never aborts. **Migration:** code that
    hand-builds a `ToolContext` (test mocks, almost exclusively) must add
    `signal: new AbortController().signal`; consuming `ctx.signal` needs no change.

  - **`assemblyAIS2s()` takes `{ voice, languages, keyterms }`.** It previously
    took no options at all, so an AssemblyAI S2S agent could not pick its voice
    and could not reach `input.language_codes` or `input.keyterms` — the pipeline
    had all three. Each is forwarded only when set; leaving `languages` unset
    still means "detect per turn", and a malformed stored value is dropped rather
    than put on the wire. The accepted voice set is the service's and is not
    verified here — an id it rejects arrives in-band after connect, leaving an
    agent that reports ready and never speaks.

- db4b0fb: Add createKeyedLock/withLock to the public SDK: a per-key async serializer for agents whose tools mutate shared ctx.state, which the LLM loop runs concurrently. Exported from the root and /utils.

### Patch Changes

- 5cfe26b: New Conversation now replays the agent's greeting. A client `reset` discarded the conversation but never reopened one: the pipeline transport greeted only at session start, so every conversation after the first began on silence. `reset()` now queues the greeting turn after clearing history, and a reset on a closed socket redials as a fresh session instead of resuming (a resume carries `?sessionId=`/`resume=1`, which keeps the server's history and suppresses the greeting).
- 90e5c15: Add `omitUndefined()` to `@alexkroman1/aai/utils` — the one way to build the optional half of an object under `exactOptionalPropertyTypes`, replacing 41 hand-written `...(x !== undefined ? { x } : {})` spreads. Also annotates `StartScreen`'s return type, so the published declarations no longer carry an inferred union leaking React's `JSXElementConstructor`.
- ce45435: Speak alphanumeric identifiers one character at a time end to end. "Speak phone numbers and codes digit by digit" was followed only halfway: measured against Full-Duplex-Bench audio, the agent wrote `ABC123`, `two K2` and `DELIV`, which TTS then rendered as "ABC one hundred twenty three", "2K2" and "Delive" — a caller cannot tell "123" from "one two three", and a quantity abutting a product code becomes one unsayable token. With the rule the same five utterances produce `two of K-two` and `D-E-L-I-V`, and transcribing the agent's own audio back shows the caller now hears `2 of K2` rather than `2K2`, and `Deliv` rather than `Dulif`.

  Also quote money and counts from the tool-result field that holds them rather than computing them, and fix `firstPartMs` in the per-turn LLM trace so it times the model's first content part instead of the AI SDK's synchronous `start`/`start-step` parts — it reported 0-2 ms on every real turn, hiding time-to-first-token entirely, and now reports a p50 of 799 ms on the same turns.

- cdc8e54: Correct the `builtinTools` default in the docs, and make it checkable.

  `DEFAULT_BUILTIN_TOOLS` has been empty for some time, but `AgentDef.builtinTools`
  still described a four-tool "cognitive set" default — contradicting the
  `BuiltinTool` doc in the same file, the SDK guide, and the scaffold guide
  shipped into every `aai init` project, which marked four built-ins "on by
  default". Unset enables none; `[]` and omitting the field mean the same thing.

  Nothing could catch the drift: the constant was annotated `readonly
BuiltinTool[]`, which erased the type-level fact that it is empty, and its only
  assertion was an `arrayContaining` spread that is vacuously true for an empty
  array. It is now `as const satisfies` with an equality test.

## 5.12.0

### Minor Changes

- c49f501: Add the @alexkroman1/aai/workspace-files subpath: the walk, caps, skip rules and strict UTF-8 decode that define a studio workspace on disk. The CLI's push, the studio guest's end-of-turn sync and the platform's validation now read one definition instead of three copies that had to agree.
- c49f501: Add the `@alexkroman1/aai/slugify` subpath (`slugifyName`) — one normalization of a human name into the platform slug grammar, shared by the CLI, the platform server, and the studio. The CLI's directory-derived project name previously used a hand-rolled regex, so `Café Ordering/` pushed as `caf-ordering` where the studio produced `cafe-ordering`.
- 348fa16: Add linkConfirmationCode to the /utils subpath: the aai login confirmation code, previously derived identically in aai-cli and the studio client. Providers build their session shell through createSttSessionShell / createTtsSessionShell, so the per-stage cleanCloseIsFatal invariant lives in one place. aai deploy drops the inert --allow-missing-secrets flag; missing provider credentials always warn.

### Patch Changes

- db3fb48: Make the SSRF DNS resolver injectable so the DNS-rebinding defense can be tested for what it does rather than for what the test host's resolver answers.
- db3fb48: Stop publishing the s2s-transport connectS2s spy seam from the runtime barrel: a mutable test-patch object was part of the public API and could be overwritten process-wide.
- a91c3bc: Split the pipeline transport's session lifecycle (provider open, greeting, provider-error teardown, stop) into pipeline-transport-lifecycle.ts, keeping pipeline-transport.ts to turn orchestration. No behaviour change.
- db3fb48: Recognise the S2S reply.content_part.started/done bracket frames. The service sends them around every reply; absent from the message union each took the unrecognised path and logged a warning, burying the one signal that says a frame the service really sends is going unhandled.
- db3fb48: Extract the SSRF DNS pin (address plus family) into a testable helper; no behaviour change.

## 5.11.0

### Patch Changes

- e8d5e15: Share the provider registries' options() narrowing seam and drop three redundant WebSocket close casts; read and write studio project files concurrently in push/pull.

## 5.10.1

## 5.10.0

### Minor Changes

- b125465: Require `reasoning_effort: "none"` on the `gpt-5.6` gateway models so their tool calls work. Those models reject a tool-carrying request at any other effort — including the server-side default, i.e. sending no `reasoning_effort` at all — and streaming reports that as a bare 500 with the explanation stripped, so an agent selecting one failed on every turn while reading as a gateway outage. `TOOLS_REQUIRE_NO_REASONING` makes the factory fill in `"none"` for those ids, covering the bare factory, the model-id string shorthand, and an explicit `model`; an explicit `reasoningEffort` is still honoured.
- 1731876: Make S2S a provider registry like STT/TTS/LLM: credential derivation, the withHostCredentialFallback allowlist, and transport dispatch now share one `S2S_REGISTRY` instead of three hand-written kind comparisons that disagreed on unknown kinds. S2S descriptors also honour `apiKeyEnv` per-stage overrides, and each S2S module exports its own `*_API_KEY_ENV` constant.
- 4b6e064: The default AssemblyAI pipeline now sends `reasoningEffort: "none"` — on a voice line, time-to-first-token is the quality, and nothing downstream can cover the wait before the first token.
- b125465: Turn preemptive generation ON by default: a high-confidence STT interim starts the reply and the committed final adopts that running stream. Still unmeasured — what makes it safe is structural (a speculation never speaks, never executes a tool, never enters history), so the worst case is one wasted LLM request and a turn identical to the old path. Set preemptiveGeneration: false to opt out.
- fb7b545: Add `assemblyAIStt({ streamingUrl })` to override the STT streaming endpoint (staging clusters, A/B against the default host). Takes precedence over `region`.
- c7617df: Add per-stage endpoint and credential overrides for the AssemblyAI stages, and make aai dev file watching opt-in. assemblyAITts gains host, assemblyAILlm gains gatewayUrl (winning over region, as assemblyAIStt streamingUrl already does over its own), and all three AssemblyAI descriptors accept apiKeyEnv to name the env var holding that stage's credential. The keys are strictly environment-scoped — measured, a production key is rejected by the sandbox STT cluster with 1008 and a staging key is rejected by production STT and TTS — so running one stage against a staging cluster needs both credentials live at once, which the single shared ASSEMBLYAI_API_KEY could not express. apiKeyEnv names a variable rather than carrying a key, so descriptors stay secret-free and serializable. Separately, aai dev no longer watches for file changes unless AAI_DEV_WATCH=1: a restart ends in-flight voice sessions, so a stray save during a long benchmark run surfaced as a provider failure several records deep.
- b125465: Collapse false-interruption recovery onto the utterance-idle signal: `falseInterruptionTimeoutMs` (a number that never governed the wait) becomes `resumeFalseInterruption` (boolean, default true), and the resume fires when the transcript stream goes quiet with no committed final.
- b125465: Replace `holdPhrase` with `deadAirCoverMs`, and turn the dead-air cover ON by default. Two audible changes. (1) The cover had no enable of its own — it was gated on `holdPhrase.length > 0`, and `holdPhrase` defaulted to `""`, so no default pipeline agent had any dead-air cover at all. It is now its own knob, defaulting to 5000 ms; a turn that sends nothing to the caller for that long hears a short filler (a distinct opening phrase before the model has said anything, then a cycled one), and `deadAirCoverMs: 0` disables it. (2) The per-turn holding line is gone, from both the transport and the default prompt: it fired at t=0 on the turn's shape rather than on real silence, and the prompt rule that produced it drove filler-opening replies to 29% of turns. Cover now waits for measured silence, so a turn that answers promptly pays nothing, and the filler never enters history. `holdPhrase` is removed from `agent()`; an already-deployed config carrying it is ignored.
- b125465: Default the pipeline LLM to gpt-5.6-luna (was gpt-5.5). It is $1/$6 per M against gpt-5.5's $5/$30 and p50 832ms vs 999ms time-to-first-token over 18 paired tool-calling turns with reasoning off on both. Because luna is in TOOLS_REQUIRE_NO_REASONING, the bare assemblyAILlm() now carries an implicit reasoningEffort: "none" — that value is a tool-calling requirement on the gpt-5.6 models, not a tuning knob. assemblyAIPipeline()'s explicit "none" stays: it agrees with the factory on this id but is the only latency guarantee under a default outside that set, and define.test.ts pins the effort and the model id together.
- 4b6e064: Split AssemblyAI endpointing into min/max_turn_silence and stop the dead-air cover firing on ordinary tool turns. min_turn_silence had been raised 1500 -> 2000 -> 3000 to stop utterances splitting, but max_turn_silence was never set and sat at the service default 1536 — so from 2000 on the minimum exceeded the maximum, the completeness check could never fire, and every turn ended on the content-blind acoustic force-end that splits utterances in the first place. Both halves are now always sent (1600 / 3500), assemblyAIStt takes maxTurnSilenceMs, and a test pins min < max. Separately, DEFAULT_DEAD_AIR_COVER_MS moves 2000 -> 5000 (it sat under the 6.24s mean tool turn and fired on 93% of them) and the cover phrases are reworded to be purely declarative, because 'Still working on that.' reads as a request for patience and callers answer it.

  The minimum is 1600 rather than 1000 on measurement: at 1000, tau2-bench retail regressed DB reward 1.00 -> 0.40 while NL assertions rose 0.60 -> 0.80 — the agent talked better and acted worse, authenticating against spelled names truncated mid-entity. Pauses inside a single failing utterance ran 856-1455ms; nine of eighteen cleared 1000 and none cleared 1536.

- b125465: Close the playback loop, fix the dead-air cover, and default preemptive generation off

  Four changes to the pipeline transport, each measured on tau2-bench retail:

  - **`playback_progress` (new client->server frame).** The host modelled
    playback open-loop — every forwarded chunk assumed to start playing on
    arrival at exactly 1.0x — so a client draining slower accrued a backlog it
    could not see, and then released `speech_started` over speech the caller
    had not heard. Clients that discard buffered audio on that edge lost ~35s
    per run; with the frame it is ~2s. The clock clamps UPWARD ONLY, so a client
    that never sends it behaves exactly as before. aai-ui's playback worklet
    emits one every 500ms while audio is queued.
  - **Dead-air cover re-arm.** The `tool-call` branch re-armed the cover
    unconditionally, and `RestartableTimer.arm` clears-and-resets — so a chain
    of calls each returning inside the window pushed the deadline out forever
    and the cover never fired at all. Now only armed when none is pending.
  - **`preemptiveGeneration` defaults to false.** Finally measured: 14
    adoptions bought a p50 0.44s head start, but 36% were poisoned after
    adoption by a tool call and restarted the turn, having burned p50 0.69s
    first. Net +8ms per caller turn for 44% of its LLM requests discarded.
  - **Endpointing back to the measured 1600/3500 pair** (the 3000 trim was never
    measured alone and its own doc named the revert condition, which a run then
    showed), with `speechIdleTimeoutMs` moved 3500 -> 4000 to keep the margin.

  Also: a per-turn LLM timing line so a stalled turn is attributable at all, and
  a system prompt that no longer contradicts itself on repeat-asks.

- b125465: Thread AssemblyAI's end_of_turn_confidence through the STT provider API: SttEvents partial/final now carry an optional SttTurnMeta whose endOfTurnConfidence is the service's 0..1 confidence that the user's turn has ended. Nothing acts on it yet; it is plumbed so a confidence-aware endpointing policy can be measured against the current time-based one. Also fixes the escape-hatch ratchet, whose 'as any' and 'as unknown as' patterns used a GNU-only word boundary that git's matcher ignores — both had been counting zero while the tree held 8 and 110.
- d8e34d8: Add `createHostServer` and let host-mode callers bring their own provider credentials — a self-hosted multi-tenant voice server that ships with no agent.

  The handshake's `host` block accepts a `credentials` record keyed by env var name (`{ ASSEMBLYAI_API_KEY: "…" }`), merged over the server's env for that connection and winning on conflict. A server can therefore hold no provider keys at all and let every session run on its caller's, so an unauthenticated caller has no operator credential to spend. Names are bounded by `ALL_PROVIDER_ENV_VARS` — the allowlist that already bounds `withHostCredentialFallback` — and an unlisted name rejects the handshake by name, since the record reaches the env the per-connection runtime is built from, where an unbounded one could set `DATABASE_URL`.

  `createHostServer` (exported from `@alexkroman1/aai-runtime`) is that server in one call: no agent, no `AAI_ALLOW_HOST` flag to remember, no credentials required. It declines plain `/websocket` sessions instead of demanding a placeholder agent and a hand-rolled runtime facade, and `defaults` carries the provider triple and any operator policy every tenant should inherit. New `examples/host-server`.

  Also corrects `buildHostAgent`'s docs: a host session with no base agent gets the default all-AssemblyAI pipeline, not the S2S path — that comment predated the pipeline-by-default flip.

  Also adds `createAgentServer` for the single-agent case — the mirror of `createHostServer`. `createRuntime` + `createServer` stay exported and unchanged (an embedder wiring `runtime.startSession(ws)` into an existing stack, or the guest harness whose runtime does not exist until the bundle arrives, still needs them), but the ordinary "I have an agent, serve it" path no longer re-states `name` and `greeting` from the agent it just passed. That duplication had a silent failure mode: omitting `greeting` raised nothing and `GET /client-config` simply served none. `decliningRuntime` is exported alongside it — the `SessionRuntime` that turns sessions away with a protocol error, previously hand-rolled in `createHostServer`.

  New `@alexkroman1/aai-ui/client-dir` subpath exports `defaultClientDir()`, the path of the prebuilt browser client, replacing the three-line `require.resolve` dance that `aai-cli`'s dev server and every self-hosted example each carried.

- 4b6e064: Add `assemblyAIStt({ languages })` to pin STT language(s) via `language_codes`. Universal-3.5 Pro code-switches across 18 languages when unset, which returns English as transliterated non-Latin script on a monolingual line.
- 4b6e064: Raise DEFAULT_MIN_TURN_SILENCE_MS 2000 -> 3000. At 2000 a hesitant utterance still split mid-sentence, and the agent answered the fragment.
- b125465: Rewrite the default system prompt as non-overlapping sections, spend the step after the tool budget on a forced final answer (so a capped turn answers with what it has instead of going silent mid-chain), and report each provider stage's effective settings at startup

### Patch Changes

- b125465: Split stopping the noise from abandoning the turn: the pipeline now ducks its outgoing audio the moment the caller speaks over it, and only a barge-in that sustains aborts the reply. An aside (a cough, "hold on a second" said to the room) is indistinguishable from a real interruption at its first partial — thresholds cannot separate them, and a stricter word gate measured -12.7 points of yield rate for no selectivity gain — but an aside STOPS and an interruption CONTINUES, so the reply resumes with nothing re-spoken. Also resumes a mid-turn barge-in from the estimated cut point rather than the [interrupted] marker, and rewrites the voice prompt around reply length: a short first sentence, a hard word budget, results instead of narrated intentions, no re-asking for the same identifier, and contractions allowed.
- b125465: Pipeline mode: hold `speech_started` back while the agent is speaking, so the event means "the user took the floor and the agent is yielding" on both transports instead of "STT saw a word". Previously any one-word partial — a cough, a backchannel, a phrase addressed to someone else in the room — announced an interruption the barge-in gates then correctly declined to make, leaving clients that act on the event (tau2-bench discards its whole agent playout buffer on it, and has no `cancelled` handler) silencing a reply the agent was still speaking.
- b125465: Trim the pipeline STT `max_turn_silence` default 3500 -> 3000 ms; `min_turn_silence` stays 1600 ms.

  This branch briefly set the pair to 800 / 1600 and reverted it on measurement, so the net change against the last release is the ceiling alone. The reverted arm is recorded because it is the strongest evidence this pair has: on tau2-bench retail (same 25 tasks, same seed, differing only in these two values) 1600 / 3500 scored reward 0.68 and 800 / 1600 scored 0.12, with splits up ~30% per utterance, merges down ~37%, and the share of mis-hearings that corrupted a tool argument nearly doubled (5.1% -> 9.8% of utterances) — the agent authenticating against truncated spelled names, exactly the failure the recorded pause measurements predicted.

  3000 keeps `max_turn_silence` below the speaking edge's idle deadline (`DEFAULT_SPEECH_IDLE_TIMEOUT_MS`, 3500) less final-emission latency, so an utterance force-ended by the ceiling still delivers its final before the edge goes idle — and the idle edge is what fires a false-interruption resume, so crossing that line lets the agent resume a reply the caller really did interrupt. It costs ~0.5s of pause tolerance for hesitant speech against 3500 and is the one value in the pair with no measurement of its own — if splits reappear on hesitant, non-spelling utterances while spelled identifiers stay intact, put it back to 3500 (and raise the idle deadline with it).

- b125465: An interrupted reply now records only the words the caller is estimated to have heard, and a reply cut before anything was audible records nothing at all (its tool steps still do). The false-interruption resume anchor reads the same cursor, and AssemblyAI TTS word timings make it word-accurate.
- 520900f: Disable permessage-deflate on provider WebSockets. The `ws` package enables it by default on clients, so every outbound STT/TTS/S2S socket offered compression; a provider that accepted cost a zlib context per socket (+321 KiB RSS and ~4.5x CPU per socket, measured) to compress PCM16 audio, which does not compress.
- c524b76: Stop reporting recoverable voice-session errors as fatal, in both session modes, and close the provider socket when a session is retired. A fatal error frame makes the browser client release the microphone and end the call, so it must mean the session is over — but six reporters used it for conditions the session survives: S2S in-band `session.error`/`error` frames (and OpenAI Realtime's `error` event), which close nothing, and pipeline mode's three turn-level failures — an `error` part in the LLM stream, a thrown `streamText`, and a TTS flush timeout. The first two pipeline cases are the worst: the transport's next act is to speak `errorPhrase` ("Could you say that again?") and invite another turn, so the caller was asked to repeat themselves into a microphone that had just been switched off. Session death is now reported only by the paths that end the session. Two S2S leaks go with it: retiring a session now closes its socket (an in-band `session_not_found` rejection of a `session.resume` left a live provider socket relaying frames to a client already told the call was over), and `stop()` now abandons a resume handshake that has not completed, which nothing could close before.
- b125465: Remove the provisional-yield audio duck. It was built to stop the agent barging out on non-directed speech, and never earned its place: the selectivity gain stayed inside the harness's noise floor across every run, while the cost was concrete — roughly 37 false ducks per benchmark run inserting 400ms of silence mid-reply, and a re-arming backstop that deadlocked into a permanently mute agent. The speech_started gate and the cut-point resume, which came in alongside it and are independently validated, stay.
- b125465: Fix preemptive generation killing any turn whose model called a tool after the speculation was adopted. `SpeculativeStream.poisoned()` was consulted once, at the adoption instant, but the speculation is still streaming then — a `tool-call` arriving afterwards reached a tool set built by `toDeclaredTools`, which has no `execute`, so the request died with "Tool result is missing for tool call <id>" and the caller heard `errorPhrase` for a reply the model could have given. An adopted run that turns out to hold a tool call is now abandoned whole and the turn restarts with executable tools; the head start is lost but the turn works.
- ae9fd19: Pin AssemblyAI S2S sessions to the Voice Agent API's only supported sample rate (24 kHz), declare it on the wire, and reject a host-mode handshake that asks for another — a mismatch previously left the agent permanently deaf with no error.
- b125465: Put max_turn_silence back to 3500 and the default gateway model back to gpt-5.5. The 2500 ceiling was the one number in the endpointing pair with no measurement of its own — it was reasoned from a run where the minimum and maximum moved together, which cannot apportion the damage between them; 1600/3500 is the pair with a measured 0.68 on two independent runs. The ordering it protected still holds at 3500, with more margin over the false-interruption window.
- 6ca79e0: Pipeline: cover the turn's opening dead air, stop the post-cancel transcript that duplicated interrupted replies, cap the dead-air filler backoff, and defer a false-interruption resume until the caller's utterance ends
- fee8ece: Point the storage-disabled guidance at the studio's Settings → Database switch, which now enables a project's ctx.db database for both its preview and production agents.
- ae9fd19: Voice prompt fixes measured on tau2-bench: scope the tool preamble to once per TURN (not per tool call), tell the model a not-found lookup on spelled input is probably a mis-hearing, and stop the false-interruption resume restarting the sentence it was mid-way through.
- a90296e: Fix pipeline history cap orphaning a tool result: the LLM-view trim is index-based, so its boundary could split an assistant tool-call from the `tool` message answering it. Both Anthropic and OpenAI reject an unmatched tool result, so every turn past ~200 messages in a long tool-using call failed at the provider and the caller heard the error phrase instead of a reply.
- b125465: Timestamp every log line, put the STT end-of-turn confidence on the wire, and move per-interim STT logs behind AAI_DEBUG_PARTIALS. (This release also turned `holdPhrase` off by default; the field has since been removed outright in favour of `deadAirCoverMs` — see the dead-air cover entry.)
- a82e54d: Trim AssemblyAI agent_context at the documented 1500-character cap instead of 1750, so the host-side tail-preserving trim decides what to drop rather than the service.
- b125465: Default the AssemblyAI LLM Gateway model to `gpt-5.6-terra` (was `gpt-5.5`).

  `ASSEMBLYAI_LLM_DEFAULT_MODEL` is what a bare `assemblyAILlm()`, every unset stage of a partial provider triple, and `assemblyAIPipeline()` all resolve to, so this moves the default pipeline's LLM for every agent that does not name one.

  It also moves the default across `TOOLS_REQUIRE_NO_REASONING`: `gpt-5.6-terra` rejects a tool-carrying request at any effort other than `"none"` — including the model's own server-side default — so the factory now fills `reasoningEffort: "none"` for the bare descriptor where under `gpt-5.5` it filled nothing. Without that fill the descriptor would fail on every turn of every agent (`DEFAULT_BUILTIN_TOOLS` puts four tools on each one), and because the pipeline streams, the gateway's explanatory 400 arrives as a bare `{"message":"something went wrong","code":500}` — a config error wearing an outage's clothes. `assemblyAIPipeline()`'s own explicit `"none"` now agrees with the factory rather than carrying the whole weight, and stays as the backstop for the next id change.

  Terra is advertised by the gateway with tools, streaming, a 270k context and a passing liveness probe, and shares `gpt-5.6-luna`'s reasoning constraint 4/4. It has no paired latency numbers, no price comparison, and no quality run of its own — the measured case in the guide is luna's. Treat the new default as unverified on latency and quality; `assemblyAILlm({ model })` pins any catalog id.

- b125465: Split the S2S wire-message dispatch out of s2s.ts into \_s2s-dispatch.ts; S2sCallbacks moves with it and is re-exported, so no import changes
- b125465: Fix three S2S defects that left most of the agent's speech unheard, each measured
  against tau2-bench retail with a bare Voice Agent API client (no SDK) as control.

  **Host-mode audio pacing is now the client's declaration, defaulting to paced**
  (`HostConfig.audioLeadMs`: omitted = real time, a number = that lead, `null` =
  unpaced). Unpaced was the blanket default, reasoning that a programmatic client
  keeps its own clock — but being programmatic does not mean consuming faster than
  the wall clock, and only a client whose timeline runs ahead is starved by pacing.
  In S2S the service synthesises a whole reply server-side and it arrives in one
  burst (up to 1118 frames in one tau2 tick, against 205 on the pipeline
  transport), so a client draining at 1x accumulated a backlog of MINUTES — and
  tau2 discards its buffer on barge-in, so 36% of all agent audio was destroyed
  unheard (p99 181s, max 272s per barge-in on a 215s call, against 18-23% and a
  15s max for the pipeline arms). The S2S arm completed a reply for 0.53 of caller
  turns where the pipeline managed 1.00, with 18% of sessions completing none.

  **`transcript.agent.delta` is accepted.** It was left out of the S2S message
  union on a measurement saying the service never sends it; re-measured, a bare
  greeting reply emits one frame per word, and one session carried 511 frames
  across 20 replies — 5 of which sent deltas and never a final `transcript.agent`,
  116 words of agent speech otherwise unrecoverable. Those are the tool-preamble
  turns that used to render blank. The accumulation is forwarded as a partial and
  committed as the reply's transcript when a COMPLETED reply sent no final — never
  on an interrupted one, where the batch covers more than was actually spoken.

  **S2S pins Voice Focus** (`near-field` / 0.9) from the same constants the
  pipeline STT stage reads, rather than inheriting the service's 0.7. The
  interferer that matters is background speech, which only the pre-model filter can
  suppress. `turn_detection` is deliberately left unset — its default is adaptive
  and entity-aware, and pinning `min_silence` disables that for the session.

  **`sttPrompt` is honoured in S2S mode**, sent as `input.transcription_prompt`
  (trimmed to that field's documented 1750-char cap, keeping the head). It was
  pipeline-only, which made it a silent config drop: `agent({ sttPrompt })` and
  host mode's `host.sttPrompt` both reached the agent definition and only
  `pipeline-transport.ts` ever read it, so an S2S agent that set one got unbiased
  transcription with no warning. Measured on tau2-bench retail, a transcription
  prompt took the authenticating caller's spelled first name from 1 of 6 attempts
  correct to 6 of 6.

- ae9fd19: Send AssemblyAI voice_focus_threshold, defaulting to 0.9 (above the service's 0.7), so background speech stops reaching the transcript. Adds assemblyAIStt({ voiceFocusThreshold }).

## 5.9.0

## 5.8.1

## 5.8.0

### Minor Changes

- d140e9b: Add CloseableDb.reserve() for connection-affine Postgres work (advisory locks, session SET)

### Patch Changes

- d140e9b: createServer().close() drops idle keep-alive connections instead of waiting out their timers, so `aai dev` shuts down and restarts promptly. In-flight requests still finish.

## 5.7.0

### Patch Changes

- 56efab9: Stop studio Publish from claiming reserved `-preview` slugs, and refuse to derive a `-preview` project name from a directory
- 1c034af: Keep one guest sandbox per slug and per studio project across web-service replicas: a cross-replica registry lets a cold broker route to a live peer's guest instead of spawning a duplicate.

## 5.6.0

### Minor Changes

- f4ae66f: Redeploys now hand over blue-green: the agents-row change event boots the
  new deploy's sandbox and waits for its readiness before detaching the old
  resident, so a redeploy never leaves an empty slot and the next caller pays
  no cold start; old sessions drain in the background as before. The warm
  sandbox pool is deleted entirely (production always ran with it disabled):
  every spawn — agent, studio, inspect — boots directly from the published
  content-addressed harness snapshot image through one code path, and every
  sandbox is tagged with its real identity at creation. Modal sandbox memory
  snapshots slot into this single spawn path once the JS SDK exposes them.
- f4ae66f: Deployed agents now run as SERVERS — the "guest is a server" contract. The
  worker bundle (sha-256-verified in the guest) and the agent env arrive as
  files written into the sandbox before exec; readiness is the guest's public
  `/health`; and the platform's whole ongoing surface is a token-gated
  `GET /manage/status` + `POST /manage/drain` pair. No control channel exists
  on an agent sandbox: lifecycle is guest-owned (idle self-exit replaces the
  orphan timeout; a drained guest refuses new sessions and exits when empty),
  and a boot crash fails the spawn immediately with the guest's stderr. The
  JSON-RPC control channel remains for studio/inspect sandboxes only, which
  always run the current harness image. Combined with per-deploy image
  pinning, the platform↔deployed-agent contract is now an exec convention
  plus five HTTP endpoints, frozen per deploy.

### Patch Changes

- 77b0a80: Drop zero-length audio frames instead of treating them as user activity.
- 753665a: Remove latent footguns: fail-closed env parsing (PORT, SANDBOX_RETIRE_DRAIN_MS, AAI_GUEST_PORT), contained promise rejections in the host-mode handshake, guest RPC dispatch, harness listen, and studio chat body reads, pipeline provider credentials resolving from providerEnv, corrupt agent rows failing closed instead of reading as unclaimed, dead sandboxes no longer preferred by session routing, scrubbed app-db provisioning errors, refusing no-auth dev tokens alongside production config, and full numeric-entity decoding for S3 keys
- 77b0a80: Log guest stderr on boot failure, validate the resume sessionId, and stop a bundle spoofing its own deploy-time config.
- f4ae66f: ctx.db on the platform now connects directly from the guest sandbox: the
  app's own scoped Postgres credentials (role with pinned search_path,
  statement_timeout, and connection limit) are delivered as `DATABASE_URL` in
  the bundle/load env, and the bundle's runtime opens its own connection —
  exactly as `aai dev` does with a project `.env`. The host-proxied `db/query`
  RPC is removed, taking the last bundle-facing RPC out of the versioned
  harness↔bundle contract.
- f4ae66f: Stored agent configs are now opaque to the platform server. Strict config
  validation (`IsolateConfigSchema`) runs once, at deploy time, on the freshly
  extracted config; row reads assert only the fields the host consumes (`name`,
  `greeting`) and pass everything else through untouched. A future schema
  tightening can therefore never make previously-deployed agents unreadable.
- f4ae66f: Deploys are pinned to the harness snapshot image they ran against. The
  content-addressed image tag is recorded on the agents row at deploy time and
  the agent's sandboxes spawn from that image ever after, so platform upgrades
  (new harness, base image, or Node version) never change the runtime
  environment under an already-deployed bundle. Redeploying re-pins to
  current; an unresolvable pin falls back with a warning; pinned agents skip
  the warm pool.
- 8b622e8: Replace hand-rolled code with established libraries: HTML entity decoding via entities, <link> parsing via htmlparser2 (fixes entity-encoded hrefs and attribute values containing '>'), percent-decoded static asset paths in the dev server, a new internal createCoalescingRunner primitive, and use-stick-to-bottom for message-list auto-scroll (height changes no longer silently unpin the transcript).
- f4ae66f: Remove platform host mode (`?host=1` on deployed agents). The platform no
  longer runs any session in the server process: `/:slug/websocket` upgrades
  are always handshake redirects to the agent's live sandbox. This deletes the
  one path where the server's current SDK interpreted stored agent configs
  (`toRuntimeAgent`), a cross-version seam for already-deployed bundles. Host
  mode remains available under `aai dev`.
- f4ae66f: Remove the legacy descriptor-less S2S fallback in `buildTransport`. Configs
  predating the pipeline-by-default flip that reach transport construction with
  no resolved pipeline providers and no `s2s` descriptor now fail loudly with a
  clear error instead of silently running an AssemblyAI S2S session.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- 77b0a80: Reset the session idle timer on conversational activity instead of on raw audio frames, and don't auto-reconnect after an idle retirement.

## 5.5.1

### Patch Changes

- 1a6f800: Remove the S2S transcript.agent.delta accumulator: the event is documented but not implemented by the service, so the fallback could never fire. Records the measured behaviour instead — transcript.agent is omitted for both replies of a tool-call turn.

## 5.5.0

### Minor Changes

- a57905b: Pipeline provider stages are now individually optional: declare any subset of stt/llm/tts and unset stages are filled from the default all-AssemblyAI pipeline (agent({ llm: "claude-sonnet-4-6" }) swaps just the model). New top-level voice field on agent() picks the default pipeline's TTS voice (voice: "michael"), desugaring to tts: assemblyAITts({ voice }); it is a compile error alongside an explicit tts descriptor or s2s. The assemblyAIPipeline() spread is no longer needed on the golden path and remains for explicitness and region: "eu".

### Patch Changes

- 030b55f: Voice output rules now forbid contractions, and the default greeting/start-failure phrases spell them out, since TTS renders contractions poorly
- 6cca475: Remove the unused parseManifest/Manifest layer; toAgentConfig is the single config entry point (ProviderDescriptorSchema now lives in agent-config.ts; the /manifest subpath surface is unchanged).
- d303cfb: S2S: commit accumulated agent transcript deltas as the reply's final transcript when reply.done arrives without one, so the assistant turn still enters conversation history when the service omits transcript.agent (observed on tool-call follow-up replies).
- 41d53ae: Accept the S2S transcript.user.delta and transcript.agent.delta events, which were being dropped as unrecognised, and report per-reply audio/transcript accounting on reply.done so an empty reply is diagnosable

## 5.4.0

### Minor Changes

- cb2de62: Pipeline mode is now the default: an agent that declares no providers gets the all-AssemblyAI cascaded pipeline (assemblyAIPipeline()) injected at parse/config/runtime time. The S2S voice-agent API is now an explicit opt-in via the new s2s: assemblyAIS2s() descriptor (exported from the main entry and @alexkroman1/aai/s2s) — there is no longer any way to reach S2S by omission.
- 2198e2e: Vercel-idiomatic API: rename tool({ parameters }) to tool({ inputSchema }) and accept any Standard Schema convertible to JSON Schema (Zod remains the default), let ctx.generate take a Zod schema directly with a typed object result (generateObject parity), accept model-id strings for llm (creator/model via the Vercel AI Gateway, bare ids via the AssemblyAI LLM Gateway), add a system alias for systemPrompt, extend toolChoice with none and { type: 'tool', toolName }, and add InferToolInput / InferToolOutput / InferAgentState type helpers.
- 2198e2e: DX overhaul: rename the three assemblyAI stage factories to assemblyAIStt/assemblyAILlm/assemblyAITts (no aliases kept), brand provider descriptor types per stage so cross-stage assignment is a compile error, move cross-package infrastructure (createEpoch, createOwnedMap, parseWsUpgradeParams, env brands) off the root barrel onto @alexkroman1/aai/internal, drop the deprecated CustomEvent alias in aai-ui, document every public provider symbol, fix doc drift (AgentDef.llm descriptor wording, resumeSessionId persistence claim, ClientTheme defaults), add package READMEs, a real docs landing page, import-path module names in the API reference, aai templates command, and human-mode CliError hints.
- 1d76583: SDK polish: AgentParams is now a pipeline/S2S mode union — a partial stt/llm/tts triple, or s2s combined with a pipeline provider or pipeline-only tuning field, is a compile error whose message names the rule (previously these were runtime parse failures or silent no-ops). The system alias and llm model-id string shorthand now also work for raw configs that skip agent() (normalized in parseManifest/toAgentConfig). The default TTS voice is now jane (US-accented English); it was vera (UK), which put a UK accent on every agent that never chose a voice.
- 5174cb2: Curate the public API surface: internal plumbing is now tagged @internal (docs-hidden), provider barrels export every type their public signatures reference (KIND constants, Unsubscribe, AssemblyAITtsLanguage, default voices, OpenaiRealtimeVoice), the runtime barrel uses explicit named exports, aai-ui exports ClientConfig's tiers/WebSocketConstructor/Button variants and renames CustomEvent to AgentCustomEvent (deprecated alias kept), and stale doc comments are fixed (interruptionMinDurationMs and minTurnSilenceMs defaults, RuntimeOptions.fetch default, pipeline voice examples).
- aafe175: Default the AssemblyAI LLM Gateway model to gpt-5.5 (was qwen3-next-80b-a3b) and add a reasoningEffort option to the gateway LLM descriptor — unset, the model keeps its server-side reasoning default; set "none"/"minimal" to turn reasoning off

## 5.3.0

### Minor Changes

- 27c5963: Voice-agent defaults hardened against three failure modes measured across tau2-bench, EVA, and Full-Duplex-Bench v3: the agent may no longer describe an action as done without a successful tool result (EVA scored faithfulness 0.075 on claims like "your window seat is reserved" with no assign_seat call); spoken identifiers must be written in normal written form in tool arguments ("K dash 2" is K2, "Z K 3 F F W" is ZK3FFW); long tool results must be summarized rather than enumerated (30% of synthesized audio was discarded by barge-in). DEFAULT_MIN_TURN_SILENCE_MS raised 1500 -> 2000, which fixes a confirmed mid-utterance split on hesitant speech.

### Patch Changes

- 27c5963: Publish the greeting transcript once instead of twice: the fixed-phrase turns (greeting, start-failure line) reach TTS in a single call, so their interim `agent_transcript` was a byte-identical copy of the final — emitted final-first, the inverse of the documented partial-then-final order.

## 5.2.0

## 5.1.1

### Patch Changes

- b829155: Export `MAX_SLUG_LENGTH` from the shared slug contract (`@alexkroman1/aai/utils`) so callers that truncate to fit the slug shape no longer hard-code 64.
- ab577dc: Internal cleanup across the aai package: dedupe shared constants (WS_OPEN, WS_NORMAL_CLOSURE, tool User-Agent/Accept headers, default toolChoice), route JSON parsing and tool-arg coercion through the shared safeJsonParse/toArgsRecord helpers, share the TTS done-once latch between the Cartesia and Rime openers, fetch page-design stylesheets concurrently, drop the redundant web-search boundary re-scan, and fix manifest/validation drift: parseManifest no longer strips startFailurePhrase and requiredEnv, and assertPipelineTuning now covers startFailurePhrase.

## 5.1.0

### Patch Changes

- 8fb0a0d: web_search now falls back to DuckDuckGo's lite endpoint when the primary HTML endpoint returns a bot-detection challenge or HTTP error, detects the anomaly interstitial as a challenge, and sends browser-like Accept headers
- ac21a90: Close the client socket when a session hits its idle timeout. Previously session-core emitted an `idle_timeout` event and left the connection open; clients treat that event as informational and wait for a close, so the session, its provider sockets, and (on the platform) its Modal input slot were all held indefinitely.

## 5.0.1

## 5.0.0

### Major Changes

- e8fef4b: Narrow the public export surface: remove registry/wire internals from the provider barrels (ASSEMBLYAI_LLM_KIND, GATEWAY_KIND, OPENROUTER_KIND, ASSEMBLYAI_TTS_KIND, CARTESIA_KIND, RIME_KIND, gateway URLs, ASSEMBLYAI_TTS_HOST, OPENROUTER_BASE_URL, default-voice constants), EMPTY_PARAMS/ExecuteTool/SessionMode from the manifest barrel, duplicate createRuntime/Runtime/RuntimeOptions/safeFetch/RunCodeExecutor re-export paths from the runtime barrel, and the WebSocketConstructor test-seam type from aai-ui. Provider factories, their Options/Provider types, and \*\_API_KEY_ENV constants are unchanged.
- 30914c9: Remove the Vector store: ctx.vector, the vector: agent field, the @alexkroman1/aai/vector subpath (pinecone/inMemoryVector), the vector/\* guest RPC, the platform POST /:slug/vector route, and the platform-owned PINECONE_API_KEY. A future retrieval feature will be a Supabase (pgvector) store following the same path as ctx.db.
- e8fef4b: Remove the @alexkroman1/aai/patterns subpath (sequential, parallel, route, orchestrate, evaluatorOptimizer, generateStructured). The combinators had no template coverage and no known consumers; compose multi-step LLM orchestration directly over ctx.generate, converting Zod schemas with z.toJSONSchema() where structured output is needed.
- 30914c9: Guest architecture v2: the sandbox guest now runs Node (same runtime as the host and aai dev), from a harness-baked Modal snapshot image, and runs the COMPLETE agent — the harness (its own private workspace package, `aai-guest`, built into one self-contained `dist/harness.mjs`) embeds the SDK runtime and wraps the same `createServer` the dev server runs, so what executes in the guest matches `aai dev` almost exactly. Client voice sessions connect DIRECTLY to the sandbox's public `/websocket` tunnel endpoint (the same path `aai dev` serves), discovered via the `GET /:slug/client-config` broker; the platform's own `WS /:slug/websocket` serves host-mode only and answers plain upgrades with 410 + guidance. The host keeps a token-authenticated control channel (`/ws`, attached via the new `ServerOptions.upgrade` hook) for bundle loading, one-shot tool trials, the session-count probe idle eviction consults, and the guest's ctx.db proxy.

  BREAKING: `allowedHosts` and the entire per-agent egress policy are removed — `agent({ allowedHosts })` is no longer a field, and the SDK's tool-egress guard, guest-fetch-policy limits (`TOOL_FETCH_*`), and `AllowedHostsSchema` are gone. Tool code and providers `fetch` directly with open egress, identical in dev and production; the Modal container is the isolation boundary, and the network builtins keep their SSRF screen. Also removed: the NDJSON stdio transport, fetch relay, message delta protocol, heartbeat/watchdog machinery, per-call state shipping, and the host-side session relay. `RuntimeOptions.runCode` injects a real `run_code` executor (the guest supplies one; `aai dev` still refuses), and the client-config response gains an optional `sessionUrl` that aai-ui's session core re-fetches per reconnect attempt.

### Minor Changes

- c36ad60: Deploy-time credential preflight: deploys are rejected (400) when the agent's config requires a credential its stored env doesn't hold, derived from the provider descriptors plus the new optional `requiredEnv` field on `agent()`. The studio publishes with a warning instead (it has no secrets UI). `aai dev` now also warns when a required key resolved from the shell only, since it won't survive `aai deploy`.
- 9b95fc9: Type ctx.state: agent() infers the state shape from its state factory and tool() carries it, so ctx.state.foo is typed instead of unknown.
- 0c2bdbd: Add assemblyAIPipeline(), a one-call preset for the all-AssemblyAI cascaded pipeline; default the LLM gateway model; and replace the AssemblyAI TTS voice list with a checkable constant (the old doc-comment list named voices that do not exist).
- 25938b2: Extract shared concurrency primitives and adopt them across the stack: new `createEpoch` (staleness guard for async continuations) and `createOwnedMap` (map entries released by ownership token, so a stale teardown can't evict a successor's entry) exports, adopted in the host runtime's session/sink maps, the WebSocket handler, the platform slot cache, and the browser session core's generation counters. The pipeline transport's turn lifecycle (`turnController`/`turnSpoke`/`ttsAudioOpen`) is now an explicit state machine (`pipeline-turn-state.ts`) whose named transitions are the only mutation path, per-turn abort wiring uses native `AbortSignal.any` instead of the hand-rolled `linkAbort`, and the bespoke `Promise.race` timeout implementations were consolidated onto `p-timeout`.
- 293da11: `web_search` no longer requires `BRAVE_API_KEY`: it is now backed by
  DuckDuckGo's keyless HTML endpoint (scraping approach ported from
  openclaw's duckduckgo plugin, MIT). Every agent gets web search with zero
  configuration; the Brave Search implementation and its key handling are
  removed.
- 0c2bdbd: Network builtins skip the SSRF screen inside a real container; the screen stays for self-hosted runs where the host is someone's machine.
- 0c2bdbd: Generate the AssemblyAI gateway model catalog from the gateway's /v1/models endpoint, with per-model tools/stream/EU/liveness flags, and type assemblyAI({ model }) against it.
- 01cecc1: Simplify the default system prompt into a general-purpose voice agent base (speaking, listening, and tool-use fundamentals) instead of a phone customer-service/domain-policy prompt, so it works across many kinds of voice agents
- 0c2bdbd: Add agent syncState + useAgentState: the agent projects its session state and the client reads it, replacing the hand-rolled return-a-snapshot-from-every-tool pattern. Removes ToolResultMap.
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
- fdd64ef: Add snapshotSessionNotes/restoreSessionNotes to the runtime for cross-replica session resume: the platform server can now persist a disconnected session's remember/recall notes and restore them when the session resumes on another host.
- 0c2bdbd: Add @alexkroman1/aai/tools: fetchJson, visitWebpage and webSearch callable from your own tool code, with the same screening and caps the model-facing builtins get.

### Patch Changes

- 5a599b2: Route a tool's `ctx.send` and `syncState` pushes to whichever client socket currently holds the session id, rather than the one captured when the tool was dispatched. A reconnect landing mid-tool-call sent both to the superseded socket; for `syncState` the lost push also recorded the projection as delivered, leaving the resumed client stale indefinitely.
- 0c2bdbd: Stop the type gate from blocking working agents: useToolResult defaults to a permissive result type, and generated projects run strict without noImplicitAny — the implicit-any family was 57% of the diagnostics coding agents had to repair and caught no real defects.
- 6fb3bc3: Fix hot-path concurrency bugs: TTS reconnect deadline + clean-close mute + stale FlushDone pairing, session resume takeover/overlap races, host-mode handshake frame loss + per-connection runtime leak, post-stop transport events, client-cancel tool abort, drain-window barge-in classification, false-interruption resume vs committed final, S2S error-before-close and tool.result redelivery after resume, tool timeout firing ctx.signal, per-agent tool-fetch concurrency parity, sandbox teardown closing live session sockets, orchestrator re-resolve identity re-check, NDJSON/pool/cold-spawn hardening
- 55e045b: Replace hand-rolled patterns with newer Node built-ins: util.styleText instead of picocolors in the CLI (dependency removed), one-shot crypto.hash() for SHA-256 digests, node:timers/promises for the dev-server listen retry, and an async-disposable WarmHarness (Symbol.asyncDispose + await using) that unifies the sandbox teardown triple across describeBundle, configureSandbox failure paths, and the studio sandbox.
- 0c2bdbd: Strip $schema and propertyNames from tool schemas sent to the AssemblyAI LLM Gateway — without it every Gemini model 500s on any agent that has tools.
- d4c2a10: Add voice-agent prompt rules drawn from EVA's itsm voice tasks: a policy-required follow-up write (assign the tier, log the interaction) is part of the action and must happen in the same turn as the write; an unmet prerequisite becomes the job, worked in order from step one and without narrating the policy; a date, time, window, or urgency is never the agent's to invent; and a validation error that spells out a required prefix has already answered the question, so correct a one-character confusable difference rather than asking the caller to confirm it.
- e8fef4b: Remove the internal loadProviderPackage helper (dead since provider SDKs became regular dependencies)

## 4.0.0

### Major Changes

- 3e21af9: Remove legacy code, dead exports, and silent fallbacks across the SDK, CLI, UI, and server.

  Breaking changes:

  - `@alexkroman1/aai`: removed the dead `MAX_VALUE_SIZE` constant and the unused `ASSEMBLYAI_STREAMING_URL` STT constant; removed the legacy STT model aliases `"u3pro-rt"` and `"universal-3.5-pro"` (use `"universal-3-5-pro"`); removed the dead `theme` manifest field and `HostConfigMessage` type; `PipelineTransportOptions.executeTool` is now required (it previously defaulted to a stub that threw mid-turn).
  - `@alexkroman1/aai-ui`: removed the dead `floatToPcm16` export.
  - `@alexkroman1/aai-cli`: removed the deprecated no-op `--skipApi` init flag; the global config dir no longer falls back to the pre-env-paths legacy path (macOS/Windows users authenticated at the old path will be re-prompted for their API key); an unreadable or malformed `.env` now fails loudly instead of silently running with no secrets.
  - aai-server (private): removed the legacy `POST /:slug/deploy` route (deploys go through `POST /deploy` with the slug in the body); a corrupt stored env record now fails the agent boot instead of degrading to an empty env; the platform default Vector factory is now required (no silent in-memory fallback).

### Minor Changes

- b50b0e9: Host mode accepts an sttPrompt in its config block, and the pipeline traces the STT→LLM boundary under AAI_DEBUG=1 (each STT partial/final, the committed turn text, and each raw AssemblyAI turn event with its end_of_turn/turn_is_formatted flags). DEFAULT_STT_PROMPT is exported and empty — biasing stays opt-in.
- 527c401: Remove the pipeline transport's endpoint-settlement layer (`endpointSettleMs` / `completeSettleMs` and the host-side settler) — every STT final now commits a turn immediately. End-of-turn detection moves into the STT provider: the AssemblyAI opener always sets `min_turn_silence` (default 1500 ms, override via `assemblyAI({ minTurnSilenceMs })`), and Deepgram's default `endpointing` rises from 100 ms to the matching 1500 ms.

### Patch Changes

- 9ad4e51: Recover from a false barge-in during a reply's playback tail: a noise-triggered interruption after the turn finished server-side used to kill the rest of the reply permanently (full transcript shown, voice cut mid-sentence, no resume). The false-interruption recovery window is now armed for playback-tail cuts too, with a continuation prompt that quotes the estimated last words the caller heard.
- b50b0e9: Filler no longer plays over a caller who is speaking: the hold phrase is skipped and dead-air cover re-arms while the caller holds the floor, so a short continuation that does not qualify as a barge-in is no longer talked over.
- 577b17a: Fix the user's barge-in utterance flickering in the UI: a final-triggered barge-in now re-emits the interim caption after the cancel, so the utterance no longer disappears for the settle window before reappearing as a committed message

## 3.2.0

### Minor Changes

- 9c9eadb: Retune the pipeline turn-taking defaults and the default voice prompt, measured against tau2's retail voice tasks.

  A clearly-complete STT final now settles for 1500ms rather than 500ms. One sentence is very often not the whole request — "How many t-shirt options do you have? Also, I want to return three items." produces a complete-looking final at the question mark, and committing there had the agent answer half the request while the rest of that same breath barged in and cancelled the reply. Measured on those tasks, every turn of every call died that way. The general settle window moves 1500ms to 2500ms for the same reason, and the barge-in duration gate is now on by default (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`, 500ms) so room noise and the tail of the agent's own audio stop abandoning replies mid-word.

  The default system prompt gains voice-specific rules, each drawn from an observed failure: keep turns to one or two sentences and don't restate what the caller already heard; offer alternative identifiers in a single question; never re-ask for a value a third time without attempting the call; a homophone can't be resolved by asking the caller to repeat themselves, so ask for the spelling and trust it over what you thought you heard; answer public questions while identity verification is still outstanding; escalation is not an escape from a value you couldn't hear, and when the answer is a transfer, transfer and nothing else; when a tool takes a list, put every affected item in one call rather than looping per item; fetch the list containing an id _before_ the write that needs it, never after; and any dollar figure you are about to say out loud is math.

  `DEFAULT_BUILTIN_TOOLS` is unchanged. Trimming it to `["calculate"]` was tried, on the theory that the other three cost an LLM round trip before the agent says anything and a call cannot afford that. Measurement did not support it: the model under test never invoked `think` or `calculate` at all — not even when the prompt demanded a calculator for a dollar figure it was about to quote — so an unused builtin costs nothing, and the one paired comparison available favoured keeping `think`.

- 9c9eadb: Speak up when a pipeline session cannot start, and actually honor `errorPhrase`. STT and TTS open independently, so the common provider failure leaves the agent with a working voice and nothing to listen with — and it said nothing, handing the caller a line that sounds connected and never answers. A failed open now speaks `startFailurePhrase` (new; defaults to DEFAULT_START_FAILURE_PHRASE, `""` disables) and drains it before teardown. Separately, `errorPhrase` was never forwarded from the agent config to the pipeline transport, so an agent that set it — including setting it to `""` to disable the recovery phrase — silently got the default; it is now passed through like `holdPhrase`.

### Patch Changes

- 9c9eadb: Keep filler out of the conversation record, and truncate oversized relayed tool results instead of dropping them. The hold phrase and the dead-air cover are timing artifacts that exist so a tool chain doesn't sound like a dropped call; they were accumulated into the turn's text and persisted, so history filled with "One moment. Still working on that. Just a moment longer." as though the agent had said something — spending context on every later turn and showing the model its own filler as an example of its output. They now reach TTS and the live caption (which is built from what reaches TTS) but not `onDelta`, which feeds history, `ctx.messages`, resume, and the STT agent-context hint. Separately, an inbound `tool_result` over MAX_TOOL_RESULT_CHARS failed schema validation and was dropped, so the relay call it answered hung to `DEFAULT_RELAY_TOOL_TIMEOUT_MS` — it is now truncated with a `[truncated]` marker so the turn continues and the model can tell the record is incomplete.
- 9c9eadb: Order `reply_done` behind the audio pacer's queue, like `audio_done`. The pacer holds a reply's audio back to a bounded lead, so a reply that finished host-side still has seconds of speech queued — and `reply_done` overtook it, telling the client the turn was over mid-reply. A client that closes the turn's books on that boundary attributes the rest of the audio to the next reply: in the tau2 voice harness every agent turn reached the simulated caller as speech carrying no transcript, and the caller hung up on what sounded like dead air.
- 9c9eadb: Make a voice reply's transcript and audio reach the client together. Pipeline mode published a reply's transcript once, when the reply ended: a turn that opens with a tool chain speaks its hold phrase and dead-air cover tens of seconds before that, so any client pairing text with audio (live captions, a voice harness) had already played the audio by the time the words arrived. `agent_transcript` is now cumulative within a reply and sent as each piece of text reaches TTS; `aai-ui` renders it as the live assistant bubble and commits it to the conversation on `reply_done`. Host-mode sessions also opt out of audio pacing (`UNPACED_AUDIO_LEAD_MS`) — pacing assumes a client that plays at one second per second, and metering audio to the wall clock starves a programmatic client that keeps its own.

## 3.1.0

### Minor Changes

- 1749ca4: Add OpenRouter LLM provider: openrouter({ model }) in @alexkroman1/aai/llm routes through OpenRouter's OpenAI-compatible endpoint using OPENROUTER_API_KEY, giving pipeline agents access to hundreds of models addressed as creator/model.

## 3.0.0

### Major Changes

- 2b395b3: Remove the workflow() app kind, the sync-turn API (POST /sync, createSyncSession, createPttRecorder, the WebSocket audio-file upload path), text-only mode (tts: none(), audioOut), and the Slack send channel (send:, @alexkroman1/aai/send, the send_message builtin).
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

### Minor Changes

- bb02ded: Three type-level hardenings: (1) branded env records (AgentEnv/ProviderEnv/HostCredentialEnv in sdk/env-types) make it a compile error for withHostCredentialFallback output to become ctx.env; (2) the host-guest NDJSON connection is typed by a per-direction RPC method map (RpcSchema / GuestRpcSchema) so method names and request params are compile-checked while untrusted wire data stays unknown; (3) Manifest is now derived from ManifestSchema (defaults live in the schema, type via z.infer) instead of a hand-declared duplicate.
- 08f2937: Simplify the client audio path: the push-to-talk recorder now uses the same capture worklet as the WebSocket mic (start/stop gating, stop-flush-ack instead of a fixed sleep, sample-rate assertion, dead-mic probe), PCM16 conversion and mic-open failure cleanup are shared helpers, the playback worklet's concealment ring uses bulk copies, and all client-audio timing constants (playback done wait, capture stop ack, playback buffer seconds) live in the shared constants module.
- bb02ded: Collapse the config-mapping layer into one canonical schema: AgentConfigSchema is now the single serializable agent-config shape flowing CLI -> server -> runtime unchanged. toAgentConfig strips an explicit host-only deny-list (tools, state) instead of copying fields, agent() derives its parameter type from AgentDef instead of re-declaring it, the server's IsolateConfigSchema extends AgentConfigSchema, and toRuntimeAgent passes the whole config through minus wire-only fields (provider descriptors now ride on the runtime agent). Type-level guards enforce each subtraction so a new config field flows everywhere by default.
- 2236275: Add region: "eu" to the AssemblyAI STT provider — routes both streaming and sync transcription to AssemblyAI's EU data-residency endpoints

### Patch Changes

- d917095: Fix session resume losing the agent's context (ctx.state): the browser client now reconnects with the server-issued sessionId instead of a bare resume=1 (so the server resumes the same session rather than minting a new id), and per-session tool state survives a disconnect for a resume grace window (SESSION_RESUME_GRACE_MS) on both the self-hosted runtime and the platform sandbox (deferred guest session/end) instead of being wiped the moment the old session stopped.
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

- eb9f662: Fix "Sync turn failed: malformed server response" when a turn's model emits an invalid tool call. The AI SDK surfaces an unparsable tool call as a `tool-call` stream part whose `input` is the raw argument string rather than a parsed object; the sync-turn runner shipped it verbatim in `toolCalls[].args`, the client's response schema rejected the whole body, and the workflow run died. Tool-call args are now coerced to a plain record (`toArgsRecord`, exported from `@alexkroman1/aai/utils`) on both the sync path and the WebSocket pipeline's `tool_call` observability frame, sync turns run the same tool-call repair the pipeline transport uses, failed/invalid calls are recorded with an error result instead of dangling, and the client's malformed-response error now names the offending field.
- 6cac47f: Fix AssemblyAI streaming TTS cutting replies short when the server acknowledges a flush with both an is_final audio frame and a FlushDone: the pair now counts as one acknowledgement, so done can no longer fire mid-reply, drop buffered sentence text, or let audio_done overtake segments still synthesizing.

## 2.0.0

### Major Changes

- e17fdc4: Remove the text-only agent mode: an agent is always a voice conversation, and a workflow never speaks.

  - `agent()` with `tts: none()` is now rejected at parse time (parseManifest, toAgentConfig, and the platform's IsolateConfigSchema) — speech-in, text/action-out apps are workflows.
  - `workflow()` no longer accepts a `tts` parameter; it always sets the internal `none()` sentinel.
  - aai-ui: `TextControls` is removed and `ChatView` always renders the voice `Controls`. `SessionCore`'s programmatic audioOut-aware APIs (`startRecording`, `sendAudioFile`) remain.
  - The `pipeline-text-only` template and the studio's text-only starter are removed.

- 6047231: Remove the per-agent sync client transport and simplify the app model to two
  kinds: **agents** (WebSocket chat/voice sessions) and **workflows** (one-shot
  `POST /sync` runs).

  Breaking changes:

  - `agent({ transport })` is removed. The default browser client always uses
    the WebSocket session for agents; workflows automatically get the run
    surface. `POST /sync` remains available as a programmatic API for pipeline
    agents.
  - `agent({ kind })` is removed — `workflow()` is the only way to define a
    workflow.
  - `ClientTransport` and `assertClientTransport` are removed; `assertAgentKind`
    no longer takes a transport argument.
  - `GET /client-config` no longer returns a `transport` field (`kind` decides
    the surface); older responses still parse — the extra field is ignored.
  - aai-ui: `SyncChatView`, `startSyncMicrophone`, `createUtteranceDetector`,
    and their option types are removed. `createSyncSession` and
    `createPttRecorder` stay (they power `WorkflowView`). The chat shell now
    uses the server-declared agent name when `client({ name })` is not passed.
  - Templates `sync-voice` and `push-to-talk-translator` are removed.
  - The `@alexkroman1/aai/workflow` subpath (pattern combinators) is renamed to
    `@alexkroman1/aai/patterns`; the old subpath is removed.

### Minor Changes

- 377ecd3: Re-arm the playback jitter buffer on underrun and conceal gaps instead of zero-filling them, report per-turn concealment counters in WebRTC's shape, pace server audio at a bounded lead, capture through an AudioContext at the STT rate (no worklet resampling), and detect a microphone that only ever delivers silence.
- 4051d7a: Two app modes — agents and workflows: new workflow() definition (audio in, action out: push-to-talk or uploaded audio runs one agentic loop over the sync transport with its own workflow system prompt, rendered by the default client's new run surface), plus ctx.generate (host-executed one-shot LLM generation for tool code, proxied out of the sandbox via the llm/generate guest RPC) and the @alexkroman1/aai/workflow combinators: sequential, parallel, route, orchestrate, evaluatorOptimizer.
- 158d5d5: Workflow default UI is now a pure execution surface: sync turn responses carry the turn's tool calls (SyncTurnResponse.toolCalls), and WorkflowView renders the transcript plus those tool calls with no greeting and no assistant messages.

### Patch Changes

- 7fc476d: Fix every sync turn failing with HTTP 415: the AssemblyAI Sync API request body is now hand-encoded multipart bytes, because a globalThis.FormData is stringified rather than encoded by the pinned undici the host fetch comes from.
- ed4f2e7: STT: stop inheriting the assemblyai SDK's 1000 ms streaming connect deadline, which covers socket open plus the server's Begin and failed healthy handshakes. The AssemblyAI STT opener now pins connectTimeout/maxConnectionRetries/connectionRetryDelay from STT*CONNECT*\* constants (2500 ms, 2 retries, 500 ms), overridable per agent via assemblyAI({ connectTimeoutMs, maxConnectRetries }).
- 89a032d: Pipeline barge-in now requires the agent to be audibly speaking rather than merely mid-turn. A reply that has not yet emitted audio cannot be spoken over, so an utterance arriving in that window is buffered and answered as a chained turn instead of aborting the reply in progress. Previously any utterance during a slow reply restarted the turn, and since each restart redid the work on a longer history it outlived the next re-prompt — a caller saying "hello? any update?" into the silence could starve the reply indefinitely. Once a turn has spoken it keeps the floor for the rest of its run, so a mid-reply TTS stall does not reopen the window.

## 1.16.0

### Minor Changes

- 5ea4cba: Keep session sockets warm with a 15s keepalive ping, and log the close code and any fatal session error so a dropped session is diagnosable from the host's own logs

### Patch Changes

- c261662: Pair the SSRF DNS-pinning dispatcher with its own undici at both tool-fetch call sites, fixing `TypeError: fetch failed` on every `fetch` made from an agent's tool code

## 1.15.0

### Minor Changes

- f87ff84: Add errorPhrase: pipeline agents now speak a recovery line when the LLM stream fails instead of going silent

### Patch Changes

- 9ffec74: Never silently fall back to S2S: forward pipeline providers based on the descriptors rather than the optional mode field, and log the resolved session mode once per runtime

## 1.14.0

### Patch Changes

- 1c57e05: Fix deployed pipeline agents rejecting holdPhrase and the other voice tuning fields: validate the runtime config against the effective providers, which the platform passes as options rather than on the agent object
- 4469856: Fix AssemblyAI streaming TTS lag in pipeline mode: flush per sentence so audio starts mid-reply instead of after the whole turn

## 1.13.1

### Patch Changes

- f662e45: Surface a provider-initiated STT socket close instead of going silently deaf. `createSessionShell` treated every clean (1000) close as expected, but only a close we initiate ourselves is — a graceful close from the provider (a session cap, an idle cutoff, an upstream deploy) still means no further transcripts will arrive. Because the `closed` latch stayed false, `sendAudio` kept forwarding frames to a dead socket: the session looked healthy, no error reached the caller, and the agent stopped responding to speech for the rest of the call. Closes now emit `stt_stream_error` for all four STT providers via a new opt-in `cleanCloseIsFatal`, keyed off the latch rather than the close code. TTS openers keep the lenient behavior, where a provider closing after it has finished sending audio is normal completion.

## 1.13.0

### Patch Changes

- 2b3c0e0: Fix all host-side egress failing with `TypeError: fetch failed`: the SSRF pinning dispatcher is built from this package's undici 8, but was handed to Node's built-in fetch (undici 7), which undici 8 rejects with `invalid onRequestStart method`. Pair the dispatcher with undici's own fetch.

## 1.12.0

### Minor Changes

- 83be5b2: Add transport selection to agent(): declare transport: "sync" (pipeline mode only) and the default browser client runs connectionless HTTP turns against POST /sync — VAD mic, text composer, and spoken-reply playback with no custom client.tsx. The transport choice is served pre-connection via the new GET /client-config endpoint (GET /:slug/client-config deployed) with the agent name and greeting; every lookup failure degrades to the WebSocket default. aai-ui exports the new SyncChatView shell plus fetchClientConfig/buildAgentUrl, and the aai dev Vite proxy now forwards /sync and /client-config so sync clients work under dev.
- bd4405a: Add a `get_page_design` builtin that fetches a webpage's raw HTML and CSS — markup with scripts/comments stripped, `<style>` blocks, and linked stylesheets — so an agent can study or mimic another site's visual design. Every request (page and stylesheets) goes through the SSRF-safe fetch; a blocked or failing stylesheet degrades to a per-sheet error. The studio coding agent now gets the tool alongside `visit_webpage`.

## 1.11.0

### Minor Changes

- a6bb262: Make `allowedHosts` declarable in `agent()` and enforce the same tool-fetch policy in `aai dev` as in production, from one shared implementation. Adds the missing `send`/`state` fields to the `agent()` parameter type.
- d72c86b: Add a zod-free `@alexkroman1/aai/utils` subpath export exposing the shared utilities plus the platform slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS`, new `sdk/slug.ts`). Client wire constants (`MIC_BUFFER_SECONDS`, `MIC_SEND_MAX_BUFFERED_BYTES`, `FILE_SEND_BACKOFF_MS`) and the `custom_event` relay caps now live in `sdk/constants.ts`; `isPathInside` is exported from the runtime. The CLI and UI re-export these from the SDK instead of carrying their own copies.
- 163cb6f: Add sync mode: connectionless HTTP turns with no WebSockets on either leg.

  Server side (`@alexkroman1/aai`): pipeline-mode runtimes gain
  `runtime.runSyncTurn()` and the self-hosted server a `POST /sync` route —
  one request per conversational turn carrying committed text or one
  endpointed utterance of PCM16 audio plus the client-held history. STT runs
  through the provider's one-shot batch capability (`transcribeClip`,
  AssemblyAI Sync API), the LLM loop runs host-side with the agent's tools,
  and TTS runs through the new one-shot `TtsOpener.synthesizeClip`
  capability (implemented for Cartesia via its `/tts/bytes` endpoint). The
  request/response schemas ship from `@alexkroman1/aai/protocol`.

  Client side (`@alexkroman1/aai-ui`): `createSyncSession()` (HTTP turns +
  history replay), `startSyncMicrophone()` (WebRTC `getUserMedia` voice
  capture through an inline AudioWorklet), and `createUtteranceDetector()`
  (pure energy-VAD utterance endpointing) — speech is endpointed in the
  browser and each utterance becomes one HTTP turn.

### Patch Changes

- 310eedb: Fix AssemblyAI TTS `language`: translate ISO 639-1 codes to the full names the streaming API requires, and reject unsupported ones at config time. Passing `language: "es"` produced a session that connected, reported ready, and was silently mute — the service refuses a bad value in-band after the socket opens. Bad values now fail in the CLI and the studio's test_agent instead.

## 1.10.0

### Patch Changes

- 3fe3eff: Harden unhandled-error paths across the SDK, CLI, and UI: missing WebSocket/stream/child-process error listeners, floating `void` promises without rejection handlers, unguarded JSON parsing, and event-handler throws that could crash the process or silently wedge a session now fail safely with clear errors.
- 5ddca41: Fix race conditions and concurrency issues across the stack:

  - **Session registry** (host): reconnect-resume no longer lets an old session's delayed teardown delete the resumed session's registry entries (delete-by-identity); idle timer can no longer re-arm after `stop()`; `remember` serializes its KV read-modify-write; OpenAI Realtime transport no longer double-emits `cancelled`.
  - **Pipeline transport**: turn epochs gate queued turns so they can't run after `stop()`/`reset()`/`cancelReply()`; interrupted-turn persistence no-ops after `reset()`; the dead-air cover timer is abort-aware; late TTS audio after a barge-in is dropped instead of re-advancing the playback clock; tool-call repair captures its own turn's abort signal; `cancelReply()` resets the endpoint settler.
  - **AssemblyAI TTS**: `cancel()` now actually cancels — the adapter drops the connection (suppressing stale audio/done/error events) and reconnects, so barge-in works and cancelled text can't splice into the next turn.
  - **Sandbox platform** (aai-server): slot session releases are identity-bound so a stale release can't idle-evict a redeployed agent's new sandbox mid-call; sessions re-validate the sandbox before starting; a failed sandbox VM start detaches from the slot instead of poisoning it; dead warm-pool harnesses fall back to a cold spawn; gVisor cleanup is properly idempotent.
  - **Studio**: all workspace mutations run under a per-project keyed lock (no more lost writes from concurrent tool calls or editor saves), and Publish re-reads the workspace instead of writing back a stale pre-build snapshot.
  - **Browser client** (aai-ui): a stale audio init can no longer unlock a newer one (orphaned live mic); the greeting replay respects turn boundaries; a server-initiated `reset` discards in-flight file uploads; stale playback-stop events can't resolve a later turn's drain early.
  - **CLI**: `NODE_ENV` preservation around Vite builds is refcounted (concurrent builds can't leak `production` into the process); config writes are atomic (temp+rename); a slug-less first deploy is no longer retried (no duplicate agents); the dev server watcher starts before the initial build, shutdown is idempotent, and restart retries a busy port; `fsKv` writes are atomic.

- 133642f: Log a pipeline LLM stream failure as one compact line with its HTTP status, URL, and provider request id instead of letting the AI SDK dump the raw error object (three nested stack traces plus the whole request body) to the console.
- fec3fa2: Performance fixes across the SDK, CLI, and UI: incremental esbuild dev-server rebuilds with cold-path fallback, backpressure guards on provider-facing WebSockets, linear OpenAI gateway stream repair with a pass-through fast path, bounded STT partial word scans, selector-granular React subscriptions in ChatView/MessageList, memoized theme and session objects, and instant auto-scroll while transcripts stream.
- 678556f: Fix voice-agent reliability, security, and correctness across the aai core:

  - OpenAI Realtime: server-VAD barge-in now flushes client playback (was talking over the user).
  - S2S transport: an unexpected idle close now surfaces an error instead of zombie-ing the session; post-cancel audio is dropped until the next reply.
  - KV: expireIn is now enforced on all backends (memory/fs/s3), not just Redis; size cap counts bytes not UTF-16 code units.
  - fsKv: key-traversal guard now rejects ../ escapes (and reads/deletes), plus a key-length bound.
  - Providers: Soniox/Rime sockets keep a crash-safe error guard through teardown; Rime/AssemblyAI TTS surface abnormal server closes; Cartesia drops in-flight audio past cancel; Soniox flushes a trailing final on quiet.
  - ws-handler: session-start failure and a createSession throw now send the client an error frame and close instead of hanging or crashing the host.
  - Pipeline: start() no longer proceeds after a provider-open failure; S2S file-upload replay is paced so audio isn't dropped past the socket buffer.
  - fetch_json caps response body size; lenientParse flags invalid known-type messages; ws-upgrade handles empty sessionId and '?' in query values; stream-repair drops stale content-length/encoding headers.
  - Dependencies: bump undici 7→8 (the SSRF-path dispatcher) and nanoevents 9→10, both majors; sweep the ai/@ai-sdk packages to their latest in-range patches; declare fast-check as an aai devDependency (was a phantom dep).

- 8a5ee8f: Replace hand-rolled utilities with established libraries (expr-eval-fork, p-event/p-timeout reuse, env-paths, use-sync-external-store, partysocket, picomatch, generic-pool, json-rpc-2.0, iron-webcrypto, argon2)

## 1.9.2

## 1.9.1

### Patch Changes

- 713025a: Pipeline mode: cover tool-execution dead air with time-based filler speech. holdPhrase only fired when a turn _opened_ with a tool call, so a model that spoke first and then chained tool calls left the caller in silence for the whole chain (15-24s in benchmark runs). Silence during tool execution now gets a filler after 2s regardless, repeating with exponential backoff until the model speaks again. `holdPhrase: ""` disables both.

## 1.9.0

### Minor Changes

- 0235618: Add AssemblyAI conversation context (agent_context) for Universal-3.5 Pro streaming: seed the agent greeting at connect and push each agent reply mid-stream so user turns are transcribed with the agent side of the dialog in context.
- 262f1e7: Add four host-side built-in tools and enable them by default: `think` (a
  private no-op reasoning scratchpad, per the spec Anthropic published for its
  tau-bench evaluation), `remember`/`recall` (session-scoped notes in KV, so
  confirmed IDs/codes/dates survive noisy voice transcripts), and `calculate`
  (a safe recursive-descent arithmetic evaluator — no `eval`, no code
  execution). When an agent does not set `builtinTools`, the new
  `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) are
  enabled; setting `builtinTools` explicitly — including `[]` — overrides the
  default. The network built-ins (`web_search`, `visit_webpage`, `fetch_json`)
  and `run_code` remain opt-in.

  Host-mode (relayed) sessions now expose built-in tool schemas and guidance
  alongside the client-supplied tools, executing built-ins host-side instead of
  relaying them — so a tau2-style harness session gets `think`/`calculate`/notes
  for free. Name collisions resolve in favor of the custom or relayed tool: the
  built-in is dropped from both dispatch and schemas.

- c5a5351: Add pipeline-mode silence nudge: new silenceTimeoutMs and silencePrompt agent config fields make the assistant proactively take a turn after a period of user silence (capped at 3 consecutive nudges until the user speaks again)
- 0235618: Default the AssemblyAI streaming STT model to `universal-3-5-pro` (Universal-3.5 Pro Real-Time) instead of `u3pro-rt`. The legacy `u3pro-rt` alias is still accepted and maps to the SDK's `u3-rt-pro`. (The `assemblyai` SDK is already on `^4.36.3`.)
- 0235618: Replace the default system prompt with a customer-service / voice-agent prompt (hard rules, tool-calling contract, voice behavior, dual-control, process) that ends by introducing the domain policy. This prompt is prepended before any agent-specific / injected instructions.
- d718fe9: Export resolveLlm from @alexkroman1/aai-runtime and ASSEMBLYAI_LLM_API_KEY_ENV from @alexkroman1/aai/llm, so host applications (e.g. the platform server's browser studio) can resolve LLM provider descriptors without duplicating provider wiring.
- 2898f21: Pipeline voice UX: stream interim user transcripts to the client (user_transcript_partial) with speech_started/speech_stopped edges, resume replies after false interruptions (falseInterruptionTimeoutMs), and expose pipeline tuning knobs on agent() — minBargeInWords, interruptionMinDurationMs, endpointSettleMs, completeSettleMs, holdPhrase. LiveKit-parity default changes: completeSettleMs default 600→500 ms, Deepgram endpointing default 300→100 ms (now configurable via deepgram({ endpointing })).
- 882e7d9: Host mode now inherits the deployed agent's `stt`/`llm`/`tts` provider config, so a `?host=1` session runs the operator's configured pipeline (e.g. AssemblyAI Universal-3.5 Pro STT + LLM + TTS, with agent_context/voice_focus) with only the client's system prompt, greeting, and tools injected — instead of falling back to the default S2S path. The dev server passes its loaded agent as `hostBaseAgent`.
- e2ee4fd: Add voice-agent host mode: external clients can inject system prompt + tool schemas via config.host and receive tool calls to execute (tool_result), enabling harness-driven agents.
- 0d024e0: Add `gateway()` LLM provider factory routing through the Vercel AI Gateway, so pipeline agents can use any `"creator/model"` id (e.g. `zai/glm-4.6`) with a single `AI_GATEWAY_API_KEY`.
- d718fe9: Deployed agents accept ?host=1 WebSocket connections that override systemPrompt/greeting/tools, gated on the owner's API key (startHostSession gains an allowHost option so the platform can gate on ownership rather than AAI_ALLOW_HOST).
- ab38293: Add AssemblyAI LLM Gateway provider for pipeline mode: assemblyAI({ model, region? }) in @alexkroman1/aai/llm routes the LLM loop through the OpenAI-compatible gateway (25+ models) using ASSEMBLYAI_API_KEY
- d718fe9: New "send" provider type: an outbound channel the agent can post to, declared as `send: slack()` from `@alexkroman1/aai/send`. Declaring a channel registers a `send_message` builtin tool and allowlists the channel's host for sandboxed tool code; `openSender()` resolves descriptors into a fetch-based `Sender` that works on the host and inside the guest sandbox. First channel: Slack incoming webhooks (`SLACK_WEBHOOK_URL`).
- 82f8253: Performance pass across the SDK and UI.

  Host runtime: client WebSocket audio sends are now guarded by a buffered-bytes cap (a stalled client is closed instead of accumulating unbounded audio in memory), pipeline TTS text is coalesced to clause boundaries after the first chunk instead of one message per word, the ElevenLabs STT opener batches mic audio to ~100 ms frames like AssemblyAI, the silence nudger keeps one long-lived timer instead of re-arming per STT partial, hot-path debug logs are gated behind `AAI_DEBUG` (new `createConsoleLogger` export), the in-memory vector store uses bounded top-K selection, and the default KV is constructed lazily.

  UI: chat messages carry a monotonic `id` used as the render key (stable across the history-window slide), the chat list is memoized, new `useSessionSelector` export for narrow subscriptions, mic sends drop frames under WebSocket backpressure instead of queueing stale audio, the capture worklet batches ~100 ms of PCM per main-thread message (down from ~190/s), dedup hooks use watermarks instead of unbounded seen-sets, auto-scroll is rAF-deduped, and the playback worklet gained an aligned Int16 fast path.

  Note one public type change in `@alexkroman1/aai-ui`: `ToolCallInfo.afterMessageIndex` (an index that drifted once history slid) is replaced by `afterMessageId`, and `ChatMessage` gained a required `id`. Nothing in the templates or repo consumed the old field, but custom client UIs reading `afterMessageIndex` must switch to `afterMessageId`.

- d718fe9: One-shot transcription for short uploads: new `transcribe_file_start`/`transcribe_file_end` protocol messages buffer an uploaded clip host-side and transcribe it in a single request via AssemblyAI's Sync API (`syncTranscribe` from `@alexkroman1/aai/stt` — the preferred endpoint for files under two minutes), then run the transcript as one user turn. Non-AssemblyAI STT providers and longer files fall back to the realtime streaming path. `sendAudioFile()` in aai-ui picks the path automatically.
- fd5a54e: Update all dependencies to latest: Vercel AI SDK v7 (@ai-sdk/\* v4), Cartesia SDK 3.3, Deepgram 5.5, ElevenLabs 2.58, AssemblyAI 4.36; Pinecone peer range is now ^8.0.0. Tooling: Biome 2.5, TypeScript 7, Vite 8.1, Vitest 4.1.10, tsdown 0.22.
- a413caf: Concurrency hardening in the agentic loop: tool calls now receive a history snapshot and a turn-scoped AbortSignal (exposed as ctx.signal) that cancels on barge-in, reset, or session stop; duplicate reply.done frames mid multi-hop turn no longer end the reply early; a failed S2S resume emits a single connection error and cannot loop into repeated resume attempts; host-mode relay refuses duplicate in-flight toolCallIds and honors turn aborts; ws-handler no longer marks a session ready (or drains buffered frames) after the socket closed mid-start.
- 0c57887: Harden credential and SSRF boundaries: SDK network builtins now default to SSRF-protected fetch, provider credential resolution no longer falls back to the host process env, host mode is opt-in, the self-hosted server binds loopback by default, and DNS pinning no longer breaks TLS. The CLI refuses to send credentials to an unapproved serverUrl from .aai/project.json.
- 0235618: Enable AssemblyAI voice focus (noise suppression) by default: the streaming STT provider now sends `voice_focus: "near-field"` at connect. Configurable via the `voiceFocus` option (`"near-field"` | `"far-field"` | `"off"`); set `"off"` to disable.
- 115a88e: Voice benchmark reliability: preserve completed tool calls/results in LLM history across barge-in aborts (no more repeated or forgotten tool calls after an interruption), settle clearly-complete STT finals briefly instead of committing instantly (plus a longer fragment settle window) so hesitant multi-part requests aggregate into one turn, coerce stringified scalar tool arguments to their schema-declared types, raise the default maxSteps to 10, and overhaul the default system prompt for act-first tool calling, full multi-part request completion, and argument fidelity.
- d718fe9: Text-only agents: `tts: none()` runs pipeline mode without synthesis (STT → LLM, text replies). No TTS credential required; the config message stamps `audioOut: false`; aai-ui adds opt-in mic recording (`startRecording`/`stopRecording`), audio-file upload (`sendAudioFile`), a text-only default UI (record + upload + text replies), and an always-visible API endpoint chip (`ApiUrlChip`, `SessionSnapshot.apiUrl`) in every session mode.
- d718fe9: Add an AssemblyAI streaming TTS provider (assemblyAI from @alexkroman1/aai/tts), targeting the production streaming-tts.assemblyai.com endpoint. Shares ASSEMBLYAI_API_KEY with AssemblyAI STT and the LLM Gateway, so an all-AssemblyAI pipeline needs one secret.

### Patch Changes

- 4758dfc: Fix AssemblyAI streaming STT rejecting telephony audio with "Input Duration Violation". The provider now coalesces inbound PCM into 50–1000 ms frames (buffering ~100 ms, capping at 1000 ms, and flushing a ≥50 ms tail on close) before forwarding to AssemblyAI, which requires each streaming audio frame to fall in that window. Clients that stream standard 20 ms RTP frames (e.g. the tau2 harness) now work unchanged.
- 0f72bef: Refactor: split oversized source modules (session-core, runtime, pipeline-transport, deno guest harness) into focused sibling files. No behavior or public API change.
- bc62b75: Internal cleanup of the aai package: dedupe the header-WebSocket adapter and ToolSchema types across transports, extract a shared runReply scaffold in the pipeline transport, consolidate PCM16/base64/error-message helpers, replace per-audio-chunk idle-timer re-arming and per-chunk STT carry reallocation with cheap accumulators, serialize KV values once, move STT/TTS resolution onto registries, and remove dead API surface (S2sHandle.sendAudioRaw, Transport.updateSession, user_transcript.turnOrder).
- 7e67c24: Internal cleanup: shared safeJsonParse/LOG_PREVIEW_CHARS helpers, deduped s2s-transport connect and dev-server build paths, native base64 in the sandbox guest, single-source MAX_REQUEST_BODY_BYTES, and vendor-correct API-key fallback for pre-resolved STT/TTS openers. The aai dev server no longer prompts for an AssemblyAI API key when the agent uses no AssemblyAI provider.
- 8817f3f: Remove unused code and fallback paths: legacy host-guest RPC schemas, backward-compat aliases (`pendingKvRequests`, `handleKvResponse`), unused exports (`jsonLogger`, `touchSlot`, `S2sEvent`, `DEFAULT_THEME`, unused metric label types), legacy OpenAI Realtime beta event-name fallbacks, inert CLI flags (`--server`/`--yes` on commands that never read them), and over-exported internal types.
- 394867e: Fix a Cartesia TTS connect failure crashing the whole host process. `client.tts.websocket()` only returns the socket after connect resolves, so on a connect-time failure (e.g. the account is out of credits) the promise rejects before an `error` listener can be bound — and cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject` (a fatal unhandled rejection) when the socket errors with no listener. The adapter now constructs `new TTSWS(client)` directly and binds the `error` listener before connecting, so the failure flows through the normal `tts_connect_failed` path and degrades only that session. As defense-in-depth, the `aai dev` host entry now installs a log-only `unhandledRejection` guard (mirroring aai-server).
- 8004ff8: Fix Cartesia TTS killing the session with a fatal `tts_stream_error` on a benign barge-in race. When a `cancel`/`flush` crosses the context's `done` on the wire, Cartesia emits a per-context 400 "Invalid context ID" error frame on the shared socket; the handler now recognizes dead-context error frames (and frames tagged with a non-active `context_id`) and drops them, while still surfacing genuine socket failures.
- 257a372: Load STT/TTS vendor SDKs lazily (cuts runtime import from 1266ms/137MB to 335ms/61MB), fix the OpenAI Realtime transport hanging when a socket closes before opening, and share the restartable-timer and registry-lookup helpers.
- 0bdb115: Fix barge-in not stopping TTS playback after synthesis completes: pipeline mode now tracks estimated client-side playback and emits cancelled (flushing the client audio buffer) when the user speaks while buffered audio is still playing, even after the server-side turn has finished.
- 578a840: host: suppress duplicate tool_call frame in relay+pipeline mode (was double-executing relayed tools)
- a252842: Bump dev dependencies: `tsdown`, `@biomejs/biome`, `@changesets/cli`, `knip`,
  `markdownlint-cli2`, `publint`, `turbo`, `@tailwindcss/vite`,
  `@vitejs/plugin-react`, `react`/`react-dom` (also widening the `aai-ui` peer
  range to `^19.2.8`), and the `@pinecone-database/pinecone` peer range to
  `^8.1.0`.
- bbb9d73: Bump production dependencies: `@ai-sdk/*` providers, `ai`, `assemblyai`,
  `@cartesia/cartesia-js`, `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`,
  `hono`, `@hono/node-server`, and `vite`.
- 257a372: Derive required provider credentials from the provider registries instead of a hardcoded AssemblyAI check that ignored tts/s2s, and stop rebuilding the system prompt per session.
- d718fe9: S2S and OpenAI Realtime now send close code 1000 on an intentional close, so a 1005 in the logs unambiguously means the peer dropped the socket rather than our own teardown.
- a413caf: Pipeline/host latency: the greeting now starts as soon as the TTS provider connects instead of waiting for the slower STT connect; tool-call yields use setImmediate instead of setTimeout(0) (~2ms less overhead per call); the Vercel tool map is built once per session instead of per turn; provider sockets close in parallel on stop.
- 9750db7: Fix relayed tool calls failing with "invoked without a toolCallId" in host + pipeline mode. The sandbox/RPC `executeTool` wrapper dropped its 5th `callOpts` argument (which carries `toolCallId`), so the relay executor couldn't correlate the client's `tool_result` and rejected every call. The wrapper now forwards `callOpts` to the RPC executor. Latent until host mode began running the STT→LLM→TTS pipeline (S2S sourced the id from a different path).
- cb2821c: Fix 'unsupported reasoning metadata' warning in pipeline mode: replace smoothStream with a text-only word-coalescing transform so Anthropic thinking signatures on reasoning parts survive multi-step tool turns
- 9aed108: Fix uncaught exceptions that could crash the host process: shim assemblyai@4.36.3's discardPendingSocket so a timed-out streaming connect no longer emits an unhandled ws 'error' ("WebSocket was closed before the connection was established"), attach error handlers to HTTP upgrade sockets, and destroy unmatched upgrade sockets instead of leaving them dangling.
- 257a372: Fix pipeline false-interruption recovery firing over a still-talking user, cap consecutive resumes, close the speaking edge when an utterance never commits, and keep a barge-in partial's caption from being blanked by the cancel that follows it.
- 257a372: Make RuntimeOptions stt/llm/tts descriptor-only, removing the pre-resolved-opener escape hatch, the opener.name sniffing it required, and the duplicated raw-descriptor channel in the transport factory.
- 860bb7d: Refactor pipeline provider internals: extract a shared session shell for STT/TTS openers, define each provider's API-key env var once next to its kind tag, and make the LLM resolver table-driven. No behavior changes.
- d718fe9: Repair the AssemblyAI LLM Gateway's id-less streaming tool_call deltas so gateway-backed pipeline agents survive tool calls
- 7240ce5: Pipeline mode: add a configurable `minBargeInWords` option (default 1, preserving instant barge-in) that requires the interim STT transcript to reach N words before interrupting the agent — raise it to ignore one-word backchannels while the agent speaks. Below-threshold _final_ transcripts while the agent is speaking are ignored the same way. Also persist the agent's spoken-so-far text on interruption (flagged `[interrupted]` in history) so the next turn's LLM knows it was cut off, instead of discarding it — unless nothing but the guaranteed hold phrase was spoken, in which case nothing is persisted.
- f22b0f4: Pipeline mode turn-taking overhaul so the agent stops cutting itself off and stops dropping the caller mid-sentence (root causes of a "the agent went silent" failure in tau2 voice runs):

  - **Endpoint settle window** (`endpointSettleMs`, default 700ms): disfluent, in-the-wild speech now commits as one turn. Previously every STT `final` started a turn immediately, so a mid-utterance pause, self-correction, or false start ("find a two-bedroom in Austin… actually make it Dallas") fired a turn on the pre-correction fragment — and a second `final` then barged in on that turn, producing wrong tool calls, duplicate calls, and responses that began before the speaker finished. Follow-on finals/partials inside the window are aggregated into a single utterance. A clearly-complete final (terminal punctuation, no trailing continuation cue) commits immediately, so clean requests pay no added latency. Set `endpointSettleMs: 0` to disable.
  - **Sub-threshold finals are no longer dropped.** A short final spoken while the agent is talking used to be discarded as a "backchannel," silently losing real short answers (a "yes", a ZIP). It is now transcribed and answered as a deferred turn once the current reply finishes.
  - **`DEFAULT_MIN_BARGE_IN_WORDS` raised from 1 to 2** so a single word — a backchannel, a cough transcribed as one token, or the leading fragment of the caller's own turn — no longer cuts the agent off mid-sentence. (Combined with the previous change, sub-threshold speech is deferred, not lost.)
  - **Voice output rule** added: when the caller spells a name/email/ID or reads out digits, the agent confirms briefly instead of reading the whole thing back letter by letter — long readbacks were slow and invited interruptions.

- 0bb1a20: Guarantee a hold phrase during tool execution. When the model opens a turn with a tool call and no preceding speech, the pipeline now deterministically speaks a short filler ("One moment.") before the tool runs — so the caller never hears dead air even if the model skips the prompt's tool preamble. Fires at most once per turn and is suppressed when the model already spoke; configurable via the stream handler's `holdPhrase` (set `""` to disable). This also makes tool-first turns produce speech, so they flush cleanly instead of relying on the silent-turn path.
- 7d4a193: Fix an OpenAI Responses API 400 ("Item 'msg*...' of type 'message' was provided without its required 'reasoning' item: 'rs*...'") on multi-turn tool calls in pipeline mode. Persisted-history reasoning stripping is now conditional: reasoning parts that carry provider metadata needed on replay are kept — OpenAI reasoning items (`openai.itemId`) required alongside their message/tool-call items, and Anthropic thinking/redacted-thinking (`anthropic.signature` / `anthropic.redactedData`). Only metadata-less reasoning traces (the ones that triggered the Anthropic "unsupported reasoning metadata" warning) are still stripped.
- 5bf4d41: Persist tool calls and their results across turns in pipeline mode. Previously only the spoken transcript survived into the next turn, so the model lost the raw results of earlier lookups (a user id, an order id) and had to re-derive them. The pipeline now keeps a Vercel AI SDK `ModelMessage` history and appends each turn's `streamText` step messages (assistant tool-call + `tool` result + text) — the SDK-idiomatic way — so tool context carries forward. Conversation memory was extracted into a focused `pipeline-history.ts` module (text view for the client/resume/tool-context; ModelMessage view for the LLM). Also fixes the test LLM fake to report `finishReason: "tool-calls"` on tool steps so multi-step response messages reconstruct correctly.
- ad295be: Adopt two Vercel AI SDK features in the pipeline instead of hand-rolling / going without:
  - `experimental_transform: smoothStream({ chunking: "word", delayInMs: null })` coalesces LLM text deltas into whole words before they reach TTS (cleaner than raw sub-word tokens), with no added streaming latency.
  - `experimental_repairToolCall` re-derives valid tool arguments (via `generateObject` constrained to the tool's JSON Schema) when the model emits a schema-invalid tool call, instead of failing the turn. Unknown-tool errors are passed through; a failed repair falls back to the original error. Lives in a focused `pipeline-repair.ts` module.
- d22d9f8: Fix pipeline turns stalling ~10s ("TTS flush timeout") on turns that produce no speech. A tool-call-only turn sent no text to the TTS context, but the transport still called `flush()` and waited for a `done` event the provider never emits for an empty context — burning the full `PIPELINE_FLUSH_TIMEOUT_MS` every silent turn. The flush/await now runs only when the turn actually produced agent text.
- 8f2093b: Strip `reasoning` parts from assistant messages persisted to the pipeline's LLM history. Reasoning is an ephemeral per-turn trace, not conversation the model should re-read; replaying it (introduced with cross-turn tool memory) also made the Anthropic provider warn "unsupported reasoning metadata" on every subsequent request because the persisted reasoning carries no valid thinking signature. Assistant messages that contained only reasoning are dropped entirely.
- 296a874: Add an optional `temperature` to the pipeline (`PipelineTransportOptions.temperature`), forwarded to `streamText`. It's omitted from the request unless explicitly set, so models that don't support it (e.g. the Claude 5 family, which ignores temperature and warns on every call) stay quiet, while temperature-capable models can opt into deterministic sampling (e.g. `0`) for consistent tool arguments and policy following.
- 752af3d: Strengthen the default voice-agent prompt's ASR-robustness guidance (voice-specific; defers all policy/identification specifics to the host-injected domain policy). On a failed lookup of a spoken value (name, email), the agent now stops retrying the mis-heard value and asks the customer to spell it, confirms, then searches again — or switches to another identification method the policy allows. Also: ask the customer to repeat anything not clearly caught instead of acting on a rough transcription, and vary turn openers instead of repeating the same acknowledgment. Patterns adapted from LiveKit's voice-agent prompting guide.
- 38f02fa: Teach the default agent prompt to recover from non-argument tool errors instead of looping. A state error (e.g. "order cannot be modified" because it isn't pending) now instructs the agent to re-read the record's status and switch to the action the policy allows — never to repeat the same tool call with the same arguments, which previously looped into a too-many-errors termination in tau2-voice runs.
- d718fe9: Fix AssemblyAI LLM Gateway streams dying on Claude models: the gateway's final usage-only chunk carries choices: null where the AI SDK schema requires an array, killing the turn after the reply had already streamed.
- 82f8253: Stop allocating per STT partial in pipeline turn-taking. `countWords` now scans instead of `split(/\s+/)`, and the final-path barge-in gate uses a new `hasMinWords` that stops as soon as the threshold is met — partials arrive several times a second and grow with the utterance, so the old word array was garbage on a latency-sensitive path. The word helpers moved to `pipeline-text.ts`.

  Also fix TTS text coalescing stranding speech across a tool call. Batching only ever deferred text that more text was coming for, but nothing released the buffer at a segment boundary, so a short unpunctuated fragment ("Sure, let me") held its tail for the whole tool-execution window — the caller heard the opening words, then dead air, since `holdPhrase` is suppressed once the model has spoken. The coalescer now exposes `boundary()`, called on `text-end` and before a tool call, which forwards the buffer and re-arms the immediate-first-chunk allowance so the post-tool reply's opening words are not batched either.

- 257a372: Fix deployed agents silently losing the default cognitive builtins, remove dead KV/Vector HTTP handlers and wrong-vendor API-key fallbacks, and reuse shared helpers for PCM views, JSON parsing and error formatting.
- d718fe9: AssemblyAI STT agent_context: keep the tail when trimming to the 1750-char cap, so an over-long agent reply keeps its closing question instead of dropping it.
- d718fe9: Fix text-only agents (tts: none()) rendering the voice UI when deployed: readyConfig read agent.tts, which the platform never sets since it passes providers as runtime options.
- 2fd1078: Code-quality sweep: reuse shared helpers (errorMessage/toolError, provider utils, TTL cache), remove dead code and leftover diagnostics, fix a session-state leak, cut hot-path allocations (base64 zero-copy, persistent playback worklet, client asset cache), and single-source defaults (DEFAULT_MAX_STEPS, slug regex).
- 711edeb: Security: the `run_code` builtin no longer executes on the host via `node:vm`.
  `node:vm` is not a security boundary — its wrappers still exposed the host
  `Function` constructor through the prototype chain, allowing a
  `console.log.__proto__.constructor("return process")()` escape to the host
  process (env/secrets + RCE). `run_code` now runs only inside the guest sandbox
  (gVisor/Deno), where the OS-level isolation is the real boundary. The host-side
  `executeInIsolate` helper is removed from the `@alexkroman1/aai-runtime` export.
  In the self-hosted path (`aai dev`), which has no sandbox, `run_code` returns an
  error instead of evaluating code on the host.
- 3db093f: Internal refactor: split oversized modules at natural seams (no behavior change). `host/runtime.ts` → transport construction extracted to `host/runtime-transport.ts`; `host/transports/pipeline-transport.ts` → STT/TTS provider lifecycle extracted to `host/transports/pipeline-providers.ts`; `aai-server/sandbox-vm.ts` → guest KV/Vector/fetch RPC surface extracted to `sandbox-guest-rpc.ts`. Oversized test files split alongside.
- 79e51cb: Harden connection-churn paths: cancel in-flight session start on disconnect, abort tool-call repair on interrupt, clean session maps on stop, release provider socket listeners, and cap S2S resume attempts.
- d718fe9: Harden the one-shot file-upload path: cap transcribe_file_start's sampleRate (memory-DoS guard), byte-budget the pre-ready WebSocket buffer so a whole upload survives session startup, auto-finalize fully-received uploads, discard in-flight transcriptions on reset/cancel, and mark turn-level transcription failures as non-fatal errors so the client session stays usable. The browser session core gains matching guards: uploads and the mic are mutually exclusive, resets abort in-flight uploads, and non-fatal server errors show a banner without ending the session.
- cf56703: Simplify internals with modern built-ins and existing deps: `Promise.withResolvers` + `p-timeout` for the TTS flush wait, S2S/OpenAI Realtime connect races, and the host-mode relay executor; `fs.cp` for scaffold layering, `stream/consumers` `text()` for stdin, and shared JSON file helpers in the CLI.

## 1.8.3

## 1.8.2

### Patch Changes

- bb06b4e: Fix S2S tool calls arriving with empty args. Strip the $schema keyword from Zod-generated JSON Schema for tool parameters — some S2S providers ship the dialect URI to the underlying model and emit tool calls with empty args even when required params are listed. Also accept both 'arguments' and 'args' field names on the wire. Pipeline transport now surfaces tool-result stream parts as tool_call_done so the client UI flips pending → done.

## 1.8.1

### Patch Changes

- ba8effb: Make OpenAI Realtime usable end-to-end on gpt-realtime-2:

  - Accept GA-renamed audio/transcript server events (`response.output_audio.{delta,done}`, `response.output_audio_transcript.{delta,done}`) alongside the legacy `response.audio.*` names so audio and transcript reach the client.
  - Trigger the agent's `greeting` on connect by sending a one-shot `response.create` with quoted instructions, and honor `skipGreeting` so resumed sessions don't replay it.
  - Coalesce `response.create` across multiple `sendToolResult` calls in the same tick. Multi-tool turns previously sent one `response.create` per tool, the second of which OpenAI rejected as `conversation_already_has_active_response`, stranding the turn so the model never received the tool results.
  - Log unhandled event types and the full payload of `error` events to make silently rejected `session.update` fields visible.

- f4cc5ef: Migrate OpenAI Realtime transport to GA API schema (gpt-realtime-2). Drop OpenAI-Beta: realtime=v1 connect header and update session.update to session.type=realtime, output_modalities, and nested audio.input/audio.output with audio/pcm format.

## 1.8.0

### Minor Changes

- a7384ad: Add OpenAI Realtime API as a pluggable s2s: provider via openaiRealtime() from @alexkroman1/aai/s2s

### Patch Changes

- cc013df: Log session.error code+message at warn level (was hidden — only the type was logged), capture session id from session.updated.config.id (the success-path message; session.ready is no longer sent there, leaving resume permanently disabled), and remove the broken time-since-session-ready check from canResumeAfter that prevented resume on any session older than 25s.

## 1.7.1

### Patch Changes

- 3c711da: Stop per-frame debug log spam when S2S socket is closed; sendAudio now silently drops frames matching sendAudioRaw and pipeline/STT behavior. Closure is still logged once via the WebSocket close event.

## 1.7.0

### Minor Changes

- 07b4263: Pluggable KV and Vector backends. New subpath exports @alexkroman1/aai/kv and @alexkroman1/aai/vector. New ctx.vector tool context field. Pinecone (integrated inference) and Redis/S3/fs/memory backends ship out of the box.

### Patch Changes

- b79855d: Change S2S/agent API base URL to wss://agents.assemblyai.com/v1/ws

## 1.6.1

### Patch Changes

- da84b47: Move @ai-sdk/_ LLM provider packages from optional peerDependencies to dependencies. Self-hosted deployments no longer need to install the @ai-sdk/_ packages separately, and prod deploys (where pnpm install --prod previously stripped optional peer deps) now resolve them reliably.

## 1.6.0

### Minor Changes

- fd3a167: Pluggable Vercel AI SDK LLM providers in pipeline mode: add openai, google, mistral, xai, groq typed factories alongside the existing anthropic. Each is a { model } descriptor; the host resolver lazy-loads the corresponding @ai-sdk/\* package via createRequire. All six AI SDK packages move to optional peer dependencies, so self-hosted users only install the ones they actually use; the managed server installs all six as direct deps in aai-server.
- c8707d6: Add ElevenLabs Scribe (scribe_v2_realtime via @elevenlabs/elevenlabs-js) and Soniox (stt-rt-v3 via direct WebSocket) STT providers alongside assemblyai and deepgram. Both follow the existing typed-descriptor pattern; agent bundles stay free of provider SDKs and the host resolver constructs the live session at createRuntime time.

### Patch Changes

- 149786b: Auto-resume AssemblyAI S2S sessions after transient WebSocket closes (1005, 1006, 1011, 3005) using session.resume within the 30s server window. Drops the in-flight reply via onCancelled so the session unblocks; falls back to the existing 'connection' error on fatal codes (1008/3006/3007/3008/3009) or when resume fails.
- 877348c: Pipeline mode: insert separator between LLM text segments split by a mid-turn tool call so consecutive deltas don't fuse into '...up.Got it' in the transcript and TTS output.

## 1.5.1

### Patch Changes

- fbb3816: Add type: "function" to tool schemas in S2S session.update payload — AssemblyAI's S2S API rejects tool objects without it.

## 1.5.0

### Minor Changes

- 58c5c75: Consolidate session.ts + pipeline-session.ts into a unified SessionCore with two transport strategies (S2S, pipeline). Switch connectS2s to typed callbacks (removing the nanoevents-backed S2sHandle emitter) and flatten client→server→provider dispatch from four layers to two. Wire format is JSON text events + raw PCM16 binary audio frames — the existing public protocol is unchanged. Adds Deepgram as a pipeline-mode STT option and Rime as a pipeline-mode TTS option.
- 868b85e: Plumb agent maxSteps and toolChoice config into pipeline mode streamText
- 58c5c75: Add Deepgram as a pipeline-mode STT provider option
- 58c5c75: feat(aai): add Rime as a pipeline-mode TTS provider option

### Patch Changes

- a361363: Fix Rime TTS provider: correct WebSocket host (users-ws.rime.ai), JSON message protocol on /ws2, longer first-audio timeout so the greeting plays. Default voice for cartesia() and rime() so they can be called with no args.

## 1.4.5

### Patch Changes

- 07dc8fb: Log raw reply.done arrivals from the S2S service (sid, status) and warn when the S2S socket closes while a reply is still active, so silent drops are visible server-side.
- 2ca5d1f: Instrument slow reply_done dispatches with warn-level logs (session id, duration, hadTurnPromise) to help diagnose event-loop starvation under load.

## 1.4.4

### Patch Changes

- 74341a4: fix(aai): dedup duplicate S2S reply.done and speech.stopped events to prevent client-side cascades in the voice session wire protocol

## 1.4.3

### Patch Changes

- 62d5a99: Fix pipeline mode: play greeting, emit a single agent_transcript per turn, open TTS at the client's playback sample rate, stop the Cartesia adapter from eagerly rotating its context (which was silently dropping in-flight audio chunks), and skip the wire `context.cancel()` when the context is already final on Cartesia's side (avoids a benign 400 that was killing the session).

## 1.4.2

### Patch Changes

- f877a6f: Fix pipeline mode: play greeting, emit a single agent_transcript per turn, open TTS at the client's playback sample rate, and stop the Cartesia adapter from eagerly rotating its context (which was silently dropping in-flight audio chunks).

## 1.4.1

### Patch Changes

- 63de397: Pass explicit baseURL to createAnthropic so the SDK's loadOptionalSetting returns before reading process.env['ANTHROPIC_BASE_URL']. The Deno platform server runs without --allow-env, and the missing baseURL caused pipeline-mode sessions to crash on first use.

## 1.4.0

## 1.3.2

## 1.3.1

### Patch Changes

- 5a9f3d5: Pipeline session concurrency fixes: serialize turns across duplicate STT finals, bound TTS flush with abort+timeout, cascade provider errors to terminate session, atomic provider open, snapshot conversation history in tool executions.

## 1.3.0

### Minor Changes

- f1a9764: Internal: manifests now classify session mode (`s2s` | `pipeline`) at parse time, and expose optional `stt`, `llm`, and `tts` fields on the `Manifest` type. Groundwork for upcoming pluggable provider support — no user-visible behavior change yet.

### Patch Changes

- c95212a: Fix runtime crash when loading the host runtime without the provider SDKs installed. `ai`, `assemblyai`, and `@cartesia/cartesia-js` are now regular dependencies instead of optional peer dependencies — the runtime eagerly imports `pipeline-session.ts`, so they were already required at module load even for S2S-mode agents. Optional peer deps described a design the code didn't enforce; now the metadata matches behavior.
- f1a9764: Fix PipelineSession: thread agentConfig.maxSteps into streamText via stopWhen: stepCountIs(n). Vercel AI SDK v6 defaults to a single step, so multi-step tool use would silently terminate after the first tool-result.
- f1a9764: agent() helper accepts stt/llm/tts fields directly, removing the need for the spread workaround in pipeline-mode agents
- 0231114: Simplify pipeline-session state management and parallelize provider open. Removes redundant PipelineState variable (equivalent to turnController != null), opens STT+TTS concurrently via Promise.allSettled (halves session-start latency), and cleans up either session if one open fails or the session aborts mid-open.
- 8a79282: Add sendAudioRaw to S2sHandle for batch-encoded audio frames

## 1.2.3

### Patch Changes

- 6a44b5b: Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.

## 1.2.2

### Patch Changes

- 534122c: Harden secrets: PBKDF2 key hashing, versioned encryption, per-agent HKDF salt, env size limit

## 1.2.1

### Patch Changes

- 7af69b8: Fix gVisor/Deno binary discovery in distroless Docker images

## 1.2.0

### Minor Changes

- ed0dfbb: Add allowedHosts manifest field and host-proxied fetch for sandbox agents

### Patch Changes

- 231ebc1: Fix Docker build (missing unzip, CI=true for pnpm) and add test:adversarial command with CI integration

## 1.1.0

### Minor Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

### Patch Changes

- 41fab1a: Remove dead code: unused exports, wrappers, and test hooks

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

### Patch Changes

- 76d25d4: Stop re-exporting test-only conformance suite from runtime barrel; this previously pulled `vitest` into the production bundle and crashed the deployed server with ERR_MODULE_NOT_FOUND.
- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.

## 1.0.1

### Patch Changes

- 5517333: Simplify codebase: fix SSRF bypass in sandbox builtins, deduplicate utilities, strengthen types
- 5d55c12: Remove unnecessary comments that restate obvious code
- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases

## 1.0.0

### Major Changes

- 837e34f: Remove self-hosted ./server API. Platform sandbox now uses Deno guest runtime with NDJSON transport.
- 7669733: Migrate aai-ui from Preact to React 19 with simplified API: useSession, useTheme, useToolResult hooks + two-tier defineClient

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- ab98c61: Remove unused SDK features: `tool` alias, `ctx.fetch`, `onError` hook, `toolChoice: "none"` and `toolChoice: { type: "tool" }` variants. Add `ToolResultMap` typing to solo-rpg template.
- 14d0653: Remove kv.list() and kv.keys() from KV API — use explicit index keys instead
- 5fd5cb3: Zod-based agent.ts authoring with agent() and tool() helpers, rename aai-core to aai

### Patch Changes

- 3bd18a9: Fix security vulnerabilities: run_code sandbox escape, SSRF wiring, credential key enforcement, DNS rebinding, path traversal, harness auth bypass, timing-safe hash comparison
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- b9b5c02: Deduplicate shared utilities, fix N+1 KV list, async static serving, and race timer leak
- 99db30d: Simplify protocol, security boundaries, and SDK structure
- 5cc9550: Security hardening: deploy ownership check, SSRF DNS fail-closed + hostname blocking, timing-safe auth tokens, run_code timer cleanup, WebSocket payload limits, message buffer cap, clientFiles size limits, HTML escape completeness, KV error sanitization
- 4c1cd20: Remove duplicate startSession patterns and dead resumeFrom plumbing
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 9d2141b: Simplify and refactor: eliminate duplicated code, fix leaky abstractions, improve hot-path efficiency
- 05f8759: Replace hand-rolled utilities with dependencies: dotenv for .env parsing, mime-types and escape-html in dev server, p-debounce for file watcher
- 1678546: Simplify codebase: use p-timeout for shutdown, html-to-text for HTML conversion, deduplicate secret key validation
- 64d83b6: Add Zod validation to NDJSON guest-to-host responses, fix session state memory leak
- 6d3ec72: Improve S2S load test concurrency: quiet mode, staggered ramp-up, zero-copy audio buffers

## 0.12.3

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform

## 0.12.2

## 0.12.1

### Patch Changes

- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability

## 0.12.0

### Minor Changes

- 99e62c3: Remove `memoryTools()` and the `"memory"` builtin tool. Users who need KV-backed memory tools should define them directly in their agent's `tools` record.

## 0.11.1

### Patch Changes

- c25ee7e: Trigger deploy for SDK and server

## 0.11.0

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

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

## 0.10.3

### Patch Changes

- 8d5f616: Use Hono builtins for WebSocket, security headers, and HTML escaping

  - Replace manual WebSocketServer + upgrade handling with @hono/node-ws
  - Replace custom escapeHtml() with Hono's html tagged template
  - Replace manual CSP string with secureHeaders middleware
  - Fix aai rag to use local dev server in dev mode
  - Fix vector upsert model loading in local dev mode
  - Add missing aws4fetch dependency for unstorage S3 driver

## 0.10.2

### Patch Changes

- 9de059e: Add repository.url for npm provenance, fix circular dependency, bump CI actions
- 1397f37: Fix Fly deploy config path and CI improvements

## 0.10.1

### Patch Changes

- aa23a1c: Add repository.url for npm provenance, fix circular dependency, bump CI actions

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

## 0.9.4

### Patch Changes

- Release all packages with version increment

## 0.9.3

## 0.9.2

## 0.9.1

### Patch Changes

- Update

## 0.9.0

### Minor Changes

- Updated toolchain
