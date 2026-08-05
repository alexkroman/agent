// Copyright 2026 the AAI authors. MIT license.
/**
 * Teardown and idle eviction for the studio session broker's sandboxes.
 *
 * Split out of studio-session-broker.ts, which owns the interesting half
 * (reuse / adopt / spawn); this is the other half — "when does a sandbox go
 * away, and whose is it to remove" — and it is the part every other path
 * calls into rather than the part they are about.
 */

import type { createOwnedMap } from "@alexkroman1/aai/internal";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";

/** How often the idle sweep runs; the window itself is `idleMs`. */
const SWEEP_INTERVAL_MS = 60_000;

type SessionMap = ReturnType<typeof createOwnedMap<string, SessionEntry>>;

export type SessionReaper = {
  /**
   * Tear down `entry` and drop it from the map — but only while it is still
   * the project's session. Every caller runs its cleanup AFTER an await (a
   * re-init that rejected, a publish whose sandbox died mid-request), and by
   * then the client may have re-brokered and installed a replacement: the
   * owned map's release deletes only while this claim still holds the key,
   * so a replacement is never evicted and never strands a live sandbox.
   */
  disposeEntry(entry: SessionEntry): Promise<void>;
  /** Stop the sweep timer (broker disposal). */
  stop(): void;
};

/**
 * Idle eviction: chat turns run browser→guest, so the host's only view of
 * activity is broker calls and the guest's end-of-turn RPCs (both touch
 * `lastUsed`). Losing a live-but-quiet sandbox costs one re-broker.
 */
export function createSessionReaper(deps: {
  sessions: SessionMap;
  fleet: SessionFleet;
  idleMs: number;
}): SessionReaper {
  const { sessions, fleet, idleMs } = deps;

  async function disposeEntry(entry: SessionEntry): Promise<void> {
    entry.release();
    // Owner-checked inside the fleet: a replacement sandbox that already
    // re-claimed this project must not lose its row to our teardown.
    await fleet.release(entry.scope, entry.project);
    // No `.catch()`: disposal here is the function's purpose rather than a
    // scope guard, and `WarmHarness[Symbol.asyncDispose]` already swallows its
    // own teardown failures (warm-harness.ts) — a second guard only implied it
    // could reject.
    await entry.warm[Symbol.asyncDispose]();
  }

  /**
   * Evict `entry` unless someone in the fleet has been brokering it — see
   * `SessionFleet.heldByUs`. The lease and the idle window are the same
   * number for exactly this comparison (see STUDIO_SESSION_IDLE_MS).
   */
  async function sweepIfIdle(entry: SessionEntry): Promise<void> {
    if (await fleet.heldByUs(entry.scope, entry.project)) return;
    await disposeEntry(entry);
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const entry of sessions.values()) {
      if (now - entry.lastUsed > idleMs) void sweepIfIdle(entry);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  return {
    disposeEntry,
    stop: () => clearInterval(sweeper),
  };
}
