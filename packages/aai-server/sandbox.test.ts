// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { createSandbox, type SandboxOptions } from "./sandbox.ts";
import { createTestStorage } from "./test-utils.ts";

// ── Mock sandbox-vm ──────────────────────────────────────────────────────────
// vi.mock factory is hoisted, so we cannot reference top-level variables.
// Instead, use vi.hoisted to create the mock objects.

const { mockConn, mockShutdown } = vi.hoisted(() => {
  const mockConn: NdjsonConnection = {
    sendRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    listen: vi.fn(),
    dispose: vi.fn(),
  };
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  return { mockConn, mockShutdown };
});

vi.mock("./sandbox-vm.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./sandbox-vm.ts")>();
  return {
    ...orig,
    createSandboxVm: vi.fn().mockResolvedValue({
      conn: mockConn,
      shutdown: mockShutdown,
    }),
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a sandbox and returns a runtime with expected shape", async () => {
    const sandbox = await createSandbox(makeSandboxOptions());
    expect(sandbox).toBeDefined();
    expect(typeof sandbox.startSession).toBe("function");
    expect(typeof sandbox.shutdown).toBe("function");
    expect(sandbox.readyConfig).toBeDefined();
  });

  it("passes correct options to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const opts = makeSandboxOptions();

    await createSandbox(opts);

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
  });

  it("registers client/send notification handler on the connection", async () => {
    await createSandbox(makeSandboxOptions());

    expect(mockConn.onNotification).toHaveBeenCalledWith("client/send", expect.any(Function));
  });

  it("shutdown cleans up sandbox handle and agent runtime", async () => {
    const sandbox = await createSandbox(makeSandboxOptions());

    await sandbox.shutdown();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("logs sandbox initialization with slug and agent name", async () => {
    const infoSpy = vi.spyOn(console, "info");

    await createSandbox(makeSandboxOptions());

    expect(infoSpy).toHaveBeenCalledWith("Sandbox initialized", {
      slug: "test-agent",
      agent: "test-agent",
    });
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

    const sandbox = await createSandbox(makeSandboxOptions({ agentConfig: customConfig }));

    expect(sandbox).toBeDefined();
    expect(sandbox.readyConfig).toBeDefined();
  });

  it("startSession is a wrapped function (not the raw runtime version)", async () => {
    const sandbox = await createSandbox(makeSandboxOptions());

    // startSession should be defined and callable
    expect(typeof sandbox.startSession).toBe("function");
    // It should be the wrapper, not the original — name check confirms wrapping
    expect(sandbox.startSession.name).toBe("startSessionWithCleanup");
  });

  it("passes harnessPath from GUEST_HARNESS_PATH env var to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");

    const originalEnv = process.env.GUEST_HARNESS_PATH;
    process.env.GUEST_HARNESS_PATH = "/custom/harness.mjs";

    try {
      await createSandbox(makeSandboxOptions());

      expect(createSandboxVm).toHaveBeenCalledWith(
        expect.objectContaining({
          harnessPath: "/custom/harness.mjs",
        }),
      );
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

    await createSandbox(makeSandboxOptions({ slug: "my-custom-agent" }));

    expect(createSandboxVm).toHaveBeenCalledWith(
      expect.objectContaining({
        kvPrefix: "agents/my-custom-agent/kv",
      }),
    );
  });
});
