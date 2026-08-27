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

/**
 * How often the idle sweep runs; the window itself is `idleMs`.
 *
 * Exported because the boundary tests have to advance fake timers by exactly
 * one sweep and place an entry's `lastUsed` relative to it. They used to
 * hand-copy the number, which is the shape of test that stops testing its own
 * boundary in silence: halve this and `advanceTimersByTime(60_000)` fires TWO
 * sweeps at ages the helper never intended, while
 * "leaves a sandbox idle for exactly the window" — the one assertion pinning
 * the strict inequality on line 111 — keeps passing without exercising it.
 */
export const SWEEP_INTERVAL_MS = 60_000;

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
 *
 * The one thing that is NOT merely a re-broker is evicting a sandbox with
 * host-driven work inside it — a Publish or an auto preview deploy, which can
 * legitimately run longer than the idle window — so the sweep consults
 * `entry.inFlight` as well as the clock (see `SessionEntry.inFlight`).
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
    //
    // Baselined under `guard-invariants` rule 27 for that same reason. The rule
    // wants a resource BOUND with `await using` so scope exit disposes it, and
    // this entry was acquired in another scope entirely — the session map owns
    // it, and reaping is what this function IS. There is no scope here to hang
    // the lifetime on, so the explicit call is the correct spelling.
    await entry.warm[Symbol.asyncDispose]();
  }

  /**
   * Entries whose sweep is still running. A sweep spans a registry round trip
   * (`heldByUs`), and NOTHING it does before that read returns takes the entry
   * out of `sessions` or moves its `lastUsed` — so without this the next tick
   * re-selects the same entry and starts a second sweep for it.
   *
   * Both halves of that matter. The platform admin connection carries no
   * `statement_timeout` — nothing on this connection sets one — so
   * a stalled registry read is unbounded: every 60s tick adds another read for
   * the same entry, piling onto the pool that is already the thing failing.
   * And once two sweeps are in flight, both reach `disposeEntry`, which means
   * two `Symbol.asyncDispose` calls — two sandbox terminates — and two fleet
   * releases. The identity guards downstream (the owned map's release, the
   * fleet's owner check) keep that from corrupting a successor's state, which
   * is exactly why it stayed invisible.
   */
  const sweeping = new Set<SessionEntry>();

  /**
   * Evict `entry` unless someone in the fleet has been brokering it — see
   * `SessionFleet.heldByUs`. The lease and the idle window are the same
   * number for exactly this comparison (see STUDIO_SESSION_IDLE_MS).
   */
  async function sweepIfIdle(entry: SessionEntry): Promise<void> {
    // Work running INSIDE the sandbox is not idleness, and `lastUsed` cannot
    // see it: a deploy touches when it returns, and its deadline outlives the
    // idle window by design (see SessionEntry.inFlight). Checked before the
    // registry read as well as before the teardown, so a sweep never starts
    // for a busy sandbox at all.
    if (entry.inFlight > 0 || sweeping.has(entry)) return;
    sweeping.add(entry);
    try {
      if (await fleet.heldByUs(entry.scope, entry.project)) return;
      // Re-read after the registry round trip: a Publish can begin while that
      // read is outstanding, and this is the last point before the terminate.
      if (entry.inFlight > 0) return;
      await disposeEntry(entry);
    } finally {
      // By identity, so this releases only our own mark. The entry is gone
      // from `sessions` on the eviction path, and still there on the
      // held-by-us path — where the next tick is meant to try again.
      sweeping.delete(entry);
    }
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
