# packages/aai/host — transport harnesses, and the workflow engine

The randomized and replay-based harnesses that exercise `host/`'s transports
end to end, plus the workflow engine/store/API internals. They live in their own
guide because `packages/aai/CLAUDE.md` sits at the 120,000-character cap
(`pnpm check:claude-md`) and these are the most self-contained sections in it:
everything else in that file describes behaviour an author has to know while
writing an agent, while these describe how the transports are *tested* and how
the workflow machinery works underneath the authoring API. The package guide
keeps a pointer here; the root guide's "Package-specific suites" table names
this file.

Everything else about `host/` — session modes, the defaults table, telephony,
SSRF, the self-hosted server, `ctx.state` — stays in `packages/aai/CLAUDE.md`.
Read that first. The workflow ENGINE, store and HTTP API are documented below;
the authoring contract for `workflow()` (what a step is, the replay rules) stays
in the package guide, which points here.

## Pipeline-transport interleaving fuzz

**`aai` has a randomized interleaving fuzz over the pipeline transport**
(`host/integration/pipeline-fuzz.integration.test.ts`, run by
`pnpm --filter @alexkroman1/aai test:integration`; needs no API keys). The
scripted specs in `host/transports/` each assert ONE interleaving; this drives
random event orderings and checks GLOBAL invariants — turn serialization, no
callback after `stop()`, no write to a closed provider session, reply-text
integrity, no audio after a reply's own `replyDone` — plus the strongest
oracle, validating every LLM request payload the way Anthropic and OpenAI do
(an unmatched `tool` result is a hard 400). That oracle is what surfaced the
`capLlm` bug (see the `maxHistory` row in the package guide's defaults table).
Two rules when extending it: **an oracle must be a property a real provider or
client enforces**, and **the generator must not itself break a provider
contract** — an early draft emitted TTS audio at arbitrary moments, and the
truncation oracle fired on the generator rather than the transport. It also
asserts COVERAGE FLOORS (barge-in, tool execution, history trimming, reply
completion): an all-green fuzz proves nothing if the random walk never entered
the state, so a suddenly greener result is usually a broken generator, not a
fixed bug. Discovery and regression are separate jobs — findings get a
deterministic spec of their own (the `capLlm` one lives in
`pipeline-history.test.ts`), because whether a random walk reaches a given
alignment is luck. That is measured, not assumed: reverting the `capLlm` fix
leaves this suite GREEN (both before and after it moved to fast-check) while
`pipeline-history.test.ts` fails immediately. The step count carries an unusual
`minLength`, because a run spends its first steps getting the session past
`start()` and shorter scripts finish before a reply ever completes.

- Its generated world (`_pipeline-fuzz-input.ts`) is split from the spec, and
  the MODEL — the request-payload validator, the `Monitor`, and
  `createCallbacks`, which is every client-visible callback wired to its oracle
  — from `_pipeline-fuzz-model.ts`, so the spec file is the properties, the
  driver and the coverage floors. Note biome's `noSecrets` rule is off for
  `**/_*-fuzz-*.ts` alongside test files (`biome.json`): a camelCase action
  name like `armBargeInFromTool` reads as high-entropy to it, and mangling a
  domain identifier to satisfy a false positive is the wrong trade.
- **Its fatality oracle needed a generator change to mean anything.** "Nothing
  conversational may reach a client that was told the session is over" passed
  on arrival — the fake LLM could not fail a turn, so the state was
  unreachable and the oracle decorative. The script pattern now carries a
  `fail` turn (an `error` stream part) and the instrumented `doStream`
  sometimes refuses outright, which are separate reporters; it then failed at
  once, on `onReplyDone`/`onSpeechStarted` after a fatal `llm` error. Hence
  the floors on `error:llm`, `llmRefused`, and `nonFatal:llm`: the first two
  keep the state reachable, the third turns a regression to `fatal` into a
  failure rather than a silent gap.
- **`preemptiveGeneration` is part of the generated world**, so both arms run in
  one property. It ADDS guardrail 1 as a global oracle (nothing may reach TTS
  between a cleanly completed reply and the next `onReplyStarted` — exactly the
  idle window a speculation runs in) and floors on speculations started /
  discarded-by-reason. It also COSTS two things, and both are stated in the code
  rather than quietly absorbed: the exact-text reply-integrity oracle is skipped
  in the ON arm (a speculation's text cannot be attributed to a reply at the
  moment it is served, and guessing is how a harness invents findings), which is
  why `replyIntegrityChecked`'s floor is the one floor in the file that has ever
  moved DOWN; and the turn-serialization bound widens, since a speculation is
  deliberately outside the turn chain. Two rules this suite does NOT guard,
  despite looking like it might: the per-utterance BUDGET (deleting the check
  leaves it green — only one speculation is ever held, and the 1 ms
  `speechIdleTimeoutMs` restores the budget before a third could fire) and
  ADOPTION (reached 0-6 times per run, too rare to floor, on the `resumeMooted`
  precedent). `transports/pipeline-speculation.test.ts` and
  `transports/pipeline-preemption.test.ts` own those. `PIPELINE_FUZZ_COVERAGE=1`
  prints the counter table, as `S2S_FUZZ_COVERAGE=1` does for the S2S property.

## S2S property test

**`aai` has a fast-check PROPERTY TEST over the S2S stack**
(`host/integration/s2s-fuzz.integration.test.ts` plus `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`; same command, also keyless).
It differs from the pipeline fuzz twice over — in what it composes, and in how
it generates.

- **The only fake is the SOCKET.** `connectS2s` (wire parse + dispatch),
  `createS2sTransport` (resume, tool-result redelivery, audio suppression) and
  `createSessionCore` (turn lifecycle, tool execution) all run for real, with
  a recording `ClientSink` at the far end. That is the point: every S2S spec that
  predates it stubs out a neighbouring layer (the transport specs mock
  `connectS2s`, the wire specs mock the callbacks), and all three bugs it found
  live in the seam BETWEEN layers, with every layer's own suite green.
- **Model-based COMMANDS, where the pipeline fuzz generates a script.** Both
  are fast-check; the difference is that legality here lives in each command's
  `check()` against a model that IS the provider state machine, so an illegal
  frame is never generated (no audio outside a reply, no `reply.started` while
  the service awaits a `tool.result`) and a counterexample contains only the
  commands that ran. Reverting each of the three fixes reproduces it from
  `[session.error(rate_limited)]`, `[drop.transient, openSocket,
  session.error(session_not_found)]`, and `[drop.transient]` — one, three, and
  one command.
- **No timers anywhere.** Socket opening and tool settlement are COMMANDS, so
  when a tool settles relative to a drop is part of the generated plan rather
  than a race. That is what makes shrinking and replay mean anything: this
  suite's own first draft awaited real `setTimeout`s, could not re-run its
  counterexamples, and intermittently reported a finding no rerun could
  reproduce. It is also why it runs in ~150ms rather than ~50s — the
  per-command drain is a `setImmediate`, not a ~1ms timer.
- **Three properties, differentiated by a per-run `faultBudget`** (0 / 2 / 3):
  turns, reconnects, retirement. One combined property cannot serve both ends
  — at 2 faults per 40 commands a tool call rarely survived to be answered (the
  central oracle ran 7 times out of 80 executions), and at 0 there are no
  resumes to redeliver across.
- Oracles: a tool call the service issued gets exactly one `tool.result` (zero
  leaves the service holding a turn it can never continue — the user hears an
  agent go silent until the idle timeout); nothing conversational reaches a
  client that was told the session is over; at most one fatal `connection`
  error per session, and no socket opened after it; no socket left open after
  `stop()`; `session.resume` only ever names an id the service issued. The
  streaming ones live in the harness's sink and THROW, so fast-check shrinks;
  the end-of-run ones run before `stop()`, which legitimately abandons work.
- **A resumed session inherits the dead socket's unanswered tool calls** —
  that is what `session.resume` MEANS, and it is the premise the tool-answer
  oracle rests on. Stop modelling it and the oracle stops meaning anything.
- **A finding is only reachable if the run does not excuse it first.** The
  tool-answer exemptions (interrupted turn, client reset, retired session, link
  not ready, a SIBLING call of the same reply still running — results flush per
  reply as a BATCH) are broad enough to silence the oracle completely, so each
  increments a `skip:<why>` counter and the floors are on the CHECKED counts.
  `toolAnsweredAcrossResume` has been near zero through three separate
  mistakes; it is the floor that stands between a live oracle and a decorative
  one. `S2S_FUZZ_COVERAGE=1` prints the table.
- **The fakes' fidelity is where the false findings came from**, every time.
  Three drafts blamed the transport for behaviour their own fake had invented:
  a `executeTool` that ignored its abort signal (the real one settles promptly
  via `pTimeout({ signal })`, so `stop()` was reported as hanging forever), one
  that ignored an ALREADY-aborted signal (which is exactly what a `tool.call`
  after a client cancel receives, since `onCancel` aborts the reply without
  replacing it), and one that rejected where the real executor always RESOLVES
  with a `toolError(...)` string. Check the real collaborator's contract before
  believing a finding.

## Fixture replay testing

Tests in `packages/aai/host/` use a **hybrid mock** pattern: a real
`Runtime` and tool executor with mocked S2S WebSocket connections. JSON
fixtures in `host/fixtures/` contain recorded AssemblyAI API messages
that are replayed through the real orchestration layer. Key helpers:

- `makeMockHandle()` — creates mock S2S WebSocket using nanoevents
- `replayFixtureMessages()` — dispatches fixture JSON as typed events
- `createFixtureSession()` — wires a real Runtime to mocked S2S

## Workflow engine, store and HTTP API

**Recovery is lease-based, not timer-based.** A claim
(`WORKFLOW_LEASE_MS`, 120s) is what stops two sandboxes replaying one run, and
a `running` run whose lease EXPIRED is claimable again — that is the whole
mechanism by which a dead sandbox's run continues, and why the status set has no
"crashed". `runDue()` runs once per runtime boot and sweeps due sleepers,
unclaimed runs, and abandoned ones. A drain therefore must NOT fail an in-flight
run: `close()` aborts `ctx.signal`, the catch leaves the run `running` with its
journal intact, and the next host resumes it. Marking it failed would turn every
redeploy into a graveyard of runs one step from finishing.

**A run is started over HTTP as well as from a tool** (`host/workflow-api.ts`,
mounted by `createServer` so `aai dev`, a self-hosted server and every deployed
guest serve it identically — the same reasoning `/phone` is mounted there):

```text
GET  /workflows            → { workflows: [{ name, description? }] }
POST /workflows/runs       → { runId }        body: { workflow, input? }
GET  /workflows/runs/:id   → a WorkflowRunSnapshot
POST /workflows/blobs      → { blobId, bytes }  body: raw bytes
```

That closes the "no trigger surface" gap this section used to record: a cron job,
a webhook relay, a script or a page can all start a run.

**A run that is EXECUTING no longer needs a visitor to finish, and that used to
be the dominant gap.** The guest measured "does anybody need me" by its live
SESSION count, and a `page: "static"` app has none by construction — so the
five-minute idle timer fired mid-run every time, and the journal then paid a
120s lease plus a visitor to continue. `WorkflowEngine.busy()` is the second
input to that decision (true while a run is in flight or a near-term wake timer
is armed), read by the guest's idle controller through
`SessionRuntime.workflows`. Verified against a real Postgres: a 12-second run
held its sandbox open under a 3-second idle window with zero sessions, and the
guest still exited 3 seconds after the run completed.

Two properties that decision has to keep. It defers the IDLE exit and NOT a
DRAIN — a drain retires the sandbox for a redeploy, every run is resumable on
the replacement, and holding a blue-green handover open for a three-hour run
would stall the deploy to save work that is not lost. And `busy()` is FALSE for
a sleeper past `MAX_WAKE_TIMER_MS` (60s): holding a billed container open for a
six-hour `ctx.sleep` is exactly what suspending the run releases it to avoid.

**What is still NOT wired is the platform WAKING a sandbox that is gone** — for
a long sleeper, or for a run abandoned by a crash, an OOM or a redeploy. Those
resume on the next boot (`runDue()`), so they wait for whatever next brings the
agent up. The substrate exists in the platform Postgres (`pg_cron`, `pgmq`,
`pg_net` — see `packages/aai-server/CLAUDE.md`), and the discovery half is
already demonstrated there: the orphan-preview sweep reaches each app's own
schema through the `app-db:<slug>` vault secret, with an identifier-shape
assertion so a corrupt meta cannot steer it.

**`/blobs` exists because bytes may not travel in the journal, and that is the
one non-obvious thing about this surface.** Replay re-reads every step output and
the run input on every resume, so audio or a document in either is re-read
forever and counts against `MAX_DB_RESULT_ROWS`. A browser cannot reach `ctx.db`
to put them anywhere else. So an upload lands in `aai_workflow_blobs` (the app's
own schema), the run is started naming the id, and the workflow reads it with
`ctx.blob(id)` INSIDE the step that needs it and `ctx.releaseBlob(id)` when done.
Blobs are swept on age (`WORKFLOW_BLOB_TTL_MS`, 24h, from `runDue()`) because an
upload whose run was never started is referenced by nothing. Note releasing must
happen AFTER the step that consumed it is journaled, never inside it: inside, a
crash between the API call and the journal write leaves the retry with nothing to
read, which turns at-least-once into a run that can never finish
(`transcription-desk`'s loop says so in place).

**The API is as public as `/websocket`, and an operator can close it.** A page
carries no credential — it is served to anyone with the URL, exactly like the
voice client — so requiring one by default would mean no static page could work,
and the existing posture is identical (anyone who knows a slug can open a voice
session and spend the tenant's provider budget). The genuine difference is the
COST SHAPE: a run outlives the request that started it, so a loop of cheap POSTs
queues far more work than a loop of sessions can. `AAI_WORKFLOW_API_TOKEN` in the
agent env makes every route require it as a bearer, checked BEFORE the engine is
resolved so an unauthenticated caller cannot even make a guest build its runtime.
Fail-OPEN when unset is the documented default, not an oversight.

The body caps (`MAX_WORKFLOW_INPUT_BYTES`, `MAX_WORKFLOW_BLOB_BYTES`) are counted
from the STREAM rather than from `Content-Length`, and an over-limit body is
discarded as it arrives rather than answered by destroying the socket — both
decisions are argued on `readBody`'s own doc comment, which is where to read
before changing either.

**The 413 is mapped in the ROUTER, not per route**, because the route that forgot
to is how the split was found: `/blobs` caught the over-limit rejection and
`/runs` did not, so an oversized input answered `500 Internal server error` —
"the agent is broken" where the caller needed "this body is too big". `readBody`
rejects with a private `BodyTooLargeError` and the router's catch turns it into
the 413, so a fifth route that reads a body inherits it.

**Every jsonb parameter in the store is bound `::text::jsonb`, and the whole
journal is wrong without it.** Bound straight to `$n::jsonb`, the `postgres`
driver JSON-encodes the string the store already stringified — so a run input
comes back as a STRING (a `run` body that iterates it dies on "not iterable"), a
step returning `"text"` replays as `"\"text\""`, and a completed run's `output`
reaches the HTTP API double-encoded. Every JSON type is affected, measured
against a real Postgres 16.

**Nothing in the unit suite can see it**, which is the part worth remembering:
the engine's specs run on the in-memory store (`_workflow-test-utils.ts`), which
holds JS values directly, so a fake that is more permissive than the driver
beneath it hid a bug on the only production path. It was found by standing up a
real Postgres and running a real agent, and it is pinned as statement TEXT in
`workflow-store.test.ts` — including a sweep asserting that NO write binds a
parameter directly to `::jsonb`, so a fourth jsonb column cannot reintroduce it.
The full argument, including why passing the raw value instead is worse (a step
returning a bare `true` fails with "cannot cast type boolean to jsonb"), is on
`createPostgresWorkflowStore`.
