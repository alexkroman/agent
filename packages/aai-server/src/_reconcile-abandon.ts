// Copyright 2026 the AAI authors. MIT license.
/**
 * When the platform STOPS repairing a run, and what it writes when it does.
 *
 * Split from `workflow-queue-reconcile.ts`, which owns the pass itself: that
 * module is the REPAIR — find a run the queue has lost and schedule it — and this
 * one is the single decision the repair is bounded by. Its own module because the
 * budget's argument is much longer than its code and the pass was at the
 * file-length cap; the seam is real either way, `reconcileStalledRuns` reaching
 * for exactly two names here.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai";
import { createLogger } from "./logger.ts";
import { setStatus } from "./platform-workflow-journal.ts";
import type { SqlExec } from "./secret-store.ts";
import type { StalledRun } from "./workflow-queue-reconcile.ts";

// The pass's own namespace deliberately: an abandonment is one outcome of a
// reconcile pass, and an operator grepping for the pass wants to see it.
const log = createLogger("workflow.queue.reconcile");

/**
 * Re-walks one run may be given before the platform declares it dead.
 *
 * Every other bound on this pass is about a TICK — `RECONCILE_MAX_PER_TICK` is
 * its width, `STALL_GRACE_MS` its rate — and neither bounds the number of times
 * one run is repaired. Without this the pass has no end: nothing on the platform
 * side writes a terminal status (only the guest's engine calls `setStatus`), so a
 * run whose guest can never complete it was re-enqueued every `STALL_GRACE_MS`
 * forever — a sandbox boot every ten minutes, per run, and a permanent resident
 * of the partial index this pass reads.
 *
 * ## Why five, and what it really buys the run
 *
 * Each re-walk is separated by a full `STALL_GRACE_MS` and is itself a queue
 * message with `QUEUE_MAX_ATTEMPTS` deliveries behind it, each booting a sandbox.
 * So five is on the order of **fifty minutes** of unreachability and ~25 boots
 * before the run is failed, which is far past any transient: a guest that has not
 * journaled a thing across that is not going to.
 *
 * The number mirrors `QUEUE_MAX_ATTEMPTS` for the same reason that one exists —
 * "a message whose guest cannot be reached is not made more deliverable by trying
 * forever, and every attempt boots a sandbox" — one layer up, where the thing not
 * made more deliverable is the RUN.
 *
 * ## The count does NOT decay, and that is the trade worth knowing
 *
 * A run that stalls, is repaired, runs healthily for a week and stalls again
 * carries its earlier strikes. Resetting them would need somebody to OBSERVE the
 * recovery, and nothing does: a resumed run journals steps and enqueues its next
 * message, and neither touches this row. What makes the un-decayed count
 * acceptable is that reaching this pass at all is abnormal — a healthy run always
 * has a queue row (a parked `sleep` is a delayed message, a `waitFor` is an open
 * hook window), and both are arms of the predicate. Five stalls in one run's life
 * means the platform lost its message five times.
 *
 * ## What a platform-wide OUTAGE costs, stated rather than argued away
 *
 * If nothing can be delivered for an hour, every run in the fleet accumulates
 * strikes and the long ones are failed. That is the honest cost of having an end
 * at all, and it is bounded by the same width bound as everything else here (20
 * runs per tick), so it is a slope rather than a cliff. The alternative — an
 * exponential backoff with no terminal state — keeps the rows and the index
 * growth forever, which is the defect this closes. An operator who knows an
 * outage happened has a real remedy either way: the run's history is intact
 * (retention is 30 days from its start) and starting a new run is one call.
 */
export const RECONCILE_MAX_ATTEMPTS = 5;

/**
 * What the run's `error` says when the platform gives up on it.
 *
 * The author reads this in `aai workflow` and in a workflow app's run list, so it
 * names the CAUSE it can honestly name — nothing was scheduled and re-walking did
 * not help — rather than guessing at the agent's own bug.
 */
export const ABANDONED_RUN_ERROR =
  `the platform stopped re-walking this run after ${RECONCILE_MAX_ATTEMPTS} attempts: ` +
  "nothing was scheduled to touch it and each re-walk left it unfinished. " +
  "Check the agent's logs for a failure at boot or in the workflow body.";

/**
 * The two statuses a run can be repaired FROM, and the compare-and-set's `expect`.
 *
 * The predicate above writes them out as literals instead of binding this, so it
 * keeps matching `workflow_runs_stalled_idx`'s partial predicate — a partial index
 * is matched by implication, and a bound array does not imply the literal list.
 * `workflow-queue-reconcile.test.ts` pins the two equal.
 */
const LIVE_STATUSES = ["pending", "running"] as const;

/**
 * Give up on a run, moving it to `failed` with a reason.
 *
 * **A compare-and-set on the live statuses, never a bare update.** The predicate
 * and this write are two autocommit statements on a reserved connection, so a
 * guest can complete the run in between — and a `failed` written over a
 * `completed` would destroy an author's real output on the strength of a stale
 * read. The journal's own `setStatus` is what makes it a CAS, and it releases the
 * run's hook tokens in the same statement, which a hand-written update here would
 * silently not do.
 *
 * **It never throws.** Abandonment is the last thing this pass does for a run and
 * the pass is a repair ACROSS tenants: one run whose failure cannot be written
 * must cost the others nothing, exactly as one run whose enqueue fails does.
 *
 * Answers whether this call is what failed the run, so a run that moved on its own
 * is not reported as abandoned.
 */
export async function abandonStalledRun(sql: SqlExec, run: StalledRun): Promise<boolean> {
  const { slug, runId } = run;
  try {
    const moved = await setStatus(
      sql,
      slug,
      runId,
      "failed",
      { error: ABANDONED_RUN_ERROR },
      LIVE_STATUSES,
    );
    if (!moved) {
      // The run reached a terminal status between the predicate and here, or its
      // agent was deleted and the cascade took it. Either way there is nothing to
      // abandon and nothing for an operator to do.
      log.debug("stalled run settled before it could be abandoned", { slug, runId });
      return false;
    }
    // WARN, and the only line in this module an author is meant to act on: the
    // platform has stopped trying, and the run's own `error` now says so too.
    log.warn("gave up re-walking a stalled run; marked it failed", {
      slug,
      runId,
      attempts: run.reconciles,
    });
    return true;
  } catch (err) {
    log.warn("could not abandon a stalled run; the rest of the pass continues", {
      slug,
      runId,
      error: errorMessage(err),
    });
    return false;
  }
}
