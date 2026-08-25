// Copyright 2026 the AAI authors. MIT license.
// Restart-supervisor specs.
//
// These used to live in `_dev-server-restart.test.ts`, where reaching the
// state machine cost nine module mocks (node:fs, chokidar, get-port, the
// runtime barrel, …), a real agent.ts on disk, a REAL bundler build per
// restart, the watcher's 300ms debounce, and 15s `vi.waitFor` ceilings to
// survive a contended CI runner. The machine itself touches none of that —
// it only calls `build`/`listen`/`close` — so with those injected the same
// invariants are assertable directly, in microseconds, with no mocks at all.
// That also made the four races below cheap enough to cover; they were
// documented in comments and previously untested.

import { describe, expect, test, vi } from "vitest";
import { createRestartSupervisor, type RestartOps } from "./_dev-restart.ts";

/** A supervised "server" is opaque to the supervisor — a label is enough. */
type Server = { id: string };

type Harness = ReturnType<typeof makeHarness>;

/**
 * Build a supervisor over recording ops. The default `build` hands out
 * `v1`, `v2`, … so assertions can name which server was closed or adopted;
 * `sleep` resolves immediately so the listen backoff costs no wall-clock.
 *
 * Overrides are folded in BEFORE the spies are read back out, so `h.notify`
 * and friends always name the op the supervisor actually called — a harness
 * that returned its own defaults would silently assert on a dead spy.
 */
function makeHarness(overrides: Partial<RestartOps<Server>> = {}) {
  let n = 0;
  const ops: RestartOps<Server> = {
    build: vi.fn(async (): Promise<Server> => ({ id: `v${++n}` })),
    listen: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
    notify: vi.fn(),
    teardown: vi.fn(async (): Promise<void> => undefined),
    sleep: async () => undefined,
    ...overrides,
  };
  const close = vi.mocked(ops.close);
  const notify = vi.mocked(ops.notify);

  return {
    supervisor: createRestartSupervisor(ops),
    build: vi.mocked(ops.build),
    listen: vi.mocked(ops.listen),
    close,
    notify,
    teardown: vi.mocked(ops.teardown ?? (() => Promise.resolve())),
    /** Ids passed to `close`, in order. */
    closed: (): string[] => close.mock.calls.map(([server]) => server.id),
    /** Messages passed to `notify` at the given level, in order. */
    messages: (level: string): string[] =>
      notify.mock.calls.filter(([lvl]) => lvl === level).map(([, message]) => message),
  };
}

/** Boot the supervisor the way `startDevServer` does: adopt the built server. */
function started(h: Harness, id = "v0"): void {
  h.supervisor.adopt({ id });
}

/**
 * Wait for `request()`'s fire-and-forget restart chain to reach `n` builds.
 * `waitUntil`, not `waitFor` + `expect`: an assertion outside a `test()` body
 * reports against the wrong test when it fails (and Biome rejects it).
 */
function settled(h: Harness, n: number): Promise<boolean> {
  return vi.waitUntil(() => h.build.mock.calls.length >= n);
}

