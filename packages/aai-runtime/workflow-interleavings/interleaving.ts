// Copyright 2026 the AAI authors. MIT license.
/**
 * What a FROZEN interleaving is: a program, a delivery burst, and the exact
 * order the scheduler released every journal round trip in.
 *
 * `workflow-concurrent-delivery.test.ts` generates interleavings and checks five
 * laws over them. When one of those laws fires, fast-check shrinks the ordering
 * to the smallest one that still breaks it and prints it — and then the run
 * ends and the counterexample is gone. Every finding this repo has made that way
 * survives only as a paragraph: the attempt-lease defect is three paragraphs of
 * that test's module doc and is a regression for nothing.
 *
 * A file in this directory is one of those counterexamples kept. `fc.scheduler`
 * draws an ordering at random; `fc.schedulerFor(ordering)` replays a given one,
 * so a frozen scenario runs in milliseconds, on every suite run, with no seed
 * and no shrinking.
 *
 * ## Each one carries the DEFECT it was found by
 *
 * A frozen ordering that only ever passes is a scenario nobody can tell is still
 * checking anything — which is the failure mode every ratchet in this repo is
 * shaped against. So an interleaving names the guard whose removal it catches
 * (`_workflow-defective-journal.ts`), and the spec runs it twice: the laws hold
 * against the real store, and the same scenario BREAKS the named law against the
 * store with that one guard taken out.
 *
 * That is what makes these regressions rather than fixtures. The healthy arm is
 * the regression; the defective arm is the proof the regression can fail.
 */

import type { JournalDefect } from "../_workflow-defective-journal.ts";
import type { Program } from "../_workflow-resume-program.ts";
import type { Arm } from "../_workflow-schedule-harness.ts";

/** One kept counterexample. */
export type Interleaving = {
  /** Short, and unique in this directory — the spec names cases by it. */
  readonly name: string;
  /** What this ordering is, and what it was found by. Printed on nothing; read by people. */
  readonly description: string;
  /**
   * The body, UNLABELLED — exactly as the generator produced it.
   *
   * `label()` is applied by the runner, as the property does, so a stored
   * program and a generated one are the same value and the step keys a frozen
   * scenario produces are the keys a generated one would.
   */
  readonly program: Program;
  /** Concurrent `execute` calls per round. */
  readonly deliveries: number;
  readonly stepConcurrency: number;
  readonly arm: Arm;
  /** Round whose deliveries a `cancel` is issued alongside, when one is. */
  readonly cancelRound?: number | undefined;
  /**
   * The scheduler ordering, 1-based in the order tasks were scheduled — what
   * `fc.schedulerFor` takes and what fast-check prints on a failure.
   *
   * Read off a generated run, never written by hand, and it has to satisfy BOTH
   * arms: every law holds under it against the real store, and the named law
   * fires under it against the store with one guard removed. An ordering
   * captured against the defective store alone does not do the job — the two
   * stores schedule different numbers of round trips, and `schedulerFor` waits
   * for an id that will never be scheduled, so the healthy arm STARVES rather
   * than passing. All three of these were found that way first, and the frozen
   * value is the first generated schedule that drives both.
   *
   * That constraint is what makes the pair a regression: today the healthy arm
   * passes, and a branch that takes the guard out turns the healthy arm INTO the
   * defective one — the same ordering, now failing.
   */
  readonly ordering: readonly number[];
  /**
   * The guard whose removal this ordering catches, and the law that catches it.
   *
   * `law` is matched as a SUBSTRING of one of the reported problems, so it is a
   * phrase from the law's own message rather than a number — a number would say
   * the check fired without saying it fired for this reason.
   */
  readonly catches: { readonly defect: JournalDefect; readonly law: string };
};
