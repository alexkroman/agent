// Copyright 2026 the AAI authors. MIT license.
/**
 * The cross-replica half of sandbox resolution: announcing this replica's
 * resident to the fleet, and finding a peer's before spawning a duplicate.
 *
 * Split from sandbox-resolve.ts, which owns this replica's slug→sandbox map
 * and its invalidation. The concerns differ in blast radius: everything here
 * is best-effort and must never affect the sandbox it describes, whereas a
 * mistake in the slot map costs a live session. See sandbox-registry.ts for
 * the lease semantics.
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Sandbox } from "./sandbox.ts";
import { REGISTRY_HEARTBEAT_MS, type RegisteredSandbox } from "./sandbox-registry.ts";
import type { BrokeredSession, ResolveSandboxOpts } from "./sandbox-resolve.ts";
import { isLive } from "./sandbox-slots.ts";

/**
 * Register this replica's resident sandbox in the cross-replica registry and
 * heartbeat its lease for as long as it remains the slot's live resident.
 *
 * Ownership is re-checked every tick, so EVERY detach path — retire,
 * terminate, idle self-exit, a lost guest, a blue-green handover — converges
 * on an unregister within one heartbeat without any of those paths knowing
 * the registry exists. That is the point: the detach paths are the delicate
 * ones, and none of them gained a new obligation here.
 *
 * Best-effort throughout: the registry must never affect the sandbox it
 * describes. A failed register is retried by the next tick; a failed
 * unregister leaves a row that expires on its own lease.
 */
export function startRegistryHeartbeat(
  slug: string,
  sandbox: Sandbox,
  opts: ResolveSandboxOpts,
): void {
  const registry = opts.registry;
  if (!registry) return;
  let entry: RegisteredSandbox | undefined;
  const stop = (timer: NodeJS.Timeout): void => {
    clearInterval(timer);
    if (entry) void registry.unregister(slug, entry.sessionUrl).catch(() => undefined);
  };
  const resolveEntry = async (): Promise<RegisteredSandbox> => {
    if (entry) return entry;
    // The tunnel URLs settle once the guest is up; earlier ticks retry. Both
    // resolve off the same readiness promise — no extra wait.
    const [sessionUrl, guestOrigin] = await Promise.all([
      sandbox.sessionUrl(),
      sandbox.guestOrigin(),
    ]);
    entry = { sessionUrl, guestOrigin };
    return entry;
  };
  const beat = async (): Promise<void> => {
    if (opts.slots.get(slug)?.sandbox !== sandbox || !isLive(sandbox)) {
      stop(timer);
      return;
    }
    try {
      await registry.register(slug, await resolveEntry());
    } catch {
      // Booting guest or transient registry error — the next tick retries.
    }
  };
  const timer = setInterval(() => void beat(), REGISTRY_HEARTBEAT_MS);
  timer.unref?.();
  void beat();
}

/**
 * The broker's cross-replica route: a live peer sandbox for `slug`.
 * Consulted only on the cold path (no local resident), where the duplicate
 * spawn it prevents is about to happen. Never fails a broker request — any
 * registry trouble reads as "no peer" and the local spawn proceeds.
 */
export async function findPeerSession(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<BrokeredSession | null> {
  const registry = opts.registry;
  if (!registry) return null;
  try {
    // Existence gate: a deleted agent's registry rows outlive the row by up
    // to one lease, and routing to them would resurrect a 404. The two reads
    // are independent (the version only gates whether the peer is used), so
    // run them concurrently — both are DB round trips with a caller waiting.
    const [version, peer] = await Promise.all([
      opts.store.getAgentVersion(slug),
      registry.findPeer(slug),
    ]);
    if (version === null || !peer) return null;
    return { ok: true, sessionUrl: peer.sessionUrl, guestOrigin: peer.guestOrigin };
  } catch (err) {
    console.warn(`Sandbox registry lookup failed for ${slug}: ${errorMessage(err)}`);
    return null;
  }
}
