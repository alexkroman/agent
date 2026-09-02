// Copyright 2026 the AAI authors. MIT license.
/**
 * The engine's AT-LEAST-ONCE claim, under a real interleaving.
 *
 * > Two deliveries of one run may overlap. What keeps that safe is not a lock —
 * > a lock is a thing to lose — but the journal.
 * > — `workflow-engine.ts`
 *
 * `workflow-resume-equivalence.test.ts` states the engine's RESUME property, and
 * both of its crash models are sequential by design: one takes the delivery away
 * at a step boundary, the other tears the engine down before its replacement
 * exists. So the sentence above was backed by a single hand-written
 * `Promise.all([replay(j, b), replay(j, b)])` over one one-step body — and this
 * repo already says that shape is not interleaving (`sdk/session-slot.test.ts`:
 * *"Real interleaving, which `Promise.all([execute(…), execute(…)])` cannot"*).
 *
 * `_workflow-concurrent-harness.ts` closes that: one engine, one journal, every
 * journal method behind `fc.scheduler`, and two or three concurrent `execute`
 * calls plus a `cancel` and a signaller per token whose journal calls land
 * wherever the scheduler puts them. Its doc carries the two design decisions
 * (why the JOURNAL is scheduled rather than `execute`, and what the `roundTrip`
 * arm is honestly a model of); `_workflow-laws-harness.ts` carries the reason
 * the survey's "effect count" law is false as stated.
 *
 * ## Three properties, and why the last two are not floors on the first
 *
 * The walk below reaches most states, and two it reaches too rarely to floor —
 * so each gets a targeted property, the same call `studio-concurrency-fuzz.test.ts`
 * makes for its attempt cap. **A timeout window racing a signal**: measured over
 * 20 runs of the walk, the close won 0 times in 6 of them, so the program is
 * FORCED to contain the wait. **Two runs of one engine**: `createStepGate` is one
 * gate per ENGINE deliberately, and every generated scenario in this repo has
 * exactly one run — the cross-run behaviour that is the whole reason the gate is
 * engine-wide was exercised by nothing until the third property below.
 *
 * ## Five laws, no literals
 *
 * 1. **Effect conservation** — the journal holds exactly the keys the
 *    uninterrupted run wrote, and no step ran FEWER times than it needed to.
 * 2. **Answer agreement** — every walk that reached an answer reached the same
 *    one, the grammar's; and every execution of a step key read back one value.
 * 3. **Terminal uniqueness** — exactly one compare-and-set moved the run
 *    terminal, and the losers read that verdict back.
 * 4. **Hook uniqueness** — no wait was both delivered and closed.
 * 5. **Start uniqueness** — one of two colliding `start` calls wins the id, and
 *    the run carries THAT caller's input.
 *
 * ## What the grammar leaves out, and why each is a finding rather than a knob
 *
 * - **Nothing about FAN-OUT, and that is a negative result worth recording.** The
 *   grammar was written without `all`/`map` on a hypothesis: a second walk whose
 *   `readSteps` caught a fan-out half-settled could reach an earlier sibling
 *   FIRST and claim attempt 1 on it, which is exactly the pair of facts
 *   `workflow-replay-divergence.ts` refuses on — an overlapping delivery failing
 *   a healthy run with a divergence message. It does not reproduce: 400 generated
 *   scenarios with the fan-out shapes enabled, across ten runs, and the laws held
 *   every time. So they are IN the grammar, and the hypothesis is written down
 *   here rather than left as an unexplained exclusion. (What exonerates the
 *   second walk is `onFirstReach` firing only when `claimAttempt` answers 1 —
 *   see that module's "two facts decide it".)
 * ## The attempt budget: what this found, and what it is now the regression for
 *
 * Two shapes used to be EXCLUDED from the grammar, with the finding written at
 * the exclusion. Both are in it now, at every delivery count, and both are the
 * regression target for the fix in `workflow-replay-step.ts` ("An attempt is a
 * LEASE"). What they found, on this property's first run:
 *
 * `claimAttempt` was a TALLY, charged before the body and never given back, and
 * `DEFAULT_STEP_MAX_ATTEMPTS` is 3 — so the budget was shared across overlapping
 * deliveries rather than held per attempt, and a step that consumed one without
 * settling one spent from it forever.
 *
 * - **`nestedWait`** — a `ctx.step` whose body SUSPENDS, which
 *   `workflow-replay-step.ts` called "one line away at every call site". A
 *   suspend is "neither retried nor journaled", but the attempt was already
 *   CHARGED and never returned, so every delivery burned one and none settled
 *   it. Shrunk to a ONE-node body under three deliveries: three walks suspend on
 *   `sleep!0` having charged 1, 2 and 3, the next round's first reach answers 4,
 *   and `appendStep(… status:"failed", error:"step s0 exhausted 3 attempt(s)")`
 *   lands — a permanent verdict on a step that then succeeded, whose own walk
 *   read that failure back out of the idempotent append and failed the run.
 * - **`flaky`** — a step that throws once, i.e. an ordinary in-process retry.
 *   Under three walks it charged 4: two hold a charge each while the third
 *   releases nothing between its two tries. The same spurious `failed`, by the
 *   other door — and the reason the delivery count used to decide the grammar.
 *
 * **`nestedWait` is GONE from the grammar, and what it cost is worth stating.**
 * A wait inside a step is now a program the engine refuses outright — it also
 * silently skipped every LATER wait in the run, which the lease fix did not
 * touch; `workflow-replay-wait.ts` has both bugs. So the shape cannot be
 * generated without generating an illegal body, and the measurement below is now
 * the record of what it USED to hold rather than what holds today.
 *
 * **Which shape a REGRESSION would be caught by, measured, because the two were
 * not equally likely.** Reverting the lease fix, `nestedWait` failed this
 * property at `numRuns: 40` on **10 runs out of 10** — it needed only a one-node
 * body. The `flaky` shape is the rarer one: with `nestedWait` removed from the
 * grammar the same revert survived 40 runs and took **45 generated scenarios** to
 * hit, at `[all([flaky, step]), step]` under three deliveries. `flaky` is
 * therefore what holds the line here now, and it holds the half of the lease that
 * is still reachable — a charge NOT given back when an attempt dies. The other
 * half, a suspend giving one back, has a deterministic test instead:
 * `workflow-replay.test.ts`, "a suspend that reaches a step's attempt loop
 * anyway".
 *
 * The fix separates the two budgets the one number was serving. Tries are
 * counted in the WALK, so no delivery spends another's retries; the charge is a
 * lease released whenever an attempt ENDS, so the pre-body ceiling bounds
 * ABANDONMENT — the thing only a durable counter can see — and its refusal is no
 * longer a journal entry at all. A step that succeeded can no longer be
 * journaled `failed`, because only a walk whose own body threw may write one.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { runConcurrentScenario } from "./_workflow-concurrent-harness.ts";
import { checkJournalInvariants } from "./_workflow-journal-invariants.ts";
import { checkLaws } from "./_workflow-laws-harness.ts";
import { noteScenario, type Stats, zeroStats } from "./_workflow-reach-harness.ts";
import {
  type HookMode,
  type Leaf,
  label,
  type Node,
  type Program,
  runScenario,
} from "./_workflow-resume-harness.ts";
import type { Arm } from "./_workflow-schedule-harness.ts";

/** Every way a generated `waitFor` can be answered. */
const ALL_HOOK_MODES: readonly HookMode[] = ["signal", "timedSignal", "timeout"];