describe("createRestartSupervisor", () => {
  test("a change request rebuilds, then swaps the old server for the new one", async () => {
    const h = makeHarness();
    started(h);

    h.supervisor.request();
    await settled(h, 1);
    await vi.waitFor(() => expect(h.messages("success")).toEqual(["Restarted"]));

    expect(h.closed()).toEqual(["v0"]);
    expect(h.supervisor.current()).toEqual({ id: "v1" });
  });

  test("builds the new server before closing the old one", async () => {
    const h = makeHarness();
    started(h);

    h.supervisor.request();
    await settled(h, 1);
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalled());

    // The down-window is only the close+listen swap, not the whole rebuild.
    const buildOrder = h.build.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const closeOrder = h.close.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    const listenOrder = h.listen.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(buildOrder).toBeLessThan(closeOrder);
    expect(closeOrder).toBeLessThan(listenOrder);
  });

  test("a change saved during startup runs exactly one restart, after adopt", async () => {
    const h = makeHarness();

    // Startup is still in flight: the supervisor starts in the "restarting"
    // state, so these queue rather than racing the initial build.
    h.supervisor.request();
    h.supervisor.request();
    expect(h.build).not.toHaveBeenCalled();

    h.supervisor.adopt({ id: "v0" });
    await settled(h, 1);
    // Two events collapse to one rebuild — not one per event.
    await vi.waitFor(() => expect(h.messages("success")).toEqual(["Restarted"]));
    expect(h.build).toHaveBeenCalledTimes(1);
  });

  test("a change during an in-flight restart loops once more with the newest files", async () => {
    const gate = Promise.withResolvers<void>();
    let first = true;
    const h = makeHarness({
      build: vi.fn(async () => {
        if (first) {
          first = false;
          await gate.promise;
          return { id: "v1" };
        }
        return { id: "v2" };
      }),
    });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledTimes(1));
    // Lands while the first rebuild is still building: must not be dropped,
    // or the final save is silently ignored and the server serves stale code.
    h.supervisor.request();
    gate.resolve();

    await settled(h, 2);
    await vi.waitFor(() => expect(h.supervisor.current()).toEqual({ id: "v2" }));
  });

  test("a failed build leaves the previous server running", async () => {
    const h = makeHarness({ build: vi.fn(() => Promise.reject(new Error("agent broke"))) });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() =>
      expect(h.messages("error")).toEqual([
        "Restart failed: agent broke (previous server still running)",
      ]),
    );

    expect(h.close).not.toHaveBeenCalled();
    expect(h.supervisor.current()).toEqual({ id: "v0" });
  });

  test("listen retries when the port is momentarily taken", async () => {
    const listen = vi
      .fn<(server: Server) => Promise<void>>()
      .mockRejectedValueOnce(new Error("EADDRINUSE"))
      .mockRejectedValueOnce(new Error("EADDRINUSE"))
      .mockResolvedValue(undefined);
    const h = makeHarness({ listen });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.messages("success")).toEqual(["Restarted"]));

    expect(listen).toHaveBeenCalledTimes(3);
    expect(h.supervisor.current()).toEqual({ id: "v1" });
  });

  test("listen failing every attempt logs a save-to-retry hint and closes the new server", async () => {
    const listen = vi
      .fn<(server: Server) => Promise<void>>()
      .mockRejectedValue(new Error("EADDRINUSE"));
    const h = makeHarness({ listen });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() =>
      expect(h.messages("error")).toEqual([
        "Restart failed: EADDRINUSE — dev server is down; save a file to retry.",
      ]),
    );

    expect(listen).toHaveBeenCalledTimes(3);
    // The old server was already closed for the swap; the new one must not be
    // left half-constructed on top of it.
    expect(h.closed()).toEqual(["v0", "v1"]);
  });

  test("close during a rebuild shuts the freshly built server down", async () => {
    const gate = Promise.withResolvers<void>();
    const h = makeHarness({
      build: vi.fn(async () => {
        await gate.promise;
        return { id: "v1" };
      }),
    });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledTimes(1));
    await h.supervisor.close();
    gate.resolve();

    // v1 never listens — closing it is the only thing keeping the port and
    // the event loop from being leaked.
    await vi.waitFor(() => expect(h.closed()).toEqual(["v0", "v1"]));
    expect(h.listen).not.toHaveBeenCalled();
  });

  test("close racing the swap shuts the newly listening server down too", async () => {
    const gate = Promise.withResolvers<void>();
    const h = makeHarness({
      listen: vi.fn(async () => {
        await gate.promise;
      }),
    });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.listen).toHaveBeenCalledTimes(1));
    // Teardown closed the OLD server, so without this the new one listens
    // forever after `aai dev` has exited.
    await h.supervisor.close();
    gate.resolve();

    await vi.waitFor(() => expect(h.closed()).toEqual(["v0", "v1"]));
    expect(h.messages("success")).toEqual([]);
  });

  test("close is idempotent: later calls join the in-flight teardown", async () => {
    const h = makeHarness();
    started(h);

    const first = h.supervisor.close();
    const second = h.supervisor.close();
    expect(second).toBe(first);
    await first;
    await h.supervisor.close();

    expect(h.teardown).toHaveBeenCalledTimes(1);
    expect(h.closed()).toEqual(["v0"]);
  });

  test("adopting after a teardown closes the server instead of orphaning it", async () => {
    // Ctrl-C during the initial build: `close()` runs while `current` is still
    // undefined, so it closes nothing, and the build then finishes and adopts.
    // Without the refusal the freshly listening server is assigned to a
    // supervisor with no teardown left to run, and its port stays bound for the
    // life of the process. `restartOnce` guards the same race for a REBUILD.
    const h = makeHarness();
    await h.supervisor.close();
    h.supervisor.adopt({ id: "booted" });
    await vi.waitUntil(() => h.closed().includes("booted"));
    expect(h.supervisor.current()).toBeUndefined();
  });

  test("a request after adopting into a closed supervisor rebuilds nothing", async () => {
    const h = makeHarness();
    await h.supervisor.close();
    h.supervisor.adopt({ id: "booted" });
    // The refused adopt leaves the supervisor in its boot window, so the
    // request queues against a boot that will never complete rather than
    // starting a rebuild for a dev server that is gone.
    h.supervisor.request();
    expect(h.build).not.toHaveBeenCalled();
  });

  test("a failing teardown hook still closes the current server", async () => {
    const h = makeHarness({ teardown: vi.fn(() => Promise.reject(new Error("watcher stuck"))) });
    started(h);

    await expect(h.supervisor.close()).resolves.toBeUndefined();
    expect(h.closed()).toEqual(["v0"]);
  });

  // ── Mutation-test findings ─────────────────────────────────────────────────
  // Four mutants survived the suite above at 94.37%. Each is a real gap, not a
  // scoring artifact: the assertions were about the OUTCOME of a path without
  // pinning the mechanism that produces it.

  test("the injected sleep is what the listen backoff waits on", async () => {
    // Killed mutant: `ops.sleep ?? sleep` -> `ops.sleep && sleep`, which
    // silently falls back to the REAL 250ms timer whenever a sleep is
    // injected. Every retry spec still passed — just slower — because none
    // asserted the injected one was ever called.
    const sleep = vi.fn(async () => undefined);
    const listen = vi
      .fn<(server: Server) => Promise<void>>()
      .mockRejectedValueOnce(new Error("EADDRINUSE"))
      .mockResolvedValue(undefined);
    const h = makeHarness({ listen, sleep });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.messages("success")).toEqual(["Restarted"]));

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
  });

  test("a request during an in-flight restart queues rather than building twice at once", async () => {
    // Killed mutant: `restarting = true` -> `false` in request(). The
    // in-flight-change spec only waited for a SECOND build, which a mutant
    // that starts two concurrent restarts satisfies just as well. What must
    // hold is that the second build does not begin until the first settles.
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let maxConcurrent = 0;
    const h = makeHarness({
      build: vi.fn(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await gate.promise;
        inFlight--;
        return { id: "v1" };
      }),
    });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.build).toHaveBeenCalledTimes(1));
    h.supervisor.request();
    h.supervisor.request();
    // Still exactly one build in flight, however many events land.
    expect(h.build).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settled(h, 2);
    expect(maxConcurrent).toBe(1);
  });

  test("a restart after a failed listen closes nothing that is not there", async () => {
    // Killed mutant: `if (current !== undefined)` -> `if (true)`. Reachable
    // only after listen exhausts its retries, which leaves no live server —
    // the mutant then hands `undefined` to ops.close.
    const listen = vi
      .fn<(server: Server) => Promise<void>>()
      .mockRejectedValue(new Error("EADDRINUSE"));
    const h = makeHarness({ listen });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.messages("error")).toHaveLength(1));
    expect(h.supervisor.current()).toBeUndefined();

    // A later save must rebuild cleanly rather than close a phantom server.
    listen.mockResolvedValue(undefined);
    h.supervisor.request();
    await vi.waitFor(() => expect(h.messages("success")).toEqual(["Restarted"]));

    for (const [server] of h.close.mock.calls) expect(server).toBeDefined();
    expect(h.closed()).toEqual(["v0", "v1"]);
  });

  test("close works with no teardown hook supplied", async () => {
    // Killed mutant: `ops.teardown?.()` -> `ops.teardown()`. `teardown` is
    // optional in RestartOps and every spec happened to pass one, so the
    // optional call was never exercised — a supervisor without one would
    // have thrown on close.
    // Built directly rather than through makeHarness: `exactOptionalPropertyTypes`
    // forbids passing `teardown: undefined`, and OMITTING it is the case.
    const close = vi.fn(async (_server: Server): Promise<void> => undefined);
    const supervisor = createRestartSupervisor<Server>({
      build: async () => ({ id: "v1" }),
      listen: async () => undefined,
      close,
      notify: vi.fn(),
    });
    supervisor.adopt({ id: "v0" });

    await expect(supervisor.close()).resolves.toBeUndefined();
    expect(close.mock.calls.map(([s]) => s.id)).toEqual(["v0"]);
  });

  test("close before adopt tears down without a server to close", async () => {
    const h = makeHarness();

    await h.supervisor.close();

    expect(h.teardown).toHaveBeenCalledTimes(1);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.supervisor.current()).toBeUndefined();
  });

  test("an unexpected throw is reported and does not wedge later restarts", async () => {
    // The realistic case is the notifier itself failing — `aai dev | head`
    // leaves stderr writes throwing EPIPE. That escapes restartOnce's own
    // try/catch, so it reaches request()'s catch, which must still clear the
    // `restarting` flag (catch-then-finally) or watching wedges forever.
    const notify = vi.fn((level: string) => {
      if (level === "success") throw new Error("EPIPE");
    });
    const h = makeHarness({ notify });
    started(h);

    h.supervisor.request();
    await vi.waitFor(() => expect(h.messages("error")).toEqual(["Restart failed: EPIPE"]));

    // Watching must still work: a later request rebuilds rather than queueing
    // behind a `restarting` flag nothing will ever clear.
    h.supervisor.request();
    await settled(h, 2);
  });
});
