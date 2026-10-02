// Copyright 2026 the AAI authors. MIT license.
/**
 * The replay every frozen interleaving's spec runs (`interleavings/*.test.ts`).
 *
 * Shared rather than copied into each case's spec: what "replay" means — the
 * oracle, the frozen scheduler, the pooled checkers — has to be ONE definition,
 * or a case could pass against a weaker replay than its siblings.
 */

import fc from "fast-check";
import { runConcurrentScenario } from "./_concurrent-harness.ts";
import { defectiveJournal, type JournalDefect } from "./_defective-journal.ts";
import { checkLaws } from "./_laws-harness.ts";
import { label, runScenario } from "./_resume-harness.ts";
import type { Interleaving } from "./interleavings/interleaving.ts";
import { checkJournalInvariants } from "./journal/_invariants.ts";
import { createMemoryJournal } from "./journal/backends/memory.ts";

/**
 * Replay one frozen interleaving, and report every claim it breaks.
 *
 * The two checkers are pooled deliberately: the five laws and the derived
 * journal invariants overlap but neither contains the other — law 2 compares a
 * step's `{status, output}` where `checkStepEntries` compares the whole stored
 * entry, and law 1's key conservation is a claim against an ORACLE that no
 * log-derived check can make. A scenario passes only when both are silent.
 *
 * `fc.schedulerFor` rather than `fc.scheduler`: the ordering is the frozen half.
 */
export async function replay(kept: Interleaving, defect?: JournalDefect): Promise<string[]> {
  const program = label(kept.program);
  const oracle = await runScenario(program, { stepConcurrency: kept.stepConcurrency });
  const inner = createMemoryJournal();
  const run = await runConcurrentScenario(program, {
    scheduler: fc.schedulerFor([...kept.ordering]),
    deliveries: kept.deliveries,
    stepConcurrency: kept.stepConcurrency,
    arm: kept.arm,
    cancelRound: kept.cancelRound,
    journal: defect ? defectiveJournal(inner, defect) : inner,
  });
  return [...checkLaws(program, run, oracle), ...checkJournalInvariants(run.writes)];
}
