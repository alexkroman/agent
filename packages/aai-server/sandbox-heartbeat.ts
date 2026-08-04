// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica registry heartbeat for one resident sandbox. Split from
 * sandbox-resolve.ts (which owns the slug→sandbox map); see
 * sandbox-registry.ts for the registry itself.
 */

import type { Sandbox } from "./sandbox.ts";
import { REGISTRY_HEARTBEAT_MS, type SandboxRegistry } from "./sandbox-registry.ts";
import type { SlotCache } from "./sandbox-slots.ts";

/** The slices of the resolver's deps the heartbeat consumes. */
export type HeartbeatDeps = {
  slots: SlotCache;
  registry?: SandboxRegistry | undefined;
};

/**
 * Register this replica's resident sandbox in the cross-replica registry
 * and heartbeat its lease with a sampled session count, for as long as it
 * remains the slot's live resident. Ownership is re-checked every tick, so
 * EVERY detach path — retire, terminate, idle eviction, a lost guest —
 * converges on an unregister within one heartbeat without any of those
 * paths knowing the registry exists. Best-effort throughout: the registry
 * must never affect the sandbox it describes.
 */
export function startRegistryHeartbeat(
  slug: string,
  sandbox: Sandbox,
  opts: HeartbeatDeps,
  isLive: (sandbox: Sandbox) => boolean,
): void {
  const registry = opts.registry;
  if (!registry) return;
  let sessionUrl: string | null = null;
  const stop = (timer: NodeJS.Timeout): void => {
    clearInterval(timer);
    if (sessionUrl) {
      void registry.unregister(slug, sessionUrl).catch(() => undefined);
    }
  };
  const beat = async (): Promise<void> => {
    if (opts.slots.get(slug)?.sandbox !== sandbox || !isLive(sandbox)) {
      stop(timer);
      return;
    }
    try {
      // The tunnel URL settles once the guest is up; earlier ticks retry.
      sessionUrl ??= await sandbox.sessionUrl();
      const sessions = await sandbox.activeSessions().catch(() => 0);
      await registry.register(slug, sessionUrl, sessions);
    } catch {
      // Booting guest or transient registry error — the next tick retries.
    }
  };
  const timer = setInterval(() => void beat(), REGISTRY_HEARTBEAT_MS);
  timer.unref?.();
  void beat();
}
