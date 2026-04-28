// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot registry — slot-based sandbox tracking.
 *
 * Each slot holds ownership info (slug, keyHash) and an optional sandbox
 * reference. Consumed by deploy/delete handlers and the orchestrator.
 */

import { getLock } from "p-lock";
import { debug } from "./_debug-log.ts";
import { IDLE_SANDBOX_MS } from "./constants.ts";
import { metrics } from "./metrics.ts";

/**
 * Agent slot — used by deploy/delete handlers and the orchestrator.
 * Each slot holds ownership info and an optional sandbox reference.
 */
export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: { shutdown(): Promise<void> };
  /**
   * Idle eviction timer. Set when a sandbox is attached, bumped on each
   * `touchSlot`, cleared when the sandbox is detached/terminated.
   */
  idleTimer?: NodeJS.Timeout;
};

/** A simple Map of slug → AgentSlot. Used by orchestrator and handlers. */
export type SlotCache = Map<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return new Map<string, AgentSlot>();
}

// ── Locks ───────────────────────────────────────────────────────────────

const apiLock = getLock();

/** Serialize deploy/delete API calls for the same slug. */
export const withSlugLock = <T>(slug: string, fn: () => Promise<T>): Promise<T> =>
  apiLock(slug).then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });

/**
 * Best-effort terminate a slot's sandbox and clear sandbox state.
 * Errors are logged but never thrown.
 *
 * If a `slots` cache is passed, the slot-resident gauge is republished.
 */
export async function terminateSlot(slot: AgentSlot, slots?: SlotCache): Promise<void> {
  const { slug } = slot;
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    delete slot.idleTimer;
  }
  if (slot.sandbox) {
    const sb = slot.sandbox;
    delete slot.sandbox;
    metrics.sandboxEvicted.inc({ reason: "terminate" });
    if (slots) publishSlotGauges(slots);
    await sb.shutdown().catch((err: unknown) => {
      console.warn("Failed to shut down sandbox", { slug, error: String(err) });
    });
  }
}

// ── Slot-cache mutators (gauge-aware) ───────────────────────────────────

/** Insert (or replace) a slot. Republishes slot gauges. */
export function setSlot(slots: SlotCache, slot: AgentSlot): void {
  slots.set(slot.slug, slot);
  publishSlotGauges(slots);
}

/** Remove a slot by slug. Republishes slot gauges. */
export function deleteSlot(slots: SlotCache, slug: string): boolean {
  const slot = slots.get(slug);
  if (slot?.idleTimer) {
    clearTimeout(slot.idleTimer);
    delete slot.idleTimer;
  }
  const removed = slots.delete(slug);
  if (removed) publishSlotGauges(slots);
  return removed;
}

/** Attach a sandbox to a slot. Republishes the resident gauge. */
export function attachSandbox(
  slots: SlotCache,
  slot: AgentSlot,
  sandbox: { shutdown(): Promise<void> },
): void {
  slot.sandbox = sandbox;
  publishSlotGauges(slots);
  resetIdleTimer(slots, slot);
}

/**
 * Bump the idle eviction timer for the slot identified by `slug`.
 *
 * No-op if the slot doesn't exist or has no resident sandbox. Call this
 * at the start of each session so an actively-used sandbox is never
 * evicted.
 */
export function touchSlot(slots: SlotCache, slug: string): void {
  const slot = slots.get(slug);
  if (!slot?.sandbox) return;
  resetIdleTimer(slots, slot);
}

function publishSlotGauges(slots: SlotCache): void {
  metrics.slotsRegistered.set(slots.size);
  let resident = 0;
  for (const slot of slots.values()) if (slot.sandbox) resident++;
  metrics.slotsResident.set(resident);
}

/**
 * (Re)schedule the idle eviction timer on `slot`. Clears any existing
 * timer first. The timer self-clears its own slot field on fire.
 */
function resetIdleTimer(slots: SlotCache, slot: AgentSlot): void {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  const { slug } = slot;
  const timer = setTimeout(() => {
    void evictIdleSandbox(slots, slug);
  }, IDLE_SANDBOX_MS);
  // Don't keep the event loop alive just for the idle timer.
  timer.unref?.();
  slot.idleTimer = timer;
}

async function evictIdleSandbox(slots: SlotCache, slug: string): Promise<void> {
  const slot = slots.get(slug);
  // Slot may have been deleted, replaced, or already had its sandbox
  // detached between schedule and fire — bail out idempotently.
  if (!slot) return;
  // The timer that fired was ours; clear the field so it doesn't
  // dangle if eviction is then followed by another attach.
  delete slot.idleTimer;
  const sb = slot.sandbox;
  if (!sb) return;
  delete slot.sandbox;
  publishSlotGauges(slots);
  metrics.sandboxEvicted.inc({ reason: "idle" });
  debug("Evicting idle sandbox", { slug });
  try {
    await sb.shutdown();
  } catch (err: unknown) {
    console.warn("Failed to shut down idle sandbox", { slug, error: String(err) });
  }
}
