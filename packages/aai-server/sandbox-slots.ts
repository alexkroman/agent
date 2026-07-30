// Copyright 2025 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import { debug } from "./_debug-log.ts";
import { createKeyedLock } from "./_keyed-lock.ts";
import { IDLE_SANDBOX_MS } from "./constants.ts";
import { metrics, type SandboxEvictReason } from "./metrics.ts";

export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: { shutdown(): Promise<void> };
  idleTimer?: NodeJS.Timeout;
  /** Number of live WebSocket sessions on this slot's sandbox. */
  activeSessions?: number;
};

export type SlotCache = Map<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return new Map<string, AgentSlot>();
}

// One slot cache per process; gauges read it lazily on each scrape so
// callers don't need to push updates after every mutation.
let _slotsForGauges: SlotCache | null = null;

// biome-ignore lint/suspicious/noExplicitAny: prom-client doesn't type `collect` as writable
(metrics.slotsRegistered as any).collect = function (this: typeof metrics.slotsRegistered) {
  this.set(_slotsForGauges?.size ?? 0);
};
// biome-ignore lint/suspicious/noExplicitAny: prom-client doesn't type `collect` as writable
(metrics.slotsResident as any).collect = function (this: typeof metrics.slotsResident) {
  let resident = 0;
  if (_slotsForGauges) {
    for (const slot of _slotsForGauges.values()) if (slot.sandbox) resident++;
  }
  this.set(resident);
};

export function registerSlotsForGauges(slots: SlotCache): void {
  _slotsForGauges = slots;
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

async function detachAndShutdown(
  slot: AgentSlot,
  reason: SandboxEvictReason,
  errorLabel: string,
): Promise<void> {
  const sb = slot.sandbox;
  if (!sb) return;
  delete slot.sandbox;
  metrics.sandboxEvicted.inc({ reason });
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    console.warn(errorLabel, { slug: slot.slug, error: errorMessage(err) });
  }
}

/** Best-effort terminate a slot's sandbox. Errors are logged, never thrown. */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  clearIdleTimer(slot);
  await detachAndShutdown(slot, "terminate", "Failed to shut down sandbox");
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
  slots.set(slot.slug, slot);
}

export function deleteSlot(slots: SlotCache, slug: string): boolean {
  const slot = slots.get(slug);
  if (slot) clearIdleTimer(slot);
  return slots.delete(slug);
}

export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: { shutdown(): Promise<void> },
): void {
  slot.sandbox = sandbox;
  resetIdleTimer(slots, slot);
}

/**
 * Register a new active session on `slug`; pauses idle eviction.
 *
 * Returns the specific slot object the session was counted on. Release MUST
 * go through {@link releaseSlotSession} with this handle: a redeploy replaces
 * the slot object (deploy.ts `setSlot`), and a stale slug-keyed release would
 * decrement the *replacement* slot's counter — rearming idle eviction under a
 * live session on the new sandbox.
 */
export function acquireSlotSession(slots: SlotCache, slug: string): AgentSlot | null {
  const slot = slots.get(slug);
  if (!slot) return null;
  slot.activeSessions = (slot.activeSessions ?? 0) + 1;
  // A live session must never be idle-evicted mid-call; stop the timer while
  // any session is active (rearmed on release when the count hits zero).
  clearIdleTimer(slot);
  return slot;
}

/** Release an acquired session handle; rearms idle eviction when none remain. */
export function releaseSlotSession(slots: SlotCache, acquired: AgentSlot | null): void {
  if (!acquired) return;
  acquired.activeSessions = Math.max(0, (acquired.activeSessions ?? 0) - 1);
  // Only the slot currently installed for this slug may drive idle eviction —
  // a handle from before a redeploy/delete must not touch the new slot.
  if (slots.get(acquired.slug) !== acquired) return;
  if (acquired.activeSessions === 0 && acquired.sandbox) resetIdleTimer(slots, acquired);
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
  // A session that started after the timer was armed but before it fired must
  // not be killed mid-call; rearm instead of evicting.
  if ((slot.activeSessions ?? 0) > 0) {
    resetIdleTimer(slots, slot);
    return;
  }
  debug("Evicting idle sandbox", { slug });
  await detachAndShutdown(slot, "idle", "Failed to shut down idle sandbox");
}
