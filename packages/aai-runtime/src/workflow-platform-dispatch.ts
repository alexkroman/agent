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
 * ## A failed enqueue REJECTS, and the delivery is not acked
 *
 * If the enqueue fails the run has a journal row and no pending message, and the
 * platform's wake sweep reads the QUEUE — so nothing will boot the guest for it
 * until something else does. This used to be `void send(...).catch(log)`, which
 * meant `execute` resolved and `/workflow-queue` answered `200 {ok:true}`
 * possibly before the enqueue had even been attempted: the platform was told to
 * forget a message whose replacement was never accepted, and the log line was
 * the only trace of a run nothing would come back for.
 *
 * So this rejects. The one caller whose own answer is an ack — `execute`, via
 * `recordOutcome` — awaits it, answers 500, and the platform retries the
 * ORIGINAL message, which closes the gap for free. The callers that cannot act
 * on it (`start` from inside a tool, `wakeUp`, `signal`) drop the rejection
 * deliberately, and for those the `error` line below is still the only trace and
 * still recoverable by hand.
 *
 * What is left is the run that was never enqueued at all — a failed `start`.
 * Closing that means the sweep reading the JOURNAL for a due run rather than the
 * queue, which is a change to what the platform considers authoritative and
 * belongs on its own.
 *
 * @internal
 */

import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
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
): (runId: string, at?: number) => Promise<void> {
  const send = createPlatformQueueSend(opts.platform);
  return async (runId, at) => {
    // Rounded UP so a delivery is never earlier than the deadline the body
    // computed: a sleep that wakes early re-reads its own stored `wakeAt`, finds it
    // still in the future, and suspends again — correct, but a wasted boot, and on
    // a deployed guest a boot is the expensive thing.
    //
    // The ceil is at MILLISECOND granularity, which preserves that property and
    // costs at most 1 ms. It used to be `Math.ceil((at - Date.now()) / 1000)`,
    // which preserved it at a cost of up to a full second on EVERY sub-second
    // wake — measured, a `ctx.sleep(100)` resumed at ~1,780 ms of which ~1,000 was
    // this line. Nothing below the field needs whole seconds: `enqueue` multiplies
    // by 1000 and Postgres computes `available_at` in milliseconds, and the
    // enqueue route validates only that the number is finite. (The remaining
    // ~780 ms is `WORKFLOW_QUEUE_INTERVAL_MS` and is by design — a future-dated
    // row is deliberately not announced; see `announce()` in
    // `aai-server/workflow-queue-store.ts`.)
    //
    // Ceil the MILLISECOND and divide afterwards, never the other way round: the
    // server's own conversion is `Math.round(delaySeconds * 1000)` (in both
    // `enqueue` and `reschedule`), so an integer millisecond survives the round
    // trip exactly, where ceiling a fractional second could be rounded back DOWN
    // and land the delivery before the deadline after all.
    const delayMs = at === undefined ? undefined : Math.max(0, Math.ceil(at - Date.now()));
    const delaySeconds = delayMs === undefined ? undefined : delayMs / 1000;
    try {
      await send(queueNameFor(runId), { runId }, { delaySeconds });
    } catch (err: unknown) {
      // Logged at `error` with the id whatever the caller does with the
      // rejection: the caller that CANNOT act on it — a `start`, which is a tool
      // call away — leaves this line as the only trace, and see the module doc
      // for why that case is recoverable by hand and nothing else.
      opts.logger.error?.(
        "Workflow delivery could not be queued; run is not scheduled",
        omitUndefined({ runId, wakeAt: at, error: errorMessage(err) }),
      );
      // And RETHROWN, which is the half the log cannot cover. A delivery's own
      // `execute` awaits this, so a failure here fails that delivery instead of
      // acking it — see the module doc.
      throw err;
    }
  };
}
