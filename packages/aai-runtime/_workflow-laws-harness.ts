// Copyright 2026 the AAI authors. MIT license.
/**
 * The five laws two overlapping deliveries of one run must satisfy, as a list of
 * sentences.
 *
 * One of four modules behind `workflow-concurrent-delivery.test.ts`, split at
 * the seams that file already had: `_workflow-schedule-harness.ts` is the wire,
 * `_workflow-concurrent-harness.ts` drives the deliveries, and this reads the
 * result and the op log back as claims. That test's own doc lists the five and
 * carries the argument.
 *
 * The seam against `_workflow-reach-harness.ts` is the one worth naming: a LAW
 * must hold for every interleaving, and a REACH counter is evidence that an
 * interleaving worth making a claim about was produced. Neither substitutes.
 *
 * ## Why a LIST rather than a chain of `expect`s
 *
 * The reason `comparable()` in `workflow-resume-equivalence.test.ts` is one
 * value: a chain prints only the first field to differ, and under an
 * interleaving the informative violation is rarely the first one. A list also
 * shrinks well — the property is `problems === []`, so fast-check reduces to the
 * smallest program and the shortest interleaving that still breaks ANY law.
 *
 * ## The law from the survey that is FALSE as stated
 *
 * The brief asked for "each step name's body ran exactly as often as in the
 * uninterrupted oracle". That is not this engine's claim, and asserting it would
 * report the design as a defect — `workflow-engine.ts` says so in the same
 * paragraph as the safety claim: *"The one thing a lock WOULD buy is not doing
 * the work twice, which is a cost rather than a correctness problem."* Two
 * overlapping walks legitimately execute the same unsettled step twice. What is
 * conserved is the JOURNAL: one row per key, the first writer authoritative, and
 * every walk reading that row back. So law 1 asserts conservation of KEYS and a
 * FLOOR on executions, and `Stats.duplicateSteps` measures the double work
 * instead of forbidding it.
 */

import type { ConcurrentScenario } from "./_workflow-concurrent-harness.ts";
import type { Scenario } from "./_workflow-resume-harness.ts";
import { expectedOutput, fails, type Program } from "./_workflow-resume-program.ts";
import { callArgs, type Ev, isGuardedTerminalMove } from "./_workflow-schedule-harness.ts";
import { isTerminalStatus, type StepEntry } from "./workflow-journal-types.ts";

/** How many `start` calls race for one minted id — see the driver. */
export const COLLIDING_STARTS = 2;

/** Every law, evaluated over one scenario against its uninterrupted oracle. */
export function checkLaws(program: Program, run: ConcurrentScenario, oracle: Scenario): string[] {
  const cancelled = run.status === "cancelled";
  return [
    ...checkEffectConservation(run, oracle, cancelled),
    ...checkAnswerAgreement(program, run),
    ...checkTerminalUniqueness(program, run, cancelled),
    ...checkHookUniqueness(run),
    ...checkStartUniqueness(run),
  ];
}

/**
 * LAW 1 — effect conservation.
 *
 * The journal holds exactly the keys the uninterrupted run wrote, and no step
 * ran FEWER times than it needed to. A CANCELLED run journals a prefix, so its
 * keys are a subset rather than the same set — which is a weaker claim and the
 * only honest one: `replayRun` checks the signal before each step executes, so
 * where the prefix ends is the cancel's business.
 */
