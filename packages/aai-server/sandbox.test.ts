// Copyright 2025 the AAI authors. MIT license.

import type { Message } from "@alexkroman1/aai";
import { anthropic } from "@alexkroman1/aai/llm";
import type { ClientEvent, ClientSink } from "@alexkroman1/aai/protocol";
import { assemblyAI } from "@alexkroman1/aai/stt";
import { cartesia } from "@alexkroman1/aai/tts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdjsonConnection } from "./ndjson-transport.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import {
  createClientSendHandler,
  createSandbox,
  createSlotCache,
  resolveSandbox,
  type SandboxOptions,
} from "./sandbox.ts";
import { createTestStorage, createTestStore } from "./test-utils.ts";

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

// ── Mock createRuntime to capture executeTool + pipeline provider args ─────

const capturedRuntimeOpts: {
  current: Parameters<typeof import("@alexkroman1/aai/runtime").createRuntime>[0] | null;
} = { current: null };

vi.mock("@alexkroman1/aai/runtime", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@alexkroman1/aai/runtime")>();
  return {
    ...orig,
    createRuntime(opts: Parameters<typeof orig.createRuntime>[0]) {
      capturedExecuteTool.current = opts.executeTool ?? null;
      capturedRuntimeOpts.current = opts;
      return orig.createRuntime(opts);
    },
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
  allowedHosts: [],
};

function makeSandboxOptions(overrides?: Partial<SandboxOptions>): SandboxOptions {
  return {
    workerCode: 'export default { name: "test" };',
    env: { AAI_ENV_TEST: "1" },
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
        vector: expect.objectContaining({
          upsert: expect.any(Function),
          query: expect.any(Function),
          delete: expect.any(Function),
        }),
      }),
      undefined,
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

  it("client/send handler tolerates a notification with no data payload", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    await vi.waitFor(() => {
      expect(mockConn.onNotification).toHaveBeenCalledWith("client/send", expect.any(Function));
    });
    const onNotification = vi.mocked(mockConn.onNotification);
    const handler = onNotification.mock.calls.find((c) => c[0] === "client/send")?.[1] as (
      raw: unknown,
    ) => void;

    // `ctx.send("evt")` with no payload arrives with `data` omitted; the handler
    // must not throw (JSON.stringify(undefined) is not a string) — a throw here
    // would become an uncaughtException that exits the whole multi-tenant host.
    expect(() => handler({ sessionId: "s1", event: "ping" })).not.toThrow();
    await sandbox.shutdown();
  });

  it("shutdown cleans up sandbox handle and agent runtime", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    await sandbox.shutdown();

    expect(mockShutdown).toHaveBeenCalledOnce();
  });

  it("uses agent config from options for runtime creation", async () => {
    const customConfig: IsolateConfig = {
      name: "custom-agent",
      systemPrompt: "Custom prompt",
      greeting: "Hi there",
      maxSteps: 10,
      toolSchemas: [
        {
          type: "function",
          name: "my_tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
        },
      ],
      builtinTools: [],
      allowedHosts: [],
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
        undefined,
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

  it("passes resolved vector to createSandboxVm for given slug", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");

    const sandbox = createSandbox(makeSandboxOptions({ slug: "my-custom-agent" }));

    expect(createSandboxVm).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "my-custom-agent",
        vector: expect.objectContaining({
          upsert: expect.any(Function),
          query: expect.any(Function),
          delete: expect.any(Function),
        }),
      }),
      undefined,
    );
    await sandbox.shutdown();
  });

  // ── Lazy VM initialization tests ──────────────────────────────────────────

  it("returns sandbox immediately before VM is ready", () => {
    const d = Promise.withResolvers<{ conn: NdjsonConnection; shutdown: () => Promise<void> }>();
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
    const d = Promise.withResolvers<{ conn: NdjsonConnection; shutdown: () => Promise<void> }>();
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

  it("invokes onVmFailed when the VM fails to start", async () => {
    mockCreateSandboxVm.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
    const onVmFailed = vi.fn();

    const sandbox = createSandbox(makeSandboxOptions({ onVmFailed }));

    await vi.waitFor(() => {
      expect(onVmFailed).toHaveBeenCalledOnce();
    });
    await sandbox.shutdown();
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

  // ── Incremental message deltas over tool/execute ──────────────────────────
  //
  // The host ships only the history the guest doesn't already hold (see
  // _sandbox-messages.ts + guest/harness-messages.ts): full on first send,
  // append-of-the-tail afterwards, full again on splice/reset/desync.

  describe("executeTool message deltas", () => {
    const m1: Message = { role: "user", content: "hi" };
    const m2: Message = { role: "assistant", content: "yo" };
    const m3: Message = { role: "user", content: "more" };

    function makeExecuteTool() {
      vi.mocked(mockConn.sendRequest).mockResolvedValue({ result: "ok" });
      createSandbox(makeSandboxOptions());
      if (!capturedExecuteTool.current) throw new Error("executeTool was not captured");
      return capturedExecuteTool.current;
    }

    it("sends full history first, then only the appended tail", async () => {
      const executeTool = makeExecuteTool();

      await executeTool("t", { a: 1 }, "s1", [m1]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith("tool/execute", {
        name: "t",
        args: { a: 1 },
        sessionId: "s1",
        messages: [m1],
        messagesMode: "full",
      });

      // Same prefix objects (the runtime snapshots with history.slice()).
      await executeTool("t", { a: 2 }, "s1", [m1, m2]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith("tool/execute", {
        name: "t",
        args: { a: 2 },
        sessionId: "s1",
        messages: [m2],
        messagesMode: "append",
        messagesBase: 1,
      });
    });

    it("falls back to a full send when the prefix identity breaks (front splice)", async () => {
      const executeTool = makeExecuteTool();

      await executeTool("t", {}, "s1", [m1, m2]);
      // maxHistory splice dropped m1 — the watermark objects no longer match.
      await executeTool("t", {}, "s1", [m2, m3]);

      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ messages: [m2, m3], messagesMode: "full" }),
      );
    });

    it("tracks sessions independently", async () => {
      const executeTool = makeExecuteTool();

      await executeTool("t", {}, "s1", [m1]);
      await executeTool("t", {}, "s2", [m1]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ sessionId: "s2", messagesMode: "full" }),
      );

      await executeTool("t", {}, "s1", [m1, m2]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ sessionId: "s1", messagesMode: "append", messagesBase: 1 }),
      );
    });

    it("retries once with full history when the guest reports a desync", async () => {
      const executeTool = makeExecuteTool();
      await executeTool("t", {}, "s1", [m1]);

      // Guest lost its cache (pool restart / LRU eviction): the append is
      // answered with the desync sentinel, then the full resend succeeds.
      vi.mocked(mockConn.sendRequest)
        .mockResolvedValueOnce({ error: "messages_desync" })
        .mockResolvedValueOnce({ result: "recovered" });

      const result = await executeTool("t", {}, "s1", [m1, m2]);

      expect(result).toBe("recovered");
      expect(mockConn.sendRequest).toHaveBeenCalledTimes(3);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ messages: [m1, m2], messagesMode: "full" }),
      );
    });

    it("resets tracking after a failed send so the next call is full", async () => {
      const executeTool = makeExecuteTool();
      await executeTool("t", {}, "s1", [m1]);

      vi.mocked(mockConn.sendRequest).mockRejectedValueOnce(new Error("RPC timed out"));
      // RPC failures are contained as a named tool error, not a rejection.
      await expect(executeTool("t", {}, "s1", [m1, m2])).resolves.toContain(
        "failed in sandbox: RPC timed out",
      );

      // The guest may or may not have applied the failed delta — resend full.
      await executeTool("t", {}, "s1", [m1, m2]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ messages: [m1, m2], messagesMode: "full" }),
      );
    });

    it("a fresh sandbox (pool acquire / guest restart) starts with full history", async () => {
      const executeTool1 = makeExecuteTool();
      await executeTool1("t", {}, "s1", [m1]);
      await executeTool1("t", {}, "s1", [m1, m2]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ messagesMode: "append" }),
      );

      // A new createSandbox = a new guest process = a new tracker: the same
      // session's next call must carry the whole history again.
      const executeTool2 = makeExecuteTool();
      await executeTool2("t", {}, "s1", [m1, m2]);
      expect(mockConn.sendRequest).toHaveBeenLastCalledWith(
        "tool/execute",
        expect.objectContaining({ messages: [m1, m2], messagesMode: "full" }),
      );
    });
  });

  // ── Pipeline mode wiring ─────────────────────────────────────────────────
  //
  // Regression guard for the bug where the CLI shipped `stt/llm/tts`
  // descriptors in `agentConfig` but `sandbox.ts` didn't thread them into
  // `createRuntime()`, so every deploy ran as S2S regardless of what the
  // agent declared. The fix wires descriptors through; this test locks it
  // in by asserting the runtime actually receives them.

  it("threads pipeline descriptors from agentConfig into createRuntime", async () => {
    const stt = assemblyAI({ model: "u3pro-rt" });
    const llm = anthropic({ model: "claude-haiku-4-5" });
    const tts = cartesia({ voice: "v" });
    const sandbox = createSandbox(
      makeSandboxOptions({
        // API keys needed because resolveLlm/Stt/Tts now run eagerly
        // during createRuntime (once per runtime, not per session).
        env: {
          ASSEMBLYAI_API_KEY: "stt-key",
          ANTHROPIC_API_KEY: "llm-key",
          CARTESIA_API_KEY: "tts-key",
        },
        agentConfig: {
          ...TEST_AGENT_CONFIG,
          stt,
          llm,
          tts,
          mode: "pipeline",
        },
      }),
    );

    expect(capturedRuntimeOpts.current?.stt).toStrictEqual(stt);
    expect(capturedRuntimeOpts.current?.llm).toStrictEqual(llm);
    expect(capturedRuntimeOpts.current?.tts).toStrictEqual(tts);

    await sandbox.shutdown();
  });

  it("does not pass pipeline providers when mode is not 'pipeline'", async () => {
    const sandbox = createSandbox(makeSandboxOptions());

    expect(capturedRuntimeOpts.current?.stt).toBeUndefined();
    expect(capturedRuntimeOpts.current?.llm).toBeUndefined();
    expect(capturedRuntimeOpts.current?.tts).toBeUndefined();

    await sandbox.shutdown();
  });

  // ── client/send relay handler ─────────────────────────────────────────────

  describe("createClientSendHandler", () => {
    function makeSink(
      open = true,
    ): ClientSink & { event: ReturnType<typeof vi.fn<ClientSink["event"]>> } {
      return {
        open,
        event: vi.fn<(e: ClientEvent) => void>(),
        playAudioChunk: vi.fn<(chunk: Uint8Array) => void>(),
        playAudioDone: vi.fn<() => void>(),
      };
    }

    it("relays a valid event to the session's open sink", () => {
      const sink = makeSink();
      const handler = createClientSendHandler(new Map([["s1", sink]]));

      handler({ sessionId: "s1", event: "status", data: { level: "info" } });

      expect(sink.event).toHaveBeenCalledWith({
        type: "custom_event",
        event: "status",
        data: { level: "info" },
      });
    });

    it("drops payloads over the byte cap even when UTF-16 length is under it", () => {
      const sink = makeSink();
      const handler = createClientSendHandler(new Map([["s1", sink]]));

      // "€" is 1 UTF-16 code unit but 3 UTF-8 bytes: 30,000 of them serialize
      // to ~30 KB by `.length` but ~90 KB on the wire — over the 64 KB cap.
      const data = "€".repeat(30_000);
      expect(JSON.stringify(data).length).toBeLessThan(65_536);

      handler({ sessionId: "s1", event: "big", data });

      expect(sink.event).not.toHaveBeenCalled();
    });

    it("relays payloads just under the byte cap", () => {
      const sink = makeSink();
      const handler = createClientSendHandler(new Map([["s1", sink]]));

      handler({ sessionId: "s1", event: "ok", data: "x".repeat(65_000) });

      expect(sink.event).toHaveBeenCalledOnce();
    });

    it("ignores events for closed sinks and unknown sessions", () => {
      const closed = makeSink(false);
      const handler = createClientSendHandler(new Map([["s1", closed]]));

      handler({ sessionId: "s1", event: "e", data: 1 });
      handler({ sessionId: "missing", event: "e", data: 1 });

      expect(closed.event).not.toHaveBeenCalled();
    });

    it("tolerates a notification with no data payload", () => {
      const sink = makeSink();
      const handler = createClientSendHandler(new Map([["s1", sink]]));

      expect(() => handler({ sessionId: "s1", event: "ping" })).not.toThrow();
      expect(sink.event).toHaveBeenCalledWith({
        type: "custom_event",
        event: "ping",
        data: undefined,
      });
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
      return { slots: createSlotCache(), store, storage: createTestStorage() };
    }

    it("detaches the resident sandbox when its VM fails to start", async () => {
      mockCreateSandboxVm.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
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
      mockCreateSandboxVm.mockReturnValueOnce(Promise.reject(new Error("VM spawn failed")));
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
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deps.slots.get("raced")?.sandbox).toBe(replacement);
      expect(replacement.shutdown).not.toHaveBeenCalled();
    });
  });

  it("forwards an optional pool to createSandboxVm", async () => {
    const { createSandboxVm } = await import("./sandbox-vm.ts");
    const fakePool = {
      acquire: vi.fn(async () => null),
      shutdown: vi.fn(async () => undefined),
      readySize: () => 0,
      isShutdown: () => false,
    };
    const sandbox = createSandbox(
      makeSandboxOptions({ pool: fakePool as unknown as import("./sandbox-pool.ts").SandboxPool }),
    );

    expect(createSandboxVm).toHaveBeenCalledWith(expect.any(Object), fakePool);
    await sandbox.shutdown();
  });
});
