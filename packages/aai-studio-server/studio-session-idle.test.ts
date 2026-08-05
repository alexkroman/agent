// Copyright 2026 the AAI authors. MIT license.

import { createOwnedMap } from "@alexkroman1/aai/internal";
import type { WarmHarness } from "aai-server/sandbox-vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "./studio-session-entry.ts";
import type { SessionFleet } from "./studio-session-fleet.ts";
import { createSessionReaper } from "./studio-session-idle.ts";

/** The sweep cadence in studio-session-idle.ts — not exported. */
const SWEEP_INTERVAL_MS = 60_000;
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
  function addEntry(project: string, ageAtSweep: number) {
    const warm = makeWarm();
    const key = `scope/${project}`;
    const entry = {
      warm,
      url: `https://guest.example/${project}`,
      scope: "scope",
      project,
      lastUsed: Date.now() + SWEEP_INTERVAL_MS - ageAtSweep,
      chatToken: "tok",
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

    test("still disposes the sandbox when the harness teardown rejects", async () => {
      // A guest that died mid-request rejects on dispose; swallowing it is
      // what keeps one bad teardown from wedging the sweep.
      const { reaper, sessions, addEntry } = setup();
      const { entry, warm, key } = addEntry("alpha", 0);
      warm[Symbol.asyncDispose] = () => Promise.reject(new Error("guest gone"));

      await expect(reaper.disposeEntry(entry)).resolves.toBeUndefined();
      expect(sessions.get(key)).toBeUndefined();
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
  });

  test("tolerates a timer handle with no unref()", () => {
    // Node's Timeout has `unref`; a fake or browser-shimmed timer may not, and
    // an unconditional call would throw at construction.
    const real = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately unref-less handle
      ((fn: () => void, ms: number) => ({ id: real(fn, ms) })) as any,
    );

    const sessions = createOwnedMap<string, SessionEntry>();
    const { fleet } = makeFleet();
    expect(() => createSessionReaper({ sessions, fleet, idleMs: IDLE_MS })).not.toThrow();
  });
});
