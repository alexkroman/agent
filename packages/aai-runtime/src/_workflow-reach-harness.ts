// Copyright 2026 the AAI authors. MIT license.
/**
 * What the interleaving REACHED, which is what the property's floors assert.
 *
 * One of four modules behind `workflow-concurrent-delivery.test.ts` —
 * `_workflow-schedule-harness.ts` is the wire, `_workflow-concurrent-harness.ts`
 * drives the deliveries, `_workflow-laws-harness.ts` states the claims, and this
 * counts. Its own seam: a LAW is a claim that must hold for every interleaving,
 * and a REACH counter is evidence that the corpus produced an interleaving worth
 * making a claim about. `check-property-floors` exists because the second half
 * is the one that silently stops being true — *"an all-green property proves
 * nothing about a state the generator never entered."*
 *
 * Everything here is derived from the op log rather than instrumented into the
 * engine, which is the same rule `studio-concurrency-fuzz.test.ts` follows with
 * its counting queue wrapper: *"a counter in the queue itself would be
 * production code carrying a field only a test reads; claims are observable from
 * out here."*
 */

import type { ConcurrentScenario } from "./_workflow-concurrent-harness.ts";
import type { Scenario } from "./_workflow-resume-harness.ts";
import { callArgs, type Ev, isGuardedTerminalMove } from "./_workflow-schedule-harness.ts";

/** What the interleaving reached, for the floors the suite asserts. */
export type Stats = {
  /** One operation's call answered while another operation's call was outstanding. */
  journalOverlaps: number;
  /** Adjacent journal calls made by two DIFFERENT deliveries of this run. */
  deliverySwitches: number;
  /** Step-body executions beyond what the uninterrupted oracle needed. */
  duplicateSteps: number;
  /** `closeHook` compare-and-sets REFUSED — a signal beat a timeout close. */
  closeRefused: number;
  /** Timeout windows that closed, having beaten the signal. */
  closeWon: number;
  /** Colliding `start` calls the journal refused. */
  startsRefused: number;
  /** Cancels whose compare-and-set won with step bodies still ahead of them. */
  cancelsMidWalk: number;
  /** Scenarios in which two walks each ran the body to an answer. */
  agreeingWalks: number;
  /**
   * Overlaps between operations of DIFFERENT runs of the one engine.
   *
   * The state `createStepGate` is engine-wide FOR, and which every generated
   * scenario in this repo missed by having exactly one run.
   */
  crossRunOverlaps: number;
  /**
   * Programs that fanned steps out concurrently.
   *
   * Set by the property rather than by {@link measure}: it is a property of the
   * generated BODY, which the op log cannot see.
   */
  fanOuts: number;
};

/** A fresh, all-zero {@link Stats}. */
export function zeroStats(): Stats {
  return {
    journalOverlaps: 0,
    deliverySwitches: 0,
    duplicateSteps: 0,
    closeRefused: 0,
    closeWon: 0,
    startsRefused: 0,
    cancelsMidWalk: 0,
    agreeingWalks: 0,
    crossRunOverlaps: 0,
    fanOuts: 0,
  };
}

/**
 * Fold one scenario into a running total.
 *
 * Two counters need the ORACLE and so are computed here rather than in the
 * scenario. {@link Stats.duplicateSteps} is the at-least-once cost the engine's
 * own doc admits to (*"not doing the work twice … is a cost rather than a
 * correctness problem"*), and measuring it is what keeps that sentence honest.
 * {@link Stats.cancelsMidWalk} is QUALIFIED rather than summed: a cancel that
 * won on the last step proves almost nothing, there having been nothing left to
 * stop — the same distinction `workflow-resume-equivalence.test.ts` draws with
 * its `earlyCancels`.
 */
export function noteScenario(total: Stats, run: ConcurrentScenario, oracle: Scenario): void {
  for (const key of Object.keys(total) as (keyof Stats)[]) {
    if (key === "cancelsMidWalk" || key === "duplicateSteps") continue;
    total[key] += run.stats[key];
  }
  if (run.stats.cancelsMidWalk > 0 && run.total < oracle.total) total.cancelsMidWalk++;
  for (const [name, count] of Object.entries(run.counts)) {
    total.duplicateSteps += Math.max(count - (oracle.counts[name] ?? 0), 0);
  }
}

/**
 * Everything the log can be read for, in one pass.
 *
 * The two interleaving counters are deliberately different questions. A SWITCH
 * is "two deliveries took turns", which a serialized harness also produces; an
 * OVERLAP is "one operation's call was ANSWERED while another's was still
 * outstanding", which only a genuinely concurrent one does. A floor on the
 * second is what would catch this harness accidentally scheduling `execute`.
 */
export function measure(events: readonly Ev[], walkOutputs: readonly unknown[][]): Stats {
  const stats = zeroStats();
  /** Calls issued and not yet answered, by the operation that issued them. */
  const open = new Map<number, string>();
  let lastDelivery: string | undefined;
  for (const ev of events) {
    if (ev.kind === "call") {
      open.set(ev.i, ev.by);
      // Only a DELIVERY's turns count as a switch: a signaller taking a turn
      // between two calls of one walk is not two walks interleaving.
      if (ev.by.startsWith("p.d")) {
        if (lastDelivery !== undefined && lastDelivery !== ev.by) stats.deliverySwitches++;
        lastDelivery = ev.by;
      }
      continue;
    }
    noteOverlap(stats, open, ev);
    open.delete(ev.i);
    noteAnswer(stats, events, ev);
  }
  if (walkOutputs.length > 1) stats.agreeingWalks++;
  return stats;
}

/** Count this answer's overlap, and whether it was with another RUN. */
function noteOverlap(stats: Stats, open: ReadonlyMap<number, string>, ev: Ev): void {
  const other = overlapped(open, ev);
  if (other === undefined) return;
  stats.journalOverlaps++;
  // The operation id is prefixed by its run — `p.` or `c.` — so a differing
  // first character is two RUNS overlapping rather than two deliveries of one.
  if (other[0] !== ev.by[0]) stats.crossRunOverlaps++;
}

/**
 * Which other operation had a call outstanding when this one was answered, if
 * any — the operation id, so the caller can see whether it was another RUN.
 */
function overlapped(open: ReadonlyMap<number, string>, ev: Ev): string | undefined {
  for (const [i, by] of open) {
    if (i !== ev.i && by !== ev.by) return by;
  }
  return undefined;
}

/** The three outcomes worth counting, off one answered call. */
function noteAnswer(stats: Stats, events: readonly Ev[], ev: Ev): void {
  if (ev.method === "closeHook" && ev.kind === "ret") {
    if (ev.value === false) stats.closeRefused++;
    else stats.closeWon++;
  }
  if (ev.method === "createRun" && ev.kind === "throw") stats.startsRefused++;
  const args = callArgs(events, ev.i);
  if (isGuardedTerminalMove(ev, args) && ev.value === true && args?.[1] === "cancelled") {
    stats.cancelsMidWalk++;
  }
}
