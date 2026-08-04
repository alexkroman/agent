// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica change notifications for the platform's Postgres rows.
 *
 * Two watchable streams, both **signals rather than payloads** — a handler
 * re-reads the row it cares about instead of trusting anything that rode on
 * the event. That keeps the row (the source of truth) authoritative: a lost
 * or duplicated event can only delay or repeat a read, never deliver stale
 * data, and Supabase Realtime's payload size cap never matters.
 *
 * - `watchAgents` — the agents table changed (a deploy bumped `version`, or
 *   a delete removed the row). This stream is THE mover of resident
 *   sandboxes: mutation handlers only write the row, and
 *   `watchAgentInvalidation` (sandbox-resolve.ts) retires/terminates
 *   residents on every replica, the writer's included.
 * - `watchWorkspace` — one studio project's workspace row changed. The
 *   studio's SSE route uses it to push preview/file state to the browser,
 *   which replaced the client-side polling loop entirely.
 *
 * Two implementations, mirroring every other platform store: Supabase
 * Realtime `postgres_changes` in production (realtime-events.ts) and the
 * in-process emitter below for dev/tests, paired with the memory stores via
 * the decorators so a workspace write and its notification cannot drift.
 */

import type { AgentRows } from "./agent-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/** Unsubscribe handle returned by every watch. Idempotent. */
export type Unwatch = () => void;

export type PlatformEvents = {
  /**
   * Fires when ANY agents row changes (deploy, delete). The handler gets the
   * slug only — re-read the row's version to learn what happened.
   */
  watchAgents(onChange: (slug: string) => void): Unwatch;
  /**
   * Fires when one project's workspace row changes. Signal only — the
   * handler re-reads the workspace.
   */
  watchWorkspace(scope: string, project: string, onChange: () => void): Unwatch;
  /** Tear down the underlying connection (production: the Realtime socket). */
  close(): Promise<void>;
};

export type MemoryPlatformEvents = {
  events: PlatformEvents;
  /** Notify agents watchers — wired into the memory agent rows' writes. */
  emitAgent(slug: string): void;
  /** Notify one project's workspace watchers — wired into memory-store writes. */
  emitWorkspace(scope: string, project: string): void;
};

const workspaceKey = (scope: string, project: string) => `${scope}\u0000${project}`;

/**
 * In-process events for dev and tests. Emission is deferred a microtask so a
 * watcher's re-read never observes the store mid-write.
 */
export function createMemoryPlatformEvents(): MemoryPlatformEvents {
  const agentWatchers = new Set<(slug: string) => void>();
  const workspaceWatchers = new Map<string, Set<() => void>>();

  return {
    events: {
      watchAgents(onChange) {
        agentWatchers.add(onChange);
        return () => agentWatchers.delete(onChange);
      },
      watchWorkspace(scope, project, onChange) {
        const key = workspaceKey(scope, project);
        let set = workspaceWatchers.get(key);
        if (!set) {
          set = new Set();
          workspaceWatchers.set(key, set);
        }
        set.add(onChange);
        return () => {
          set.delete(onChange);
          if (set.size === 0) workspaceWatchers.delete(key);
        };
      },
      close: () => Promise.resolve(),
    },
    emitAgent(slug) {
      queueMicrotask(() => {
        for (const watcher of agentWatchers) watcher(slug);
      });
    },
    emitWorkspace(scope, project) {
      const set = workspaceWatchers.get(workspaceKey(scope, project));
      if (!set) return;
      queueMicrotask(() => {
        for (const watcher of set) watcher();
      });
    },
  };
}

/**
 * Memory agent rows that notify watchers on every write — the dev-side
 * equivalent of the Postgres tables' `postgres_changes` stream. Production
 * never wraps: the database itself is the emitter there, and a local echo
 * would double-fire the writing replica.
 */
export function withAgentEvents(rows: AgentRows, emit: (slug: string) => void): AgentRows {
  return {
    ...rows,
    async put(record) {
      await rows.put(record);
      emit(record.slug);
    },
    async delete(slug) {
      await rows.delete(slug);
      emit(slug);
    },
  };
}

/** Memory workspace store that notifies watchers on every write. See above. */
export function withWorkspaceEvents(
  store: WorkspaceStore,
  emit: (scope: string, project: string) => void,
): WorkspaceStore {
  return {
    ...store,
    async put(scope, project, doc, expectedVersion) {
      const version = await store.put(scope, project, doc, expectedVersion);
      emit(scope, project);
      return version;
    },
    async delete(scope, project) {
      await store.delete(scope, project);
      emit(scope, project);
    },
  };
}
