// Copyright 2025 the AAI authors. MIT license.

import { sleep } from "@alexkroman1/aai/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inlineWorker } from "./_sandbox-vm-test-utils.ts";
import { SANDBOX_TEARDOWN_READY_MS } from "./constants.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { captureLogs, createTestStore } from "./test-utils.ts";

// ── Mock sandbox-vm ──────────────────────────────────────────────────────────
// vi.mock factory is hoisted, so we cannot reference top-level variables.
// Instead, use vi.hoisted to create the mock objects.

const { mockDrain, mockShutdown, mockOnExit, mockSpawnAgentServer } = vi.hoisted(() => {
  const mockDrain = vi.fn().mockResolvedValue(undefined);
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  const mockOnExit = vi.fn();
  const mockSpawnAgentServer = vi.fn().mockResolvedValue({
    sessionUrl: "wss://tunnel.test:443/websocket",
    drain: mockDrain,
    shutdown: mockShutdown,
    onExit: mockOnExit,
    alive: () => true,
  });
  return { mockDrain, mockShutdown, mockOnExit, mockSpawnAgentServer };
});

/** Fire the exit callback `createSandbox` registered on the guest handle. */
function fireGuestExit(): void {
  const cb = mockOnExit.mock.calls.at(-1)?.[0] as (() => void) | undefined;
  if (!cb) throw new Error("createSandbox never registered an exit listener");
  cb();
}

