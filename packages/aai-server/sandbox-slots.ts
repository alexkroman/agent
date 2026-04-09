// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot registry — simple Map with idle-timeout eviction and hard cap.
 *
 * Each entry tracks the live sandbox, active sessions, and an idle timer.
 * When all sessions end and the idle timer fires, the sandbox is shut down
 * and the entry removed. New agents are rejected once MAX_VMS is reached.
 */

import { getLock } from "p-lock";
import { IDLE_TIMEOUT_MS, MAX_VMS } from "./constants.ts";

export type AgentEntry = {
  slug: string;
  sandbox: { shutdown(): Promise<void> };
  sessions: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

export type AgentMap = Map<string, AgentEntry> & {
  startIdleTimer(slug: string): void;
  cancelIdleTimer(slug: string): void;
};

export function createAgentMap(): AgentMap {
  const map = new Map<string, AgentEntry>() as AgentMap;

  map.startIdleTimer = (slug: string): void => {
    const entry = map.get(slug);
    if (!entry) return;
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      map.delete(slug);
      entry.sandbox.shutdown().catch((err: unknown) => {
        console.warn("Idle sandbox shutdown failed", { slug, error: err });
      });
    }, IDLE_TIMEOUT_MS);
  };

  map.cancelIdleTimer = (slug: string): void => {
    const entry = map.get(slug);
    if (!entry) return;
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  };

  return map;
}

export function isAtCapacity(agents: AgentMap): boolean {
  return agents.size >= MAX_VMS;
}

// ── Backward-compatible exports ─────────────────────────────────────────
// These types and functions are consumed by deploy.ts, delete.ts,
// secret-handler.ts, orchestrator.ts, context.ts, index.ts, and tests.

/**
 * Legacy agent slot — used by deploy/delete handlers and the orchestrator.
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
