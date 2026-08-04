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
import { retireSandbox } from "./sandbox-retire.ts";
import type { AgentSlot, SlotCache } from "./sandbox-slots.ts";

/** Detach a slot's sandbox and deliver its retirement (awaited). */
async function retireSlotDelivered(slot: AgentSlot): Promise<void> {
  const sb = slot.sandbox;
  delete slot.sandbox;
  if (sb) await retireSandbox(sb, { slug: slot.slug, reason: "replica-shutdown" });
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
};

/** Release every guest this process owns. Never throws. */
export async function teardownSandboxes(targets: TeardownTargets): Promise<void> {
  const { slots, broker } = targets;

  const work: Promise<unknown>[] = [...slots.values()].map((slot) => retireSlotDelivered(slot));
  // Sandboxes retired earlier by a mutation are deliberately not chased:
  // they are off the slot map and already self-governing.
  if (broker) work.push(broker.dispose());

  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") {
      console.warn("Sandbox teardown failed:", errorMessage(result.reason));
    }
  }
}
