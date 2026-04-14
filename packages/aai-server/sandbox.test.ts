// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createTestStorage } from "./test-utils.ts";

// ── Mock sandbox-vm ──────────────────────────────────────────────────────────
// vi.mock factory is hoisted, so we cannot reference top-level variables.
// Instead, use vi.hoisted to create the mock objects.

const { mockConn, mockShutdown, mockCreateSandboxVm, capturedExecuteTool } = vi.hoisted(() => {
  const mockConn: NdjsonConnection = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  };
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  const mockCreateSandboxVm = vi.fn().mockResolvedValue({
    conn: mockConn,
    shutdown: mockShutdown,
  });
  /** Captures the `executeTool` function passed to `createRuntime` by `createSandbox`. */
  const capturedExecuteTool: {
    current: import("@alexkroman1/aai/runtime").ExecuteTool | null;
  } = { current: null };
  return { mockConn, mockShutdown, mockCreateSandboxVm, capturedExecuteTool };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sandbox-vm.ts")>();
  return {
    ...orig,
    createSandboxVm: mockCreateSandboxVm,
  };
});

// ── Mock createRuntime to capture executeTool arg ───────────────────────────

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      capturedExecuteTool.current = opts.executeTool ?? null;
      return orig.createRuntime(opts);
    },
  };
});

// ── Mock ssrf to avoid real URL validation ───────────────────────────────────

vi.mock("./ssrf.ts", () => ({
  ssrfSafeFetch: vi.fn(
    async (url: string, init: RequestInit, underlyingFetch: typeof globalThis.fetch) =>
      underlyingFetch(url, init),
  ),
}));

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
    storage: createTestStorage(),
    slug: "test-agent",
    agentConfig: TEST_AGENT_CONFIG,
    ...overrides,
  };
}

/** Create a deferred promise that can be resolved/rejected externally. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a sandbox and returns a runtime with expected shape", async () => {
    const sandbox = createSandbox(makeSandboxOptions());
    expect(sandbox).toBeDefined();
    expect(typeof sandbox.startSession).toBe("function");
    expect(typeof sandbox.shutdown).toBe("function");
    expect(sandbox.readyConfig).toBeDefined();
    await sandbox.shutdown();
  });

  it("passes correct options to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const opts = makeSandboxOptions();

    const sandbox = createSandbox(opts);

    expect(createSandboxVm).toHaveBeenCalledOnce();
    expect(createSandboxVm).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "test-agent",
        workerCode: opts.workerCode,
        env: opts.env,
        kvStorage: opts.storage,
        kvPrefix: expect.stringContaining("test-agent"),
      }),
    );
    await sandbox.shutdown();
  });

  it("registers client/send notification handler on the connection after VM is ready", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    // Wait for the vmReady .then() to fire
    await vi.waitFor(() => {
      expect(mockConn.onNotification).toHaveBeenCalledWith("client/send", expect.any(Function));
    });
    await sandbox.shutdown();
  });

  it("shutdown cleans up sandbox handle and agent runtime", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    await sandbox.shutdown();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("logs sandbox initializing with slug and agent name", () => {
    const infoSpy = vi.spyOn(console, "info");

    const sandbox = createSandbox(makeSandboxOptions());

    expect(infoSpy).toHaveBeenCalledWith("Sandbox initializing", {
      slug: "test-agent",
      agent: "test-agent",
    });
    // Cleanup: shutdown in background (fire-and-forget since test doesn't need it)
    void sandbox.shutdown();
  });

  it("uses agent config from options for runtime creation", async () => {
    const customConfig: IsolateConfig = {
      name: "custom-agent",
      systemPrompt: "Custom prompt",
      greeting: "Hi there",
      maxSteps: 10,
      toolSchemas: [
        {
          name: "my_tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      ],
      builtinTools: [],
    };

    const sandbox = createSandbox(makeSandboxOptions({ agentConfig: customConfig }));

    expect(sandbox).toBeDefined();
    expect(sandbox.readyConfig).toBeDefined();
    await sandbox.shutdown();
  });

  it("startSession is a wrapped function (not the raw runtime version)", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    // startSession should be defined and callable
    expect(typeof sandbox.startSession).toBe("function");
    // It should be the wrapper, not the original — name check confirms wrapping
    expect(sandbox.startSession.name).toBe("startSessionWithCleanup");
    await sandbox.shutdown();
  });

  it("passes harnessPath from GUEST_HARNESS_PATH env var to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");

    const originalEnv = process.env.GUEST_HARNESS_PATH;
    process.env.GUEST_HARNESS_PATH = "/custom/harness.mjs";

    try {
      const sandbox = createSandbox(makeSandboxOptions());

      expect(createSandboxVm).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessPath: "/custom/harness.mjs",
        }),
      );
      await sandbox.shutdown();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.GUEST_HARNESS_PATH;
      } else {
        process.env.GUEST_HARNESS_PATH = originalEnv;
      }
    }
  });

  it("passes kvPrefix derived from slug to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");

    const sandbox = createSandbox(makeSandboxOptions({ slug: "my-custom-agent" }));

    expect(createSandboxVm).toHaveBeenCalledWith(
      expect.objectContaining({
        kvPrefix: "agents/my-custom-agent/kv",
      }),
    );
    await sandbox.shutdown();
  });

  // ── Lazy VM initialization tests ──────────────────────────────────────────

  it("returns sandbox immediately before VM is ready", () => {
    const d = deferred<{ conn: NdjsonConnection; shutdown: () => Promise<void> }>();
    mockCreateSandboxVm.mockReturnValueOnce(d.promise);

    // createSandbox returns synchronously even though VM is still pending
    const sandbox = createSandbox(makeSandboxOptions());

    expect(sandbox).toBeDefined();
    expect(typeof sandbox.startSession).toBe("function");
    expect(typeof sandbox.shutdown).toBe("function");
    expect(sandbox.readyConfig).toBeDefined();

    // Resolve the VM to clean up
    d.resolve({ conn: mockConn, shutdown: mockShutdown });
    void sandbox.shutdown();
  });

  it("shutdown waits for VM before cleaning up", async () => {
    const d = deferred<{ conn: NdjsonConnection; shutdown: () => Promise<void> }>();
    mockCreateSandboxVm.mockReturnValueOnce(d.promise);

    const sandbox = createSandbox(makeSandboxOptions());

    // Start shutdown — it will block on vmReady
    const shutdownDone = sandbox.shutdown();

    // mockShutdown should not have been called yet (VM is still pending)
    expect(mockShutdown).not.toHaveBeenCalled();

    // Now resolve the VM
    d.resolve({ conn: mockConn, shutdown: mockShutdown });

    await shutdownDone;

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("shutdown succeeds even when VM failed to start", async () => {
    mockCreateSandboxVm.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));

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

  it("executeTool returns toolError when VM fails to start", async () => {
    mockCreateSandboxVm.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));

    createSandbox(makeSandboxOptions());

    // Wait for the VM rejection to propagate
    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        "Sandbox VM failed to start",
        expect.objectContaining({ slug: "test-agent" }),
      );
    });

    // The createRuntime mock captures the executeTool function passed by createSandbox
    if (!capturedExecuteTool.current) throw new Error("executeTool was not captured");
    const executeTool = capturedExecuteTool.current;

    const result = await executeTool("some_tool", { arg: "value" }, "session-1", []);

    // Should return a toolError JSON string, not throw
    expect(result).toBe(JSON.stringify({ error: "Sandbox failed to start: VM spawn failed" }));
  });
});