vi.mock("./sandbox-vm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sandbox-vm.ts")>();
  return {
    ...orig,
    spawnAgentServer: mockSpawnAgentServer,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSandboxOptions(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    worker: inlineWorker(),
    env: { AAI_ENV_TEST: "1" },
    slug: "test-agent",
    version: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSandbox", () => {
  const logs = captureLogs();
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a sandbox with the server-handle shape", async () => {
    const sandbox = createSandbox(makeSandboxOptions());
    expect(typeof sandbox.sessionUrl).toBe("function");
    expect(typeof sandbox.drain).toBe("function");
    expect(typeof sandbox.shutdown).toBe("function");
    await sandbox.shutdown();
  });

  it("passes correct options to spawnAgentServer", async () => {
    const opts = makeSandboxOptions({ imageTag: "aai-guest-harness:abcd1234" });

    const sandbox = createSandbox(opts);

    expect(mockSpawnAgentServer).toHaveBeenCalledOnce();
    expect(mockSpawnAgentServer).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "test-agent",
        worker: opts.worker,
        env: opts.env,
        imageTag: "aai-guest-harness:abcd1234",
      }),
    );
    await sandbox.shutdown();
  });

  it("sessionUrl resolves the handle's tunnel session endpoint", async () => {
    const sandbox = createSandbox(makeSandboxOptions());
    await expect(sandbox.sessionUrl()).resolves.toBe("wss://tunnel.test:443/websocket");
    await sandbox.shutdown();
  });

  it("sessionUrl rejects when the VM failed to start", async () => {
    mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
    const sandbox = createSandbox(makeSandboxOptions());
    await expect(sandbox.sessionUrl()).rejects.toThrow("VM spawn failed");
    await sandbox.shutdown();
  });

  it("shutdown cleans up the sandbox handle", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    await sandbox.shutdown();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  describe("drain", () => {
    it("forwards to the guest's manage surface", async () => {
      const sandbox = createSandbox(makeSandboxOptions());
      await sandbox.drain();
      expect(mockDrain).toHaveBeenCalledOnce();
      await sandbox.shutdown();
    });

    it("forwards the drain deadline to the guest", async () => {
      const sandbox = createSandbox(makeSandboxOptions());
      await sandbox.drain(60_000);
      expect(mockDrain).toHaveBeenCalledWith(60_000);
      await sandbox.shutdown();
    });

    it("propagates an unreachable guest — retirement's signal to terminate", async () => {
      mockDrain.mockRejectedValueOnce(new Error("guest gone"));
      const sandbox = createSandbox(makeSandboxOptions());
      await expect(sandbox.drain()).rejects.toThrow("guest gone");
      await sandbox.shutdown();
    });
  });

  // ── Teardown readiness budget ─────────────────────────────────────────────
  //
  // Reaching a guest needs a handle, so drain/shutdown go through the spawn's
  // readiness promise — which carries the BOOT budget (120s). Correct for a
  // broker; wrong for a process that is exiting, where it blocks shutdown for
  // two minutes on a guest that has never served a session.
  //
  // Giving up at the budget is NOT walking away, though it used to be: a boot
  // this outlasts is TERMINATED through the kill the backend published at
  // `onSpawned`. The old empty `catch` left it "to the guest's own idle
  // self-exit", which a DELETE cannot afford — it has already dropped the app's
  // Postgres role and database, so the abandoned guest boots and fails `28P01`
  // against credentials that were valid when its env was composed.
  describe("teardown while still booting", () => {
    /** A spawn that never comes back — a guest stuck mid-boot. */
    function neverBoots(): void {
      mockSpawnAgentServer.mockReturnValueOnce(new Promise(() => undefined));
    }

    /**
     * The same stuck boot, having published its kill the way both real backends
     * do (`BackendAgentSpawn.onSpawned`) — i.e. the shape a mid-boot teardown
     * actually meets in production.
     */
    function neverBootsButKillable(terminate: () => Promise<void>): void {
      mockSpawnAgentServer.mockImplementationOnce(
        (opts: { onSpawned?: ((t: () => Promise<void>) => void) | undefined }) => {
          opts.onSpawned?.(terminate);
          return new Promise(() => undefined);
        },
      );
    }

    it("shutdown terminates a boot it outlasted instead of abandoning it", async () => {
      vi.useFakeTimers();
      try {
        const terminate = vi.fn().mockResolvedValue(undefined);
        neverBootsButKillable(terminate);
        const sandbox = createSandbox(makeSandboxOptions());

        const settled = vi.fn();
        void sandbox.shutdown().then(settled);
        await vi.advanceTimersByTimeAsync(SANDBOX_TEARDOWN_READY_MS);

        expect(terminate).toHaveBeenCalledTimes(1);
        expect(settled).toHaveBeenCalled();
        // The graceful path was never available — there was no guest to ask.
        expect(mockShutdown).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // The kill is the FALLBACK, not the mechanism: a guest that is ready still
    // gets to refuse new sessions and exit on its own, which is what keeps a
    // redeploy from cutting the calls a retirement is draining.
    it("shutdown asks a ready guest rather than terminating its sandbox", async () => {
      const terminate = vi.fn().mockResolvedValue(undefined);
      mockSpawnAgentServer.mockImplementationOnce(
        (opts: { onSpawned?: ((t: () => Promise<void>) => void) | undefined }) => {
          opts.onSpawned?.(terminate);
          return Promise.resolve({
            sessionUrl: "wss://tunnel.test:443/websocket",
            drain: mockDrain,
            shutdown: mockShutdown,
            onExit: mockOnExit,
            alive: () => true,
          });
        },
      );
      const sandbox = createSandbox(makeSandboxOptions());

      await sandbox.shutdown();

      expect(mockShutdown).toHaveBeenCalledTimes(1);
      expect(terminate).not.toHaveBeenCalled();
    });

    // Every caller of `shutdown` is already tearing down, so an undeliverable
    // kill must not become a thrown teardown — `terminateSlot` would only log
    // it, and there is nothing else this process could still do about it.
    it("shutdown resolves when the mid-boot terminate itself fails", async () => {
      vi.useFakeTimers();
      try {
        neverBootsButKillable(() => Promise.reject(new Error("control plane down")));
        const sandbox = createSandbox(makeSandboxOptions());

        const settled = vi.fn();
        const rejected = vi.fn();
        void sandbox.shutdown().then(settled, rejected);
        await vi.advanceTimersByTimeAsync(SANDBOX_TEARDOWN_READY_MS);

        expect(settled).toHaveBeenCalled();
        expect(rejected).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // Nothing here AWAITS the teardown promise: against an unbounded wait that
    // would hang to the suite timeout instead of failing, and a 20s red test
    // that names nothing is barely better than a green one. Recording the
    // settlement on a spy fails on the spot, and says which side settled.
    it("drain gives up at the budget instead of waiting out the boot", async () => {
      vi.useFakeTimers();
      try {
        neverBoots();
        const sandbox = createSandbox(makeSandboxOptions());

        const rejected = vi.fn();
        void sandbox.drain().catch(rejected);
        await vi.advanceTimersByTimeAsync(SANDBOX_TEARDOWN_READY_MS);

        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("still booting") }),
        );
        // The rejection is retirement's signal to terminate rather than trust
        // a guest it never reached.
        expect(mockDrain).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    // `retireSandbox` calls drain() and then, on its rejection, shutdown().
    // A fresh timer per call would let one stuck sandbox spend the budget
    // twice on its way out — and the shutdown handler's own deadline is sized
    // against one.
    it("spends the budget once across drain and shutdown", async () => {
      vi.useFakeTimers();
      try {
        neverBoots();
        const sandbox = createSandbox(makeSandboxOptions());

        const drainRejected = vi.fn();
        void sandbox.drain().catch(drainRejected);
        await vi.advanceTimersByTimeAsync(SANDBOX_TEARDOWN_READY_MS);
        expect(drainRejected).toHaveBeenCalled();

        // The budget is now spent. A second one would leave this pending —
        // recorded on a spy, not awaited, for the reason above.
        const shutdownSettled = vi.fn();
        void sandbox.shutdown().then(shutdownSettled);
        await vi.advanceTimersByTimeAsync(0);

        expect(shutdownSettled).toHaveBeenCalled();
        expect(mockShutdown).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("passes harnessPath from GUEST_HARNESS_PATH env var to spawnAgentServer", async () => {
    vi.stubEnv("GUEST_HARNESS_PATH", "/custom/harness.mjs");
    const sandbox = createSandbox(makeSandboxOptions());

    expect(mockSpawnAgentServer).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessPath: "/custom/harness.mjs",
      }),
    );
    await sandbox.shutdown();
  });

  // ── Lazy VM initialization tests ──────────────────────────────────────────

  it("returns sandbox immediately before VM is ready", () => {
    const d = Promise.withResolvers<{
      sessionUrl: string;
      shutdown: () => Promise<void>;
    }>();
    mockSpawnAgentServer.mockReturnValueOnce(d.promise);

    // createSandbox returns synchronously even though VM is still pending
    const sandbox = createSandbox(makeSandboxOptions());

    expect(typeof sandbox.sessionUrl).toBe("function");
    expect(typeof sandbox.shutdown).toBe("function");

    // Resolve the VM to clean up
    d.resolve({ sessionUrl: "wss://t/websocket", shutdown: mockShutdown });
    void sandbox.shutdown();
  });

  it("shutdown waits for VM before cleaning up", async () => {
    const d = Promise.withResolvers<{
      sessionUrl: string;
      shutdown: () => Promise<void>;
    }>();
    mockSpawnAgentServer.mockReturnValueOnce(d.promise);

    const sandbox = createSandbox(makeSandboxOptions());

    // Start shutdown — it will block on vmReady
    const shutdownDone = sandbox.shutdown();

    // mockShutdown should not have been called yet (VM is still pending)
    expect(mockShutdown).not.toHaveBeenCalled();

    // Now resolve the VM
    d.resolve({ sessionUrl: "wss://t/websocket", shutdown: mockShutdown });

    await shutdownDone;

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("shutdown succeeds even when VM failed to start", async () => {
    mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));

    const sandbox = createSandbox(makeSandboxOptions());

    // Wait for the rejection handler (.catch) to run
    await vi.waitFor(() => {
      expect(logs.all()).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "sandbox VM failed to start",
          ctx: expect.objectContaining({ slug: "test-agent" }),
        }),
      );
    });

    // shutdown should resolve without throwing
    await expect(sandbox.shutdown()).resolves.toBeUndefined();
  });

  it("invokes onSandboxLost when the VM fails to start", async () => {
    mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
    const onSandboxLost = vi.fn();

    const sandbox = createSandbox(makeSandboxOptions({ onSandboxLost }));

    await vi.waitFor(() => {
      expect(onSandboxLost).toHaveBeenCalledOnce();
    });
    await sandbox.shutdown();
  });

  // ── Guest death AFTER a successful start ─────────────────────────────────
  // The failure this closes: nothing subscribed to the harness's exit, so a
  // guest killed mid-life stayed installed in its slot and the broker kept
  // handing its dead sessionUrl to every new client (measured: 182s).

  describe("guest exit after a successful start", () => {
    it("reports alive() true while the guest is running", async () => {
      const sandbox = createSandbox(makeSandboxOptions());
      await sandbox.sessionUrl();

      expect(sandbox.alive()).toBe(true);
      await sandbox.shutdown();
    });

    it("reports alive() false and invokes onSandboxLost once the guest exits", async () => {
      const onSandboxLost = vi.fn();
      const sandbox = createSandbox(makeSandboxOptions({ onSandboxLost }));
      await sandbox.sessionUrl();

      fireGuestExit();

      expect(sandbox.alive()).toBe(false);
      expect(onSandboxLost).toHaveBeenCalledOnce();
      await sandbox.shutdown();
    });

    it("reports alive() true while the VM is still booting", () => {
      const d = Promise.withResolvers<never>();
      mockSpawnAgentServer.mockReturnValueOnce(d.promise);

      // Pending is not dead — a booting sandbox must not be torn down.
      const sandbox = createSandbox(makeSandboxOptions());

      expect(sandbox.alive()).toBe(true);
      d.reject(new Error("cleanup"));
    });

    it("reports alive() false when the VM failed to start", async () => {
      mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
      const sandbox = createSandbox(makeSandboxOptions());

      await vi.waitFor(() => {
        expect(sandbox.alive()).toBe(false);
      });
      await sandbox.shutdown();
    });

    it("notifies onSandboxLost only once when exit and failure both fire", async () => {
      const onSandboxLost = vi.fn();
      const sandbox = createSandbox(makeSandboxOptions({ onSandboxLost }));
      await sandbox.sessionUrl();

      fireGuestExit();
      fireGuestExit();

      expect(onSandboxLost).toHaveBeenCalledOnce();
      await sandbox.shutdown();
    });
  });

  // ── resolveSandbox: poisoned-sandbox detach (rejected vmReady) ────────────

  describe("resolveSandbox vmReady failure", () => {
    async function seedAgent(slug: string) {
      const store = createTestStore();
      await store.putAgent({
        slug,
        env: {},
        worker: 'export default { name: "t" };',
        clientFiles: {},
        credential_hashes: ["hash"],
      });
      return {
        slots: createSlotCache(),
        store,
      };
    }

    it("detaches the resident sandbox when its VM fails to start", async () => {
      mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
      const deps = await seedAgent("broken");

      const sandbox = await resolveSandbox("broken", deps);
      expect(sandbox).not.toBeNull();

      // The async vmReady rejection must detach the poisoned sandbox so the
      // next connection rebuilds it (live traffic would otherwise keep
      // clearing the idle timer forever). The detach may already have run by
      // the time resolveSandbox returns — its lock section queues right
      // behind the resolve's.
      await vi.waitFor(() => {
        expect(deps.slots.get("broken")?.sandbox).toBeUndefined();
      });
      // The empty SLOT goes too. It used to stay registered "for the rebuild",
      // but a rebuild needs nothing from it — `resolveSandbox` re-reads the row
      // either way and `rebuildSlot` claims a fresh slot when none exists — so
      // keeping it only grew the map by one shell per slug, forever.
      await vi.waitFor(() => {
        expect(deps.slots.has("broken")).toBe(false);
      });
      // And the slug still resolves: an empty slot was never the thing that
      // made it resolvable.
      const rebuilt = await resolveSandbox("broken", deps);
      expect(rebuilt).not.toBeNull();
      await rebuilt?.shutdown();
    });

    /**
     * The case that made the map grow without bound: an agent-mode guest
     * self-exiting after `AGENT_IDLE_EXIT_MS` is the NORMAL end of a
     * sandbox's life, not a failure — so on a long-lived replica
     * (`MIN_CONTAINERS=1` spans every deploy) every slug ever brokered left a
     * `{ slug }` shell behind. Same standard `_keyed-lock.ts` exists to keep,
     * and the one `rebuildSlot` already applies to a slug with no bundle.
     */
    it("drops the slot when an idle guest exits, not just its sandbox", async () => {
      const deps = await seedAgent("idle-exit");
      const sandbox = await resolveSandbox("idle-exit", deps);
      expect(sandbox).not.toBeNull();
      expect(deps.slots.has("idle-exit")).toBe(true);

      fireGuestExit();

      await vi.waitFor(() => {
        expect(deps.slots.has("idle-exit")).toBe(false);
      });
    });

    /**
     * The identity check in `buildSlotSandbox`'s detach: a sandbox that dies
     * AFTER a deploy already replaced it in the slot must take neither the
     * successor nor the slot with it.
     *
     * Driven off `fireGuestExit` rather than a failed spawn, because the
     * failed-spawn version could not actually stage what it described. Its
     * detach callback had already run by the time it installed the
     * "replacement", so the check it meant to exercise was never reached — the
     * assertion passed only because the emptied slot object stayed mapped and
     * could still be mutated. A guest exit is fired on demand, so the ordering
     * is stated rather than hoped for.
     */
    it("does not detach a replacement sandbox installed before the original died", async () => {
      const deps = await seedAgent("raced");
      const original = await resolveSandbox("raced", deps);
      expect(original).not.toBeNull();

      // A deploy swaps in a new sandbox while the original is still alive.
      const replacement = { shutdown: vi.fn().mockResolvedValue(undefined) };
      const slot = deps.slots.get("raced");
      if (!slot) throw new Error("slot missing");
      slot.sandbox = replacement;

      // Only NOW does the original's guest exit.
      fireGuestExit();
      await sleep(0);

      expect(deps.slots.get("raced")?.sandbox).toBe(replacement);
      expect(replacement.shutdown).not.toHaveBeenCalled();
      // And the slot survives — the delete is identity-checked too.
      expect(deps.slots.has("raced")).toBe(true);
    });

    it("rebuilds rather than re-serving a resident whose guest exited", async () => {
      const deps = await seedAgent("zombie");

      const first = await resolveSandbox("zombie", deps);
      expect(first).not.toBeNull();
      await first?.sessionUrl();

      // The guest dies under the host — the exact case that used to leave a
      // dead sessionUrl in the slot until idle eviction reclaimed it.
      fireGuestExit();
      expect(first?.alive()).toBe(false);

      const second = await resolveSandbox("zombie", deps);

      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      expect(second?.alive()).toBe(true);
    });
  });
});
