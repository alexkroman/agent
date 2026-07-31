// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica session resume for sandbox sessions (see sandbox.ts, which
 * wires this into the session lifecycle, and session-state-store.ts for the
 * persistence).
 *
 * The deferred guest `session/end` covers a resume that lands back on the
 * SAME replica; the platform proxy is free to route the reconnect elsewhere.
 * When a SessionStateStore is configured, every disconnect also persists the
 * session's resumable state — guest ctx.state (via the `session/export` RPC)
 * plus the host-side `remember` notes — and a `?sessionId=<id>` resume
 * hydrates it back. Both restore sides are set-if-absent, so a same-replica
 * resume's live, fresher state always wins.
 */

import { errorMessage } from "@alexkroman1/aai";
import { restoreSessionNotes, snapshotSessionNotes } from "@alexkroman1/aai/runtime";
import { debug } from "./_debug-log.ts";
import { type GuestConnection, SessionExportResultSchema } from "./rpc-schemas.ts";
import type { SessionStateStore } from "./session-state-store.ts";

export type SessionResumer = {
  /** Persist a disconnected session's resumable state. Fire-and-forget. */
  persist(sessionId: string): void;
  /** Hydrate persisted state for a resumed session. Fire-and-forget. */
  restore(sessionId: string): void;
  /** Await in-flight persists — shutdown calls this while the guest is alive. */
  flushPendingSaves(): Promise<void>;
};

export function createSessionResumer(opts: {
  slug: string;
  store: SessionStateStore | undefined;
  vmReady: Promise<{ conn: GuestConnection }>;
}): SessionResumer {
  const { slug, store, vmReady } = opts;
  const pendingSaves = new Set<Promise<void>>();

  /** Guest ctx.state for a session, or undefined (no state / old harness / dead VM). */
  async function exportGuestState(sessionId: string): Promise<Record<string, unknown> | undefined> {
    try {
      const handle = await vmReady;
      const raw = await handle.conn.sendRequest("session/export", { sessionId });
      const parsed = SessionExportResultSchema.safeParse(raw);
      return parsed.success ? parsed.data.state : undefined;
    } catch {
      // Best-effort: a pre-`session/export` harness answers method-not-found,
      // and a dead VM can't answer at all — either way notes may still save.
    }
  }

  function persist(sessionId: string): void {
    if (!store) return;
    const save = (async () => {
      const state = await exportGuestState(sessionId);
      const notes = snapshotSessionNotes(sessionId);
      if (!(state || notes)) return;
      await store.save(slug, sessionId, {
        ...(state && { state }),
        ...(notes && { notes }),
      });
    })().catch((err: unknown) => {
      console.warn("Failed to persist session resume state", {
        slug,
        error: errorMessage(err),
      });
    });
    pendingSaves.add(save);
    void save.finally(() => pendingSaves.delete(save));
  }

  /**
   * Fire-and-forget from the upgrade path: one row read + one notification,
   * racing a first tool call that is gated on a full STT→LLM turn. The
   * guest's restore and the notes restore are both set-if-absent, so losing
   * that race can only skip the hydration — never clobber newer state.
   */
  function restore(sessionId: string): void {
    if (!store) return;
    void (async () => {
      const saved = await store.load(slug, sessionId);
      if (!saved) return;
      if (saved.notes) restoreSessionNotes(sessionId, saved.notes);
      if (saved.state) {
        const handle = await vmReady;
        handle.conn.sendNotification("session/restore", { sessionId, state: saved.state });
      }
      debug("Session resume state hydrated", { slug, sessionId });
    })().catch((err: unknown) => {
      // A failed hydration degrades to a stateless resume — same outcome as
      // no store — so log rather than fail the session.
      console.warn("Failed to restore session resume state", {
        slug,
        error: errorMessage(err),
      });
    });
  }

  return {
    persist,
    restore,
    async flushPendingSaves() {
      if (pendingSaves.size > 0) await Promise.allSettled([...pendingSaves]);
    },
  };
}
