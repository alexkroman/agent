// Copyright 2025 the AAI authors. MIT license.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./gvisor.ts", () => ({
  isGvisorAvailable: vi.fn(),
  createGvisorSandbox: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("./ndjson-transport.ts", () => ({
  createNdjsonConnection: vi.fn(),
}));

import type { Storage } from "unstorage";

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
    hasItem: vi.fn(() => Promise.resolve(false)),
    getKeys: vi.fn(() => Promise.resolve([])),
    getMeta: vi.fn(() => Promise.resolve({})),
    clear: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: stub unwatch callback
    watch: vi.fn(() => Promise.resolve(() => {})),
  } as unknown as Storage;
}

function createMockConnection() {
  return {
    listen: vi.fn(),
    sendRequest: vi.fn().mockResolvedValue({ ok: true }),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
  };
}

// ── configureSandbox ─────────────────────────────────────────────────────────

describe("configureSandbox", () => {
  let mockConn: ReturnType<typeof createMockConnection>;
  const cleanupFn = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    mockConn = createMockConnection();
    cleanupFn.mockClear();
  });

  it("sends bundle/load request with code and env", async () => {
    const { _internals } = await import("./sandbox-vm.ts");

    const handle = await _internals.configureSandbox(
      // biome-ignore lint/suspicious/noExplicitAny: mock connection object
      mockConn as any,
      {
        slug: "test-agent",
        workerCode: "console.log('hello')",
        env: { FOO: "bar" },
        harnessPath: "/tmp/harness.js",
      },
      cleanupFn,
    );

    expect(mockConn.listen).toHaveBeenCalled();
    expect(mockConn.sendRequest).toHaveBeenCalledWith("bundle/load", {
      code: "console.log('hello')",
      env: { FOO: "bar" },
    });
    expect(handle.conn).toBe(mockConn);
  });

  it("registers KV handlers when storage is provided", async () => {
    const { _internals } = await import("./sandbox-vm.ts");
    const mockStorage = createMockStorage();

    await _internals.configureSandbox(
      // biome-ignore lint/suspicious/noExplicitAny: mock connection object
      mockConn as any,
      {
        slug: "test-agent",
        workerCode: "",
        env: {},
        harnessPath: "/tmp/harness.js",
        kvStorage: mockStorage,
        kvPrefix: "agents/test-agent/kv",
      },
      cleanupFn,
    );

    // Should register kv/get, kv/set, kv/del handlers
    expect(mockConn.onRequest).toHaveBeenCalledWith("kv/get", expect.any(Function));
    expect(mockConn.onRequest).toHaveBeenCalledWith("kv/set", expect.any(Function));
    expect(mockConn.onRequest).toHaveBeenCalledWith("kv/del", expect.any(Function));
  });

  it("does not register KV handlers when storage is not provided", async () => {
    const { _internals } = await import("./sandbox-vm.ts");

    await _internals.configureSandbox(
      // biome-ignore lint/suspicious/noExplicitAny: mock connection object
      mockConn as any,
      {
        slug: "test-agent",
        workerCode: "",
        env: {},
        harnessPath: "/tmp/harness.js",
      },
      cleanupFn,
    );

    expect(mockConn.onRequest).not.toHaveBeenCalled();
  });

  it("shutdown sends notification and disposes connection", async () => {
    const { _internals } = await import("./sandbox-vm.ts");

    const handle = await _internals.configureSandbox(
      // biome-ignore lint/suspicious/noExplicitAny: mock connection object
      mockConn as any,
      {
        slug: "test-agent",
        workerCode: "",
        env: {},
        harnessPath: "/tmp/harness.js",
      },
      cleanupFn,
    );

    await handle.shutdown();

    expect(mockConn.sendNotification).toHaveBeenCalledWith("shutdown");
    expect(mockConn.dispose).toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalled();
  });
});

// ── createSandboxVm factory ──────────────────────────────────────────────────

describe("createSandboxVm", () => {
  it("routes to dev sandbox when gVisor is unavailable", async () => {
    const { isGvisorAvailable } = await import("./gvisor.ts");
    (isGvisorAvailable as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { spawn } = await import("node:child_process");
    const { createNdjsonConnection } = await import("./ndjson-transport.ts");

    // Create mock child process
    const mockChild = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
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

    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    // Mock the NDJSON connection
    const mockConn = createMockConnection();
    (createNdjsonConnection as ReturnType<typeof vi.fn>).mockReturnValue(mockConn);

    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const handle = await createSandboxVm({
      slug: "test",
      workerCode: "",
      env: {},
      harnessPath: "/tmp/harness.ts",
    });

    // Should succeed via dev sandbox path
    expect(handle).toBeDefined();
    expect(handle.conn).toBe(mockConn);
    expect(handle.shutdown).toBeTypeOf("function");

    // Verify spawn was called with Deno args (dev mode path)
    expect(spawn).toHaveBeenCalledWith(
      "deno",
      ["run", "--allow-env", "--no-prompt", "/tmp/harness.ts"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "inherit"] }),
    );
  });

  it("routes to gVisor sandbox when available", async () => {
    const { isGvisorAvailable, createGvisorSandbox } = await import("./gvisor.ts");
    const { createNdjsonConnection } = await import("./ndjson-transport.ts");

    (isGvisorAvailable as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Mock gVisor sandbox
    // biome-ignore lint/suspicious/noExplicitAny: mock child process object
    const mockGvisorChild = new EventEmitter() as any;
    Object.assign(mockGvisorChild, {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      pid: 99_999,
      kill: vi.fn(() => true),
      exitCode: null,
    });

    const mockCleanup = vi.fn().mockResolvedValue(undefined);
    (createGvisorSandbox as ReturnType<typeof vi.fn>).mockReturnValue({
      process: mockGvisorChild,
      cleanup: mockCleanup,
    });

    const mockConn = createMockConnection();
    (createNdjsonConnection as ReturnType<typeof vi.fn>).mockReturnValue(mockConn);

    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const handle = await createSandboxVm({
      slug: "test",
      workerCode: "",
      env: {},
      harnessPath: "/tmp/harness.ts",
    });

    expect(handle).toBeDefined();
    expect(handle.conn).toBe(mockConn);
    expect(createGvisorSandbox).toHaveBeenCalledWith({
      slug: "test",
      harnessPath: "/tmp/harness.ts",
    });
  });
});
