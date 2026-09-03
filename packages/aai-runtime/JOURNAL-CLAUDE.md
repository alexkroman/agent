# JOURNAL-CLAUDE.md — the durable journal's test topology and contract points

A SIBLING of `packages/aai-runtime/CLAUDE.md` rather than a second package
guide, for the reason `packages/aai-server/MODAL-CLAUDE.md` is one: Claude Code
auto-loads only `CLAUDE.md`, so a sibling is read on demand and is the right
shape for REFERENCE — which all of this is. It moved here when that guide hit
its 120,000-char cap, and the rule for what may follow it is the same: a
decision somebody needs resident while working elsewhere in the package belongs
in `CLAUDE.md`; the topology of the journal's own tests, and the minutiae of
what its contract does and does not promise, belong here.

Start from "A run's journal has THREE homes" in that guide — it is what these
three sections qualify.

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
`loadJournalConformance()` on `/internal` dynamically imports the case modules.
They `import { describe, expect, test } from "vitest"`, which is an OPTIONAL peer
of this package, and a static clause is bundled INTO `dist/internal.js` —
measured: `import … from "vitest"` on line 4. `@alexkroman1/aai-cli`'s published
`dist` imports a VALUE from that exact module (`consoleLogger`, in `_dev-env.ts`)
with every bare specifier external, so the plain clause makes `aai dev`
unrunnable in any install without the test runner: `ERR_MODULE_NOT_FOUND` from
inside a published package, invisible to `publint` and to `attw`. Behind the
dynamic import the same code splits into its own chunk (verified: zero `vitest`
references in `dist/internal.js`) and is loaded only by the caller that asks.
Same rule as `/eval/vitest` and `@alexkroman1/aai/testing/vitest`, but as a
function because `/internal` cannot afford to be split in two.

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

Moved here from `CLAUDE.md`, which is at its 120,000-character cap and now
carries three lines and a pointer. What is below is the original account of why
a charge is a lease rather than a tally, followed by the two things the lease
grew: a HOLDER, and an expiry.

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
REFUSES outright, see "A step body may not WAIT" in `CLAUDE.md` — all three
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
it silently; the
recorder tests in `workflow-journal-postgres.test.ts` and
`platform-workflow-journal.test.ts` pin the branch with no clock in them, because
the conformance case that pins the EFFECT can only fail in one direction.

### The old table is gone, and the fixture had to learn to drop one

`aai_workflow_attempts` is dropped by
`supabase/migrations/20260903160000_workflow_attempt_leases.sql`, which also
re-issues `sweep_terminal_workflow_runs` — a function body naming a dropped table
fails at RUN time, and that one runs from pg_cron with nobody watching.

`ensurePlatformTables` replayed only creates, alters and indexes, so the test
fixtures kept a table production no longer has: `schema-drift.scenario.test.ts`
failed on an undeclared `workflow_attempts` and `journal-ddl-parity.test.ts`
would have failed its bijection. It replays `drop table if exists` now, last, on
the stated assumption that no migration re-creates a table it dropped.
