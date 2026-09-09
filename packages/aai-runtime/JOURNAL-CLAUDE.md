# JOURNAL-CLAUDE.md — the durable journal and the replay engine's decisions

A SIBLING of `packages/aai-runtime/CLAUDE.md` rather than a second package
guide, for the reason `packages/aai-server/MODAL-CLAUDE.md` is one: Claude Code
auto-loads only `CLAUDE.md`, so a sibling is read on demand and is the right
shape for REFERENCE — which all of this is. It moved here when that guide hit
its 120,000-char cap, and the rule for what may follow it is the same: a
decision somebody needs resident while working elsewhere in the package belongs
in `CLAUDE.md`; the journal's own decisions, the engine's walk, the topology of
their tests and the minutiae of what the contract does and does not promise
belong here.

The guide keeps the one thing a reader elsewhere in the package needs — which
journal a deployment gets, and in what order — under the same heading this file
opens with, and points here for the rest. It grew a second time when
`ctx.messages`' tool arm and per-tool error classification had nowhere to be
written down: the whole `## A run's journal has THREE homes` section came over
then, subsections and all, which is why the pointer stubs `CLAUDE.md` used to
carry for "An attempt is a LEASE" and "A failure of the JOURNAL is not a failure
of the RUN" are gone — the accounts they pointed at are below.

## A run's journal has THREE homes, and the order between them is a decision

`selectJournal` (`workflow-runtime.ts`) picks the replay engine's journal:
**platform, then postgres, then memory**, and the boot line names whichever won.

- **platform** — `createPlatformJournal`, one `POST /:slug/workflow-journal` per
  operation, beside the queue, session state and upload records that already work
  this way. The statements run on the platform's own database
  (`aai-server/platform-workflow-journal.ts`), which mirrors
  `workflow-journal-schema.ts` with a `slug` added to every key.
- **postgres** — `createPostgresJournal` over the agent's own `DATABASE_URL`,
  which is what a self-hosted deployment has and the platform never provisions.
- **memory** — a `Map`, for trying a workflow out before provisioning anything.

**The order is what closed the bug, and it is not "most specific wins".** A
deployed guest could reach NEITHER durable backend: the platform provisions no
tenant database, so every deployed run journaled into a sandbox that self-exits
after `AGENT_IDLE_EXIT_MS`. A step's result, its attempt count and an open
approval window died with it — and nothing reported it, because from inside the
system a step whose result was lost is indistinguishable from one never reached.
The run sat suspended looking healthy, so "durable" was true of the interface and
false of every deployment.

Platform BEFORE postgres for a second reason: a deployed guest may also carry an
author-supplied `DATABASE_URL`, and its runs belong beside its session state
rather than split across two databases with the wake sweep able to see only one
of them.

**The platform pair is read from THIS PROCESS's environment**
(`platformGuestOptions`), never the agent's — the distinction that already cost
a deployment, and the safer read besides: an agent may set any `AAI_*` key as a
secret, so under the tenant spelling an agent would choose the base URL and
bearer its own journal was sent to. `CLAUDE.md`'s "`AAI_PUBLIC_BASE_URL` is what
a THIRD PARTY dials" carries the rest.

**Memory is last and the boot line SAYS so.** A durability tradeoff absent from
the log reads as a bug, and this is the one an author is most likely to hit by
accident.

### A journal read is a round trip, and four shapes issued it N times

**The ~840 ms is DECOMPOSABLE now, and was a total for as long as it was
quoted.** Every RPC carries a W3C `traceparent` (`_trace-context.ts`) and logs
its own elapsed at debug; `aai-server`'s `withReserved` logs `waitedMs` and
`workMs` under the same id. So `elapsed - (waited + work)` is the hop, and
"was it our pool" is answerable from two log lines rather than from a guess —
which matters because `ADMIN_POOL_MAX` had already been widened once on the
assumption that it was. One span per CALL: a run's whole walk is not one trace,
which would need the trace minted at the delivery and carried through
`workflow-run-context.ts`.

Every platform-arm `JournalStore` call is one `POST /:slug/workflow-journal`,
measured at **~840 ms of server time**, on a route holding one of
`ADMIN_POOL_MAX` connections for the whole request — so these are the pool a
run's own WRITES queue behind. `use-transcript-workflow` sustained ~2 a second
on ONE run: a fan-out's `settledSince` re-reads the WHOLE journal once per step,
the overlapping walks above each do it again, and a delivery's opening was three
SEQUENTIAL round trips, then two, and is now ONE.

`_journal-shared-reads.ts` collapses the first two — `getRun`, `readSteps` and
`readSleeps` being the reads that are pure functions of a run id — and its
module doc carries the argument. The one thing to know first: it is a
**COALESCER, not a cache**, so a caller arriving mid-flight gets a TRAILING read
and none is answered from a read that started before it asked. `settledSince`
exists to rely on exactly that; a cache would silently defeat it.
`ReplayOptions.steps` is the third — the step read is issued BESIDE the
`running` compare-and-set — and `ADMIN_POOL_MAX` was widened with them (the
admin pool note under "Stateless server", `packages/aai-server/CLAUDE.md`).

