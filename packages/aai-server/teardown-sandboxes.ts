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
import { drainingSandboxes } from "./sandbox-retire.ts";
import { type SlotCache, terminateSlot } from "./sandbox-slots.ts";

/**
 * Live client sessions across every guest this replica owns — what the
 * shutdown drain actually has to wait for.
 *
 * The orchestrator's own `wss.clients.size` cannot answer this. Browser voice
 * sessions dial the guest sandbox's tunnel DIRECTLY and never touch the
 * server process, so the socket count is structurally blind to them: it
 * reported 0 on every scale-in while calls were in flight, the drain returned
 * immediately, and `teardownSandboxes` below cut all of them. The 120s
 * `SHUTDOWN_DRAIN_MS` budget was dead weight — it could only ever measure
 * connections that no longer exist on this path.
 *
 * Includes sandboxes that a mutation retired and that are still draining
 * (sandbox-retire.ts): they are off the slot map by design, but the calls on
 * them are exactly the ones retirement exists to protect.
 *
 * Best-effort per sandbox — an unreachable guest counts 0, the same
 * convention idle eviction uses, so one wedged guest cannot stall shutdown
 * past its own bounded RPC timeout.
 */
export async function liveGuestSessions(slots: SlotCache): Promise<number> {
  const owned: { activeSessions?: () => Promise<number> }[] = [
    ...[...slots.values()].flatMap((slot) => [
      ...(slot.sandbox ? [slot.sandbox] : []),
      ...(slot.replicas ?? []),
    ]),
    ...drainingSandboxes(),
  ];
  const counts = await Promise.all(
    owned.map((sb) => sb.activeSessions?.().catch(() => 0) ?? Promise.resolve(0)),
  );
  return counts.reduce((total, n) => total + n, 0);
}

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
  // A fourth kind: sandboxes retired by a mutation and still draining (see
  // sandbox-retire.ts). They are deliberately detached from their slot, so
  // the loop above cannot see them — and their drain deadline is minutes,
  // far past the container's grace period, so waiting on it would just get
  // the process SIGKILLed with the guests still up.
  work.push(...drainingSandboxes().map((sb) => sb.shutdown()));
  if (pool) work.push(pool.shutdown());
  if (broker) work.push(broker.dispose());

  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") {
      console.warn("Sandbox teardown failed:", errorMessage(result.reason));
    }
  }
}
