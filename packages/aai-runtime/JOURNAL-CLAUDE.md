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
  hand-written case per method is what a thirteenth method would not get.

  **It did not get it, and there is now an assertion instead of this warning.**
  `readStep` was added and the table did not notice — the paragraph above
  predicted exactly that and was still only prose. The roster is checked against
  the imported NAMESPACE now ("the table names every journal method"), so a
  fourteenth method fails this suite rather than being remembered. Same reason
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
