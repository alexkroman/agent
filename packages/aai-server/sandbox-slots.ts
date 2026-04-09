// Copyright 2025 the AAI authors. MIT license.
/**
 * Agent slot registry — simple Map with idle-timeout eviction and hard cap.
 *
 * Each entry tracks the live sandbox, active sessions, and an idle timer.
 * When all sessions end and the idle timer fires, the sandbox is shut down
 * and the entry removed. New agents are rejected once MAX_VMS is reached.
 */

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
