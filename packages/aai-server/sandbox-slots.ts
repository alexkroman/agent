// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot registry — slot-based sandbox tracking.
 *
 * Each slot holds ownership info (slug, keyHash) and an optional sandbox
 * reference. Consumed by deploy/delete handlers and the orchestrator.
 */

import { getLock } from "p-lock";
import { metrics } from "./metrics.ts";

/**
 * Agent slot — used by deploy/delete handlers and the orchestrator.
 * Each slot holds ownership info and an optional sandbox reference.
 */
export type AgentSlot = {
  slug: string;
  keyHash: string;
  sandbox?: { shutdown(): Promise<void> };
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
  if (slot.sandbox) {
    const sb = slot.sandbox;
    delete slot.sandbox;
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
}

function publishSlotGauges(slots: SlotCache): void {
  metrics.slotsRegistered.set(slots.size);
  let resident = 0;
  for (const slot of slots.values()) if (slot.sandbox) resident++;
  metrics.slotsResident.set(resident);
}
