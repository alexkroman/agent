// Copyright 2026 the AAI authors. MIT license.
/**
 * One shutdown teardown for both services.
 *
 * A replica going down treats its AGENT guests exactly like a redeploy
 * treats a superseded one: RETIRE, don't terminate. Sessions dial the
 * sandbox tunnel directly and the guest has zero dependency on this process
 * after boot, so killing it here would cut live calls to protect nothing —
 * the drain request hands each guest its budget, the guest finishes its
 * calls and exits itself (empty → immediate; deadline → bounded; Modal's
 * sandbox `timeoutMs` is the backstop). The drains ARE awaited, unlike a
 * deploy's fire-and-forget retirement: the process is about to exit, and an
 * undelivered drain request is a guest that never learns it was retired.
 * An idle guest exits within one lifecycle poll of the drain landing, so
 * the routine scale-in still reclaims promptly.
 *
 * STUDIO guests are the opposite case: their coding-agent sessions live on
 * the host's control channel, so a dead host makes them useless — the
 * broker's `dispose()` terminates them. It is documented for shutdown but
 * once had no production call site at all, so a restart orphaned one guest
 * per active studio project, burning its orphan timeout billed on Modal.
 *
 * Every failure is logged and swallowed: shutdown is best-effort by nature
 * (the sandbox may already be gone), and one rejecting teardown must not
 * stop the others or fail the process exit.
 */

import { errorMessage } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";

import { envMs } from "./constants.ts";
import { createLogger } from "./logger.ts";
import { retireSlot, type SlotCache } from "./sandbox-slots.ts";

const log = createLogger("sandbox.teardown");

/**
 * How long to keep serving after `draining` flips, before tearing anything
 * down. Override with `SHUTDOWN_GRACE_MS`; 0 disables the wait.
 *
 * The flip only makes `/health` fail — the platform's proxy stops routing
 * here when it NOTICES, which is up to one health-check interval later.
 * Tearing down inside that window means requests still arriving find an
 * emptied slot: the broker refuses to boot a replacement (see
 * `ResolveSandboxOpts.isDraining`), so they get a retryable 503, but a 503 to
 * a user who would otherwise have been served is worth a few seconds of
 * patience. The guests are unaffected either way — they outlive this process
 * by design.
 *
 * Deliberately short. Modal delivers SIGTERM and then kills the container,
 * so this budget is spent from the same allowance the drains below need; a
 * long wait would trade a rare 503 for undelivered drain requests, which is
 * the worse failure (a guest that never learns it was retired).
 */
export const SHUTDOWN_GRACE_MS = 3000;

/**
 * Resolve the grace period from the environment, through the one env-ms parse
 * the package shares (`envMs`) — an unusable value falls back rather than
 * disabling the wait by accident, which is exactly the rule that constant
 * documents for `SANDBOX_RETIRE_DRAIN_MS`.
 */
export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.SHUTDOWN_GRACE_MS, SHUTDOWN_GRACE_MS);
}

export type TeardownTargets = {
  /** The replica's slug→sandbox map; every resident is retired. */
  slots: SlotCache;
  /**
   * The studio session broker, when this process serves the studio. Absent
   * in the agent-only service, and safe to pass when the lazily-created
   * broker was never built (its dispose resolves immediately).
   */
  broker?: { dispose(): Promise<void> } | undefined;
  /**
   * Seconds to keep serving before teardown, so the proxy can observe the
   * `/health` 503 first. Defaults to {@link shutdownGraceMs}; 0 skips it.
   */
  graceMs?: number;
};

/** Release every guest this process owns. Never throws. */
export async function teardownSandboxes(targets: TeardownTargets): Promise<void> {
  const { slots, broker } = targets;

  // Let the proxy notice we are unhealthy before emptying the slots.
  //
  // REFERENCED, deliberately. This wait used to come from a package-private
  // `_sleep.ts` that unref'd every timer it armed, which is defensible for the
  // two dial/health poll intervals that also used it and wrong here: an unref'd
  // grace during shutdown lets the process exit before it elapses, skipping
  // every drain below — the exact thing this routine exists to deliver. Nothing
  // else guarantees a pending handle at this point, since the listener is
  // already closing. `SHUTDOWN_TEARDOWN_TIMEOUT_MS` is the net if the grace is
  // ever misconfigured long.
  const graceMs = targets.graceMs ?? shutdownGraceMs();
  if (graceMs > 0) await sleep(graceMs);

  const work: Promise<unknown>[] = [...slots.values()].map((slot) =>
    retireSlot(slot, "replica-shutdown"),
  );
  // Sandboxes retired earlier by a mutation are deliberately not chased:
  // they are off the slot map and already self-governing.
  if (broker) work.push(broker.dispose());

  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") {
      log.warn("teardown failed", { error: errorMessage(result.reason) });
    }
  }
}
