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

## Provider sockets disable permessage-deflate

**`ws` defaults `perMessageDeflate` to TRUE on clients and FALSE on servers.**
That asymmetry is the whole gotcha: inbound session sockets
(`WebSocketServer` in `host/server.ts`) decline compression for free, while
every outbound provider socket OFFERS it, and any provider whose server
accepts leaves us holding a zlib deflate+inflate context per socket for the
life of the session. Measured on 200 client sockets exchanging PCM16 frames,
peer accepting vs declining: **+321 KiB RSS per socket** (405 vs 84) and
**~4.5x the CPU** for the same audio (2223 ms vs 491 ms). Pipeline mode opens
two provider sockets per session, so it is paid twice per concurrent call —
more than every other per-session allocation combined, on the one path that
scales with concurrency.

It also buys nothing: these sockets carry PCM16, base64 of it, or an
already-compressed codec. None of that deflates.

So every provider-facing socket spreads `PROVIDER_WS_OPTIONS`
(`host/_ws.ts`) — `defaultCreateHeaderWebSocket` (S2S + OpenAI Realtime),
`providers/tts/rime.ts`, `providers/tts/assemblyai.ts`,
`providers/stt/soniox.ts`. **A new provider that constructs its own `ws`
client must do the same**; `host/_ws.test.ts` pins the wire behaviour against
a server that offers the extension, and the three adapter suites assert the
constructor option.

The vendor-SDK providers (`assemblyai` STT, `@deepgram/sdk`,
`@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`) keep their WebSocket
private and expose no option to pass through, so they are NOT covered — their
compression behaviour is whatever the SDK and the provider negotiate. Worth
re-checking if one of them shows unexplained per-session memory.

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
GET    /workflows            → { workflows: [{ name, description? }] }
POST   /workflows/runs       → { runId }         body: { workflow, input?, key? }
GET    /workflows/runs       → { runs }          ?workflow=&key=&limit=
GET    /workflows/runs/:id   → a WorkflowRunSnapshot
DELETE /workflows/runs/:id   → { runId, cancelled }
POST   /workflows/blobs      → { blobId, bytes } body: raw bytes
```

That closes the "no trigger surface" gap this section used to record: a cron job,
a webhook relay, a script or a page can all start a run.

Three shapes in that table are easy to get wrong. **`GET /runs` is the collection
and `GET /runs/:id` is a member**, differing by one slash, so the exact match is
ordered BEFORE the prefix match — otherwise the collection reads as a run whose
id is the empty string. **The find route reads its query off `req.url`**, because
`server.ts` splits the query off before dispatching and every other route here is
an exact path match, so this is the first one that needs it. And **`DELETE`
answers 200 either way**, carrying `cancelled: true|false`: a 404 would conflate
"no such run" with "already finished", and two tabs pressing Stop is ordinary.

**Cancellation is prompt only where the run is EXECUTING.** `cancel` writes the
terminal status and then aborts that run's own `AbortController` — one per
in-flight execution, combined with the engine's shutdown signal via
`AbortSignal.any`, so a workflow body sees a drain and a cancel through the same
`ctx.signal`. A run in flight on ANOTHER replica has no such handle here, and what
stops it is the store rather than a signal: `suspend`/`complete`/`fail` all carry
`status in ('pending','sleeping','running')`, so that replica finishes its current
step and finds its terminal write refused. The status a caller reads is `cancelled`
either way; the difference is only how much work was wasted. Two details follow
from that. `execute` distinguishes "aborted by cancel" from "abandoned by drain"
(the run's own controller, not the shared signal) so a cancelled run is not
recorded as `failed` over the status the caller asked for — and `recordStep` is
deliberately NOT gated on a live status, because the step already ran and a journal
that records what happened stays truthful for a run cancelled underneath it.

**A determinism violation is reported by comparing the journal against what a
replay CLAIMED.** Step ids are `<kind>:<name>#<ordinal>` assigned by call order,
so a body whose sequence varies between replays computes different ids: the
lookup misses, the step runs a second time, and its earlier result is orphaned —
silently, with the run still completing and its journal growing toward
`MAX_WORKFLOW_STEPS`
on every replay. So `buildContext` records every id it hands out and `execute`
reports, in a `finally`, any journaled id nobody claimed. **It needs no exemption
for a suspended run**, which is the non-obvious part: at every unwind point an
execution has necessarily walked past every entry a previous life recorded, because
the only way to reach a later `sleep` is through the earlier ones. It reports
rather than throws — the work is already done, and failing the run would lose
output over a warning.

