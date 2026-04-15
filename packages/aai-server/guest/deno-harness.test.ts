// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

function getWrittenLines(): unknown[] {
  const decoder = new TextDecoder();
  return writtenBytes
    .map((b) => decoder.decode(b))
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

shimDeno();

// Dynamic import after shim is in place.
// @ts-expect-error -- deno-harness.ts uses Deno types not available in Node
const harness = await import("./deno-harness.ts");
const {
  TextLineStream,
  createSessionStateMap,
  executeTool,
  handleRequest,
  handleKvResponse,
  handleNotification,
  pendingKvRequests,
} = harness;

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
});

// ── handleRequest ─────────────────────────────────────────────────────────

describe("handleRequest", () => {
  test("bundle/load errors on missing code param", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null };
    await handleRequest({ jsonrpc: "2.0", id: 1, method: "bundle/load", params: {} }, state);
    const lines = getWrittenLines();
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_602, message: "bundle/load requires { code: string, env: {} }" },
      },
    ]);
  });

  test("tool/execute errors when agent not loaded", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null };
    await handleRequest({ jsonrpc: "2.0", id: 2, method: "tool/execute", params: {} }, state);
    const lines = getWrittenLines();
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32_000, message: "Agent not loaded" },
      },
    ]);
  });

  test("unknown method returns -32601", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null };
    await handleRequest({ jsonrpc: "2.0", id: 3, method: "unknown/method" }, state);
    const lines = getWrittenLines();
    expect(lines).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        error: { code: -32_601, message: "Method not found: unknown/method" },
      },
    ]);
  });
});

// ── handleKvResponse ──────────────────────────────────────────────────────

describe("handleKvResponse", () => {
  afterEach(() => {
    pendingKvRequests.clear();
  });

  test("resolves pending request on success", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    pendingKvRequests.set(10, { resolve, reject: vi.fn() });
    handleKvResponse({ jsonrpc: "2.0", id: 10, result: { value: "data" } });
    expect(await promise).toEqual({ value: "data" });
    expect(pendingKvRequests.size).toBe(0);
  });

  test("rejects pending request on error", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pendingKvRequests.set(11, {
      resolve,
      reject: (err: unknown) => reject(err),
    });
    handleKvResponse({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -1, message: "not found" },
    });
    await expect(promise).rejects.toThrow("not found");
  });

  test("ignores responses with no matching pending request", () => {
    handleKvResponse({ jsonrpc: "2.0", id: 999, result: "orphan" });
  });
});

// ── handleNotification ────────────────────────────────────────────────────

describe("handleNotification", () => {
  test("session/end deletes session state", () => {
    const sessionState = createSessionStateMap(() => ({ x: 1 }));
    sessionState.get("s1").x = 99;
    const state = { agent: null, sessionState };
    handleNotification(
      { jsonrpc: "2.0", method: "session/end", params: { sessionId: "s1" } },
      state,
    );
    expect(sessionState.get("s1").x).toBe(1);
  });

  test("shutdown calls Deno.exit(0)", () => {
    const state = { agent: null, sessionState: null };
    handleNotification({ jsonrpc: "2.0", method: "shutdown" }, state);
    const denoShim = (globalThis as Record<string, unknown>).Deno as {
      exit: ReturnType<typeof vi.fn>;
    };
    expect(denoShim.exit).toHaveBeenCalledWith(0);
  });
});
