---
issue: TODO
status: implemented
last_updated: "2026-08-17"
---

# Do the tests prove durability? Turns and workflows, audited

An audit of the tests that stand behind this repo's two durability claims —
**a turn's state survives the connection and the process that held it**, and
**a workflow run survives the sandbox that started it**. It asks the question
`test-review-sweep-2026-08.md` asks of the suite generally, narrowed to the one
property that is invisible until it fails in production: *if durability broke,
which test goes red?*

The findings below were written with nothing edited, which is why they read as a
survey rather than as a changelog.

The short answer is that the two halves are in very different shape. The
**wake path** and the **session-state backend** are proved against a real
Postgres, by suites written specifically because a fake cannot answer their
question. The **Postgres workflow world** — the one production runs — is
executed by nothing at all, and the **commit point for turn state** survives
deletion with 2,667 unit tests still green.

**These findings have since been implemented — see below.**

## Implementation

Seven of the nine findings are closed; two are recorded as work for a follow-up,
each for a stated reason rather than because it ran out of road.

| Finding | Landed | Proof it can fail |
| --- | --- | --- |
| F1 | `aai-server/workflow-world.scenario.test.ts` (8) | rethrowing the migration's exit(0) reddens the defect pin, and the process survives |
| F2, F3 | `session-state-store.test.ts` (26), `runtime-session-state.test.ts` (11) | neutering `flush` kills 10 of 26; moving `hydrate` after `start` kills 3 of 11 |
| F4, F5 | `aai-server/workflow-keys.scenario.test.ts` (8), `workflow-uploads.scenario.test.ts` (11) | four SQL mutations kill 10 tests between them |
| F6 | `aai-server/workflow-lock-sweep.scenario.test.ts` (6) | inverting the presence check kills all 6 |
| F7 | prose, in three files | n/a — the finding was that prose lied |
| F8 | the GRACEFUL half only, inside F1's suite | a second OS process reads the run back |
| F9 | recorded; nothing built | n/a |

**The audit's own thesis held against the audit's own work, twice.** F4's first
ULID-tiebreak test PASSED with `, run_id desc` deleted — the lookup index carries
the tiebreak, so an index-only scan returns it whether or not the query asks. The
`ORDER BY` is load-bearing only on a plan that must SORT (a table predating the
index, a parallel plan, a seq scan), so the suite now runs the lookup a second
time with index scans disabled and asserts both plans agree. And F1's first draft
asserted `.workflow-data/` did not exist, which is wrong in principle: the
directory is gitignored and other suites create it. Both were caught by mutation,
not by review.

**F1's suite found a live production defect on its first real run**, and two
agents reached it independently. `@workflow/world-postgres@4.3.3`'s
`setupDatabase` puts its `process.exit(0)` INSIDE its own `try`, and its `catch`
exits 1 — so `migratePostgresWorld`'s stand-in throws `MigrationExitedError(0)`,
`setupDatabase` catches it, reports the migration as failed, and re-exits as 1.
`migrateAndSubscribe` then throws on a migration that SUCCEEDED, before
`getWorld().start?.()`. The schema is migrated; the queue is never subscribed and
`reenqueueActiveRuns` never runs. Runs started in that same process still
dispatch, which is why nothing noticed — but a run parked in a `sleep` or on a
webhook is not picked up when its guest is woken, which is the wake-sweep path
the platform's whole durable-run story rests on. It also makes F6's sweep dead
code on every Postgres-world boot.

The module doc reasons the interception is safe because "the exit is the last
statement in both branches". It is, and the success one is the last statement
inside a `try`.

It was PINNED first, by a test written to fail the moment somebody fixed it — the
forcing function `RETIRED_COLUMNS` uses — and then FIXED in this branch, with
that case inverted in the same commit to assert the cure. The fix is one line:
the stand-in keeps the FIRST exit code, since a second `exit` is the CLI reacting
to our own interception.

