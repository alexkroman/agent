// Copyright 2025 the AAI authors. MIT license.
import { beforeEach, describe, expect, test, vi } from "vitest";

// ── Deno global shim ──────────────────────────────────────────────────────
// harness-rpc writes NDJSON via Deno.stdout.writeSync. Shim it before any
// call so the module runs cleanly in Node.

const writtenBytes: Uint8Array[] = [];

(globalThis as Record<string, unknown>).Deno = {
  stdout: {
    writeSync(data: Uint8Array) {
      writtenBytes.push(new Uint8Array(data));
      return data.byteLength;
    },
  },
  exit: vi.fn(),
  stdin: undefined,
};

// Dynamic import after the shim is in place. Importing this module also
// installs the proxied `globalThis.fetch` (forks pool isolates this file).
const rpc = await import("./harness-rpc.ts");
const {
  handleFetchNotification,
  handleHostResponse,
  kvAdapter,
  pendingFetches,
  pendingHostRequests,
  sendError,
  sendResponse,
  sendToClient,
  vectorAdapter,
} = rpc;

type WrittenMessage = {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

function getWrittenMessages(): WrittenMessage[] {
  const decoder = new TextDecoder();
  return writtenBytes
    .map((b) => decoder.decode(b))
    .join("")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as WrittenMessage);
}

function lastMessage(): WrittenMessage {
  const messages = getWrittenMessages();
  const last = messages.at(-1);
  if (!last) throw new Error("no NDJSON messages written");
  return last;
}

/** Resolve the most recently written host request with the given result. */
function respondToLastRequest(result: unknown): void {
  const { id } = lastMessage();
  if (id === undefined) throw new Error("last message is not a request");
  handleHostResponse({ id, result });
}

/**
 * Yield a macrotask so the async fetch proxy can progress: it serializes the
 * request body before registering its pending-fetch entry and writing the RPC.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Read the guest-generated fetch id from the last written fetch/request. */
function lastFetchId(): string {
  const msg = lastMessage();
  if (msg.method !== "fetch/request") throw new Error("last message is not a fetch/request");
  return msg.params?.id as string;
}

beforeEach(() => {
  writtenBytes.length = 0;
  pendingHostRequests.clear();
  pendingFetches.clear();
});

describe("NDJSON writing", () => {
  test("sendResponse writes a JSON-RPC result line", () => {
    sendResponse(7, { ok: true });
    expect(lastMessage()).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  test("sendError writes a JSON-RPC error line", () => {
    sendError("abc", -32_601, "no such method");
    expect(lastMessage()).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32_601, message: "no such method" },
    });
  });

  test("sendToClient writes a client/send notification", () => {
    sendToClient("sess-1", "status", { level: "info" });
    expect(lastMessage()).toEqual({
      jsonrpc: "2.0",
      method: "client/send",
      params: { sessionId: "sess-1", event: "status", data: { level: "info" } },
    });
  });

  test("writeMessage loops until all bytes are written when writeSync is partial", () => {
    const deno = (globalThis as Record<string, unknown>).Deno as {
      stdout: { writeSync(data: Uint8Array): number };
    };
    const original = deno.stdout.writeSync;
    // Simulate a full pipe buffer: accept at most 5 bytes per call.
    deno.stdout.writeSync = (data: Uint8Array) => {
      const n = Math.min(5, data.byteLength);
      writtenBytes.push(new Uint8Array(data.subarray(0, n)));
      return n;
    };
    try {
      sendResponse(9, { ok: "0123456789abcdef" });
    } finally {
      deno.stdout.writeSync = original;
    }
    expect(lastMessage()).toEqual({ jsonrpc: "2.0", id: 9, result: { ok: "0123456789abcdef" } });
  });
});

