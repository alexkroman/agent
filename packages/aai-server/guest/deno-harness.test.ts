// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests for the Deno guest harness: TextLineStream,
 * createSessionStateMap, and executeTool (including the run_code builtin).
 * JSON-RPC message handling tests live in deno-harness-rpc.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Deno global shim ──────────────────────────────────────────────────────
// The harness uses Deno.stdout.write and Deno.exit at module scope.
// Shim them before importing so the module loads cleanly in Node.
// Deliberately no `version` field: importBundleModule uses `Deno.version.deno`
// to detect real Deno (Node cannot import blob: modules).

const writtenBytes: Uint8Array[] = [];

(globalThis as Record<string, unknown>).Deno = {
  stdout: {
    write(data: Uint8Array) {
      writtenBytes.push(new Uint8Array(data));
      return Promise.resolve(data.byteLength);
    },
  },
  exit: vi.fn(),
  stdin: undefined, // prevents main() from running
};

// Dynamic import after shim is in place.
const { TextLineStream, createSessionStateMap, executeTool } = await import("./deno-harness.ts");
const { createSessionMessagesCache, MESSAGES_DESYNC_ERROR } = await import("./harness-messages.ts");

beforeEach(() => {
  writtenBytes.length = 0;
  // Reset the Deno.exit mock between tests
  const denoShim = (globalThis as Record<string, unknown>).Deno as {
    exit: ReturnType<typeof vi.fn>;
  };
  denoShim.exit.mockClear();
});

// ── TextLineStream ────────────────────────────────────────────────────────

describe("TextLineStream", () => {
  async function collectLines(chunks: string[]): Promise<string[]> {
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }).pipeThrough(new TextLineStream());
    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    return lines;
  }

  test("splits a single chunk into lines", async () => {
    const lines = await collectLines(["hello\nworld\n"]);
    expect(lines).toEqual(["hello", "world"]);
  });

  test("handles partial lines across chunks", async () => {
    const lines = await collectLines(["hel", "lo\nwor", "ld\n"]);
    expect(lines).toEqual(["hello", "world"]);
  });

  test("flushes remaining buffer on stream end", async () => {
    const lines = await collectLines(["hello\nworld"]);
    expect(lines).toEqual(["hello", "world"]);
  });

  test("handles empty chunks", async () => {
    const lines = await collectLines(["", "a\n", "", "b\n"]);
    expect(lines).toEqual(["a", "b"]);
  });

  test("handles one huge line delivered across many chunks", async () => {
    // Guards the incremental-scan rewrite: a single line spanning many
    // chunks (the bundle/load shape) must come out intact, and lines after
    // it must still split correctly.
    const chunkCount = 64;
    const chunk = "x".repeat(1024);
    const chunks = Array.from({ length: chunkCount }, () => chunk);
    chunks.push("tail\nnext\nlast");
    const lines = await collectLines(chunks);
    expect(lines).toEqual([`${chunk.repeat(chunkCount)}tail`, "next", "last"]);
  });

  test("handles chunks containing multiple newlines mid-stream", async () => {
    const lines = await collectLines(["a\nb\nc", "d\n\ne\n", "f"]);
    expect(lines).toEqual(["a", "b", "cd", "", "e", "f"]);
  });
});

// ── createSessionStateMap ─────────────────────────────────────────────────

describe("createSessionStateMap", () => {
  test("lazily initializes state from factory", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    const state = map.get("session-1");
    expect(state).toEqual({ count: 0 });
  });

  test("returns same state on repeated get", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    const a = map.get("session-1");
    a.count = 42;
    const b = map.get("session-1");
    expect(b.count).toBe(42);
  });

  test("deep-clones initial state (sessions are isolated)", () => {
    const map = createSessionStateMap(() => ({ items: [1, 2] }));
    const s1 = map.get("s1");
    const s2 = map.get("s2");
    s1.items = [99];
    expect(s2.items).toEqual([1, 2]);
  });

  test("delete removes a session", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    map.get("s1").count = 5;
    map.delete("s1");
    expect(map.get("s1").count).toBe(0);
  });

  test("returns empty object when no factory provided", () => {
    const map = createSessionStateMap();
    expect(map.get("s1")).toEqual({});
  });

  test("peek never lazily initializes state", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    expect(map.peek("s1")).toBeUndefined();
    map.get("s1").count = 3;
    expect(map.peek("s1")).toEqual({ count: 3 });
  });

  test("restore hydrates an absent session with a detached clone", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    const persisted = { count: 7 };
    map.restore("s1", persisted);
    expect(map.get("s1")).toEqual({ count: 7 });
    // Cloned on the way in — the caller's object is not shared state.
    persisted.count = 99;
    expect(map.get("s1")).toEqual({ count: 7 });
  });

  test("restore is set-if-absent: live state is never clobbered", () => {
    const map = createSessionStateMap(() => ({ count: 0 }));
    map.get("s1").count = 5;
    map.restore("s1", { count: 1 });
    expect(map.get("s1")).toEqual({ count: 5 });
  });
});

// ── executeTool ───────────────────────────────────────────────────────────