Inverting it turned up one thing worth keeping. The ❌ `Failed to setup database:
MigrationExitedError` line **cannot** be removed and is now asserted as expected
noise: `setupDatabase` catches our interception on its way out and logs it before
exiting again. It is harmless — the migration had committed and closed its pool,
the exit being the last statement in that `try` — but it looks exactly like a
failed migration to whoever greps the logs, so it is pinned rather than left to
alarm. The first draft of the inverted test asserted its absence and failed for
that reason; the symptom the fix actually cures is the world not starting.

What did not land, and why:

- **F8's hard-kill half.** `_fault-mode.ts` is `_`-internal to `aai-cli`, and the
  dependency graph allows exactly one edge to the CLI (`aai-guest`, four
  subpaths) — so `aai-server` can reach neither the supervisor nor the WDK
  transform a parked run needs. It belongs beside `dev-workflow.scenario.test.ts`
  in `aai-cli`, whose fixture needs one added `DATABASE_URL` to make the world an
  axis. The edge was not widened and the module was not copied. Note
  `aai-cli/CLAUDE.md` expects a `restart-mid-step` durability assertion to be RED
  today for a real reason, which is F6's wedge.
- **F9's CI leg.** Recorded, not built: one leg setting `AAI_FAULT_PROFILE` is a
  decision about what CI spends, and it wants F8's home settled first.
Both real bugs the audit found ARE fixed here, each with a test that dies without
the fix. The migration defect is above. The second is the session-state size cap,
which compared UTF-16 code units against a byte budget
(`json.length > MAX_SESSION_STATE_BYTES`, logged as `bytes`) — the class
`fetchCappedText` already fixed once, and it matters more here because the cap's
job is bounding what a tenant sees as their own database usage. Measured: a slot
of CJK content held ~3 MiB while the cap read it as under 1 MiB. It is
`Buffer.byteLength` now, and the new case is the only one in that file that can
discriminate, every other being ASCII where units and bytes agree.

Both were pinned before they were fixed rather than fixed on sight, which is what
made the A/B possible in each direction — and in the migration's case is what
caught the first fix asserting the wrong symptom.

Two smaller notes from the same reading are NOT changed, both arguably intended
and now documented where they bite: a slot refused by the cap leaves its
previously committed, SMALLER value in the backend, so a resume hydrates a stale
value rather than none (recorded on the refusal itself — it is the better of the
two behaviours, but a reader of that log line should know which one they have);
and `has()` counts a VIRTUAL slot write, so a session that has only touched a
virtual slot reads as "has state" to `pushStateSnapshot`.

## Method

Three passes, in this order:

1. **Read the claim, then find the assertion.** Every durability claim stated
   in a module doc or a guide was traced to the test that would fail if it
   stopped holding. A claim whose only witness is prose is a finding.
2. **Ask what the double can express.** A recorder `Db` holds statements, not
   semantics; a memory backend holds JS values, not encodings. Where the claim
   is about SQL or a driver, a double answers by construction — the same
   argument `pg-cron.scenario.test.ts` and `jsonb-encoding.scenario.test.ts`
   were written from.
3. **Mutate and re-run.** Where a claim looked covered, the line carrying it
   was neutered and the owning suite re-run. Coverage says a module is
   *executed*; only a surviving mutant says nothing *checks* it. This is the
   distinction AGENTS.md already draws for the manual mutation diagnostic
   (`check:test-assertions` catches a test with no assertion; mutation catches
   an assertion that does not discriminate).

## Part I — What is genuinely proved

Stated first, because it is most of the surface and it is good.

- **The durable-run wake path, both ends, over a real Postgres.**
  `aai-server/workflow-wake.scenario.test.ts` (12 tests) drives the guest's
  hint publisher and the platform's sweep against one database, because the two
  are only correct together and every claim in them is a claim about SQL. It
  covers the exhausted job, the lock-expiry dating, the empty queue, the
  deleted agent, DDL idempotence across boots, the one-row table constraint,
  and — the one a fake cannot state at all — that one tenant's unreadable hint
  table does not cost another its wake.
