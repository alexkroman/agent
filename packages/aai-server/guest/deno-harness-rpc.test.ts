// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests for the Deno guest harness JSON-RPC surface: handleRequest,
 * handleHostResponse, handleNotification, and the vector adapter.
 * TextLineStream / session state / executeTool tests live in
 * deno-harness.test.ts.
 */
import { STORAGE_DISABLED_MESSAGE } from "@alexkroman1/aai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ── Deno global shim ──────────────────────────────────────────────────────
// The harness uses Deno.stdout.write and Deno.exit at module scope.
// Shim them before importing so the module loads cleanly in Node.

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

function getWrittenLines(): unknown[] {
  const decoder = new TextDecoder();
  return writtenBytes
    .map((b) => decoder.decode(b))
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Dynamic import after shim is in place.
const harness = await import("./deno-harness.ts");
const { createSessionMessagesCache } = await import("./harness-messages.ts");
const {
  createSessionStateMap,
  handleRequest,
  handleHostResponse,
  handleNotification,
  pendingHostRequests,
} = harness;

/** Yield a macrotask so the async serialized stdout writer can flush. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  writtenBytes.length = 0;
  // Reset the Deno.exit mock between tests
  const denoShim = (globalThis as Record<string, unknown>).Deno as {
    exit: ReturnType<typeof vi.fn>;
  };
  denoShim.exit.mockClear();
});

// ── handleRequest ─────────────────────────────────────────────────────────

describe("handleRequest", () => {
  test("bundle/load errors on missing code param", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null, sessionMessages: null };
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
    const state = { agent: null, sessionState: null, sessionMessages: null };
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
    const state = { agent: null, sessionState: null, sessionMessages: null };
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

  test("bundle/load responds with plain ok for a bundle without __aaiConfig", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null, sessionMessages: null };
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "bundle/load",
        params: { code: 'export default { name: "plain", tools: {} };', env: {} },
      },
      state,
    );
    expect(getWrittenLines()).toEqual([{ jsonrpc: "2.0", id: 4, result: { ok: true } }]);
  });

  test("ctx.db throws storage-not-enabled guidance when bundle/load says disabled", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null, sessionMessages: null };
    const code =
      'export default { name: "t", tools: { use_db: { description: "d", ' +
      'execute: async (_args, ctx) => JSON.stringify(await ctx.db.query("select 1")) } } };';
    // No storageEnabled param → disabled (also what older hosts send).
    await handleRequest(
      { jsonrpc: "2.0", id: 40, method: "bundle/load", params: { code, env: {} } },
      state,
    );
    writtenBytes.length = 0;
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 41,
        method: "tool/execute",
        params: { name: "use_db", args: {}, sessionId: "s1", messages: [] },
      },
      state,
    );
    const reply = getWrittenLines().find((m) => (m as { id?: number }).id === 41) as {
      result: { error: string };
    };
    // Must match the SDK tool-executor's message exactly so dev and prod agree.
    expect(reply.result.error).toBe(STORAGE_DISABLED_MESSAGE);
  });

  test("ctx.db proxies db/query to the host when storage is enabled", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null, sessionMessages: null };
    const code =
      'export default { name: "t", tools: { use_db: { description: "d", ' +
      'execute: async (_args, ctx) => JSON.stringify(await ctx.db.query("select body from notes", [7])) } } };';
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 42,
        method: "bundle/load",
        params: { code, env: {}, storageEnabled: true },
      },
      state,
    );
    writtenBytes.length = 0;
    const done = handleRequest(
      {
        jsonrpc: "2.0",
        id: 43,
        method: "tool/execute",
        params: { name: "use_db", args: {}, sessionId: "s1", messages: [] },
      },
      state,
    );
    // The tool call is now awaiting the proxied db/query — answer it.
    await vi.waitFor(() => {
      expect(getWrittenLines().some((m) => (m as { method?: string }).method === "db/query")).toBe(
        true,
      );
    });
    const dbReq = getWrittenLines().find(
      (m) => (m as { method?: string }).method === "db/query",
    ) as { id: number; params: unknown };
    expect(dbReq.params).toEqual({ sql: "select body from notes", params: [7] });
    handleHostResponse({ id: dbReq.id, result: [{ body: "hello" }] });
    await done;

    const reply = getWrittenLines().find((m) => (m as { id?: number }).id === 43) as {
      result: { result: string };
    };
    expect(reply.result.result).toBe(JSON.stringify([{ body: "hello" }]));
    // Reset the flag for later tests: reload a bundle without storage.
    await handleRequest(
      {
        jsonrpc: "2.0",
        id: 44,
        method: "bundle/load",
        params: { code: 'export default { name: "p", tools: {} };', env: {} },
      },
      state,
    );
  });

  test("bundle/load returns the bundle's self-described __aaiConfig", async () => {
    writtenBytes.length = 0;
    const state = { agent: null, sessionState: null, sessionMessages: null };
    const code =
      'export default { name: "studio-agent", tools: {} };\n' +
      'export const __aaiConfig = { name: "studio-agent", systemPrompt: "s", toolSchemas: [] };';
    await handleRequest(
      { jsonrpc: "2.0", id: 5, method: "bundle/load", params: { code, env: {} } },
      state,
    );
    expect(getWrittenLines()).toEqual([
      {
        jsonrpc: "2.0",
        id: 5,
        result: {
          ok: true,
          config: { name: "studio-agent", systemPrompt: "s", toolSchemas: [] },
        },
      },
    ]);
  });
});

// ── handleHostResponse ──────────────────────────────────────────────────────

describe("handleHostResponse", () => {
  afterEach(() => {
    pendingHostRequests.clear();
  });

  test("resolves pending request on success", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    pendingHostRequests.set(10, { resolve, reject: vi.fn() });
    handleHostResponse({ jsonrpc: "2.0", id: 10, result: { value: "data" } });
    expect(await promise).toEqual({ value: "data" });
    expect(pendingHostRequests.size).toBe(0);
  });

  test("rejects pending request on error", async () => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pendingHostRequests.set(11, {
      resolve,
      reject: (err: unknown) => reject(err),
    });
    handleHostResponse({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -1, message: "not found" },
    });
    await expect(promise).rejects.toThrow("not found");
  });

  test("ignores responses with no matching pending request", () => {
    handleHostResponse({ jsonrpc: "2.0", id: 999, result: "orphan" });
  });
});

// ── handleNotification ────────────────────────────────────────────────────

describe("handleNotification", () => {
  test("session/end deletes session state", () => {
    const sessionState = createSessionStateMap(() => ({ x: 1 }));
    sessionState.get("s1").x = 99;
    const state = { agent: null, sessionState, sessionMessages: createSessionMessagesCache() };
    handleNotification(
      { jsonrpc: "2.0", method: "session/end", params: { sessionId: "s1" } },
      state,
    );
    expect(sessionState.get("s1").x).toBe(1);
  });

  test("session/end drops the session's cached message history", () => {
    const sessionMessages = createSessionMessagesCache();
    sessionMessages.apply("s1", [{ role: "user", content: "a" }], "full", undefined);
    const state = { agent: null, sessionState: createSessionStateMap(), sessionMessages };
    handleNotification(
      { jsonrpc: "2.0", method: "session/end", params: { sessionId: "s1" } },
      state,
    );
    expect(sessionMessages.size()).toBe(0);
  });

  test("shutdown calls Deno.exit(0)", () => {
    const state = { agent: null, sessionState: null, sessionMessages: null };
    handleNotification({ jsonrpc: "2.0", method: "shutdown" }, state);
    const denoShim = (globalThis as Record<string, unknown>).Deno as {
      exit: ReturnType<typeof vi.fn>;
    };
    expect(denoShim.exit).toHaveBeenCalledWith(0);
  });
});

// ── vector adapter ────────────────────────────────────────────────────────

describe("vector adapter", () => {
  afterEach(() => {
    pendingHostRequests.clear();
  });

  test("upsert sends vector/upsert request", async () => {
    const adapter = harness.vectorAdapter;
    const promise = adapter.upsert("doc-1", "hello", { tag: "x" });
    await flush();

    // The request should be pending
    expect(pendingHostRequests.size).toBe(1);
    const [[id]] = [...pendingHostRequests.entries()];

    // The written line should contain the right method and params
    const lines = getWrittenLines();
    expect(lines).toContainEqual(
      expect.objectContaining({
        method: "vector/upsert",
        params: { id: "doc-1", text: "hello", metadata: { tag: "x" } },
      }),
    );

    harness.handleHostResponse({ jsonrpc: "2.0", id, result: undefined });
    await promise;
    expect(pendingHostRequests.size).toBe(0);
  });

  test("query returns matches", async () => {
    const adapter = harness.vectorAdapter;
    const promise = adapter.query("hello");
    await flush();

    expect(pendingHostRequests.size).toBe(1);
    const [[id]] = [...pendingHostRequests.entries()];

    const lines = getWrittenLines();
    expect(lines).toContainEqual(
      expect.objectContaining({ method: "vector/query", params: { text: "hello" } }),
    );

    const matches = [{ id: "doc-1", score: 0.9, text: "hello" }];
    harness.handleHostResponse({ jsonrpc: "2.0", id, result: matches });
    expect(await promise).toEqual(matches);
  });

  test("delete sends vector/delete with single id", async () => {
    const adapter = harness.vectorAdapter;
    const promise = adapter.delete("doc-1");
    await flush();

    expect(pendingHostRequests.size).toBe(1);
    const [[id]] = [...pendingHostRequests.entries()];

    const lines = getWrittenLines();
    expect(lines).toContainEqual(
      expect.objectContaining({
        method: "vector/delete",
        params: { ids: "doc-1" },
      }),
    );

    harness.handleHostResponse({ jsonrpc: "2.0", id, result: undefined });
    await promise;
    expect(pendingHostRequests.size).toBe(0);
  });
});