**The record read joined them, and `setStatus`'s `expect` is what made that
possible.** `execute` opened with `await journal.getRun(runId)` and only then
issued the rest, so a delivery cost two round trips before a body could run;
folding the read in leaves one, nothing in the opening depending on the record.
Two things are load-bearing, both argued at the call site: a run this delivery
may not walk answers `false` rather than moving, so an eager set can neither
resurrect a terminal run nor undo an `abandon`; and a LOST eager set is
**re-asked, never believed** — issued beside the record read it can reach the
store ahead of a racing `start`'s `createRun` and decline a run that is alive,
which `workflow-concurrent-delivery.test.ts` shrinks to a step the body needed
and nothing ever ran. `workflow-engine-opening.test.ts` states both. The
speedup also moved where a cancel lands, which is why law 1 relaxes its
per-name floor for a cancelled run and `cancelsMidWalk`'s floor was
re-measured.

The FOURTH is a WAIT, and it was the worst of them because it grew with the
number of DELIVERIES rather than with the body: a settled step was answered from
the walk's snapshot and every elapsed `ctx.sleep` was still a `claimSleep` round
trip, so a polling run's traffic was quadratic. `JournalStore.readSleeps` and
"A wait was outside the whole-read guarantee" below carry the measurement and
the rule for using the snapshot.

### A clock, a random number and a uuid are AFFORDANCES

`ctx.now()`, `ctx.random()` and `ctx.uuid()` journal what they read — one value
per reach, keyed `now!0` / `random!0` / `uuid!0` in a POSITIONAL space of their
own, appended through `appendStep` so no `JournalStore` method was added and
every backend carries them already. They are the shape two shipped templates
were hand-rolling (`transcription-workflow`'s `startClock`,
`call-audit-workflow`'s two `now` reads), and `guard-invariants` rule 30 stays
the lexical backstop with its remedy naming them.

**`workflow-replay-determinism.ts`'s module doc is the argument**, and the three
decisions it records are the ones not to relitigate: their own key space (per
KIND, so inserting one shifts no other); NO attempt lease (a lease bounds
abandonment and these have no body to abandon); and one float per `random()` call
rather than a seeded sequence. A fourth thing it settles is why they RECORD a
divergence reach and never raise one — an unrecorded reach fails the next step on
a healthy resume, and raising is unsound without `claimAttempt`'s corroboration.

**Inside a `ctx.step` they are REFUSED**, by the same `currentRun()?.step` test
and for the same key-shift reason as the section below.

### A wait is keyed by NAME, and `ctx.sleep` takes a label for it

`ctx.sleep(label, until, options?)` and `ctx.waitFor(token, options?)` journal
their waits as `sleep!<label>#<occurrence>` and `hook!<token>#<occurrence>` —
name plus occurrence, exactly like `ctx.step`. The occurrence counters are PER
NAME, so a loop is one label and N rows, and inserting a wait shifts nothing.

They were two bare ordinals, and then a body reaching a different NUMBER of waits
read its predecessor's record. Two shapes, both legal code with no author mistake
in them beyond a condition:

```ts no-check
if (somethingAboutTheClock) await ctx.sleep("early", 1000);
await ctx.sleep("schedule", WEEK_MS); // sleep!1 on walk 1, sleep!0 on walk 2
```

Positionally, walk 2 read the elapsed `early` record and the week-long wait
resolved instantly, reporting `completed` with the clock unmoved. The hook
version is worse: the body is handed the other wait's PAYLOAD.
`workflow-replay-wait.test.ts`'s "a body that reaches a different NUMBER of
waits" pins all three cases and A/Bs green against positional keys.

Three things not to relitigate:

- **`label` is REQUIRED, and `Literal<Label>` types it.** The same constraint
  `ctx.step`'s name carries, for the same reason — an identity computed at run
  time is the hazard the whole scheme exists to remove. It was a breaking
  signature change, taken while there are no external consumers.
- **`correlationId` is NOT defaulted from `label`.** They answer different
  questions: `label` decides which journal ROW this wait is, `correlationId`
  decides which waits one `wakeUp` ends. A polled schedule wants one label and one
  id across every iteration; two independent waits want two labels and may
  want a shared id.
- **The three determinism reads stay positional** (`now!0`, `random!0`,
  `uuid!0`). They take no argument to name, and they journal through `appendStep`
  so a reach is at least recorded for the divergence check. `sdk/workflow-ctx.ts`
  carries why requiring a literal there is the worse trade.

What is left is one shape, and it is strictly better than what it replaced: a
label or token that is ITSELF non-deterministic mints a key no walk has reached,
so the run registers a fresh wait and PARKS on something nobody can signal. That
hangs rather than answering wrongly, and nothing detects it —
`workflow-replay-divergence.ts` states the residual and why the NEW-key report
that would catch it is not built. `waitTokenDiverged` there is the nearest thing:
it compares the token `claimHook` hands back against the one the walk reached, so
it is an assertion about the KEY SCHEME (unreachable while a key names its token)
rather than about the body, and it is what caught the positional case.

### A step body may not WAIT, and the engine refuses one that does

`ctx.sleep` and `ctx.waitFor` belong to the body. The closure `ctx.step` is
handed CAPTURES `ctx`, though, so `ctx.step("napper", () => ctx.sleep("nap",
2000))` is one line away at every call site, and until `workflow-replay-wait.ts`
existed the engine ran it — silently, and wrongly in three separate ways. Two of
them are measured below and both still stand; the third was the key slide, which
naming the waits closed independently (see "A wait is keyed by NAME").

- **The step body re-ran from the top on every delivery.** The suspend unwinds
  out of the step, the attempt charge is released (correct — a suspend settles
  nothing), so the step is never journaled and the next delivery re-runs the
  closure. A one-step body logged its effect **twice** across two deliveries and
  reported `completed`. For a step that calls a paid provider that is a duplicate
  charge, which is how this was found.
- **And every LATER wait in the run READ the wrong record.** That half is CLOSED,
  and not by this check — see "A wait is keyed by NAME" above, which carries the
  transcript. It is listed here because it was one of three reasons for the
  refusal rather than the whole of it, and because `workflow-replay-wait.ts`'s
  own doc is still the clearest statement of what positional keys cost.

So both methods now refuse when `currentRun()?.step` is set — which is true for
the whole of a step's execution, including inside every helper it awaits, since
`withStepContext` narrows the run context rather than a lexical scope. The
refusal is a `FatalError` (a redelivery cannot make a body legal) recorded
through `replayRun`'s `refused`, so a body that catches broadly cannot turn it
into `completed` — the third verdict on that channel, beside a divergence and an
abandoned step.

**It cannot be a TYPE**, and it is not worth making RESUMABLE either;
`workflow-replay-wait.ts`'s module doc argues both (a captured binding is not an
argument, and TypeScript has no effect system; "work, then wait, then more work"
is already two steps with the wait between them).