describe("host RPC round-trip", () => {
  // hostRequest is module-private; exercise it through the KV adapter.
  test("writes a JSON-RPC request and resolves with the host result", async () => {
    const promise = kvAdapter.get("a");
    const msg = lastMessage();
    expect(msg.method).toBe("kv/get");
    expect(msg.params).toEqual({ key: "a" });
    respondToLastRequest("value");
    await expect(promise).resolves.toBe("value");
  });

  test("rejects when the host returns an error", async () => {
    const promise = kvAdapter.get("a");
    const { id } = lastMessage();
    handleHostResponse({ id: id as number, error: { code: 1, message: "kv down" } });
    await expect(promise).rejects.toThrow("kv down");
  });

  test("ignores responses with no matching pending request", () => {
    expect(() => handleHostResponse({ id: 999_999, result: "orphan" })).not.toThrow();
  });
});

describe("proxied fetch", () => {
  test("sends fetch/request with guest-generated id, method, headers, and base64 body", async () => {
    const promise = fetch("https://api.test/things", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    await flush();

    const msg = lastMessage();
    expect(msg.method).toBe("fetch/request");
    expect(msg.params).toMatchObject({
      url: "https://api.test/things",
      method: "POST",
      body: btoa("hello"),
    });
    expect(msg.params?.headers).toMatchObject({ "content-type": "text/plain" });
    const id = lastFetchId();
    expect(id).toMatch(/^f\d+$/);
    // The pending entry is registered BEFORE the host responds, so early
    // rejection notifications can never be dropped.
    expect(pendingFetches.has(id)).toBe(true);

    respondToLastRequest({ id });
    handleFetchNotification("fetch/response-start", {
      id,
      status: 201,
      statusText: "Created",
      headers: { "x-served-by": "host" },
    });
    handleFetchNotification("fetch/response-chunk", { id, data: btoa("hel") });
    handleFetchNotification("fetch/response-chunk", { id, data: btoa("lo!") });
    handleFetchNotification("fetch/response-end", { id });

    const res = await promise;
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.headers.get("x-served-by")).toBe("host");
    await expect(res.text()).resolves.toBe("hello!");
    expect(pendingFetches.size).toBe(0);
  });

  test("GET request sends null body and resolves an empty response", async () => {
    const promise = fetch("https://api.test/empty");
    await flush();
    expect(lastMessage().params).toMatchObject({ method: "GET", body: null });
    const id = lastFetchId();

    respondToLastRequest({ id });
    handleFetchNotification("fetch/response-end", { id });

    const res = await promise;
    expect(res.status).toBe(200); // defaults when no response-start arrived
    await expect(res.text()).resolves.toBe("");
  });

  test("rejects with TypeError on fetch/response-error", async () => {
    const promise = fetch("https://api.test/boom");
    await flush();
    const id = lastFetchId();
    respondToLastRequest({ id });
    handleFetchNotification("fetch/response-error", { id, message: "dns failure" });
    await expect(promise).rejects.toThrow(TypeError);
    await expect(promise).rejects.toThrow("fetch failed: dns failure");
    expect(pendingFetches.size).toBe(0);
  });

  test("rejects promptly when the error notification races ahead of the RPC response", async () => {
    // Regression: a disallowed-host fetch is rejected synchronously by the
    // host, so fetch/response-error can arrive BEFORE the `{ id }` response.
    // The guest must already be listening — the error used to be dropped and
    // the fetch stalled until the 30s tool timeout, leaking the entry.
    const promise = fetch("https://blocked.test/secret");
    await flush();
    const id = lastFetchId();

    // Error notification first, RPC response second (the racy ordering).
    handleFetchNotification("fetch/response-error", {
      id,
      message: 'Host "blocked.test" is not allowed.',
    });
    respondToLastRequest({ id });

    await expect(promise).rejects.toThrow('fetch failed: Host "blocked.test" is not allowed.');
    expect(pendingFetches.size).toBe(0);
  });

  test("cleans up the pending entry when the fetch/request RPC itself rejects", async () => {
    const promise = fetch("https://api.test/no-handler");
    await flush();
    const { id: rpcId } = lastMessage();
    if (rpcId === undefined) throw new Error("no fetch/request written");

    handleHostResponse({
      id: rpcId,
      error: { code: -32_601, message: "Method not found: fetch/request" },
    });

    await expect(promise).rejects.toThrow("fetch failed: Method not found: fetch/request");
    expect(pendingFetches.size).toBe(0);
  });

  test("rejects request bodies over the 1 MB limit before contacting the host", async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    await expect(fetch("https://api.test/big", { method: "POST", body: big })).rejects.toThrow(
      /exceeds .* byte limit/,
    );
    // No fetch/request RPC was written for the oversized body.
    expect(getWrittenMessages().filter((m) => m.method === "fetch/request")).toEqual([]);
  });

  test("round-trips binary bodies through base64 chunking", async () => {
    // Cross the 8 KB base64 chunk boundary with non-ASCII byte values.
    const bytes = new Uint8Array(9000).map((_, i) => (i * 31 + 200) % 256);
    const promise = fetch("https://api.test/bin", { method: "POST", body: bytes });
    await flush();
    const sent = lastMessage().params?.body as string;
    expect(Uint8Array.from(atob(sent), (c) => c.charCodeAt(0))).toEqual(bytes);
    const id = lastFetchId();

    respondToLastRequest({ id });
    handleFetchNotification("fetch/response-chunk", { id, data: sent });
    handleFetchNotification("fetch/response-end", { id });
    const res = await promise;
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("ignores notifications for unknown fetch ids and unknown methods", () => {
    expect(() => {
      handleFetchNotification("fetch/response-chunk", { id: "nope", data: btoa("x") });
      handleFetchNotification("fetch/unknown", { id: "nope" });
    }).not.toThrow();
  });
});

describe("kvAdapter", () => {
  test("get resolves the host result and maps undefined to null", async () => {
    const kv = kvAdapter;
    const p1 = kv.get("present");
    respondToLastRequest("stored");
    await expect(p1).resolves.toBe("stored");

    const p2 = kv.get("missing");
    respondToLastRequest(undefined);
    await expect(p2).resolves.toBeNull();
  });

  test("set forwards expireIn only when provided", async () => {
    const kv = kvAdapter;
    const p1 = kv.set("a", 1, { expireIn: 60 });
    expect(lastMessage().params).toEqual({ key: "a", value: 1, expireIn: 60 });
    respondToLastRequest(null);
    await p1;

    const p2 = kv.set("b", 2);
    expect(lastMessage().params).toEqual({ key: "b", value: 2 });
    respondToLastRequest(null);
    await p2;
  });

  test("delete accepts a single key or an array of keys", async () => {
    const kv = kvAdapter;
    const p1 = kv.delete("solo");
    expect(lastMessage()).toMatchObject({ method: "kv/del", params: { key: "solo" } });
    respondToLastRequest(null);
    await p1;

    const p2 = kv.delete(["a", "b"]);
    const delMessages = getWrittenMessages().filter((m) => m.method === "kv/del");
    expect(delMessages.map((m) => m.params?.key)).toEqual(["solo", "a", "b"]);
    for (const m of delMessages.slice(1)) {
      handleHostResponse({ id: m.id as number, result: null });
    }
    await expect(p2).resolves.toBeUndefined();
  });
});

describe("vectorAdapter", () => {
  test("upsert omits metadata when not provided", async () => {
    const vector = vectorAdapter;
    const p = vector.upsert("id-1", "text");
    expect(lastMessage()).toMatchObject({
      method: "vector/upsert",
      params: { id: "id-1", text: "text" },
    });
    expect(lastMessage().params).not.toHaveProperty("metadata");
    respondToLastRequest(null);
    await p;
  });

  test("query forwards topK and filter and returns matches", async () => {
    const vector = vectorAdapter;
    const matches = [{ id: "m1", score: 0.5, text: "hit" }];
    const p = vector.query("needle", { topK: 2, filter: { lang: "en" } });
    expect(lastMessage()).toMatchObject({
      method: "vector/query",
      params: { text: "needle", topK: 2, filter: { lang: "en" } },
    });
    respondToLastRequest(matches);
    await expect(p).resolves.toEqual(matches);
  });

  test("delete forwards ids", async () => {
    const vector = vectorAdapter;
    const p = vector.delete(["a", "b"]);
    expect(lastMessage()).toMatchObject({ method: "vector/delete", params: { ids: ["a", "b"] } });
    respondToLastRequest(null);
    await p;
  });
});