- **The session-state backend over a real Postgres.**
  `aai-server/session-state.scenario.test.ts` (12 tests) proves a slot's value
  survives a new process, that the column holds `jsonb` and not a jsonb string,
  that awkward JSON round-trips byte for byte, that the event log survives at
  its own indices, and that a re-appended index is a no-op so a retried flush
  cannot duplicate.
- **Suspension, resume and replay on the Local World.**
  `aai-cli/dev-workflow.scenario.test.ts` (15 tests) is the only test in the
  repo that runs a real transformed workflow end to end. It spans a durable
  `sleep` (the second progress line is written by a step running in a *fresh*
  flow-route call after the resume, appending to the same stream), proves a
  finished run's chunks are retained and replayable to a late reader, proves a
  webhook round trip inside one POST, and proves `wake` ends a sleeping run
  early and reports how many sleeps it stopped.
- **The durable event log's own logic.** `session-event-stream.test.ts` (21
  tests) is the strongest unit suite in this area: retry in index order after a
  failed write, flush-before-read so a tail is never reported that cannot be
  served, the retention cap advancing the index without growing the log,
  hydration re-basing an event recorded before the position was known, and a
  sparse log resuming past its highest index rather than past its count.
- **Session identity across a really-severed socket.**
  `session-resume.scenario.test.ts` (11 tests) cuts a real TCP relay with
  `destroy()` rather than `close()` — deliberately, because a clean close is
  the "user hung up" case — and proves the reconnect lands on the same session
  and suppresses the greeting. `session-resume-state.scenario.test.ts` (4
  tests) does the same against the *real* runtime and pins the state snapshot
  push to the resumed socket.
- **The guest stays alive for a woken run.**
  `harness-agent-mode.test.ts` proves an in-flight workflow callback counts as
  busy and keeps the idle clock reset — without which a wake buys at most one
  idle window before the guest exits mid-step.

## Part II — Findings

### F1 — The Postgres workflow world is executed by nothing

**Severity: high.** This is the world production runs, and no test ever loads
it.

`workflow-world.test.ts` (19 tests) asserts only on the ENVIRONMENT, and its
header says so as a deliberate choice — a sound one, since `getWorld()`
memoizes on first read. But nothing else picks the thread up. Across the whole
repo, `@workflow/world-postgres` appears in test files only inside that file's
env-string assertions and one guest packaging test. Nothing runs
`migratePostgresWorld()`, `getWorld().start?.()`, or a single run through
graphile-worker against a real database.

`dev-workflow.scenario.test.ts` — the one end-to-end workflow test — writes a
fixture `.env` containing only `FIXTURE_STEP_TOKEN`, so `configureWorkflowWorld`
resolves `local`. Everything Part I credits it with is proved on the world whose
own doc says "a restart forgets in-flight runs."

Three specific consequences:

- **The migration stand-in's SUCCESS path is asserted by nothing.**
  `migratePostgresWorld` intercepts `process.exit` because `setupDatabase` is a
  CLI entry point that exits 0 on success — and the module doc records the
  outage that came of not intercepting it: `aai dev` printing
  `✅ Database schema created successfully!` and exiting 0 before anything
  listened, and a deployed guest doing the same before `server.listen`, so the
  platform's readiness poll never got an answer and every spawn failed. The one
  test that reaches this code (`reports a failure instead of throwing it`)
  drives the FAILURE exit — verified by running it: it dials
  `postgres://…@localhost:5432/world`, fails to connect, and its exit(1) is
  caught. Its only assertion is `errors.length > 0`, which any failure
  satisfies. A regression that re-threw the exit(0) case, or dropped the
  `exitCode !== 0` discrimination, would take down exactly the configuration
  `transcription-workflow` documents as correct, and nothing here would go red.
