// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests for the Deno guest harness: TextLineStream,
 * createSessionStateMap, and executeTool (including the run_code builtin).
 * JSON-RPC message handling tests live in deno-harness-rpc.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Deno global shim ──────────────────────────────────────────────────────
// The harness uses Deno.stdout.writeSync and Deno.exit at module scope.
// Shim them before importing so the module loads cleanly in Node.

const writtenBytes: Uint8Array[] = [];

function shimDeno() {
  (globalThis as Record<string, unknown>).Deno = {
    stdout: {
      writeSync(data: Uint8Array) {
        writtenBytes.push(new Uint8Array(data));
        return data.byteLength;
      },
    },
    exit: vi.fn(),
    stdin: undefined, // prevents main() from running
  };
}

shimDeno();

// Dynamic import after shim is in place.
const { TextLineStream, createSessionStateMap, executeTool } = await import("./deno-harness.ts");

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

  test("returns result string for successful execution", async () => {
    const agent = makeAgent({
      greet: { description: "greet", execute: () => "hello" },
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("greet"), state);
    expect(result).toEqual({ result: "hello", state: {} });
  });

  test("stringifies non-string results", async () => {
    const agent = makeAgent({
      count: { description: "count", execute: () => ({ n: 42 }) },
    });
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("count"), state);
    expect(result).toEqual({ result: '{"n":42}', state: {} });
  });

  test("returns error for unknown tool", async () => {
    const agent = makeAgent({});
    const state = createSessionStateMap();
    const result = await executeTool(agent, makeReq("nope"), state);
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
    const result = await executeTool(agent, makeReq("fail"), state);
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
    const resultPromise = executeTool(agent, makeReq("slow"), state);
    vi.advanceTimersByTime(30_000);
    const result = await resultPromise;
    expect(result).toEqual({
      error: 'Tool "slow" timed out after 30000ms',
    });
    vi.useRealTimers();
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
    const result = await executeTool(agent, makeReq("echo", { x: 1 }), state);
    expect(result).toEqual({
      result: '{"parsed":true,"x":1}',
      state: {},
    });
  });

  // ── run_code (executes in-guest; gVisor/Deno is the boundary) ────────────

  test("run_code executes and captures console output", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: 'console.log("hello", 2 + 2)' }),
      state,
    );
    expect(result).toEqual({ result: "hello 4", state: {} });
  });

  test("run_code supports top-level await", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", {
        code: "await Promise.resolve(); console.log('done')",
      }),
      state,
    );
    expect(result).toEqual({ result: "done", state: {} });
  });

  test("run_code returns no-output message for silent code", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: "const x = 1 + 1;" }),
      state,
    );
    expect(result).toEqual({ result: "Code ran successfully (no output)", state: {} });
  });

  test("run_code returns error object for runtime errors", async () => {
    const state = createSessionStateMap();
    const result = await executeTool(
      makeAgent({}),
      makeReq("run_code", { code: "throw new Error('boom')" }),
      state,
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
    );
    expect(result).toEqual({ result: "ok", state: {} });
  });
});