function checkEffectConservation(
  run: ConcurrentScenario,
  oracle: Scenario,
  cancelled: boolean,
): string[] {
  const problems: string[] = [];
  const conserved = cancelled
    ? run.keys.every((key) => oracle.keys.includes(key))
    : sameKeys(run.keys, oracle.keys);
  if (!conserved) {
    problems.push(
      `journal keys diverged: ran ${JSON.stringify(run.keys)}, oracle ${JSON.stringify(oracle.keys)}`,
    );
  }
  for (const [name, count] of Object.entries(run.counts)) {
    const floor = oracle.counts[name] ?? 0;
    if (floor === 0) problems.push(`step ${name} ran but the oracle never reached it`);
    else if (count < floor) {
      problems.push(`step ${name} ran ${count} time(s), under the oracle's ${floor}`);
    }
  }
  return problems;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * LAW 2 — answer agreement.
 *
 * Every walk that reached an answer reached the SAME answer, and it is the one
 * the grammar predicts; and every execution of one step key read back one value,
 * which is `appendStep`'s idempotency seen from the caller's side.
 */
function checkAnswerAgreement(program: Program, run: ConcurrentScenario): string[] {
  const problems: string[] = [];
  const expected = expectedFor(program, run.delivered);
  for (const [i, output] of run.walkOutputs.entries()) {
    if (JSON.stringify(output) !== JSON.stringify(expected)) {
      problems.push(
        `walk ${i} answered ${JSON.stringify(output)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  const byKey = new Map<string, string>();
  for (const ev of run.log) {
    if (ev.kind !== "ret" || ev.method !== "appendStep") continue;
    // Filtered by RUN: a journal key is per run, so a companion sharing the
    // engine has its own `s0#0` and pooling the two reported a disagreement
    // between two runs that each answered correctly.
    if (callArgs(run.log, ev.i)?.[0] !== run.runId) continue;
    const entry = ev.value as StepEntry | undefined;
    if (!entry) continue;
    const answer = JSON.stringify({ status: entry.status, output: entry.output });
    const first = byKey.get(entry.key);
    if (first === undefined) byKey.set(entry.key, answer);
    else if (first !== answer) {
      problems.push(`step ${entry.key} was journaled as ${first} and read back as ${answer}`);
    }
  }
  return problems;
}

/**
 * What the run's answer must be.
 *
 * `expectedOutput` computes it without the engine; the one patch is a `timeout`
 * hook whose window a racing signal answered before it shut. That is not a
 * defect — the wait was open when the signal arrived — so the law stays an
 * ABSOLUTE claim rather than being weakened to "one of two answers", which is
 * what would have made it blind to the two answers really disagreeing.
 */
function expectedFor(program: Program, delivered: Set<string>): unknown[] {
  return expectedOutput(program).map((value, i) => {
    const node = program[i];
    if (node?.t === "hook" && node.mode === "timeout" && delivered.has(node.token)) {
      return { ok: node.token };
    }
    return value;
  });
}

/**
 * LAW 3 — terminal uniqueness.
 *
 * Exactly one compare-and-set moved the run terminal, the run really did
 * terminate, and — when nothing cancelled it — it terminated where the grammar
 * says. The last two are the LIVENESS half: a run left `running` satisfies every
 * uniqueness claim above trivially.
 */
function checkTerminalUniqueness(
  program: Program,
  run: ConcurrentScenario,
  cancelled: boolean,
): string[] {
  const problems: string[] = [];
  const moved = countTerminalMoves(run);
  if (moved > 1) problems.push(`${moved} deliveries moved the run terminal`);
  const terminal = run.status !== undefined && isTerminalStatus(run.status);
  if (!terminal) {
    problems.push(`the run never terminated — it is ${String(run.status)}`);
    return problems;
  }
  if (moved !== 1) {
    problems.push(`the run is ${String(run.status)} but ${moved} compare-and-set(s) moved it`);
  }
  if (cancelled) return problems;
  const sound = fails(program) ? "failed" : "completed";
  if (run.status !== sound) {
    // The recorded ERROR is named, not merely the status: a status alone sends a
    // reader back to the interleaving to guess which of a dozen ways a run can
    // fail this was, and the message is the whole diagnosis.
    problems.push(`the run is ${String(run.status)} (${String(run.error)}), expected ${sound}`);
  }
  // A failed run's record carries no output — `recordOutcome` patches only the
  // error — which is the same rule `soundOutput` states next door.
  const wanted = fails(program) ? undefined : expectedFor(program, run.delivered);
  if (JSON.stringify(run.output) !== JSON.stringify(wanted)) {
    problems.push(
      `the run recorded ${JSON.stringify(run.output)}, expected ${JSON.stringify(wanted)}`,
    );
  }
  return problems;
}

/**
 * How many compare-and-set writes moved THIS run terminal.
 *
 * Filtered by run: a companion sharing the engine writes its own terminal status
 * through the same journal, and pooling the two reported a healthy pair as two
 * deliveries of one run — see `ConcurrentScenario.runId`.
 */
function countTerminalMoves(run: ConcurrentScenario): number {
  let moved = 0;
  for (const ev of run.log) {
    if (ev.kind !== "ret" || ev.value !== true) continue;
    const args = callArgs(run.log, ev.i);
    if (args?.[0] === run.runId && isGuardedTerminalMove(ev, args)) moved++;
  }
  return moved;
}

/**
 * LAW 4 — hook uniqueness: for any wait, at most one of `deliverHook` and
 * `closeHook` may win.
 *
 * `closeHook`'s contract is what makes them mutually exclusive: a `true` means
 * "no signal may be taken through this window", and the compare-and-set on
 * `delivered` is what keeps it true. Its own doc names the failure —
 * unconditional, it *"prevented only half the divergence it is documented to
 * prevent: the engine reads the deadline, then closes, and a signal landing
 * between the two left this walk taking the TIMED-OUT branch while every later
 * replay read `delivered: true` and took the ANSWERED one."*
 *
 * A `closeHook` answering `true` for a record that is GONE would be a false
 * positive here, and cannot arise: the memory journal deletes a settled run's
 * TOKEN INDEX and keeps the hook record, so the walk still reads `delivered`
 * and never reaches the close.
 */
function checkHookUniqueness(run: ConcurrentScenario): string[] {
  const keyOf = tokenKeys(run.log);
  const closed = new Set<string>();
  for (const ev of run.log) {
    if (ev.kind !== "ret" || ev.method !== "closeHook" || ev.value !== true) continue;
    const args = callArgs(run.log, ev.i);
    if (args?.[0] !== run.runId) continue;
    const key = args[1];
    if (typeof key === "string") closed.add(key);
  }
  const problems: string[] = [];
  for (const token of run.delivered) {
    const key = keyOf.get(token);
    if (key !== undefined && closed.has(key)) {
      problems.push(`hook ${key} was both delivered (${token}) and closed`);
    }
  }
  return problems;
}

/** Token to the journal key its wait registered under, from `claimHook`. */
function tokenKeys(events: readonly Ev[]): Map<string, string> {
  const keyOf = new Map<string, string>();
  for (const ev of events) {
    if (ev.kind !== "call" || ev.method !== "claimHook") continue;
    const [, key, token] = ev.args ?? [];
    // A companion has no hooks by contract, so no filter by run is needed here —
    // and one would be wrong: `deliverHook` is addressed by TOKEN, not by run.
    if (typeof key === "string" && typeof token === "string") keyOf.set(token, key);
  }
  return keyOf;
}

/**
 * LAW 5 — start uniqueness.
 *
 * The run id is minted by the CALLER, so `JournalStore.createRun` promises that
 * "a collision means two starts raced and exactly one may win". The second half
 * is what makes the loser observable: the run must carry the WINNING caller's
 * input, because a `start` that resolved handed its caller an id, and an id
 * naming somebody else's input is a discarded run the caller believes it owns.
 */
function checkStartUniqueness(run: ConcurrentScenario): string[] {
  const problems: string[] = [];
  if (run.startsWon.length !== 1) {
    problems.push(`${run.startsWon.length} of ${COLLIDING_STARTS} colliding starts won the id`);
  }
  const winner = run.startsWon[0];
  if (winner !== undefined && JSON.stringify(winner) !== JSON.stringify(run.recordInput)) {
    problems.push(
      `the run carries input ${JSON.stringify(run.recordInput)}, not the winning start's ${JSON.stringify(winner)}`,
    );
  }
  return problems;
}
