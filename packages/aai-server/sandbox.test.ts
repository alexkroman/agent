// Copyright 2025 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "./_sleep.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { resolveSandbox } from "./sandbox-resolve.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestStore } from "./test-utils.ts";

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

const TEST_AGENT_CONFIG: IsolateConfig = {
  name: "test-agent",
  systemPrompt: "You are a test agent",
  greeting: "Hello!",
  maxSteps: 3,
  toolSchemas: [],
  builtinTools: [],
};

function makeSandboxOptions(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workerCode: 'export default { name: "test" };',
    env: { AAI_ENV_TEST: "1" },
    slug: "test-agent",
    version: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
        workerCode: opts.workerCode,
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
      expect(console.error).toHaveBeenCalledWith(
        "Sandbox VM failed to start",
        expect.objectContaining({ slug: "test-agent" }),
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
        agentConfig: TEST_AGENT_CONFIG,
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
      // The slot itself stays registered for the rebuild.
      expect(deps.slots.has("broken")).toBe(true);
    });

    it("does not detach a replacement sandbox installed after the failure", async () => {
      mockSpawnAgentServer.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
      const deps = await seedAgent("raced");

      await resolveSandbox("raced", deps);
      // A deploy replaces the slot's sandbox before the failure callback runs.
      const replacement = { shutdown: vi.fn().mockResolvedValue(undefined) };
      const slot = deps.slots.get("raced");
      if (!slot) throw new Error("slot missing");
      slot.sandbox = replacement;

      await vi.waitFor(() => {
        expect(console.error).toHaveBeenCalledWith(
          "Sandbox VM failed to start",
          expect.objectContaining({ slug: "raced" }),
        );
      });
      // Let the identity-checked detach (queued under the slug lock) settle.
      await sleep(0);

      expect(deps.slots.get("raced")?.sandbox).toBe(replacement);
      expect(replacement.shutdown).not.toHaveBeenCalled();
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
