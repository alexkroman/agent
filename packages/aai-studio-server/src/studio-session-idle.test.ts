// Copyright 2026 the AAI authors. MIT license.

import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { WarmHarness } from "aai-server/sandbox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";
import { createSessionReaper, SWEEP_INTERVAL_MS } from "./studio-session-idle.ts";

/**
 * The sweep cadence is IMPORTED, never re-declared: `addEntry` positions
 * `lastUsed` relative to the next sweep and every boundary test advances by
 * exactly one, so a copy that drifted from the module would move both — the
 * ages the helper intends and the moment they are read — and the assertions
 * would go on passing while measuring something else.
 */
const IDLE_MS = 300_000;

type Harness = {
  disposed: number;
} & WarmHarness;

function makeWarm(): Harness {
  const warm = {
    disposed: 0,
    async [Symbol.asyncDispose]() {
      warm.disposed += 1;
    },
  };
  return warm as unknown as Harness;
}

function makeFleet(over: Partial<SessionFleet> = {}) {
  const calls = { release: [] as string[], heldByUs: [] as string[] };
  const fleet: SessionFleet = {
    adopt: () => Promise.resolve(null),
    claim: () => Promise.resolve(),
    release: (scope, project) => {
      calls.release.push(`${scope}/${project}`);
      return Promise.resolve();
    },
    touch: () => undefined,
    heldByUs: (scope, project) => {
      calls.heldByUs.push(`${scope}/${project}`);
      return Promise.resolve(false);
    },
    ...over,
  };
  return { fleet, calls };
}

function setup(opts: { fleet?: Partial<SessionFleet>; idleMs?: number } = {}) {
  const sessions = createOwnedMap<string, SessionEntry>();
  const { fleet, calls } = makeFleet(opts.fleet);
  const reaper = createSessionReaper({
    sessions,
    fleet,
    idleMs: opts.idleMs ?? IDLE_MS,
  });

  /**
   * Claim an entry that will be `ageAtSweep` ms idle when the NEXT sweep
   * fires. Fake timers advance `Date.now()` too, so the age is stated at the
   * moment that matters rather than at claim time — otherwise every boundary
   * assertion silently carries one sweep interval of slack.
   */
  function addEntry(project: string, ageAtSweep: number, inFlight = 0) {
    const warm = makeWarm();
    const key = `scope/${project}`;
    const entry = {
      warm,
      url: `https://guest.example/${project}`,
      scope: "scope",
      project,
      lastUsed: Date.now() + SWEEP_INTERVAL_MS - ageAtSweep,
      chatToken: "tok",
      inFlight,
      release: () => false,
    } as SessionEntry;
    entry.release = sessions.claim(key, entry);
    return { entry, warm, key };
  }

  return { sessions, fleet, calls, reaper, addEntry };
}

