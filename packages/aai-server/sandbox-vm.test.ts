// Copyright 2025 the AAI authors. MIT license.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./vsock.ts", () => ({
  createRpcChannel: vi.fn(),
}));

vi.mock("./firecracker.ts", () => ({
  isFirecrackerAvailable: vi.fn(),
  startVm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  fork: vi.fn(),
}));

vi.mock("node:net", () => ({
  connect: vi.fn(),
}));

import type { Storage } from "unstorage";
import { _internals } from "./sandbox-vm.ts";

const { handleKvRequest } = _internals;

// ── handleKvRequest ──────────────────────────────────────────────────────────

function createMockStorage(): Storage {
  const data = new Map<string, unknown>();
  return {
    getItem: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    setItem: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    // Storage interface stubs — not used by handleKvRequest
    hasItem: vi.fn(() => Promise.resolve(false)),
    getKeys: vi.fn(() => Promise.resolve([])),
    getMeta: vi.fn(() => Promise.resolve({})),
    clear: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: stub unwatch callback
    watch: vi.fn(() => Promise.resolve(() => {})),
  } as unknown as Storage;
}

describe("handleKvRequest", () => {
  let storage: Storage;
  const prefix = "agents/test-slug/kv";

  beforeEach(() => {
    storage = createMockStorage();
  });

  it("handles get operation", async () => {
    (storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue("hello");

    const result = await handleKvRequest(
      { type: "kv", op: "get", key: "mykey", id: "g:1" },
      storage,
      prefix,
    );

    expect(storage.getItem).toHaveBeenCalledWith(`${prefix}:mykey`);
    expect(result).toEqual({ value: "hello" });
  });

  it("handles get returning null for missing keys", async () => {
    (storage.getItem as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await handleKvRequest(
      { type: "kv", op: "get", key: "missing", id: "g:2" },
      storage,
      prefix,
    );

    expect(result).toEqual({ value: null });
  });

  it("handles set operation", async () => {
    const result = await handleKvRequest(
      { type: "kv", op: "set", key: "mykey", value: "world", id: "g:3" },
      storage,
      prefix,
    );

    expect(storage.setItem).toHaveBeenCalledWith(`${prefix}:mykey`, "world");
    expect(result).toEqual({ ok: true });
  });

  it("handles del operation", async () => {
    const result = await handleKvRequest(
      { type: "kv", op: "del", key: "mykey", id: "g:4" },
      storage,
      prefix,
    );

    expect(storage.removeItem).toHaveBeenCalledWith(`${prefix}:mykey`);
    expect(result).toEqual({ ok: true });
  });

  it("handles mget operation", async () => {
    const getItem = storage.getItem as ReturnType<typeof vi.fn>;
    getItem.mockImplementation((key: string) => {
      if (key === `${prefix}:a`) return Promise.resolve("val-a");
      if (key === `${prefix}:b`) return Promise.resolve("val-b");
      return Promise.resolve(null);
    });

    const result = await handleKvRequest(
      { type: "kv", op: "mget", keys: ["a", "b", "c"], id: "g:5" },
      storage,
      prefix,
    );

    expect(getItem).toHaveBeenCalledWith(`${prefix}:a`);
    expect(getItem).toHaveBeenCalledWith(`${prefix}:b`);
    expect(getItem).toHaveBeenCalledWith(`${prefix}:c`);
    expect(result).toEqual({ values: ["val-a", "val-b", null] });
  });

  it("handles mget with empty keys array", async () => {
    const result = await handleKvRequest(
      { type: "kv", op: "mget", keys: [], id: "g:6" },
      storage,
      prefix,
    );

    expect(result).toEqual({ values: [] });
  });

  it("returns error for unknown operation", async () => {
    const result = await handleKvRequest(
      { type: "kv", op: "unknown", key: "x", id: "g:7" },
      storage,
      prefix,
    );

    expect(result).toEqual({ error: "Unknown KV op: unknown" });
  });
});

// ── createSandboxVm factory ──────────────────────────────────────────────────

describe("createSandboxVm", () => {
  it("returns a SandboxHandle (dev mode on non-Linux)", async () => {
    // On macOS / non-Linux, createSandboxVm should use createDevSandbox.
    // Since child_process.fork is mocked, we need to set up the mocks properly.
    const { createRpcChannel } = await import("./vsock.ts");
    const { fork } = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    // Create mock child process
    const mockChild = new EventEmitter() as ReturnType<typeof import("node:child_process").fork>;
    const mockStdout = new PassThrough();
    const mockStdin = new PassThrough();
    Object.assign(mockChild, {
      stdout: mockStdout,
      stdin: mockStdin,
      pid: 12_345,
      kill: vi.fn(() => true),
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
    });

    (fork as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    // Mock RPC channel
    const mockChannel = {
      request: vi.fn().mockResolvedValue({ ok: true }),
      onRequest: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    };
    (createRpcChannel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const mockStorage = createMockStorage();

    const { createDevSandbox } = await import("./sandbox-vm.ts");
    const handle = await createDevSandbox({
      slug: "test-agent",
      workerCode: "console.log('hello')",
      agentEnv: { FOO: "bar" },
      harnessPath: "/tmp/harness.js",
      kvStorage: mockStorage,
      kvPrefix: "agents/test-agent/kv",
    });

    expect(handle).toBeDefined();
    expect(handle.request).toBeTypeOf("function");
    expect(handle.shutdown).toBeTypeOf("function");

    // Verify bundle message was sent
    expect(mockChannel.request).toHaveBeenCalledWith(
      { type: "bundle", code: "console.log('hello')", env: { FOO: "bar" } },
      { timeout: expect.any(Number) },
    );

    // Verify KV handler was registered
    expect(mockChannel.onRequest).toHaveBeenCalledWith("kv", expect.any(Function));
  });

  it("SandboxHandle.request delegates to the RPC channel", async () => {
    const { createRpcChannel } = await import("./vsock.ts");
    const { fork } = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const mockChild = new EventEmitter() as ReturnType<typeof import("node:child_process").fork>;
    Object.assign(mockChild, {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      pid: 12_345,
      kill: vi.fn(() => true),
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
    });

    (fork as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const mockChannel = {
      request: vi.fn().mockResolvedValue({ ok: true, result: "tool-output" }),
      onRequest: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    };
    (createRpcChannel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const { createDevSandbox } = await import("./sandbox-vm.ts");
    const handle = await createDevSandbox({
      slug: "test",
      workerCode: "",
      agentEnv: {},
      harnessPath: "/tmp/harness.js",
    });

    // Reset call count (bundle message already used one call)
    mockChannel.request.mockClear();
    mockChannel.request.mockResolvedValue({ result: "tool-output" });

    const response = await handle.request({ type: "tool", name: "greet" }, { timeout: 5000 });
    expect(response).toEqual({ result: "tool-output" });
    expect(mockChannel.request).toHaveBeenCalledWith(
      { type: "tool", name: "greet" },
      { timeout: 5000 },
    );
  });

  it("SandboxHandle.shutdown closes channel and kills child", async () => {
    const { createRpcChannel } = await import("./vsock.ts");
    const { fork } = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const mockChild = new EventEmitter() as ReturnType<typeof import("node:child_process").fork>;
    const killFn = vi.fn(() => {
      // Simulate child exiting after kill
      setImmediate(() => mockChild.emit("exit", 0, "SIGTERM"));
      return true;
    });
    Object.assign(mockChild, {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      pid: 12_345,
      kill: killFn,
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
    });

    (fork as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const mockChannel = {
      request: vi.fn().mockResolvedValue({ ok: true }),
      onRequest: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    };
    (createRpcChannel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const { createDevSandbox } = await import("./sandbox-vm.ts");
    const handle = await createDevSandbox({
      slug: "test",
      workerCode: "",
      agentEnv: {},
      harnessPath: "/tmp/harness.js",
    });

    await handle.shutdown();

    expect(mockChannel.close).toHaveBeenCalled();
    expect(killFn).toHaveBeenCalledWith("SIGTERM");
  });

  it("throws when harnessPath is missing for dev sandbox", async () => {
    const { createDevSandbox } = await import("./sandbox-vm.ts");

    await expect(
      createDevSandbox({
        slug: "test",
        workerCode: "",
        agentEnv: {},
      }),
    ).rejects.toThrow("harnessPath is required");
  });

  it("createSandboxVm routes to dev sandbox on non-Linux", async () => {
    const { isFirecrackerAvailable } = await import("./firecracker.ts");
    (isFirecrackerAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { createRpcChannel } = await import("./vsock.ts");
    const { fork } = await import("node:child_process");
    const { EventEmitter } = await import("node:events");
    const { PassThrough } = await import("node:stream");

    const mockChild = new EventEmitter() as ReturnType<typeof import("node:child_process").fork>;
    Object.assign(mockChild, {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      pid: 12_345,
      kill: vi.fn(() => true),
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
    });

    (fork as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    const mockChannel = {
      request: vi.fn().mockResolvedValue({ ok: true }),
      onRequest: vi.fn(),
      notify: vi.fn(),
      close: vi.fn(),
    };
    (createRpcChannel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const handle = await createSandboxVm({
      slug: "test",
      workerCode: "",
      agentEnv: {},
      harnessPath: "/tmp/harness.js",
    });

    // Should succeed via dev sandbox path (not throw Firecracker errors)
    expect(handle).toBeDefined();
    expect(handle.request).toBeTypeOf("function");
    expect(handle.shutdown).toBeTypeOf("function");
  });
});
