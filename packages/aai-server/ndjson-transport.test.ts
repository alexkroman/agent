// Copyright 2025 the AAI authors. MIT license.

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNdjsonConnection } from "./ndjson-transport.ts";

// Helper: collect lines written to a writable stream
function collectLines(stream: PassThrough): string[] {
  const lines: string[] = [];
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split("\n")) {
      if (line.trim()) lines.push(line);
    }
  });
  return lines;
}

// Helper: write a JSON-RPC message to a readable stream
function writeMessage(stream: PassThrough, msg: unknown): void {
  stream.push(`${JSON.stringify(msg)}\n`);
}

describe("createNdjsonConnection", () => {
  let readable: PassThrough;
  let writable: PassThrough;
  let writtenLines: string[];

  beforeEach(() => {
    readable = new PassThrough();
    writable = new PassThrough();
    writtenLines = collectLines(writable);
  });

  afterEach(() => {
    readable.destroy();
    writable.destroy();
  });

  // ── sendRequest ──────────────────────────────────────────────────────────

  it("sends a JSON-RPC 2.0 request and resolves when matching response arrives", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const resultPromise = conn.sendRequest("ping", { foo: "bar" });

    // Wait for request to be written
    await vi.waitFor(() => writtenLines.length > 0);

    const sent = JSON.parse(writtenLines.at(0) ?? "");
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("ping");
    expect(sent.params).toEqual({ foo: "bar" });
    expect(typeof sent.id).toBe("number");

    // Send matching response back
    writeMessage(readable, { jsonrpc: "2.0", id: sent.id, result: { pong: true } });

    const result = await resultPromise;
    expect(result).toEqual({ pong: true });
  });

  it("auto-increments request ids", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const p1 = conn.sendRequest("a");
    const p2 = conn.sendRequest("b");

    await vi.waitFor(() => writtenLines.length >= 2);

    const msg1 = JSON.parse(writtenLines.at(0) ?? "");
    const msg2 = JSON.parse(writtenLines.at(1) ?? "");

    expect(msg1.id).not.toBe(msg2.id);

    // Resolve both so the test doesn't leak
    writeMessage(readable, { jsonrpc: "2.0", id: msg1.id, result: null });
    writeMessage(readable, { jsonrpc: "2.0", id: msg2.id, result: null });
    await Promise.all([p1, p2]);
  });

  // ── receive response error ───────────────────────────────────────────────

  it("rejects the request promise when a JSON-RPC error response arrives", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const resultPromise = conn.sendRequest("fail");

    await vi.waitFor(() => writtenLines.length > 0);
    const sent = JSON.parse(writtenLines.at(0) ?? "");

    writeMessage(readable, {
      jsonrpc: "2.0",
      id: sent.id,
      error: { code: -32_600, message: "Invalid request" },
    });

    await expect(resultPromise).rejects.toMatchObject({
      message: "Invalid request",
      code: -32_600,
    });
  });

  // ── incoming requests (host receives request, must reply) ────────────────

  it("dispatches incoming request to registered handler and sends response", async () => {
    const conn = createNdjsonConnection(readable, writable);

    conn.onRequest("kv/get", async (params: unknown) => {
      const p = params as { key: string };
      return { value: `got:${p.key}` };
    });

    conn.listen();

    // Guest sends a request to the host
    writeMessage(readable, { jsonrpc: "2.0", id: 42, method: "kv/get", params: { key: "x" } });

    // Host should write back a response
    await vi.waitFor(() => writtenLines.length > 0);

    const response = JSON.parse(writtenLines.at(0) ?? "");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(42);
    expect(response.result).toEqual({ value: "got:x" });
  });

  it("sends error response when incoming request handler throws", async () => {
    const conn = createNdjsonConnection(readable, writable);

    conn.onRequest("boom", async () => {
      throw new Error("handler exploded");
    });

    conn.listen();

    writeMessage(readable, { jsonrpc: "2.0", id: 7, method: "boom", params: {} });

    await vi.waitFor(() => writtenLines.length > 0);

    const response = JSON.parse(writtenLines.at(0) ?? "");
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(7);
    expect(response.error).toBeDefined();
    expect(response.error.message).toBe("handler exploded");
  });

  // ── notifications (no response expected) ────────────────────────────────

  it("sends a notification without an id field", () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    conn.sendNotification("shutdown");

    expect(writtenLines.length).toBe(1);
    const sent = JSON.parse(writtenLines.at(0) ?? "");
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("shutdown");
    expect(sent.id).toBeUndefined();
  });

  it("sends notification with params when provided", () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    conn.sendNotification("event", { type: "ping" });

    const sent = JSON.parse(writtenLines.at(0) ?? "");
    expect(sent.params).toEqual({ type: "ping" });
    expect(sent.id).toBeUndefined();
  });

  // ── incoming notifications ───────────────────────────────────────────────

  it("dispatches incoming notification to registered handler (no response sent)", async () => {
    const handler = vi.fn();
    const conn = createNdjsonConnection(readable, writable);

    conn.onNotification("event", handler);
    conn.listen();

    writeMessage(readable, { jsonrpc: "2.0", method: "event", params: { x: 1 } });

    await vi.waitFor(() => handler.mock.calls.length > 0);

    expect(handler).toHaveBeenCalledWith({ x: 1 });
    // No response should be written
    expect(writtenLines.length).toBe(0);
  });

  // ── concurrent requests (out-of-order responses) ─────────────────────────

  it("resolves concurrent requests correctly when responses arrive out of order", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const p1 = conn.sendRequest<string>("first");
    const p2 = conn.sendRequest<string>("second");
    const p3 = conn.sendRequest<string>("third");

    await vi.waitFor(() => writtenLines.length >= 3);

    const ids = writtenLines.map((l) => JSON.parse(l).id as number);
    const [id1, id2, id3] = ids;

    // Reply out of order: 3, 1, 2
    writeMessage(readable, { jsonrpc: "2.0", id: id3, result: "three" });
    writeMessage(readable, { jsonrpc: "2.0", id: id1, result: "one" });
    writeMessage(readable, { jsonrpc: "2.0", id: id2, result: "two" });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe("one");
    expect(r2).toBe("two");
    expect(r3).toBe("three");
  });

  // ── dispose ──────────────────────────────────────────────────────────────

  it("dispose rejects all pending requests", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const p1 = conn.sendRequest("slow1");
    const p2 = conn.sendRequest("slow2");

    await vi.waitFor(() => writtenLines.length >= 2);

    conn.dispose();

    await expect(p1).rejects.toThrow();
    await expect(p2).rejects.toThrow();
  });

  // ── envelope validation ─────────────────────────────────────────────────

  it("ignores response with non-numeric id", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const p = conn.sendRequest("test");
    await vi.waitFor(() => writtenLines.length > 0);
    const sent = JSON.parse(writtenLines.at(0) ?? "");

    // Send malformed response (string id) — should be ignored
    writeMessage(readable, { jsonrpc: "2.0", id: "bad", result: "nope" });
    // Send valid response to avoid hanging promise
    writeMessage(readable, { jsonrpc: "2.0", id: sent.id, result: "ok" });

    expect(await p).toBe("ok");
  });

  it("ignores response missing jsonrpc field", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const p = conn.sendRequest("test");
    await vi.waitFor(() => writtenLines.length > 0);
    const sent = JSON.parse(writtenLines.at(0) ?? "");

    // Missing jsonrpc field — should be ignored
    writeMessage(readable, { id: sent.id, result: "nope" });
    // Valid response
    writeMessage(readable, { jsonrpc: "2.0", id: sent.id, result: "ok" });

    expect(await p).toBe("ok");
  });

  it("ignores request with non-string method", async () => {
    const conn = createNdjsonConnection(readable, writable);
    conn.onRequest("valid", async () => "handled");
    conn.listen();

    // Malformed request (numeric method) — should be silently dropped
    writeMessage(readable, { jsonrpc: "2.0", id: 99, method: 123, params: {} });

    // Valid request
    writeMessage(readable, { jsonrpc: "2.0", id: 100, method: "valid", params: {} });
    await vi.waitFor(() => writtenLines.length > 0);

    const response = JSON.parse(writtenLines.at(0) ?? "");
    expect(response.id).toBe(100);
    expect(response.result).toBe("handled");
  });

  it("ignores non-object JSON values", () => {
    const handler = vi.fn();
    const conn = createNdjsonConnection(readable, writable);
    conn.onNotification("test", handler);
    conn.listen();

    // Array, number, string, null — all non-object, should be ignored
    writeMessage(readable, [1, 2, 3]);
    writeMessage(readable, 42);
    writeMessage(readable, "hello");
    writeMessage(readable, null);

    expect(handler).not.toHaveBeenCalled();
    expect(writtenLines.length).toBe(0);
  });
});
