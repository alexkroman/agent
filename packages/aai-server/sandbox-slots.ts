// Copyright 2025 the AAI authors. MIT license.

import { createOwnedMap, errorMessage, type OwnedMap } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { createKeyedLock } from "./_keyed-lock.ts";
import { IDLE_SANDBOX_MS } from "./constants.ts";

export type AgentSlot = {
  slug: string;
  sandbox?: {
    shutdown(): Promise<void>;
    /**
     * Live client sessions in the guest. Sessions connect DIRECTLY to the
     * sandbox's tunnel, so the host cannot count them — idle eviction asks
     * the guest before killing (see evictIdleSandbox).
     */
    activeSessions?: () => Promise<number>;
  };
  idleTimer?: NodeJS.Timeout;
  /**
   * Slug epoch the resident sandbox was built at (see platform-epoch.ts).
   * resolveSandbox terminates and rebuilds when the current epoch differs —
   * a deploy/secret/storage mutation on another replica or service.
   */
  epoch?: number;
};

// An OwnedMap because a redeploy replaces the slot object under the same
// slug: mutations driven by a pre-replacement handle must no-op (see the
// identity re-check in evictIdleSandbox), which is the map's `owns` check.
export type SlotCache = OwnedMap<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return createOwnedMap<string, AgentSlot>();
}

// Internal keyed lock (not p-lock): entries are deleted when released, so the
// pre-auth WS-upgrade path can't grow the map one entry per distinct slug.
const apiLock = createKeyedLock();

/** Run `fn` while holding a keyed lock, releasing it in every outcome. */
export const withLock = <T>(
  lock: (key: string) => Promise<() => void>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> =>
  lock(key).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });

/** Serialize deploy/delete API calls for the same slug. */
export const withSlugLock = <T>(slug: string, fn: () => Promise<T>): Promise<T> =>
  withLock(apiLock, slug, fn);

function clearIdleTimer(slot: AgentSlot): void {
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    delete slot.idleTimer;
  }
}

async function detachAndShutdown(slot: AgentSlot, errorLabel: string): Promise<void> {
  const sb = slot.sandbox;
  if (!sb) return;
  delete slot.sandbox;
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    console.warn(errorLabel, { slug: slot.slug, error: errorMessage(err) });
  }
}

/** Best-effort terminate a slot's sandbox. Errors are logged, never thrown. */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  clearIdleTimer(slot);
  await detachAndShutdown(slot, "Failed to shut down sandbox");
}

/**
 * Terminate `slug`'s sandbox (if resident) so the next session picks up new
 * config — used by the secret and storage handlers after a mutation.
 */
export async function restartSlotSandbox(
  slots: SlotCache,
  slug: string,
  reason: string,
): Promise<void> {
  const slot = slots.get(slug);
  if (slot?.sandbox) {
    console.info(`Restarting sandbox for ${reason}`, { slug });
    await terminateSlot(slot);
  }
}

export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.claim(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  const slot = slots.get(slug);
  if (slot) clearIdleTimer(slot);
  return slots.delete(slug);
}

export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: NonNullable<AgentSlot["sandbox"]>,
): void {
  slot.sandbox = sandbox;
  resetIdleTimer(slots, slot);
}

function resetIdleTimer(slots: SlotCache, slot: AgentSlot): void {
  clearIdleTimer(slot);
  const { slug } = slot;
  const timer = setTimeout(() => {
    void evictIdleSandbox(slots, slug);
  }, IDLE_SANDBOX_MS);
  timer.unref?.();
  slot.idleTimer = timer;
}

async function evictIdleSandbox(slots: SlotCache, slug: string): Promise<void> {
  const slot = slots.get(slug);
  if (!slot) return;
  // The fired timer was ours; drop the field so a later attach can rearm.
  delete slot.idleTimer;
  if (!slot.sandbox) return;
  // Sessions connect directly to the sandbox, so the host must ASK whether
  // any are live before killing it mid-call. A dead/unreachable guest
  // answers 0 (see Sandbox.activeSessions) — eviction proceeds.
  const live = (await slot.sandbox.activeSessions?.().catch(() => 0)) ?? 0;
  // The probe awaited; only the slot's CURRENT sandbox may be evicted (a
  // deploy may have replaced it while we asked).
  if (slots.get(slug) !== slot || slot.sandbox === undefined) return;
  if (live > 0) {
    resetIdleTimer(slots, slot);
    return;
  }
  debug("Evicting idle sandbox", { slug });
  await detachAndShutdown(slot, "Failed to shut down idle sandbox");
}