- **The queue subscription is asserted by nothing.** `getWorld().start?.()` is
  what makes graphile-worker poll; without it "a run sits `pending` forever with
  no error anywhere," as the module doc puts it. No test observes it being
  called, let alone working.
- **A silent fallback to the local world is undetectable.** The module doc
  names this as the hazard the configure/load ordering exists for — "a guest
  that silently uses the local world in production, writing runs to a
  `.workflow-data/` directory inside a container that is about to be
  destroyed." There is no positive assertion anywhere that a run landed in
  Postgres. See Part III: this is precisely the assertion vercel/eve writes.

### F2 — The commit point for turn state survives deletion

**Severity: high.** Proved by mutation, not inferred.

`runtime-tools.ts:374` is `await stateStore.flush(sid)`, in the `finally` of
every tool call, and its comment is unambiguous about why: "THE COMMIT POINT,
and it is awaited… Fire-and-forget here would drop exactly the writes a crash is
supposed to preserve."

The A/B: `flush` was made an unconditional no-op (strictly stronger than
dropping the `await`) and the `aai` unit project re-run.

| Tree | Test files | Tests |
| --- | --- | --- |
| clean | 172 passed | 2,667 passed |
| `flush` neutered | 171 passed, 1 failed | 2,648 passed, 19 skipped |

The single failed suite is `exports-no-dev-deps.test.ts`, which shells out to
`pnpm --filter @alexkroman1/aai build` when `dist/` is missing; it fails on this
container for a Node-major reason and passes on a warm `dist/`. Its 19 tests are
the 19 skipped, and 2,648 + 19 = 2,667. **Zero tests failed because of the
mutation.**

The only thing in the repo that catches it is
`aai-server/session-state.scenario.test.ts`, in a different package, behind
`describeWithPg`. That gate does run in CI (`AAI_REQUIRE_PG=1` on the
integration-and-scenario job), so this is not an unguarded line — but the
package that OWNS the durability of a turn cannot tell whether it still has any.

### F3 — `session-state-store.ts` has no spec, and four decisions have none at all

**Severity: high.** F2 is the symptom; this is the shape.

Three modules on the turn-durability path have no co-located spec:
`session-state-store.ts`, `session-state-postgres.ts`, `runtime-session-state.ts`.
The asymmetry with their event-log twins is exact and worth naming, because the
two are documented as the same shape — `runtime-session-stream.ts`'s header
says its ordering is "for exactly the reasons `attachSessionState`'s doc" gives:

| Concern | Slot state | Event log |
| --- | --- | --- |
| store logic | `session-state-store.ts` — no spec | `session-event-stream.ts` — 21 tests |
| session wiring | `runtime-session-state.ts` — no spec | `runtime-session-stream.test.ts` — 10 tests |
| flush at the boundary | nothing (F2) | `stop FLUSHES the pending batch` |
| hydrate before start | scenario only, memory-backed | `the underlying start still runs, and after the restore` |

Four decisions inside the store are covered by nothing anywhere — not by the
unit tier, not by the Postgres scenario suite, whose 12 cases are about the
backend round trip rather than the store's branches:

1. **The size cap.** `MAX_SESSION_STATE_BYTES` is read at exactly one line
   (`serializeForCommit`) and referenced by no test in the repository. It is
   the thing that stops one runaway slot filling the tenant's own schema —
   which the studio shows as their database usage.
2. **The unserializable-value path**, which exists specifically so a throw
   cannot escape into a tool call's `finally` and replace the tool's result.
3. **Fail-open hydration.** `hydrateOne`'s catch is the redeploy story: a value
   written by the previous version of an agent that the next one cannot parse is
   dropped with a warning rather than failing the session, "because refusing
   would mean a routine deploy drops every in-flight call."
4. **Commit-failure retry.** `commitPending` puts the slots back on the dirty
   set so the next tool call retries. Nothing asserts the re-add, so a failure
   that silently dropped the writes would look identical.

### F4 — The Postgres correlation-key store is only ever driven against a recorder