/**
 * One leaf step. `flaky` throws once, then succeeds.
 *
 * Both leaf kinds are generated at every delivery count. `flaky` used to be
 * gated on one, because a step's retry budget was DURABLE and three walks spent
 * four of it — see the module doc's attempt-budget finding.
 */
function leafArb(): fc.Arbitrary<Leaf> {
  return fc
    .tuple(fc.constantFrom("step" as const, "flaky" as const), fc.integer({ min: 0, max: 9 }))
    .map(([t, value]): Leaf => ({ t, name: "", value }));
}

/**
 * One statement of a body.
 *
 * `fanOut` is off only where a property's own claim needs a body that issues one
 * step at a time — see the cross-run property, and the cancel property in
 * `workflow-resume-equivalence.test.ts` for the same call.
 */
function nodeArb(failing: boolean, fanOut = true): fc.Arbitrary<Node> {
  const shapes: fc.Arbitrary<Node>[] = [
    leafArb(),
    fc.integer({ min: 2, max: 3 }).map((count): Node => ({ t: "loop", name: "", count })),
    fc.constant<Node>({ t: "sleep", waitLabel: "" }),
    // A `ctx.step` whose body SUSPENDS — "one line away at every call site", and
    // the shape that found the attempt-budget defect. See the module doc.
    fc.constantFrom(...ALL_HOOK_MODES).map((mode): Node => ({ t: "hook", token: "", mode })),
    fc
      .array(leafArb(), { minLength: 1, maxLength: 2 })
      .map((children): Node => ({ t: "nested", name: "", children })),
  ];
  if (failing) shapes.push(fc.constant<Node>({ t: "boom", name: "" }));
  if (fanOut) {
    shapes.push(
      fc
        .array(leafArb(), { minLength: 2, maxLength: 3 })
        .map((children): Node => ({ t: "all", children })),
      fc
        .tuple(fc.integer({ min: 1, max: 3 }), fc.array(leafArb(), { minLength: 2, maxLength: 3 }))
        .map(([width, children]): Node => ({ t: "map", width, children })),
    );
  }
  return fc.oneof(...shapes);
}

