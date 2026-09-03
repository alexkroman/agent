// Copyright 2026 the AAI authors. MIT license.
/**
 * What a walk RESOLVED to, and how a throw becomes one.
 *
 * Split out of `workflow-replay.ts` at the seam that file's own history already
 * names: {@link classifyThrow} was extracted from `replayRun`'s `catch` because
 * the arms are a decision procedure with a fixed ORDER sharing no state with the
 * rest of that function, and inlined they took `replayRun` past Biome's
 * cognitive-complexity ceiling. Moving it one step further out is the same cut,
 * and it brings {@link ReplayOutcome} with it because the type is exactly what
 * the procedure returns — a reader checking whether the arms are exhaustive
 * wants both in front of them.
 *
 * `replayRun` re-exports the type, so nothing importing it from
 * `workflow-replay.ts` had to move.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai/utils";
import type { SuspendController } from "./workflow-replay-suspend.ts";

/** What a run's execution resolved to. */
export type ReplayOutcome =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; error: { message: string } }
  /**
   * The body is waiting. Not an outcome the RUN has — it is still `running` —
   * but the outcome this DELIVERY has: the caller returns the worker.
   *
   * `wakeAt` present means a TIMER — schedule the next delivery for then.
   * `undefined` means a HOOK: there is no deadline, and the next delivery comes
   * from whoever signals. Scheduling one anyway would poll a run that may be
   * parked for a week.
   */
  | { kind: "suspended"; wakeAt: number | undefined };

/**
 * What the RACE settling with a rejection means, once the walk's state is in hand.
 *
 * Extracted from {@link replayRun}'s `catch` rather than inlined, because the
 * arms are a decision procedure with a fixed ORDER and nothing else in that
 * function shares state with them — and inlined they took `replayRun` over
 * Biome's cognitive-complexity ceiling, the same seam
 * `workflow-replay-step.ts` was split at.
 *
 * `undefined` means "this is not this function's business": an abort is the
 * caller's own signal coming back out, and `replayRun` re-throws it.
 */
export function classifyThrow(
  err: unknown,
  walk: {
    signal: AbortSignal | undefined;
    refused: string | undefined;
    journalFailed: boolean;
    suspend: SuspendController;
  },
): ReplayOutcome | undefined {
  // The run was cancelled and its status is already whatever cancelled it.
  if (walk.signal?.aborted && err === walk.signal.reason) return undefined;
  // The JOURNAL failed, so the run's state is unknown and this is not a verdict
  // about the run at all: `undefined` re-throws, the delivery fails, and the
  // queue retries it. Ahead of the refusal below because a refusal is a reading
  // of the journal, and a journal that is not answering cannot support one.
  if (walk.journalFailed) return undefined;
  // A REFUSAL the engine raised about this walk wins over everything below,
  // INCLUDING a suspension — which is the one ordering that changed when
  // suspension stopped being a throw, and it changed towards the truth. Three
  // raise one: a divergence — once the walk has read a key the run never
  // reached, every later line ran against a body that had lost its place, so its
  // own failure describes a consequence rather than the cause — a step whose
  // budget is held by attempts that never ended (`StepAbandonedError`), where
  // the body never ran at all and whatever it did instead is not the finding —
  // and a wait reached inside a step, where every wait AFTER it would read the
  // wrong record. A walk that has lost its place must not be parked and
  // re-delivered: the refusal is stable, so every later delivery would raise it
  // again, and meanwhile the run reads as healthily waiting.
  if (walk.refused !== undefined) return { kind: "failed", error: { message: walk.refused } };
  // The walk parked. Not a failure and not something the body did: this value
  // was minted by the suspend controller and was never in the body's reach.
  const suspension = walk.suspend.suspensionOf(err);
  if (suspension) return { kind: "suspended", wakeAt: suspension.wakeAt };
  return { kind: "failed", error: { message: errorMessage(err) } };
}