describe("createSessionReaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("disposeEntry", () => {
    test("releases the claim, drops the fleet row, and disposes the sandbox", async () => {
      const { reaper, sessions, calls, addEntry } = setup();
      const { entry, warm, key } = addEntry("alpha", 0);

      await reaper.disposeEntry(entry);

      expect(sessions.get(key)).toBeUndefined();
      expect(calls.release).toEqual(["scope/alpha"]);
      expect(warm.disposed).toBe(1);
    });

    test("gives up the claim and the fleet row before awaiting the teardown", async () => {
      // Ordering is the point: the sandbox teardown is the slow part, and a
      // client re-brokering during it must find the key free and the fleet row
      // gone rather than racing a half-disposed entry.
      const { reaper, sessions, calls, addEntry } = setup();
      const { entry, key } = addEntry("alpha", 0);
      let observed: { claimed: boolean; released: string[] } | undefined;
      entry.warm[Symbol.asyncDispose] = () => {
        observed = { claimed: sessions.get(key) !== undefined, released: [...calls.release] };
        return Promise.resolve();
      };

      await reaper.disposeEntry(entry);

      expect(observed).toEqual({ claimed: false, released: ["scope/alpha"] });
    });

    test("does not evict a replacement that already re-claimed the key", async () => {
      // Every caller disposes AFTER an await, by which point the client may
      // have re-brokered. The owned map's release is what makes that safe.
      const { reaper, sessions, addEntry } = setup();
      const { entry } = addEntry("alpha", 0);
      const replacement = addEntry("alpha", 0);

      await reaper.disposeEntry(entry);

      expect(sessions.get("scope/alpha")).toBe(replacement.entry);
    });
  });

  describe("idle sweep", () => {
    test("evicts a sandbox idle longer than the window", async () => {
      const { reaper, sessions, calls, addEntry } = setup();
      const { warm } = addEntry("alpha", IDLE_MS + 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(calls.heldByUs).toEqual(["scope/alpha"]);
      expect(warm.disposed).toBe(1);
      expect(sessions.get("scope/alpha")).toBeUndefined();
      reaper.stop();
    });

    test("leaves a sandbox idle for exactly the window", async () => {
      // The boundary: the window is how long a quiet sandbox may live, so the
      // sweep fires strictly past it.
      const { reaper, sessions, calls, addEntry } = setup();
      const { warm } = addEntry("alpha", IDLE_MS);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(calls.heldByUs).toEqual([]);
      expect(warm.disposed).toBe(0);
      expect(sessions.get("scope/alpha")).toBeDefined();
      reaper.stop();
    });

    test("leaves a freshly used sandbox alone", async () => {
      const { reaper, calls, addEntry } = setup();
      const { warm } = addEntry("alpha", 0);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(calls.heldByUs).toEqual([]);
      expect(warm.disposed).toBe(0);
      reaper.stop();
    });

    test("does not sweep before the first interval elapses", async () => {
      const { reaper, addEntry } = setup();
      // Far past the window, so only the cadence can be holding the sweep off.
      const { warm } = addEntry("alpha", IDLE_MS * 2);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS - 1);
      expect(warm.disposed).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(warm.disposed).toBe(1);
      reaper.stop();
    });

    test("spares an idle sandbox a peer has been brokering", async () => {
      // A peer installs over HTTP and touches the lease — neither reaches
      // this process, so the lease is the only evidence it is in use.
      const { reaper, sessions, addEntry } = setup({
        fleet: { heldByUs: () => Promise.resolve(true) },
      });
      const { warm } = addEntry("alpha", IDLE_MS + 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(warm.disposed).toBe(0);
      expect(sessions.get("scope/alpha")).toBeDefined();
      reaper.stop();
    });

    test("sweeps only the idle entries, leaving active ones", async () => {
      const { reaper, sessions, addEntry } = setup();
      const idle = addEntry("idle", IDLE_MS + 1);
      const active = addEntry("active", 1000);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(idle.warm.disposed).toBe(1);
      expect(active.warm.disposed).toBe(0);
      expect(sessions.get("scope/active")).toBeDefined();
      reaper.stop();
    });

    test("keeps sweeping on later intervals", async () => {
      const { reaper, addEntry } = setup();
      addEntry("alpha", 0);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      const later = addEntry("beta", IDLE_MS + 1);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(later.warm.disposed).toBe(1);
      reaper.stop();
    });

    test("stop() ends the sweep", async () => {
      const { reaper, addEntry } = setup();
      const { warm } = addEntry("alpha", IDLE_MS + 1);

      reaper.stop();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);

      expect(warm.disposed).toBe(0);
    });

    test("a stalled registry read stays ONE read, however many ticks pass", async () => {
      // The entry is still in `sessions` and its `lastUsed` has not moved
      // while `heldByUs` is pending, so every tick re-selects it. The platform
      // admin connection has no statement_timeout, so "pending" is unbounded —
      // one read per tick would pile onto the pool that is already stuck.
      const reads: string[] = [];
      const { reaper, addEntry } = setup({
        fleet: {
          heldByUs: (scope, project) => {
            reads.push(`${scope}/${project}`);
            return new Promise<boolean>(() => {
              /* never settles */
            });
          },
        },
      });
      addEntry("alpha", IDLE_MS + 1);

      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(reads).toEqual(["scope/alpha"]);
      reaper.stop();
    });

    test("disposes once when a slow read spans two ticks", async () => {
      // Two sweeps reaching disposeEntry means two Symbol.asyncDispose calls —
      // two sandbox terminates — and two fleet releases. The identity guards
      // downstream absorb the damage, which is what kept it invisible.
      const gates: ((held: boolean) => void)[] = [];
      const { reaper, sessions, calls, addEntry } = setup({
        fleet: {
          heldByUs: () =>
            new Promise<boolean>((resolve) => {
              gates.push(resolve);
            }),
        },
      });
      const { warm } = addEntry("alpha", IDLE_MS + 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      // Only the first tick ever issued a read; release it and let it settle.
      expect(gates).toHaveLength(1);
      for (const gate of gates) gate(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(warm.disposed).toBe(1);
      expect(calls.release).toEqual(["scope/alpha"]);
      expect(sessions.get("scope/alpha")).toBeUndefined();
      reaper.stop();
    });

    /**
     * A Publish or an auto preview deploy runs INSIDE the sandbox and can
     * legitimately outlive the idle window — `WORKSPACE_DEPLOY_TIMEOUT_MS` is
     * 330s against a 300s window — and the deploy touches `lastUsed` only when
     * it RETURNS. So the clock alone said "idle" for a sandbox that was
     * building: it was terminated mid-`aai deploy`, the build re-ran from
     * scratch, and the browser's chat URL was dead.
     */
    test("never evicts a sandbox with work in flight, and does not even read the registry", async () => {
      const { reaper, sessions, calls, addEntry } = setup();
      const { warm } = addEntry("alpha", IDLE_MS * 3, 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);

      expect(warm.disposed).toBe(0);
      expect(sessions.get("scope/alpha")).toBeDefined();
      // Not merely spared — never examined. The sweep is skipped before the
      // registry round trip, so a busy sandbox costs no reads either.
      expect(calls.heldByUs).toEqual([]);
      reaper.stop();
    });

    test("evicts once the in-flight deploy releases", async () => {
      const { reaper, sessions, addEntry } = setup();
      const { entry, warm } = addEntry("alpha", IDLE_MS + 1, 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(warm.disposed).toBe(0);

      entry.inFlight = 0;
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(warm.disposed).toBe(1);
      expect(sessions.get("scope/alpha")).toBeUndefined();
      reaper.stop();
    });

    test("a deploy that starts DURING the registry read still spares the sandbox", async () => {
      // The last gap: `heldByUs` spans a real round trip, and a Publish can
      // begin inside it. Re-read after the await or the terminate lands on a
      // sandbox that is building.
      const gates: ((held: boolean) => void)[] = [];
      const { reaper, sessions, addEntry } = setup({
        fleet: {
          heldByUs: () =>
            new Promise<boolean>((resolve) => {
              gates.push(resolve);
            }),
        },
      });
      const { entry, warm } = addEntry("alpha", IDLE_MS + 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(gates).toHaveLength(1);
      // Publish arrives while the read is outstanding.
      entry.inFlight = 1;
      gates[0]?.(false);
      await vi.advanceTimersByTimeAsync(0);

      expect(warm.disposed).toBe(0);
      expect(sessions.get("scope/alpha")).toBeDefined();
      reaper.stop();
    });

    test("retries on the next tick after a peer's hold lapses", async () => {
      // The guard must release on the spare path too, or one held-by-us answer
      // would exempt the entry from eviction for the life of the process.
      let held = true;
      const { reaper, sessions, addEntry } = setup({
        fleet: { heldByUs: () => Promise.resolve(held) },
      });
      const { warm } = addEntry("alpha", IDLE_MS + 1);

      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(warm.disposed).toBe(0);

      held = false;
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      expect(warm.disposed).toBe(1);
      expect(sessions.get("scope/alpha")).toBeUndefined();
      reaper.stop();
    });
  });

  test("tolerates a timer handle with no unref()", () => {
    // Node's Timeout has `unref`; a fake or browser-shimmed timer may not, and
    // an unconditional call would throw at construction.
    const real = globalThis.setInterval;
    // A handle with no `unref` — the shape a fake or browser-shimmed timer
    // returns. Cast through `unknown` rather than widening to `any`.
    const unreflessSetInterval = ((fn: () => void, ms: number) => ({
      id: real(fn, ms),
    })) as unknown as typeof globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(unreflessSetInterval);

    const sessions = createOwnedMap<string, SessionEntry>();
    const { fleet } = makeFleet();
    expect(() => createSessionReaper({ sessions, fleet, idleMs: IDLE_MS })).not.toThrow();
  });
});
