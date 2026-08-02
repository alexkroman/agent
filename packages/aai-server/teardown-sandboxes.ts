// Copyright 2026 the AAI authors. MIT license.
/**
 * One shutdown teardown for both services.
 *
 * Every guest a replica owns has to be released when the process goes down,
 * and there are three kinds: the slug slots' sandboxes (primary AND overflow
 * replicas), the warm pool's pre-spawned harnesses, and — in the studio
 * service — the session broker's per-project coding-agent sandboxes.
 *
 * Both entries previously inlined a partial version of this and each missed
 * something:
 *
 * - `slot.sandbox?.shutdown()` skips `slot.replicas`, which `terminateSlot`
 *   already handles. Scaled-out slugs leaked every overflow replica.
 * - `StudioSessionBroker.dispose()` is documented for shutdown but had no
 *   production call site at all, so a restart orphaned one guest per active
 *   studio project.
 *
 * A leaked guest is not free. It exits on the harness orphan timeout
 * (`HARNESS_ORPHAN_TIMEOUT_MS`, 5 min), and on Modal the sandbox then lingers
 * until `SANDBOX_IDLE_TIMEOUT_SECS` reclaims it — up to ~20 minutes of billed
 * sandbox per orphan, on a service that autoscales and therefore scales in
 * routinely.
 *
 * Every failure is logged and swallowed: shutdown is best-effort by nature
 * (the sandbox may already be gone), and one rejecting teardown must not stop
 * the others or fail the process exit.
 */

import { errorMessage } from "@alexkroman1/aai";
import { type SlotCache, terminateSlot } from "./sandbox-slots.ts";

export type TeardownTargets = {
  /** The replica's slug→sandbox map; primaries and replicas both go down. */
  slots: SlotCache;
  /** Pre-warmed harness pool, when one is configured. */
  pool?: { shutdown(): Promise<void> } | undefined;
  /**
   * The studio session broker, when this process serves the studio. Absent
   * in the agent-only service, and safe to pass when the lazily-created
   * broker was never built (its dispose resolves immediately).
   */
  broker?: { dispose(): Promise<void> } | undefined;
};

/** Release every guest this process owns. Never throws. */
export async function teardownSandboxes(targets: TeardownTargets): Promise<void> {
  const { slots, pool, broker } = targets;

  const work: Promise<unknown>[] = [...slots.values()].map((slot) => terminateSlot(slot));
  if (pool) work.push(pool.shutdown());
  if (broker) work.push(broker.dispose());

  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") {
      console.warn("Sandbox teardown failed:", errorMessage(result.reason));
    }
  }
}
