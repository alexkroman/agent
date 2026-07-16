// Copyright 2025 the AAI authors. MIT license.
/**
 * Unit tests for the Deno guest harness JSON-RPC surface: handleRequest,
 * handleHostResponse, handleNotification, and the vector adapter.
 * TextLineStream / session state / executeTool tests live in
 * deno-harness.test.ts.
 */
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
const harness = await import("./deno-harness.ts");
const {
  createSessionStateMap,
  handleRequest,
  handleHostResponse,
  handleNotification,
  pendingHostRequests,
} = harness;

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

// ── vector adapter ────────────────────────────────────────────────────────

describe("vector adapter", () => {
  afterEach(() => {
    pendingHostRequests.clear();
  });

  test("upsert sends vector/upsert request", async () => {
    const adapter = harness.makeVectorAdapter();
    const promise = adapter.upsert("doc-1", "hello", { tag: "x" });

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
    const adapter = harness.makeVectorAdapter();
    const promise = adapter.query("hello");

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
    const adapter = harness.makeVectorAdapter();
    const promise = adapter.delete("doc-1");

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