**Severity: medium-high.** The correlation-key index is what makes a durable run
reachable from the NEXT phone call — the case the whole feature exists for, per
`workflow-keys.ts`'s own header.

`workflow-keys.test.ts` drives `createPostgresKeyStore` against a recording
`Db`, and says so honestly: "A real-Postgres pass over the same store belongs in
the integration tier." There is no such pass. `store-conformance.ts` registers
the pair `conformance: false` with the reason "SDK tier: same package boundary
as session-state above" — but session-state's boundary was solved, by putting
`session-state.scenario.test.ts` in `aai-server`, which may import `aai`. The
cited precedent points the other way.

What the recorder cannot see, and what therefore has never executed:

- the `create table` and the four-column `create index` — a syntax error in
  either is green today, which is the `pg-cron.scenario.test.ts` lesson verbatim
  ("asserts only that the body reached `cron.schedule` as a string, so a syntax
  error was green");
- `on conflict (run_id) do nothing`, whose no-op behaviour depends on the
  primary key really being on `run_id`;
- the ordering itself. The test asserts the literal string
  `order by created_at desc, run_id desc`; that two runs recorded in the same
  millisecond really come back newest-first via the ULID tiebreak is a claim
  about `timestamptz` resolution and collation, and it is unmade.

### F5 — The Postgres upload store is only ever driven against a recorder

**Severity: medium-high.** Same shape as F4, with a sharper edge: here the two
backends are tested asymmetrically in the wrong direction.

`workflow-uploads.test.ts` drives the FILE backend for real against a temp
directory, reasoning that "its whole subject is byte offsets, which a fake would
only restate" — and drives the POSTGRES backend against a recorder. But the
Postgres backend's subject is byte offsets too; they are just written in SQL.
Its module doc calls that arm "the one that matters, because a durable run is
precisely the thing that outlives the container that started it."

The unexecuted claims are all driver-level:

```sql
select substring(
    bytes
    from (greatest(byte_offset, $2) - byte_offset + 1)::int
    for  (least(byte_offset + octet_length(bytes), $3) - greatest(byte_offset, $2))::int
  ) as part
```

Postgres string positions are 1-based, the bounds are per row so one statement
spans several chunks, `byte_offset` is `bigint` compared against JS numbers, and
`bytes` is `bytea` arriving as something the code wraps in `new Uint8Array`.
`info()` additionally coerces `size` with `Number(row.size)` because bigint
comes back as a string. Every one of those is exactly the class of bug
`jsonb-encoding.scenario.test.ts` was written for, and none of them is
representable in a recorder. A header probe returning the wrong 64 KB reads to
every caller as a corrupt file.

### F6 — The lock sweep's "verified against a real database" points at a measurement

**Severity: medium.** `workflow-lock-sweep.test.ts` (10 tests) covers the policy
well against a fake, and is candid that "the one thing a fake cannot check is
that `graphile_worker.force_unlock_workers` exists and does what its name says.
That is verified against a real database — see the module doc."

The module doc records a past measurement ("ONE hard kill … strands every
in-flight step… A repeated-kill soak wedged 4 of 4 runs") and the debugging note
that a first verification hand-converted the advisory-lock hex wrong. Both are
valuable history. Neither is a thing that runs: there is no script and no suite
anywhere in the repo that touches `force_unlock_workers`. `PRESENCE_LOCK_CLASS`
is exported with a comment saying it exists "so a test or a verification script
can contend for the SAME lock" — and no test or script does.

This matters more than an ordinary gap because the module doc establishes that
this sweep is "the ONLY recovery, not an accelerator of one": `is_available` is
a stored generated column with no time term, so a job locked by a dead worker is
invisible for the life of the database.

### F7 — Two durability suites cite a retired mechanism, and rule out what now works

**Severity: low to fix, high to leave.** These are the two files a reader opens
to find out what resume durability is proved to do.

`session-resume.scenario.test.ts` and `session-resume-state.scenario.test.ts`
both attribute session state to `runtime.ts`'s `stateMap` and both close with a
variant of: "it says nothing about a PROCESS restart, which no amount of testing
will make work: `stateMap` is a plain `Map`, so a restart empties it."

`stateMap` no longer exists as an identifier anywhere in the repo — the name
survives only in prose in these two files plus two comments. `ctx.state` is
retired too (`guard-invariants` rule 6 is retired for that reason), and
`session-resume-state.scenario.test.ts` in fact drives a `sessionSlot` while its
header and its `describe` string both say `ctx.state`. Most importantly the
impossibility is now false in both directions: `session-state-store.ts` states
that it "REPLACES the runtime's old `stateMap`", and
`session-state.scenario.test.ts`'s first case is literally named "a slot's value
survives a new process."

The cost of leaving it is not cosmetic. A reader auditing resume durability
finds two authoritative-looking files telling them process-restart durability is
unachievable, which is the precise reason not to go looking for F2 and F3.

### F8 — Nothing proves a run survives the process that started it

**Severity: medium, and blocked on F1.** `dev-workflow.scenario.test.ts` runs
one dev server for the whole file by design. The Local World forgets in-flight
runs on restart by design. So the single most load-bearing sentence in the
durable-workflow feature — a run outlives its guest — can only be tested on the
Postgres world, and F1 is why it is not tested at all.

### F9 — The chaos tier already exists, is well built, and nothing runs it

**Severity: medium, and the cheapest finding here to act on.** Found while
answering a question this audit's first draft did not ask — whether a
regular/chaos test matrix would be worth adding. It would; it is already
written.

`packages/aai-cli/_fault-mode.ts` re-runs a suite against a dev server that is
**hard-killed and restarted at declared points**, switched on by
`AAI_FAULT_PROFILE=<name>`. Its own module doc has already settled the three
decisions that make chaos testing a test rather than a flake generator:

- **The kill is a SIGKILL, and that is the only faithful option.** A graceful
  stop lets graphile-worker's runner release its queue locks, "so a fault mode
  built on SIGTERM would exercise the recovery path that already works and never
  the one that does not."
- **There is no seed and no PRNG.** A profile is an ORDERED LIST of fault points
  keyed on logical events, so the Nth kill lands after the same observed event on
  every machine at every speed. The doc contrasts this with a wall-clock killer
  in `tmp/`, whose "runs cannot be compared to each other."
- **A profile that never fired FAILS**, via `assertPlanConsumed` /
  `awaitSettled` — which is the guard against the exact "green while testing
  nothing" outcome the rest of this document is about.

It is correctly declared in `turbo.json`'s task `env`, so strict env mode cannot
strip it. It has **one** consumer, `aai-cli/e2e.test.ts:237`, and
`grep -rn FAULT .github/` returns **nothing**: no CI leg sets the variable, so
the mode has never run anywhere but by hand.

That is the fourth instance in this repo of a mechanism that exists, is wired,
and is evaluated by nothing — after the `.size-limit.json` no script referenced,
the `ls-lint` config no pipeline ran, and the `.turbo` cache path that never
matched `cacheDir`. It is listed here rather than as an aside because the two
findings it bears on are the two hardest ones: F8's restart case is precisely
what `startSupervisedDevServer` was built for, and F6's hard-kill soak is the
measurement its SIGKILL rationale cites.

**What this does NOT argue for is a chaos MATRIX.** Multiplying every suite by a
chaos axis is the wrong shape: most tests have no meaningful behaviour under a
kill, so the run doubles and the signal does not. Chaos belongs as a profile over
the short list of suites whose subject IS survival. And it belongs **outside the
merge gate** — `aai-server/CLAUDE.md` already sets that bar from the deleted
load/adversarial tier, a catalogue of chaos tests that passed while testing
nothing (`aliveCount > 0` — 1 of 14 sandboxes working was a pass; hostile tool
bodies that were never invoked). Its stated conditions for reintroduction are
that the hostile code must actually execute, that thresholds must tie to
constants the server really reads, and that it must not block merges.

Note the repo already does randomized fault injection where it fits: the S2S
property test spends a per-run `faultBudget` on generated `drop.transient` /
`drop.fatal` commands, and its value comes from SHRINKING a failure to a command
list (`[drop.transient, openSocket, session.error(session_not_found)]`) that
pastes into a regression test. Ordered fault points and generated fault commands
are two solutions to the same replayability problem; between them there is no
gap a wall-clock killer would fill.

## Part III — How vercel/eve tests the same thing

`vercel/eve` runs on the same Workflow DevKit and has the same two nouns —
durable turns, durable workflow runs — so it is the closest available comparison.
Four things it does that this repo does not, three of which map directly onto
findings above.

**1. A world MATRIX in CI, not a world choice.** `e2e/matrix.json` registers the
worlds; `e2e-local.yml`, `e2e-postgres.yml` and `e2e-vercel.yml` each run the
whole fixture suite against one of them. The README states the purpose in the
same words this audit needed: the world suites prove "the world's infrastructure
— build, deploy, boot, streaming, **durability** — without live models." This is
F1's answer, generalized: the world stops being a thing one test happens to
select and becomes an axis every test runs on.

**2. Deterministic mock models, so world coverage never rides on model flake.**
`EVE_E2E_MODEL=mock` swaps every model for a scripted responder, and evals whose
assertions genuinely need a live model carry a `real-model` tag the world suites
exclude. The README treats untagging as the migration unit — "prefer untagging
over new `real-model` tags — deterministic evals make every world suite
stronger." This repo reaches the same end differently in
`dev-workflow.scenario.test.ts`, by driving the run through the DevKit's own
`start` rather than a voice session ("a session would add STT/LLM/TTS
credentials to a test about durability"). Same instinct, one world.

**3. A positive assertion that the run really landed in the durable world.**
After the evals pass, `e2e-postgres.yml` execs into the Postgres service
container and runs
`select count(*) from workflow.workflow_runs`, failing if it is zero:

```text
# Durability proof: when any eval actually executed, its traffic
# must have produced Postgres-backed workflow runs, not silently
# fallen back to the local world.
```

That is F1's silent-fallback hazard, closed by an assertion. Note it is a
*counter*, and they guard it the way this repo's own doctrine says a counter
must be guarded: the step first derives `executed_evals` from the JUnit file
and, when it is zero, prints "persistence assertion skipped" and exits rather
than letting an empty run read as a proof. That is the corpus-floor rule from
"Quality ratchets", applied to a durability check.

**4. Concurrency is part of the durable-run test, not adjacent to it.** The
`agent-workflow-stress` fixture drives 50 durable sessions to 100 total turns
and asserts event counts (`turn.completed` × 100, `notEvent("turn.failed")`) and
that each session's second turn kept its session id. The Postgres leg runs it
with `WORKFLOW_POSTGRES_WORKER_CONCURRENCY: 50` and a pool of 52 — i.e. real
graphile-worker contention, which is the regime F6's orphaned-lock wedge lives
in.

Two places where this repo is **ahead**, which are worth recording so the
comparison is not read as a scoreboard:

- **Eve's own replay proof is tagged `real-model`.**
  `agent-schedules/evals/stream-resume.eval.ts` — the direct analogue of this
  repo's `?startIndex` replay — asserts that a reader reattaching at a non-zero
  index gets the durable log's tail. It carries the `real-model` tag, so it runs
  only on the local world with a live model and is excluded from both world
  suites. This repo's equivalent claims are pinned deterministically at unit
  level (`session-event-stream.test.ts`) and again over a real Postgres
  (`session-state.scenario.test.ts`), which is stronger.
- **Nothing in eve corresponds to the wake sweep's cross-tenant isolation
  case.** `workflow-wake.scenario.test.ts`'s "one tenant's unreadable hint table
  does not cost another its wake" is a durability property of a MULTI-TENANT
  platform, and eve's fixtures are single-tenant by construction.

## Part IV — Recommended order of work

Ordered by what unblocks what, not by severity.

1. **F7 first, because it is fifteen minutes and it is actively misleading.**
   Retitle the two scenario suites' headers to `sessionSlot`, drop the `stateMap`
   attribution, and replace the "no amount of testing will make work" paragraph
   with a pointer to `session-state.scenario.test.ts`. Fix the
   `ctx.state` `describe` string in `session-resume-state.scenario.test.ts` while
   there.
2. **F2 + F3: give `session-state-store.ts` a spec.** It needs no database — the
   memory backend is a valid double for exactly the four decisions listed, and
   the store's own doc explains why (`freezeStorable` runs in both). Cases: the
   size cap refusing a commit while leaving the in-memory value correct; an
   unserializable value not escaping into the caller; hydration dropping an
   unparsable row with a warning and keeping the session alive; a failing
   `commit` re-adding the slots to the dirty set so the next flush retries. Then
   a spec for `runtime-session-state.ts` mirroring
   `runtime-session-stream.test.ts`'s two orderings — hydrate before `start`, and
   flush at the boundary — which is what makes F2's mutation die in the package
   that owns it.
3. **F4 and F5 together: one Postgres-gated suite in `aai-server`.** Both are
   the same fix and the same precedent (`session-state.scenario.test.ts` is the
   template, including the app-shaped schema and the `search_path` handle). Keys:
   the DDL executing, two runs in one millisecond ordering by the ULID tiebreak,
   a re-record being a no-op. Uploads: a range read spanning a chunk boundary
   returning the same bytes the file backend returns for the same input — the
   two arms compared directly, which is what makes the 1-based `substring`
   arithmetic falsifiable. Register both as `conformance: true` if the case
   lists can be shared, or correct the two `why` strings, which currently cite a
   boundary this suite would have crossed.
4. **F1: run the Postgres world.** The cheap first step is not a matrix — it is
   one scenario test that points `configureWorkflowWorld` at
   `AAI_TEST_PG_URL`, calls `startWorkflowWorldIfDeclared(true, "postgres")`,
   and asserts the migration returned rather than exited and that a run reaches
   `workflow.workflow_runs`. That single assertion closes the silent-fallback
   hazard and covers the migration stand-in's success path at once. The larger
   version is eve's: make the world an axis `dev-workflow.scenario.test.ts` runs
   on twice, which is what F8 needs.
5. **F8 after F1, through the fault mode rather than a killer of its own.**
   A restart test is a second server against the same database and is meaningless
   on the Local World, which is why it waits for F1 — but it should be written on
   `startSupervisedDevServer` (F9), not on a fresh process-killer. That gives it
   the SIGKILL rationale, the event-keyed fault points that make a kill land at
   the same moment on every machine, and `assertPlanConsumed`, which fails a run
   whose kill never fired. Mind the dependency direction: the mode lives in
   `aai-cli` and `aai-server` may not import it, so where the restart case lives
   is a real question that answering F9 has to settle.
6. **F9 is the cheapest of these and can go first or last.** Nothing has to be
   built — one CI leg setting `AAI_FAULT_PROFILE` over the suites whose subject
   is survival, kept off the merge gate. Doing it before F8 means F8 has a home;
   doing it after means F8 defines what the profile has to cover.
7. **F6 last, and possibly as a script rather than a suite.** The claim needs a
   real graphile-worker schema and a killed pool, so it is the most expensive
   thing here; a committed, documented verification script that contends for
   `PRESENCE_LOCK_CLASS` would at least make the module doc's "verified against
   a real database" true of something repeatable. Whatever it becomes, the test
   file's cross-reference should stop pointing at a measurement. Note the fault
   mode's SIGKILL rationale CITES this finding's hard-kill soak, so F9 and F6 are
   the same measurement approached from two directions.
