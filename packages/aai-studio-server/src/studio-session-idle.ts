// Copyright 2026 the AAI authors. MIT license.
/**
 * Teardown and idle eviction for the studio session broker's sandboxes.
 *
 * Split out of studio-session-broker.ts, which owns the interesting half
 * (reuse / adopt / spawn); this is the other half — "when does a sandbox go
 * away, and whose is it to remove" — and it is the part every other path
 * calls into rather than the part they are about.
 */

import { errorMessage } from "@alexkroman1/aai";
import { type createOwnedMap, sleep } from "@alexkroman1/aai/internal";
import { envMs } from "aai-server/config";
import { createLogger } from "aai-server/logger";
import pTimeout from "p-timeout";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";

const log = createLogger("studio.session");

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

/**
 * How long a replica going down waits for work inside its studio sandboxes —
 * a chat turn (and its `test_agent` builds), a Publish, a preview deploy —
 * before terminating them anyway. Override with `STUDIO_SHUTDOWN_DRAIN_MS`;
 * 0 terminates at once, as before this existed.
 *
 * The number is what FITS, not what the work needs: a turn runs for minutes
 * and a Publish up to `WORKSPACE_DEPLOY_TIMEOUT_MS` (330s). Everything here
 * runs inside `onShutdown`, netted at `SHUTDOWN_TEARDOWN_TIMEOUT_MS` (20s);
 * that net exists because Modal SIGKILLs the container when its stop grace
 * lapses (see constants.ts and serve-lifecycle.ts). The grace itself is
 * Modal's and is written down nowhere in this repo — `NODE_STOP_TIMEOUT_SECS`
 * (150s, scripts/modal_image.py) is only the Python wrapper's own wait, and
 * its comment defers to Modal's backstop — so ASSUME it is no longer than
 * the ~23s this process already budgets to exit, and stay inside the 20s net.
 * The wait starts at the signal (index.ts), in parallel with the agent
 * guests' retirement; 12s leaves 8s of that net for the terminates and
 * registry releases that follow it, whose Modal calls carry no timeout of
 * their own. `studio-session-idle.test.ts` holds the default inside the net.
 *
 * What it buys is the TAIL of the work: a turn that ends within the window
 * finishes and persists. A longer one is cut, and the client recovers it: it
 * regenerates the turn on a fresh sandbox (aai-studio-client
 * `turn-recovery.ts`), re-posting the conversation that ends in the user's
 * message — which the guest persisted before the cut turn ran.
 */
export const STUDIO_SHUTDOWN_DRAIN_MS = 12_000;

/** {@link STUDIO_SHUTDOWN_DRAIN_MS}, overridable through the environment. */
export function studioShutdownDrainMs(env: NodeJS.ProcessEnv = process.env): number {
  return envMs(env.STUDIO_SHUTDOWN_DRAIN_MS, STUDIO_SHUTDOWN_DRAIN_MS);
}

/**
 * How often a shutdown drain re-reads `SessionEntry.inFlight`. A counter, not
 * an event: the publisher's `hold` is the only writer, and a quarter second is
 * nothing against a drain budget measured in seconds.
 */
export const QUIESCE_POLL_MS = 250;

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
  /**
   * Wait, at most `budgetMs`, for `entry`'s sandbox to have no work in it —
   * the shutdown drain (see {@link STUDIO_SHUTDOWN_DRAIN_MS}). Never throws:
   * a budget that lapses, or a guest that cannot answer, logs and resolves,
   * and the caller terminates either way.
   */
  quiesce(entry: SessionEntry, budgetMs: number): Promise<void>;
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
    // Reaping TAKES OWNERSHIP of the sandbox from the session map, so it is
    // bound here (`guard-invariants` rule 27) and terminated at scope exit —
    // after both releases below, as before, and now also on a path where one
    // of them throws, which the explicit trailing call would have skipped,
    // leaking a billed sandbox. No `.catch()`: `WarmHarness[Symbol.asyncDispose]`
    // already swallows its own teardown failures (warm-harness.ts).
    await using _warm = entry.warm;
    entry.release();
    // Owner-checked inside the fleet: a replacement sandbox that already
    // re-claimed this project must not lose its row to our teardown.
    await fleet.release(entry.scope, entry.project);
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

  /**
   * Both halves of "no work in this sandbox", because neither side sees the
   * other's: the GUEST knows about chat turns (they stream browser→guest, and
   * the host hears of one only at its end-of-turn RPCs), and only the HOST
   * holds `inFlight`, the Publish and preview deploys it sent. The guest's
   * half also closes the door — a drained guest refuses new turns and
   * re-installs (aai-guest-studio/turn-drain.ts). The host half has no door:
   * `dispose` stops the preview deployer first, but a Publish request that
   * still reaches this replica during the drain is not waited for once the
   * count has read zero — the proxy stops routing here within one health
   * check of `draining`, so that window is short.
   */
  async function quiesce(entry: SessionEntry, budgetMs: number): Promise<void> {
    const stopPolling = new AbortController();
    const hostWork = async (): Promise<void> => {
      while (entry.inFlight > 0 && !stopPolling.signal.aborted) {
        await sleep(QUIESCE_POLL_MS, { signal: stopPolling.signal });
      }
    };
    try {
      await pTimeout(
        Promise.all([entry.warm.conn.sendRequest("studio/drain", {}, budgetMs), hostWork()]),
        { milliseconds: budgetMs },
      );
    } catch (err) {
      // Lapsed, or the guest could not answer (gone already, or a harness
      // that predates the request): terminate regardless — waiting longer
      // spends the shutdown budget the other teardowns need.
      log.warn("studio sandbox not quiet at shutdown; terminating", {
        project: entry.project,
        inFlight: entry.inFlight,
        error: errorMessage(err),
      });
    } finally {
      stopPolling.abort();
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
    quiesce,
    stop: () => clearInterval(sweeper),
  };
}