**A step output is refused before it is journaled if it cannot survive JSON**
(`findUnjournalable`, in `sdk/workflow.ts` so `@alexkroman1/aai/testing`'s
`createWorkflowContext` runs the same check in an author's own suite). Not retried:
a `Date` or a `Map` is an authoring mistake, not a transient failure, and the whole
point is to fail on THIS execution rather than hand the resume a different value.
The walk reports the property path, unwinds its `seen` set per branch so a DAG is
not mistaken for a cycle, and accepts `undefined` because the store writes it as
`null`.

**The correlation key is a column, added by an `alter table`** rather than only
in `create table if not exists` — an app whose journal predates it would
otherwise keep the old shape forever and fail every `start({ key })` on an
unknown column.
Its index is PARTIAL (`where correlation_key is not null`): most runs carry no key,
and indexing those nulls would tax every insert for a lookup that cannot match
them.

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

**That control did NOTHING on deployed agents until 2026-08-11, which is the
worst shape for one to fail in.** `createServer` reads the token out of its `env`
option, and the guest's agent mode passed no `env` at all — so an operator who
set the variable, read this paragraph, and verified the deploy got an API as open
as before, with nothing anywhere reporting it. Agent mode now forwards exactly
that one key (never the whole agent env, which would also make host mode
reachable for any agent whose own env sets `AAI_ALLOW_HOST`). It is pinned in
`aai-server/agent-server-integration.test.ts` against a REAL harness, because the
wiring is the bug: every layer below the boot contract was correct on its own.

The body caps (`MAX_WORKFLOW_INPUT_BYTES`, `MAX_WORKFLOW_BLOB_BYTES`) are counted
from the STREAM rather than from `Content-Length`, and an over-limit body is
discarded as it arrives rather than answered by destroying the socket — both
decisions are argued on `readBody`'s own doc comment, which is where to read
before changing either.

**"No workflows" and "no runtime" are DIFFERENT answers.** An engine resolver
that returns undefined means the app declared none (or storage is off) → 404. One
that THROWS means the runtime could not be built → 500 carrying the reason. They
were conflated, and the message that came out denied the premise: a guest with a
missing provider key answered "This app declares no workflows" for an app whose
workflows were declared and fine, while the only statement of the cause
("AssemblyAI LLM: missing API key") went to the guest log, which the author of a
deployed agent cannot see. Verified live against a real guest: `GET /workflows`
and `POST /workflows/runs` both now answer 500 naming the key and its env var. The
router catches the throw, so a request still cannot crash the guest.

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

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have actually heard, marked `[interrupted]` — not everything the model produced.
A reply cut before anything was audible records **nothing at all** (its
completed tool steps still do). That is LiveKit's rule, and it exists because
TTS runs behind the text: a barge-in discards whatever is still in the
provider's buffer, so the old record told the model it had delivered
information the caller never got, and the model then never repeated it.

**One cursor, one owner** — `host/transports/pipeline-heard.ts`
(`createHeardTracker`). It answers exactly one question: given this reply's TTS
text and its forwarded audio, which characters did the caller hear? History
truncation and the false-interruption resume anchor (`buildTailResumePrompt`)
are two READERS of that one answer, which is what keeps the resume prompt from
quoting words the record denies. It also owns the playback clock, so the
barge-in gate reads the same object.

Two tiers of accuracy, decided at RUNTIME rather than by a capability flag:

| provider | timings | cursor |
| --- | --- | --- |
| AssemblyAI TTS | `WordBoundaries` frames, parsed in `providers/tts/assemblyai-words.ts` | last word whose audio WHOLLY elapsed |
| Cartesia | `add_timestamps` exists in the SDK, not wired up | proportional estimate, snapped to a word |
| Rime | a `timestamps` frame exists, unmodelled | proportional estimate, snapped to a word |

A provider that reports nothing degrades to exactly the estimate that was there
before, so nothing regresses; the zero case needs no timings at all. Both
roundings err toward UNDER-keeping, deliberately: over-keeping is the measured
failure, while under-keeping costs a word or two of redundancy that the resume
prompt's "without repeating what they already heard" absorbs.

**The lag is `HEARD_AUDIO_LAG_MS` (750) and it is DERIVED, not measured** —
`PLAYBACK_JITTER_MS` (400, real) plus an assumed sub-second network hop. It is
the counterpart of `PIPELINE_PLAYBACK_GRACE_MS` with the opposite sign, and a
separate constant on purpose: the grace errs late because a spurious cancel is
harmless, while this one is subtracted from a position where erring either way
costs. See both constants' docs.

**The client's committed transcript and the history entry now diverge on
purpose.** The caption still shows everything that reached TTS, because it was
published as interims while the audio was being synthesized. It CANNOT be
corrected after the fact to match the shorter record: emitting an
`agent_transcript` after `cancelled` is the measured 19-of-73 double-transcript
bug (`persistInterruptedTurn` in `pipeline-history.ts` — read it there).

Two mechanisms this leans on: the audio gate (a cancelled turn's late audio AND
its late word timings are both dropped by it, so no second epoch was invented),
and `emitText`'s `record` flag, which now decides what may be truncated into
history as well as what reaches `onDelta` — filler is audible, so it moves the
heard POSITION, and is never recordable. The TTS coalescer flushes when that
flag flips so no batched send ever mixes the two.

**Not covered: a barge-in during the TTS drain.** `runTurn` has already
committed the full text by then, so that case keeps `buildTailResumePrompt` as
its only mitigation (which this change makes word-truthful). Fixing it means
deferring the history commit until after the drain — a change to `runReply`'s
body contract, deliberately separate.

## Is a run really durable? — the restart suite

Two files answer the question the whole mechanism is sold on, and they are the
same property at two levels of realism:

- **`host/workflow-restart.test.ts`** (unit) — the memory store, plus the OTHER
  half of the guarantee.
- **`host/integration/workflow-restart.integration.test.ts`** (`AAI_TEST_PG_URL`)
  — the same property against a real Postgres journal.

The harness is `host/_workflow-restart-harness.ts`; read its module doc before
changing either. Four things worth carrying out of it:

- **A restart is a new ENGINE over the same store, and that is not a shortcut.**
  Everything the engine keeps in process is per-engine (`inFlight`,
  `controllers`, wake `timers`, `namesOf`, the memoized `init()`, the context
  factory), so `close()` plus a fresh `createWorkflowEngine` IS the production
  event. The suite asserts on step BODIES rather than on the run's output for
  that reason: an output can be perfectly correct while every step ran four
  times.
- **Where the crash lands is the experiment.** The workflow parks at a gate
  BETWEEN steps, so the host dies with step `i` durable and nothing in flight —
  the one instant where the guarantee is exactly-once. A crash INSIDE a step
  body is at-least-once by design and has its own test; only the between-steps
  case may assert a count of 1, and conflating them is how a suite comes to
  "prove" a guarantee the engine does not make.
- **The integration tier exists for the ENCODING, not for realism in general.**
  The memory store holds JS values, so a step output that survives a restart in
  the fake can come back double-encoded from Postgres and replay would hand the
  resumed run a string where it wrote an object — the `::text::jsonb` hazard
  `workflow-store.ts` documents, invisible above that line. Each journaled value
  is therefore an object with a NUMBER read back numerically by the workflow
  itself, so a bad round trip fails inside the run.
- **Each restart takes a new connection POOL as well as a new engine** in the
  integration tier, which is the other half of what a restarted process does not
  keep. The lease is expired by hand between restarts; waiting out the real
  `WORKFLOW_LEASE_MS` per step would cost two minutes to observe nothing, and
  the claim rule exercised is `lease_until < now()` either way.

**Running it is what found the `42701` notice leak.** `ADD_RUNS_KEY` is an
`alter table … add column if not exists`, which raises duplicate_COLUMN — a
SQLSTATE `postgres-db.ts`'s notice filter did not carry — so every engine after
the first logged `column "correlation_key" … already exists` into a log the guest
relays to the platform. That is the exact noise the filter exists to remove, from
the exact caller it was written for, and no unit test can see it because the
notice comes from the driver rather than from our code.

## `speech_started` means "the agent is yielding", on BOTH transports

The two transports derive this event differently and a client cannot tell them
apart, so pipeline mode holds it back to match S2S rather than emitting what it
happens to know. In S2S the service fires its speech-started the moment it stops
generating, so the event coincides with a real interruption. Pipeline mode has
no VAD and derives the edge from the STT transcript stream, where the FIRST
non-empty partial opened it — one word of a cough, a backchannel, or a phrase
the caller addressed to someone else in the room. `minBargeInWords` and
`interruptionMinDurationMs` correctly declined to abort the reply for those, so
the agent kept talking; the client had been told it stopped.

**That divergence is not cosmetic, because clients act on it.** tau2-bench's
harness DISCARDS its entire agent playout buffer on `speech_started` and has no
`cancelled` handler at all — so the one event that really means "the agent
stopped" is ignored, and the one that did not is treated as authoritative. A
reply still being spoken was thrown away mid-sentence. `aai-ui` reads the same
event as informational (it only clears the caption; playback stops on
`cancelled`), which is why this never showed up in the browser.

Measured by replaying the benchmark's own recorded caller audio against a live
pipeline agent (the `scripts/voice-replay/` harness, since removed), on the
run's 10 conversations richest
in these signals: **184 `speech_started` against 87 `cancelled` — 53% of the
events the client acted on were not interruptions at all.** The agent yielded
to non-directed speech on 12 of 12 occasions and then sat silent a median 5.9s
(these are real barge-outs, not inter-sentence gaps: only 2.5% of natural gaps
between agent segments are ≤0.6s).

So while the agent holds the floor the edge is HELD, and released only when a
barge-in really fires (alongside `cancelled`) or when the agent stops speaking
on its own — `createGatedSpeechEdges` in `pipeline-user-speech.ts`. While the
agent is silent it passes straight through: there is no floor to yield and the
event just means "listening". Live captions are unaffected either way, because
`user_transcript_partial` is emitted independently of the gate.

The property to preserve — and what the specs in `pipeline-voice-events.test.ts`
pin — is that **the score no longer depends on how the client reads the event**.
Across the panel, the spread between a client that truncates on
`speech_started` and one that truncates on `cancelled` collapsed from up to
**66.7 points** (R_Y 89.7% vs 46.7%; S_BC 33.3% vs 100%) to **≤2.7 points**
(R_Y 44.1% both ways). Note which direction R_Y moved: the benchmark's
flattering 90% yield rate was an ARTIFACT of the same bug that wrecked
selectivity — truncating on a signal that arrives ~470ms after the first partial
makes yields look instant. A correct client's yield rate against the old code
was already 46.7%. Do not read the drop as a regression, and do not "fix" it by
reverting the gate.

## The journal's schema is MIGRATED, not re-created every boot

`workflow-schema.ts` holds the DDL and an ordered `MIGRATIONS` list; `init()`
creates a ledger table (`aai_workflow_migrations`), reads which ids are already
applied, and runs only what is missing.

It used to run every `create … if not exists` on every boot. That is idempotent
and therefore looked free, and it was not: Postgres raises a NOTICE per no-op, so
a healthy app logged six or seven per engine into a log the guest relays to the
platform — and one of them (`42701`, from `alter table … add column if not
exists`) was missed by the driver's notice filter, which is how the cost became
visible at all. Nothing re-running is what removes them.

Three properties to keep:

- **Every statement stays individually idempotent**, and that is required rather
  than defensive. Apps deployed before the ledger existed have the tables and no
  record of them, so `0001` and `0002` will run against a populated schema exactly
  once and must be no-ops there. A future migration may drop `if not exists` only
  if it can never meet a schema that already has it, which for a shipped SDK is
  never.
- **Append only.** A released id is a fact about somebody's database. Order is
  load-bearing too — the steps table's foreign key needs the runs table, and the
  correlation-key index needs the column an earlier migration adds — and
  `workflow-store.test.ts` pins both orderings.
- **Dropping the journal means dropping the LEDGER with it.** A schema whose
  record claims tables that are gone reads as fully migrated, so `init()` creates
  nothing and every query fails with `relation "aai_workflow_runs" does not
  exist`. That is the shape an operator hits after a manual `drop table`, and the
  integration suite reproduced it by forgetting exactly this.