/** A whole body, unlabelled — the property labels it. */
function programArb(failing: boolean, maxLength: number, fanOut = true): fc.Arbitrary<Program> {
  return fc.array(nodeArb(failing, fanOut), { minLength: 1, maxLength });
}

/**
 * A body GUARANTEED to reach an already-shut `waitFor` window, with a `ctx.sleep`
 * spliced in at a generated position — the state the third property targets.
 *
 * Forced by INSERTION rather than by filtering, so every generated value maps to
 * a legal one and shrinking stays well behaved. `failing` is off: a `boom` before
 * the hook ends the run terminally and the window is never reached, so the
 * generator would be refuting its own precondition.
 */
function racedWindowArb(): fc.Arbitrary<Program> {
  return fc
    .tuple(fc.array(nodeArb(false), { maxLength: 2 }), fc.integer({ min: 0 }))
    .map(([nodes, at]): Program => {
      const out = [...nodes];
      out.splice(Math.min(at, out.length), 0, { t: "hook", token: "", mode: "timeout" });
      return out;
    });
}

/**
 * States the interleaving has to have REACHED, or the five laws are satisfied by
 * a corpus in which the two deliveries never met.
 *
 * Floors sit under the OBSERVED MINIMUM over 20 runs with the range beside each,
 * never a fraction of the mean. This generator's distribution is worse-tailed
 * than the sequential one it borrows its grammar from: whether two walks are in
 * the journal together at all is decided by the scheduler, so a run in which
 * every delivery happened to be released to completion in turn reaches almost
 * none of these.
 */
const reached: Stats = zeroStats();

