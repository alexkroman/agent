// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot registry — slot-based sandbox tracking.
 *
 * Each slot holds ownership info (slug, keyHash) and an optional sandbox
 * reference. Consumed by deploy/delete handlers and the orchestrator.
 */

import { getLock } from "p-lock";

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
 */
export async function terminateSlot(slot: AgentSlot): Promise<void> {
  const { slug } = slot;
  if (slot.sandbox) {
    const sb = slot.sandbox;
    delete slot.sandbox;
    await sb.shutdown().catch((err: unknown) => {
      console.warn("Failed to shut down sandbox", { slug, error: String(err) });
    });
  }
}