**What the refusal cost, recorded because it is a real loss.** The property
grammar's `nestedWait` node (`_workflow-resume-program.ts`) generated exactly
this shape and was the 10-out-of-10 regression for the lease fix ("An attempt is
a LEASE, and it EXPIRES", below). It is
gone: it can no longer generate a legal body. The arm it defended — a suspend
GIVING BACK its charge — is gone too, and needs no replacement: a suspension is
no longer a THROW, so nothing unwinds through a step's attempt loop and there is
no charge to hand back (`workflow-replay-suspend.ts`). The half of the lease
still reachable through `ctx` — a charge NOT given back when an attempt dies —
is held by `flaky`. Removing the node also lowered two coverage floors in
`workflow-resume-equivalence.test.ts`, re-measured over 20 runs with the old
ranges kept beside the new ones.

**And the refusal now guards LIVENESS as well.** A wait parks on a promise that
never settles and quiescence means "no engine operation in flight", so a wait
inside a step is a step awaiting something that cannot settle, holding the walk
open against the check that would suspend it — `replayRun` would never return.
A/B'd: with the check disabled, all eight cases in `workflow-replay-wait.test.ts`
stop failing and start timing OUT. That module's own doc carries it.

**That residual is REACHABLE, and the estimate beside it was measured wrong.**
It read "far past what one dispatcher per deployment produces". One dispatcher
produces up to FIVE, whenever a single step exceeds 60 seconds: the platform's
`QUEUE_DELIVERY_TIMEOUT_MS` (60s, `aai-server/workflow-queue-deliver.ts`) closes
the delivery's HTTP response but does **not** stop the walk, so every redelivery
adds a CONCURRENT walk of the same run in the same guest — measured at 61.15s
then 65.23s against a live dev server, i.e. the ceiling plus
`RETRY_BACKOFF_MS[0..1]`. Each of those walks charges the same step key, so a
step running longer than roughly 2.2 minutes takes a fourth charge against a
budget of three and is REFUSED. A slow-but-healthy step is exactly the case the
lease was supposed to protect.

Worse, the duplicate walks were not merely wasteful: `replayRun` reads the
journal ONCE per walk, so a walk that starts before an earlier one has journaled
anything re-executed **every** step. Measured on the transcription template, a
second walk re-ran `normalizeRecording`, `splitRecording`, four
`transcribeSegment` calls against the real provider and `mergeTranscript` on a
run already marked `completed`.

**That half is CLOSED, by `settledSince` in `workflow-replay-step.ts`.** A
snapshot can only be stale about a key somebody ELSE reached, and `claimAttempt`
already answers exactly that: `1` means this attempt is the only one
outstanding, so nothing has been missed. So a miss in the snapshot re-reads the
journal **only when the charge says another walk touched this key**, and a
settled entry answers the step instead of running it — which also makes a
settled step answer from the journal rather than take the `StepAbandonedError`
the blown budget above would otherwise produce (the two checks are ordered on
that ground). The happy path pays nothing: a first walk reaching a fresh step
sees `1` and never re-reads. `workflow-concurrent-delivery.test.ts` measured the
effect — generated `duplicateSteps` fell from **44-107 to 6-21**, and its floor
came down with a re-measured range — and
`workflow-replay-stale-snapshot.test.ts` pins the two interleavings by hand.

What is NOT closed is the race it was never about: two walks reaching a step
NEITHER has settled still both run it, which is the engine's stated
at-least-once cost, and the delivery door still starts walks it cannot stop. Both
want a heartbeat on the RUN so a ceiling cannot abandon a walk that is alive.
The platform's own half — a slow delivery starving every OTHER tenant's claim —
is fixed separately in `aai-server/workflow-queue-budget.ts`.

### A run record names the CODE it was started against

`RunRecord.codeVersion` is `AAI_BUNDLE_SHA256`, recorded at `start` and compared
at each walk, and it exists for one reader: the divergence message. That message
states two causes — a redeploy mid-flight, or a non-deterministic body — and then
hands the reader a test to run against their own source, because a journal holds
what a value WAS and never how it was produced. The version settles half of it:
an inequality states the redeploy and names both bundles, an equality ELIMINATES
it. The fork stays in the text either way, being what says what to look for.

**A DIAGNOSTIC, never a gate**, and read from THIS PROCESS's environment rather
than the agent's — an agent may set any other `AAI_*` key as a secret, so a
tenant read would let it pin its own version and have the message assert as a
fact the one cause it had ruled out. Absence therefore means UNKNOWN in both
directions and may never read as "unchanged"; only a deployed guest has a hash.
`workflow-code-version.ts` carries the rest, including why an inequality does not
refuse the run.

### A step body can read its own ATTEMPT

`stepInfo()` on `@alexkroman1/aai/step` answers
`{ name, key, attempt, maxAttempts, isLastAttempt }` inside a step and
`undefined` everywhere else. The engine already tracked the number and nothing
could read it, so the one decision a retry policy cannot make for an author was
unavailable: degrade rather than fail. **`sdk/step-attempt.ts` carries the
argument** — the two differences from the DevKit's `getStepMetadata()`, and why
`maxAttempts` has to travel with the attempt rather than be restated at the body.

What is this package's: `installWorkflowSupport` publishes the reader
(`createStepInfoReader` in `workflow-report.ts`) into a `Symbol.for` slot like
`stepReport()`'s, because the answer lives in this package's `AsyncLocalStorage`
and `/step` rides the browser bundle. It derives `isLastAttempt` with `>=` and
not `===`, since a burned boot can push the count past the ceiling and that is
exactly the try a body most wants to degrade on. And the EVAL engine fills the
slot with a first-and-only attempt rather than leaving it empty — unfilled means
`undefined`, which a body reads as "no run", so a step that degrades on its last
attempt would be measured on that branch.

### A step entry records when it STARTED

`StepEntry.startedAt`, so `finishedAt - startedAt` is what the step cost. An
entry carried `attempts` and `finishedAt` and no start, so the only elapsed time
derivable from a run's history was the gap between one step's finish and the
next's — which is the previous step's cost PLUS whatever the body did between
them, and is nothing at all for the first step of a run or the first after a
wait. The park-curve section below is the evidence: its production numbers
(`walkingForSeconds: 285`, "~45 behind it at 12 a minute") came off a log line,
because the journal could not be asked.

An absolute instant rather than a duration — the difference is derivable and the
instant is not, and a gap between one entry's `finishedAt` and the next's
`startedAt` is DELIVERY latency, a different question from step cost and the one
that tells a slow step from a slow queue. It spans the whole reach, retries and
backoff included, and excludes time queued behind `StepGate`; the field's own doc
argues both.

**OPTIONAL, and absence means the row predates the column.** The journal is
append-only over tables that already hold rows, so a reader owes an absent start
"unknown" and never zero — which would report a long step as instant. The
conformance table pins that in both directions, including that a start of `0` is
KEPT: an arm reading `startedAt ?? undefined` would satisfy the absence case
while silently dropping a real value.

**No reader surfaces it yet**, and that is worth saying rather than implying: the
public workflow API carries a run SNAPSHOT and no step history, so this is
queryable from the database and from nowhere else. A route and a CLI verb over
`readSteps` are the obvious next move and are not built.

Two things the change found, both about the DDL-parity gate. It read the ONE
migration that CREATES these tables, so a column added by a later one was
uncompared — which made it blind to exactly the drift it exists to catch, and
had already hidden `workflow_runs.reconciled_at` plus two reconcile indexes. It
reads every migration in filename order now, applies `alter table … add column`
on both sides, and scopes the parse to the five tables the pairing derives. And
its column-ORDER assertion had to go: a column added by an `alter` lands last, so
the two sides diverge in position the moment either adds one. Sets are compared
instead; every claim that matters is asserted by name.

### A parked delivery asks to come back PROPORTIONATELY

`workflow-queue-dispatch.ts` refuses a delivery whose run is already being
walked, and `workflow-queue-park.ts` decides what to answer it:
`clamp(walkingForSeconds / 8, 5, 120)`, reported on the same curve — one park is
one line and one reschedule, so `reportPark` ANSWERS the delay it printed rather
than either half computing it twice.

It was a flat 5, argued as "self-limiting by construction" because the first park
lands ~61s into a walk and a healthy run parks zero times. True, and the
conclusion was not: after that it is a 5s LOOP, and each turn is a full queue
round trip doing no work plus one of the replica's
`WORKFLOW_QUEUE_DELIVER_CONCURRENCY` slots. Production, on a 660 MiB upload:
`walkingForSeconds: 285` with ~45 behind it at 12 a minute; ~170 for a 15-minute
one. The curve makes the count logarithmic — **13 to reach 285s, 24 to reach
900s**.

Three things not to relitigate, each argued at its own constant: the floor stays
5 for a brief RACE between two deliveries (it binds only under 40s of walk); the
ceiling is 120s against the four numbers it must stay under
(`QUEUE_DELIVERY_TIMEOUT_MS`, `RETRY_BACKOFF_MS`'s longest, `STALL_GRACE_MS`,
`TRANSCRIBE_UPLOAD_TIMEOUT_MS`); and the LEVEL is a pure function of the elapsed
walk rather than "the first one is different", which needs per-run state and
hides the falling rate that says nothing new is wrong.

**A park spends no attempt and the platform caps nothing** — `reschedule` writes
`locked_at` and `available_at` only, and `parkedFor` takes any finite
non-negative number. So only the first delivery's 60s abort costs one of
`QUEUE_MAX_ATTEMPTS`, and a walk of any length parks at attempt 1 forever.

**The GUEST's liveness signal is a separate defect with the same cause**, and it
is the sharper one: `packages/aai-guest/CLAUDE.md` under "Lifecycle is
guest-owned" — the idle reaper counted HTTP responses, so the 60s abort read as
an idle guest and a step longer than the idle window never completed. Parking is
what made that reachable, because before it the redundant walks were the thing
holding the guest open.

## What the tiers of test each cover, and why none substitutes

The claims are of four different kinds, which is why there are four files:

- **`workflow-journal-platform.test.ts`** — our side of the wire. The CODEC (a
  `Uint8Array` in a step's output crosses as an envelope, not as an index map,
  which `JSON.stringify` produces with no error), and three answers REFUSED
  rather than invented: `claimAttempt` on a non-number (a made-up ceiling does
  not hold), `appendStep` on an unreadable answer (the STORED entry is what makes
  a double execution deterministic), `claimSleep` likewise.
- **`aai-server/platform-workflow-journal.test.ts`** — SHAPE, over all thirteen
  methods as a TABLE rather than a case each: every statement binds the slug as
  `$1`, no statement binds a bare `$n::jsonb`, `claimAttempt` issues exactly one
  query. A table because the interesting failure is one method forgetting, and a
  hand-written case per method is what the NEXT method would not get.

  **It did not get it, and there is now an assertion instead of this warning.**
  `readStep` was added and the table did not notice — the paragraph above
  predicted exactly that and was still only prose. The roster is checked against
  the imported NAMESPACE now ("the table names every journal method"), so a
  method added to the namespace fails this suite rather than being remembered.
  Same reason
  every counting gate in this repo carries a floor: the success output of a
  hand-kept table is indistinguishable from a complete one.
- **`aai-server/platform-workflow-journal.scenario.test.ts`** — the only place
  TENANCY is testable, that being a claim about column values in a shared table.
  Two tenants' rows, and every cross-tenant read comes back empty.
- **`aai-server/journal-conformance-platform.scenario.test.ts`** — the shared
  CONTRACT, answered by the real route over a real database. The three above each
  assert a property somebody thought to write down; this one asserts the same
  cases every other backend answers, which is a different job. See below.

Two things the scenario tier taught. **`jsonb` NORMALIZES**, so a value survives
by MEANING and not by bytes — the memory journal preserves bytes and these do
not, a divergence a spec might reasonably have asserted, so the cases compare
parsed values. And the **`::text::jsonb`** binding is deliberate on both stores:
postgres.js JSON-serializes a parameter bound to a jsonb position, and the
self-hosted twin shipped with a bare cast that stored a JSON string containing
the JSON, found only by a real server.

## The FOURTH arm is the platform's own SQL, and it lives in `aai-server`

`journal-conformance.ts` declares ONE case list and `JOURNAL_BACKENDS` registers
the backends. Three arms run it from this package; the fourth cannot, and it is
the one that finds platform bugs:

| Arm | Tier | What it can see |
| --- | --- | --- |
| memory | unit | the reference |
| platform over a FAKE transport | unit | THIS side of the wire — the codec, `toRun`/`toStep` |
| postgres, real database | scenario | `on conflict`, a row count, a unique index |
| **platform over the REAL route and a real Postgres** | scenario, in `aai-server` | the platform's own statements |

The unit platform arm delegates every SEMANTIC to the memory reference (its own
header says so), so a divergence in the platform's SQL is invisible to it. One
was shipped: `createRun` was `on conflict (slug, run_id) do nothing` with no
`returning`, so a duplicate run id was answered with SUCCESS — against an
interface that says "rejects if `runId` already exists", a memory backend that
throws, and a self-hosted store that trips its primary key. Two racing starts on
one id both believed they had won and the loser's `input` was discarded, on the
platform arm only, i.e. for every deployed agent. A/B'd: with that SQL in place
the unit suite reports **123 passed** and the fourth arm fails the shared case.

`aai-server/journal-conformance-platform.scenario.test.ts` is that arm. The
refusal it now gets is a typed `PlatformWorkflowRunTakenError` mapped to a
**409** by `withReserved`'s `statusFor` hook — the same shape as `claimHook`'s
token conflict, and for the same reason: every plain `Error` there becomes a
retryable **503**, so the engine spends the message's whole attempt budget on a
refusal that cannot change.

**The case list crosses the boundary through a LOADER, not a re-export clause.**
`loadJournalConformance()` on `/internal` dynamically imports the case modules,
which `import { describe, expect, test } from "vitest"`. Behind the dynamic
import that code splits into its own chunk — verified: zero `vitest` references
in `dist/internal.js` — and is loaded only by the caller that asks. It is a
function rather than a second subpath because `/internal` cannot afford to be
split in two. **The rule this serves, and the shipped failure behind it, are
konsistent's `runtime-runner-free-subpaths`**; what stays here is the half that
convention cannot see, because konsistent reads static import statements and not
`import()`: a STATIC clause reaching these modules is bundled in, measured at
`import … from "vitest"` on line 4 of `dist/internal.js`, so the dynamic form is
load-bearing and a refactor that "simplifies" it back to a clause reintroduces
the fault with the direct-import gate still green.

## Three `JournalStore` contract points the suite refused to decide, decided

A conformance table can only assert what the interface actually promises, and
three points were underspecified — each with two backends doing one thing and the
third doing another, and no case able to name a winner. The decisions:

- **`setStatus`'s patch is ADDITIVE.** A field the patch does not carry is not
  written, and an explicit `undefined` is the same as absent — so a stored
  `output` can never be CLEARED. The platform already behaves this way (the
  handler builds `{output, error}` and the SQL `coalesce`s), which makes memory's
  and postgres's `"output" in patch` distinction dead code. Adopted rather than
  fixed the other way for three reasons. It is what `error` has always done in
  ALL THREE backends (`coalesce($6, error)`, `if (patch?.error)`), so the
  alternative leaves two fields of one patch with two rules. Reaching the
  distinction over HTTP needs a new wire field — the client sends
  `output: encode(patch?.output)` and `JSON.stringify` drops an `undefined` key,
  so "no patch" and "clear it" are already the same bytes — i.e. a protocol
  change to serve a caller that does not exist: the engine passes either a
  defined output or no patch at all. And clearing a terminal payload is a
  mutation primitive in disguise, which this interface says outright it does not
  have ("no `updateStep` and no `deleteRun`: the journal is APPEND-ONLY").
- **`claimAttempt`, `claimSleep`, `claimHook` and `appendStep` are defined only
  for a run that EXISTS, and a backend MAY throw.** Memory throws; both
  databases insert a row with no run to belong to and answer normally. Left
  under-specified ON PURPOSE, out loud, so nobody writes a caller that depends on
  either: mandating the throw costs the databases a read (or a foreign key) per
  step to detect a state the engine cannot reach — it calls these only after
  `createRun` — and mandating the answer would have memory invent a slot, i.e.
  resurrect a run, which is the worse of the two.
- **`readSteps` is ordered by `finishedAt`, ties broken by `key`.** Both
  databases already do exactly that (`order by finished_at, key`); memory returns
  insertion order, which agrees except on a same-millisecond tie. The one-line
  change memory owes: sort a COPY of `steps` by `finishedAt` then `key` before
  mapping. One limit worth stating rather than pretending away — a database
  breaks the tie in the column's COLLATION, which for `text` under a non-C
  collation is not code-unit order, and step keys are punctuation-heavy
  (`fetch#0`, `sleep!0`). It is unobservable in practice: a tie needs two steps
  settling in one millisecond, and the engine indexes what `readSteps` returns by
  `key`. Do not tighten it to a byte order without `collate "C"` on the column.

## A failure of the JOURNAL is not a failure of the RUN

`replayRun` has always documented that it propagates a store failure rather than
marking a run failed on a database blip. **That was true only of `readSteps`** —
the one journal call made before the body starts. Every other one is reached FROM
the body, so its rejection unwound through the body like any other throw and
`classifyThrow` could not tell it from an exception the body raised. It answered
`{ kind: "failed" }`, which `setStatus` writes as a TERMINAL status, so one
unavailable moment killed a healthy run permanently, discarded a step that had
already SUCCEEDED (unjournaled, so a retry has nothing to answer from), and
showed a caller the store's "connection reset" as their own workflow's error.

**`workflow-replay-journal-failure.ts` closes it and carries the argument** — why
a wrapper around the store rather than a check at each of seven methods across
five files, why the body SWALLOWING the rejection is the quieter half, and why
its one exemption is `JournalConflictError` (`claimHook`'s token conflict: a
verdict about the run, so it must still fail it — without the exemption
`workflow-engine-waits.test.ts` retries a conflicted run forever). Every backend
owes that type for that case; the platform arm maps its route's 409, scoped to
`claimHook` because postgres refuses a duplicate run id with a raw primary-key
violation and a type only one arm keeps is worse than none.

Two things this found are worth more than the fix. The unit platform conformance
arm's fake transport answered **500 for every throw**, under a comment reasoning
that status could not matter because the client propagates either way — true when
written, false the moment status began deciding a type, and it made that arm
structurally unable to see the mapping. And the conformance table asserted the
conflict with a bare `toThrow()`, which cannot see an arm refusing with the wrong
type at all.

## A wait was outside the whole-read guarantee

`JournalStore`'s own doc argues that the journal is READ WHOLE at the top of a
walk rather than queried per step, because a replay reaches every step the run
has ever completed. That argument was implemented for steps and for nothing
else: `readSteps` was the only bulk read, so a settled step was free and every
`ctx.sleep` a walk reached was a `claimSleep` round trip whose answer was almost
always "that finished several deliveries ago".

**A POLLING body is where it compounds, and it does so in the number of
DELIVERIES rather than the size of the body.** `ctx.sleep("poll", …)` in a loop
mints a new key per iteration — `sleep!poll#0`, `sleep!poll#1`, … — all of them
elapsed by the time the next delivery walks them, so delivery N re-claimed N-1
finished waits before it could do any work.

Measured in production, on a 34-segment `transcription-workflow` run: journal
`POST`s per delivery rose **+1 per delivery, monotonically, across 69
consecutive deliveries** — 2,675 of them in 25 minutes, and the run never
completed. The gap between deliveries grew 11s → 37s tracking the count, and
when journal p50 fell 796ms → 164ms the gap collapsed to 11s with the count
unchanged, which is what identifies the count rather than the latency as the
term. Nothing reported it: every call SUCCEEDED, so a log shows a run getting
slower.

`JournalStore.readSleeps` is the missing half — one bulk read, taken beside
`readSteps` in `workflow-engine.ts` and handed down as `ReplayOptions.sleeps`.

**What a snapshot may answer is NARROWER than for a step, and that is the whole
of the correctness argument.** `claimSleep` is a CLAIM, not a read: it creates
the record when there is none. So `overInSnapshot`
(`workflow-replay-waits.ts`) answers `true` only when the record is IN the
snapshot — the claim has already happened — AND the wait is over by a MONOTONIC
test: `woken` is set once and never cleared, and `wakeAt` is fixed on the first
reach (first write wins) so a past deadline stays past. Everything else
round-trips exactly as before, which means a stale snapshot can only ever be
wrong in the direction of taking a round trip it did not need — never of
skipping a claim that had to happen, and never of missing a wake.

Three things not to relitigate:

- **The deadline half of `ctx.waitFor` takes the same arm**, and not by analogy:
  a `hookTimeout` is a row in the same table, so `readSleeps` already carries it.
  What it does not skip is `closeHook`, whose answer decides the branch.
- **`claimHook` has the same shape and is deliberately NOT fixed.** `delivered`
  is monotonic exactly as `woken` is, so a bulk hook read would let a snapshot
  answer an already-answered wait — but hooks are their own table and their own
  read, and the shape that makes sleeps quadratic (a fresh key per loop
  iteration) is not one a body reaches with `waitFor`, which parks rather than
  polls. Measure a body that does before adding the second read.
- **The engine prefetches unconditionally**, so a run with no waits pays one
  extra `POST` per delivery. It is issued CONCURRENTLY with the step read, so it
  costs no latency, and a wait-free workflow typically takes one delivery; a
  lazy read would save that at the price of putting the read on the critical
  path of the first wait of every polling run, which is the case that matters.

`workflow-wait-snapshot.test.ts` is the regression, and its module doc carries
the A/B: with the snapshot arm removed, claims per delivery go
`[1, 2, 3, 4, 5, 5]` against the flat `[1, 1, 1, 1, 1, 0]` it asserts.

## An attempt is a LEASE, and it EXPIRES

Moved here from `CLAUDE.md` when that guide hit its 120,000-character cap; the
pointer stub it kept for a while came over with the rest of the journal section
and is gone. What is below is the original account of why a charge is a lease
rather than a tally, followed by the two things the lease grew: a HOLDER, and an
expiry.

`claimAttempt` charges an attempt before a step's body runs — a crash therefore
burns it, which is the whole reason the charge precedes the body — and
`releaseAttempt` gives one back. The number a claim answers is not "how many
times has this step been tried"; it is **how many attempts are outstanding
right now**, this one included. Only an attempt that never ENDED keeps its
charge, and only a dead worker fails to end one, so the pre-body ceiling bounds
ABANDONMENT.

It used to be a bare tally, and one number served two budgets that pull in
opposite directions — how many times to TRY (the author's `maxAttempts`) and how
many workers may die holding this step. A property harness
(`workflow-concurrent-delivery.test.ts`) shrank the defect to a ONE-node body
under three deliveries: a `ctx.step` whose body sleeps — a shape the engine now
REFUSES outright, see "A step body may not WAIT" above — all three
suspending
inside it having charged one each, so the next reach found the budget spent and
appended `{status: "failed", error: "step s0 exhausted 3 attempt(s)"}` over a
step that then SUCCEEDED — whose own walk read that failure back out of the
idempotent append and failed the run. Tries are counted in the WALK now, and the
pre-body refusal is no longer a journal entry at all
(`StepAbandonedError`, classified like a divergence: a verdict about the walk,
never about the step). **A step that succeeded is never journaled `failed`,
because only a walk whose own body threw may write a `failed` entry.**
`workflow-replay-step.ts`'s module doc carries the rest.

**The residual that account ends on is the rest of this section.** It read: a
charge cannot tell an abandoned attempt from a LIVE one, so `maxAttempts`
simultaneous in-flight deliveries of one step is the most this tolerates, and
closing it needs a heartbeat. Half of that is now closed — a charge EXPIRES, so
an abandoned one stops counting — and the half that is not is stated at "The
window is generous, and there is no heartbeat" below: without a refresh the
window has to be long, so the ceiling bounds concurrency over an hour rather
than over minutes.

### A charge names its HOLDER

`claimAttempt(runId, key, holder, leaseMs)`, where `holder` is the WALK's own id
— `replayRun` mints one per walk. Two things follow:

- **A claim is IDEMPOTENT for a holder that already has one.** Re-claiming
  answers the same number rather than a higher one. The engine claims once per
  walk per key, so this is a defence rather than a fix — but a claim is a
  non-idempotent write over an at-least-once transport, and
  `workflow-journal-platform.ts` had to carry a rule about it ("must not soften
  it by retrying the call itself — a retried claim would burn two").
- **A charge can EXPIRE**, which is the half that fixes a real defect. A scalar
  counter cannot: the charge a dead walk left was indistinguishable from a live
  one, so it stood forever and `maxAttempts` deaths on one step key refused that
  step permanently, with `StepAbandonedError` reporting a run nobody could
  revive. Expiring individual charges needs an instant per charge, which needs
  the holder.

### The shape is ONE ROW per key, holding a MAP

`aai_workflow_attempt_leases (run_id, key, holders jsonb)`, primary key
`(run_id, key)`, where `holders` maps holder to the instant it claimed. The row
is what makes the claim ATOMIC — two concurrent claims collide on it, so the
second blocks on its lock and re-evaluates against the first's committed value,
exactly as the scalar counter's `n = n + 1` did.

**A row per HOLDER is the obvious shape and it is WRONG.** It was written that
way first: two claims by different holders conflict on nothing, so each inserts
its own row and each counts under a snapshot the other's insert is absent from.
Both answer `1`, both read that as a first reach, and the ceiling bounds nothing.
Measured on a real Postgres — three concurrent claims answered **`[1, 1, 3]`**
against a contract that no two ever agree, caught by the conformance suite's
"two concurrent claims never hand out the same number".

`_workflow-journal-attempts.ts` holds the statement and the three cases its
`case` expression gets right; the platform twin is in
`aai-server/platform-workflow-journal.ts` with a `slug` added to the key.

### The window is generous, and there is no heartbeat

`ATTEMPT_LEASE_MS` is an hour. A live walk does NOT refresh its charge, so the
window has to clear the longest walk that can legitimately be running — measured
at 285 s and ~900 s in production, with a step's own `stepFetch` allowed
`STEP_FETCH_INACTIVITY_MS` (10 minutes) per stall.

**Both ways of being wrong are not equal, which is what makes a generous window
right.** Too SHORT and a live walk's charge vanishes: the ceiling under-counts,
a step is re-run, and the engine's stated at-least-once cost applies — the
direction `JournalStore.releaseAttempt` already calls safe. Too LONG and a dead
walk's charge lingers: the ceiling over-counts and refuses a healthy step, which
is the bug being fixed. An hour turns "forever" into "an hour" for every death
and cannot be wrong in the expensive direction.

**What a heartbeat would buy is a SHORTER window**, not a different mechanism: a
walk that renewed its lease could be given one measured in minutes, and the
ceiling would bound concurrency in near-real time. It needs a timer per in-flight
step and its teardown, and is not built.

**A live holder's re-claim must NOT refresh its instant.** Otherwise a walk
that keeps re-reaching one key holds its charge for as long as it keeps
reaching — the failure the expiry exists to end, by a slower route. That is
what the `case` in the statement is for, and an unconditional add would delete
it silently.

It is pinned twice, and the conformance half is exact rather than coarse. The
recorder tests in `workflow-journal-postgres.test.ts` and
`platform-workflow-journal.test.ts` assert the branch with no clock in them at
all. The conformance case OWNS the clock instead of racing it: it spies
`Date.now` to stamp the first claim half an hour ago, re-claims now, and reads
under a ten-minute window, so 1 means the instant was kept and 2 means it was
refreshed. A first draft aged charges with real `sleep()`s, and that version
could only fail in one direction — a machine slow enough to age a refreshed
charge past the window passed it wrongly, which made the interesting half of
the assertion untestable. Every arm runs in-process, including the platform
ones, which is what makes one spy reach all three backends.

### The old table is RETIRED, not dropped

`aai_workflow_attempts` is gone from the runtime's own DDL, which is free — a
self-hoster's copy is an empty table nothing reads, and a shipped applier has no
business running `drop table` on an operator's database.

The PLATFORM's copy is the expand half of an expand/contract.
`supabase db push` runs before the deploy (`ship.yml` gates the deploy job on
migrate) and Modal's rolling strategy keeps the previous build serving beside the
new one, so dropping `aai_platform.workflow_attempts` in the same release is
`42P01` under still-running old containers — on the one journal call every step
makes before its body runs. It compounds with the retry-budget change beside it:
that failure reaches the guest as a 503, and because the guest ANSWERED it spends
the message's own five attempts, whose backoff totals ~380 s. A rollout longer
than about six minutes would drop messages.

So the drop is owed to a later release and `RETIRED_OBJECTS` in
`platform-schema.test.ts` is the ledger that remembers — self-clearing, because
the entry's own assertion fails once the drop lands. `20260903160000`'s re-issued
`sweep_terminal_workflow_runs` cleans BOTH tables for the length of the expand,
and the `gone_attempts` arm goes with the table.

Two fixture consequences. `platform-schema.scenario.test.ts` asserts the EXACT
set of `aai_platform` tables, so it lists both for one release — that suite needs
a Supabase stack and skips without one, which is why this was caught in CI's
`platform-stack` job rather than locally. And `ensurePlatformTables` replayed only
creates, alters and indexes; it replays `drop table if exists` now, which applies
nothing yet and is pre-positioned for the contract release the ledger entry
guarantees.