describe("two deliveries of one run, overlapping inside the journal", () => {
  test("agree on every answer, journal every key once, and end the run once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        // Drawn independently of the program, which they used not to be: the
        // grammar was a function of the delivery count, because a step's retry
        // budget was shared across deliveries and two shapes were unsafe above a
        // certain number of them. See the module doc.
        fc.integer({ min: 2, max: 3 }),
        programArb(true, 4),
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom<Arm>("direct", "roundTrip"),
        fc.option(fc.integer({ min: 1, max: 2 }), { nil: undefined }),
        async (s, deliveries, raw, stepConcurrency, arm, cancelRound) => {
          const program = label(raw);
          // The ORACLE is the uninterrupted run of the same body, one delivery
          // at a time — `runScenario` with no crash and no cancel.
          const oracle = await runScenario(program, { stepConcurrency });
          const run = await runConcurrentScenario(program, {
            scheduler: s,
            deliveries,
            stepConcurrency,
            arm,
            cancelRound,
          });
          noteScenario(reached, run, oracle);
          if (program.some((node) => node.t === "all" || node.t === "map")) reached.fanOuts++;
          // The five laws, plus the claims DERIVED from the write log. Neither
          // contains the other: law 2 compares a step's `{status, output}`
          // where `checkStepEntries` compares the whole stored entry, and law 1
          // is a claim against an ORACLE no log-derived check can make.
          expect([
            ...checkLaws(program, run, oracle),
            ...checkJournalInvariants(run.writes),
          ]).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );

    // Ranges over 20 runs. Without these the five laws are satisfied by a corpus
    // in which the scheduler serialized every delivery — which is precisely the
    // vacuity the harness's own doc warns about, quoting the studio fuzz test:
    // the harness would report success by construction.
    // The one that would catch this harness accidentally serializing itself.
    expect(
      reached.journalOverlaps,
      "no two operations were ever in the journal at once",
    ).toBeGreaterThan(350); // 499-705
    expect(reached.deliverySwitches, "two deliveries never took turns").toBeGreaterThan(200); // 369-508
    // The at-least-once COST, measured rather than forbidden — see the laws
    // module. The floor was `> 20` against a measured 44-107, and it came DOWN
    // by an order of magnitude when `settledSince` landed
    // (`workflow-replay-step.ts`): a walk no longer executes a step its
    // snapshot missed but the journal has SETTLED, so what is left here is the
    // genuine race — two walks reaching a step neither has settled — rather
    // than the stale-snapshot case, which was most of it. Lowered with a
    // re-measured range rather than kept, because the number is evidence that
    // an interleaving worth a claim was produced, not a target.
    expect(reached.duplicateSteps, "no step body ever ran twice").toBeGreaterThan(2); // 6-21 over 30 runs
    // Small by construction — a second walk reaches an answer only when it got
    // past the terminal check before the first one wrote it — so `> 0` is what a
    // "never reached" floor is for.
    expect(reached.agreeingWalks, "two walks never both reached an answer").toBeGreaterThan(0);
    // Exactly one refusal per scenario, by construction, so there is no range to
    // record and nothing for a floor above zero to be measured against.
    expect(reached.startsRefused, "no colliding start was ever refused").toBeGreaterThan(0);
    expect(reached.cancelsMidWalk, "no cancel landed with work still ahead").toBeGreaterThan(8); // 12-23
    expect(reached.fanOuts, "no program fanned steps out").toBeGreaterThan(6); // 13-28
  }, 120_000);
});

/** What the third property reached, kept apart so its floors are its own. */
const raced: Stats = zeroStats();

/**
 * The `closeHook` compare-and-set, targeted.
 *
 * Its own property rather than a floor on the walk above, the same call the
 * studio fuzz test makes for its attempt cap: reaching this needs a
 * `deliverHook` released into the few scheduling points between a wait's
 * `claimHook` and its `closeHook`, and a random body of up to four nodes reaches
 * it too rarely to floor. Measured over 20 runs of the property above, a timeout
 * window closed **0 times in 6 of them** and the close was refused **0 times in
 * 8** — so a floor on either there would flake at exactly the rate the state is
 * missed. Here the program is FORCED to contain the wait and the signaller is
 * aimed at it, which takes both counters into the dozens.
 *
 * What the CAS decides is which of two answers every later replay reads:
 * `closeHook`'s own doc says an unconditional close "prevented only half the
 * divergence it is documented to prevent — the engine reads the deadline, then
 * closes, and a signal landing between the two left this walk taking the
 * TIMED-OUT branch while every later replay read `delivered: true` and took the
 * ANSWERED one."
 */
describe("a timeout window and a signal, racing for one wait", () => {
  test("let exactly one of them win, and every walk reads that one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        racedWindowArb(),
        fc.integer({ min: 2, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom<Arm>("direct", "roundTrip"),
        async (s, rawProgram, deliveries, stepConcurrency, arm) => {
          const program = label(rawProgram);
          const oracle = await runScenario(program, { stepConcurrency });
          const run = await runConcurrentScenario(program, {
            scheduler: s,
            deliveries,
            stepConcurrency,
            arm,
          });
          noteScenario(raced, run, oracle);
          // The five laws, plus the claims DERIVED from the write log. Neither
          // contains the other: law 2 compares a step's `{status, output}`
          // where `checkStepEntries` compares the whole stored entry, and law 1
          // is a claim against an ORACLE no log-derived check can make.
          expect([
            ...checkLaws(program, run, oracle),
            ...checkJournalInvariants(run.writes),
          ]).toEqual([]);
        },
      ),
      { numRuns: 60 },
    );

    // Ranges over 20 runs. BOTH outcomes have to be reached: a corpus in which
    // the close always won never exercises the refusal, and one in which the
    // signal always won never exercises the close.
    expect(raced.closeWon, "no timeout window ever closed").toBeGreaterThan(35); // 71-111
    expect(raced.closeRefused, "a signal never once beat a timeout close").toBeGreaterThan(12); // 22-41
  }, 120_000);
});