describe("executeTool", () => {
  const makeAgent = (
    tools: Record<string, { description: string; execute: (...args: unknown[]) => unknown }>,
  ) => ({
    name: "test-agent",
    systemPrompt: "test",
    greeting: "hi",
    tools,
  });

  const makeReq = (name: string, args: Record<string, unknown> = {}) => ({
    name,
    args,
    sessionId: "sess-1",
    messages: [],
  });

  /** Fresh per-test messages cache (executeTool's 4th argument). */
  const makeMessages = () => createSessionMessagesCache();

  test("returns result string for successful execution", async () => {
    const agent = makeAgent({
      greet: { description: "greet", execute: () => "hello" },
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("greet"), state, makeMessages());
    expect(result).toEqual({ result: "hello" });
  });

  test("stringifies non-string results", async () => {
    const agent = makeAgent({
      count: { description: "count", execute: () => ({ n: 42 }) },
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("count"), state, makeMessages());
    expect(result).toEqual({ result: '{"n":42}' });
  });

  test("returns error for unknown tool", async () => {
    const agent = makeAgent({});
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("nope"), state, makeMessages());
    expect(result).toEqual({ error: "Unknown tool: nope" });
  });

  test("returns error when tool throws", async () => {
    const agent = makeAgent({
      fail: {
        description: "fail",
        execute: () => {
          throw new Error("boom");
        },
      },
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("fail"), state, makeMessages());
    expect(result).toEqual({ error: "boom" });
  });

  test("times out after TOOL_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const agent = makeAgent({
      slow: {
        description: "slow",
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentionally never-resolving promise
        execute: () => new Promise(() => {}),
      },
    });
    const state = createSessionStateMap();
    const resultPromise = executeTool(agent, makeReq("slow"), state, makeMessages());
    vi.advanceTimersByTime(30_000);
    const result = await resultPromise;
    expect(result).toEqual({
      error: 'Tool "slow" timed out after 30000ms',
    });
    vi.useRealTimers();
  });

  test("returns a tool error (not a protocol error) when args fail validation", async () => {
    // Invalid LLM-supplied args must come back on the { error } tool-result
    // path so the model can repair them — not as a JSON-RPC protocol error.
    const agent = makeAgent({
      strict: {
        description: "strict",
        parameters: {
          parse: () => {
            throw new Error("Expected string, received number");
          },
        },
        execute: () => "never reached",
      } as never,
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("strict", { x: 1 }), state, makeMessages());
    expect(result).toEqual({ error: "Expected string, received number" });
  });

  test("passes parsed args when tool has parameters.parse", async () => {
    const agent = makeAgent({
      echo: {
        description: "echo",
        parameters: {
          parse: (a: unknown) => ({ parsed: true, ...(a as Record<string, unknown>) }),
        },
        execute: (args: unknown) => args,
      } as never,
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("echo", { x: 1 }), state, makeMessages());
    expect(result).toEqual({ result: '{"parsed":true,"x":1}' });
  });

  // ── run_code (executes in-guest; Modal/Deno is the boundary) ─────────────

  test("run_code executes and captures console output", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: 'console.log("hello", 2 + 2)' }),
      state,
      makeMessages(),
    );
    expect(result).toEqual({ result: "hello 4" });
  });

  test("run_code supports top-level await", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", {
        code: "await Promise.resolve(); console.log('done')",
      }),
      state,
      makeMessages(),
    );
    expect(result).toEqual({ result: "done" });
  });

  test("run_code returns no-output message for silent code", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: "const x = 1 + 1;" }),
      state,
      makeMessages(),
    );
    expect(result).toEqual({ result: "Code ran successfully (no output)" });
  });

  test("run_code returns error object for runtime errors", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: "throw new Error('boom')" }),
      state,
      makeMessages(),
    );
    expect(result).toEqual({ error: "boom" });
  });

  test("run_code works without the tool being in the agent bundle", async () => {
    // run_code is a builtin, not a custom tool — it must run even though the
    // agent declares no tools.
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: 'console.log("ok")' }),
      state,
      makeMessages(),
    );
    expect(result).toEqual({ result: "ok" });
  });

  // ── Incremental message deltas (see harness-messages.ts) ────────────────

  const echoMessagesAgent = () =>
    makeAgent({
      echo_messages: {
        description: "echo",
        execute: (_args: unknown, ctx: { messages: readonly { content: string }[] }) =>
          ctx.messages.map((m) => m.content).join(","),
      } as never,
    });

  test("append delta extends the cached history for ctx.messages", async () => {
    const agent = echoMessagesAgent();
    const state = createSessionStateMap();
    const cache = makeMessages();

    const r1 = await executeTool(
      agent,
      {
        ...makeReq("echo_messages"),
        messages: [{ role: "user" as const, content: "a" }],
        messagesMode: "full" as const,
      },
      state,
      cache,
    );
    expect(r1).toEqual({ result: "a" });

    const r2 = await executeTool(
      agent,
      {
        ...makeReq("echo_messages"),
        messages: [{ role: "assistant" as const, content: "b" }],
        messagesMode: "append" as const,
        messagesBase: 1,
      },
      state,
      cache,
    );
    expect(r2).toEqual({ result: "a,b" });
  });

  test("append with a mismatched base returns the desync error", async () => {
    const agent = echoMessagesAgent();
    const state = createSessionStateMap();
    const cache = makeMessages();

    const result = await executeTool(
      agent,
      {
        ...makeReq("echo_messages"),
        messages: [{ role: "user" as const, content: "late" }],
        messagesMode: "append" as const,
        messagesBase: 3,
      },
      state,
      cache,
    );
    expect(result).toEqual({ error: MESSAGES_DESYNC_ERROR });
  });

  test("plain messages without a mode are treated as full history", async () => {
    const agent = echoMessagesAgent();
    const state = createSessionStateMap();
    const result = await executeTool(
      agent,
      { ...makeReq("echo_messages"), messages: [{ role: "user" as const, content: "legacy" }] },
      state,
      makeMessages(),
    );
    expect(result).toEqual({ result: "legacy" });
  });
});
