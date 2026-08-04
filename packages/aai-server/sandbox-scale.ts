// Copyright 2026 the AAI authors. MIT license.
/**
 * Horizontal guest-sandbox scaling: least-connections routing across a
 * slug's sandbox replicas, scaling out when every resident sandbox is at
 * session capacity.
 *
 * The broker (`GET /:slug/client-config` → resolveSandbox) is the only
 * routing point — sessions connect DIRECTLY to a sandbox's tunnel, so once
 * a client holds a sessionUrl the host never sees (or can move) that
 * session again. Routing therefore happens per broker request, over the
 * same guest `status` RPC idle eviction already relies on for live session
 * counts. Scale-in is idle eviction's job (sandbox-slots.ts): an overflow
 * replica whose sessions have all ended is reclaimed on the next idle probe.
 *
 * Least-connections is implemented here rather than pulled in as a library
 * deliberately: off-the-shelf Node balancers (round-robin / random /
 * power-of-two-choices, e.g. the `load-balancers` package) are stateless
 * pickers that infer backend load from their own bookkeeping of the calls
 * they routed. That bookkeeping cannot be truthful here — sessions start
 * AND END without passing through the host — so the only honest load signal
 * is the guest-reported session count, and balancing over a known
 * per-backend load is an argmin, not a dependency.
 */

import { debug } from "./_debug-log.ts";
import { SANDBOX_MAX_REPLICAS, SANDBOX_MAX_SESSIONS } from "./constants.ts";
import type { Sandbox } from "./sandbox.ts";
import { type AgentSlot, type SlotCache, withSlugLock } from "./sandbox-slots.ts";

export type ScaleOptions = {
  /** Live sessions per sandbox before the broker scales the slug out. */
  maxSessionsPerSandbox: number;
  /** Cap on sandboxes per slug (primary included) on this replica. */
  maxSandboxes: number;
};

/**
 * The env-configured scaling policy (`SANDBOX_MAX_SESSIONS` /
 * `SANDBOX_MAX_REPLICAS`); undefined — the default — disables scaling.
 */
export function defaultScaleOptions(): ScaleOptions | undefined {
  if (SANDBOX_MAX_SESSIONS <= 0) return;
  return {
    maxSessionsPerSandbox: SANDBOX_MAX_SESSIONS,
    maxSandboxes: Math.max(1, SANDBOX_MAX_REPLICAS),
  };
}

/** The slot's sandboxes, primary first. Replicas are always real Sandboxes. */
function allSandboxes(slot: AgentSlot, primary: Sandbox): Sandbox[] {
  return [primary, ...((slot.replicas ?? []) as Sandbox[])];
}

function leastLoaded(counts: number[]): number {
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    if ((counts[i] ?? 0) < (counts[best] ?? 0)) best = i;
  }
  return best;
}

export type RouteSessionArgs = {
  slug: string;
  slots: SlotCache;
  /** The slug's current slot, whose primary sandbox is `primary`. */
  slot: AgentSlot;
  primary: Sandbox;
  scale: ScaleOptions;
  /**
   * Build one more sandbox from the slug's stored bundle. Resolves null
   * when the bundle vanished mid-route (concurrent delete).
   */
  spawnReplica: () => Promise<Sandbox | null>;
};

/**
 * Pick the sandbox this session should connect to: the least-loaded resident
 * one while any has capacity, a freshly spawned replica when all are full,
 * and the least-loaded regardless once the per-slug cap is reached.
 */
export async function routeSession(args: RouteSessionArgs): Promise<Sandbox> {
  const { slug, slots, slot, primary, scale } = args;
  const candidates = allSandboxes(slot, primary);
  // A failed probe ranks LAST (Infinity), never first: eviction's "an
  // unreachable guest answers 0" convention means "safe to reclaim", but
  // this is an argmin over routing targets — mapping a dead/flapping guest
  // to 0 makes it strictly the least-loaded, and every new client gets its
  // sessionUrl, connects to a dead endpoint, re-brokers, and lands on the
  // same answer until idle eviction reaps it. At Infinity it is also "at
  // capacity", so a slug whose only sandbox stopped answering scales out to
  // a fresh replica instead of routing into the void.
  const counts = await Promise.all(
    candidates.map((sb) => sb.activeSessions().catch(() => Number.POSITIVE_INFINITY)),
  );
  const best = leastLoaded(counts);
  const bestSandbox = candidates[best] ?? primary;
  if ((counts[best] ?? 0) < scale.maxSessionsPerSandbox) return bestSandbox;
  if (candidates.length >= scale.maxSandboxes) {
    console.warn("All sandbox replicas at session capacity; routing to least-loaded", {
      slug,
      sandboxes: candidates.length,
      sessions: counts[best],
    });
    return bestSandbox;
  }
  // Scale out — serialized per slug so concurrent saturated brokers don't
  // each spawn a replica (the same reason cold resolves take this lock).
  return withSlugLock(slug, async () => {
    // Re-check under the lock: a deploy/delete may have replaced or torn
    // down the slot while we waited (the client will re-broker onto the
    // rebuilt sandbox), or another waiter may already have scaled out.
    if (!slots.owns(slug, slot) || slot.sandbox === undefined) return bestSandbox;
    const now = allSandboxes(slot, slot.sandbox as Sandbox);
    if (now.length > candidates.length) return now.at(-1) ?? bestSandbox;
    const replica = await args.spawnReplica();
    if (!replica) return bestSandbox;
    slot.replicas = [...(slot.replicas ?? []), replica];
    debug("Scaled out sandbox replica", { slug, sandboxes: now.length + 1 });
    return replica;
  });
}
