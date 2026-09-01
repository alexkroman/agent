// Copyright 2026 the AAI authors. MIT license.
/**
 * The DEPLOYED dispatcher: hand a delivery to the platform's queue.
 *
 * `workflow-in-process.ts` is the other one, and the split is the whole reason
 * `dispatch` is a parameter of the engine rather than something it decides. Its
 * timers live in this process, which is the honest trade for `aai dev`; a
 * deployed guest self-exits after `AGENT_IDLE_EXIT_MS`, so a `ctx.sleep(1 day)`
 * held only by a `setTimeout` is forgotten along with the sandbox.
 *
 * The engine's own module doc already specified this shape: "a deployed guest —
 * the dispatcher POSTs the platform's queue, which delivers to `/workflow-queue`,
 * which calls `execute`". This is that dispatcher.
 *
 * ## It REPLACES the local timer rather than racing it
 *
 * Both would work — a delivery is at-least-once by contract and `execute` is
 * written for overlap, the journal rather than a lock being what keeps it safe.
 * But "safe" there means the second walk adopts the first's values, not that it
 * is free: it burns a second `claimAttempt` against the step's ceiling, and a
 * retry budget spent on our own duplicate is a step that fails earlier than the
 * author asked for.
 *
 * So a deployment has exactly one dispatcher. The cost is that a zero-delay
 * dispatch — a `start` — now waits for the queue rather than the next turn of the
 * loop, which is latency a durable workflow already pays and a caller never sees:
 * `start` resolves a run id, never a result.
 *
 * ## A failed enqueue STRANDS the run, and says so
 *
 * `dispatch` returns nothing by contract, so there is nothing to await and
 * nowhere to report a rejection but the log. If the enqueue fails the run has a
 * journal row and no pending message, and the platform's wake sweep reads the
 * QUEUE — so nothing will boot the guest for it until something else does.
 *
 * That is a real gap rather than an accepted one, and it is logged at `error`
 * with the run id so it is recoverable by hand. Closing it properly means the
 * sweep reading the JOURNAL for a due run rather than the queue, which is a
 * change to what the platform considers authoritative and belongs on its own.
 *
 * @internal
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type { PlatformEndpoint } from "./platform-endpoint.ts";
import type { Logger } from "./runtime-config.ts";
import { createPlatformQueueSend } from "./workflow-platform-queue.ts";

/**
 * The queue name one run's ORCHESTRATION messages ride.
 *
 * The grammar is `__wkf_workflow_<id>`, and the platform's claim splits the due
 * set on it: orchestration serialized per run, steps fanned out. A replay wants
 * exactly that serialization — two walks of one body interleaving is the thing
 * the split exists to prevent — so a delivery goes on the workflow topic and the
 * step topic is unused by this engine, which executes a step inline during the
 * walk rather than as its own message.
 *
 * Spelled through `queueNameFor` rather than inline at the call site because
 * `WORKFLOW_QUEUE_NAME_PATTERN` is what the platform's SQL matches, and a name
 * this side composes differently is a message the claim silently never selects.
 */
export function queueNameFor(runId: string): string {
  return `__wkf_workflow_${runId}`;
}

/** What {@link createPlatformDispatch} needs. */
export type PlatformDispatchOptions = {
  platform: PlatformEndpoint;
  logger: Logger;
};

/**
 * Build the dispatcher a deployed guest hands to the engine.
 *
 * @internal
 */
export function createPlatformDispatch(
  opts: PlatformDispatchOptions,
): (runId: string, at?: number) => void {
  const send = createPlatformQueueSend(opts.platform);
  return (runId, at) => {
    // Seconds, because that is what the queue takes. Rounded UP so a delivery is
    // never earlier than the deadline the body computed: a sleep that wakes early
    // re-reads its own stored `wakeAt`, finds it still in the future, and suspends
    // again — correct, but a wasted boot, and on a deployed guest a boot is the
    // expensive thing.
    const delaySeconds =
      at === undefined ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
    void send(queueNameFor(runId), { runId }, { delaySeconds }).catch((err: unknown) => {
      // See the module doc: this strands the run. Logged at `error` with the id,
      // because it is the only trace and it is recoverable by hand.
      opts.logger.error?.(
        "Workflow delivery could not be queued; run is not scheduled",
        omitUndefined({
          runId,
          wakeAt: at,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  };
}