/** What the cross-run property reached. */
const crossRun: Stats = zeroStats();

/**
 * A companion body: hook-free, and short.
 *
 * Hook-free by the store's contract — a token is unique ACROSS runs, so two runs
 * of one labelled program derive the same `tok0` and the second's `claimHook`
 * throws by design (`onRunSettled` gives the tokens back, so a SEQUENTIAL second
 * run is fine; a concurrent one is not, and the SDK's advice to derive a token
 * per session is the authoring half of the same rule). Short because the claim it
 * carries is about the shared step GATE rather than about its own body.
 */
function companionArb(): fc.Arbitrary<Program> {
  const shapes: fc.Arbitrary<Node>[] = [
    leafArb(),
    fc.integer({ min: 2, max: 3 }).map((count): Node => ({ t: "loop", name: "", count })),
    fc.constant<Node>({ t: "sleep", waitLabel: "" }),
    fc
      .array(leafArb(), { minLength: 1, maxLength: 2 })
      .map((children): Node => ({ t: "nested", name: "", children })),
  ];
  return fc.array(fc.oneof(...shapes), { minLength: 1, maxLength: 3 });
}

/**
 * TWO runs of one engine, which is the case the engine-wide step gate is FOR.
 *
 * `createStepGate` is one gate per engine deliberately — *"what it protects is
 * process memory, and a deployed guest serves every run of its slug"* — and
 * every generated scenario in this repo, this file's other two properties
 * included, has exactly one run. So the cross-run behaviour that is the whole
 * reason the gate is engine-wide was exercised by nothing generated.
 *
 * `stepConcurrency` is drawn from 1..2 rather than wider on purpose: at one slot
 * the two runs' steps really do queue behind each other, and a gate that had lost
 * its re-entrancy would wedge BOTH runs — the deadlock `workflow-step-gate.ts`
 * records, which at the default width *"wedge[s] every workflow in the agent"*.
 * With three slots free a second run simply takes one and proves nothing.
 *
 * The companion's claim is deliberately narrower than the primary's five laws:
 * that sharing the gate did not change its ANSWER, or its journal, or leave it
 * running. Per-step invocation counts would need a second recorder whose numbers
 * no law reads.
 */
describe("two runs of one engine, sharing its step gate", () => {
  test("each reaches its own answer, and neither wedges the other", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        programArb(false, 3, false),
        companionArb(),
        fc.integer({ min: 2, max: 3 }),
        fc.integer({ min: 1, max: 2 }),
        async (s, rawProgram, rawCompanion, deliveries, stepConcurrency) => {
          const program = label(rawProgram);
          const companion = label(rawCompanion);
          const oracle = await runScenario(program, { stepConcurrency });
          const companionOracle = await runScenario(companion, { stepConcurrency });
          const run = await runConcurrentScenario(program, {
            scheduler: s,
            deliveries,
            stepConcurrency,
            arm: "direct",
            companion,
          });
          noteScenario(crossRun, run, oracle);
          // The five laws, plus the claims DERIVED from the write log. Neither
          // contains the other: law 2 compares a step's `{status, output}`
          // where `checkStepEntries` compares the whole stored entry, and law 1
          // is a claim against an ORACLE no log-derived check can make.
          expect([
            ...checkLaws(program, run, oracle),
            ...checkJournalInvariants(run.writes),
          ]).toEqual([]);
          // The companion, against its OWN uninterrupted oracle.
          expect(run.companion, "the companion run vanished").toBeDefined();
          expect(run.companion?.status, "the companion did not reach its status").toBe(
            companionOracle.status,
          );
          expect(run.companion?.keys, "the companion's journal diverged").toEqual(
            companionOracle.keys,
          );
          expect(run.companion?.output, "the companion's answer diverged").toEqual(
            companionOracle.output,
          );
        },
      ),
      { numRuns: 40 },
    );

    // Range over 20 runs. The ONE state this property exists for, and the only
    // floor in the file whose absence would leave a whole property decorative:
    // with no cross-run overlap the companion is a second run that merely
    // happened to also finish.
    expect(
      crossRun.crossRunOverlaps,
      "the two runs were never in the journal at once",
    ).toBeGreaterThan(600); // 1088-1337
  }, 120_000);
});
