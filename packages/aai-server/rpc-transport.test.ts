// Copyright 2025 the AAI authors. MIT license.
/**
 * Tests for the WebSocket JSON-RPC transport — framing, correlation,
 * timeouts, pre-listen buffering, and dead-peer semantics, all against the
 * fake socket from _sandbox-vm-test-utils.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { createFakeGuestSocket } from "./_sandbox-vm-test-utils.ts";
import { createRpcConnection } from "./rpc-transport.ts";
import { captureLogs } from "./test-utils.ts";

describe("createRpcConnection", () => {
  const logs = captureLogs();

  it("correlates a request with its response", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();

    const pending = conn.sendRequest("hello", { a: 1 });
    const req = socket.sentMessages().find((m) => m.method === "hello");
    expect(req?.params).toEqual({ a: 1 });

    socket.receive({ jsonrpc: "2.0", id: req?.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects a request when the peer answers with an error", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();

    const pending = conn.sendRequest("hello");
    const req = socket.sentMessages().find((m) => m.method === "hello");
    socket.receive({ jsonrpc: "2.0", id: req?.id, error: { code: -32_000, message: "boom" } });
    await expect(pending).rejects.toThrow(/boom/);
  });

  it("times out a request the peer never answers", async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeGuestSocket();
      const conn = createRpcConnection(socket.ws);
      conn.listen();
      const pending = conn.sendRequest("hello", undefined, 1000);
      const assertion = expect(pending).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches incoming requests to registered handlers", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.onRequest("sum", (params) => {
      const { a, b } = params as { a: number; b: number };
      return a + b;
    });
    conn.listen();

    socket.receive({ jsonrpc: "2.0", id: 7, method: "sum", params: { a: 2, b: 3 } });
    await vi.waitFor(() => {
      const resp = socket.sentMessages().find((m) => m.id === 7);
      expect(resp?.result).toBe(5);
    });
  });

  it("answers unknown methods with -32601 naming the method", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();

    socket.receive({ jsonrpc: "2.0", id: 9, method: "nope" });
    await vi.waitFor(() => {
      const resp = socket.sentMessages().find((m) => m.id === 9) as
        | { error?: { code: number; message: string } }
        | undefined;
      expect(resp?.error?.code).toBe(-32_601);
      expect(resp?.error?.message).toContain("nope");
    });
  });

  it("maps handler throws to -32603 with the thrown message", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.onRequest("explode", () => {
      throw new Error("kaboom");
    });
    conn.listen();

    socket.receive({ jsonrpc: "2.0", id: 11, method: "explode" });
    await vi.waitFor(() => {
      const resp = socket.sentMessages().find((m) => m.id === 11) as
        | { error?: { code: number; message: string } }
        | undefined;
      expect(resp?.error?.code).toBe(-32_603);
      expect(resp?.error?.message).toBe("kaboom");
    });
  });

  it("buffers frames received before listen() and replays them", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    // Arrives before any handler could be registered…
    socket.receive({ jsonrpc: "2.0", id: 3, method: "early", params: { x: 1 } });
    // …handler registration and listen happen later; nothing is lost.
    conn.onRequest("early", (params) => params);
    conn.listen();
    await vi.waitFor(() => {
      const resp = socket.sentMessages().find((m) => m.id === 3);
      expect(resp?.result).toEqual({ x: 1 });
    });
  });

  it("caps the pre-listen buffer, keeping the OLDEST frames", async () => {
    // "The guest sends nothing unprompted" is a property of the peer, and the
    // peer is a sandbox running tenant code. Overflow drops the NEWEST frame:
    // this is a replay buffer, so the first frame is the one a handler is
    // waiting for — a ring would discard exactly the wrong end.
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    const flood = 200;
    for (let id = 0; id < flood; id++) {
      socket.receive({ jsonrpc: "2.0", id, method: "early", params: { id } });
    }
    conn.onRequest("early", (params) => params);
    conn.listen();

    await vi.waitFor(() => {
      // The first frame survived...
      expect(socket.sentMessages().find((m) => m.id === 0)?.result).toEqual({ id: 0 });
    });
    // ...the last did not, and the replay is bounded rather than the flood's size.
    expect(socket.sentMessages().find((m) => m.id === flood - 1)).toBeUndefined();
    expect(socket.sentMessages().length).toBeLessThan(flood);
    expect(logs.warns().join("\n")).toContain("before listen()");
  });

  it("routes notifications and contains handler throws", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    const seen: unknown[] = [];
    conn.onNotification("evt", (params) => {
      seen.push(params);
      throw new Error("handler bug");
    });
    conn.listen();

    socket.receive({ jsonrpc: "2.0", method: "evt", params: { p: 1 } });
    expect(seen).toEqual([{ p: 1 }]);
    expect(logs.all()).toContainEqual(
      expect.objectContaining({ level: "error", ctx: { error: "handler bug" } }),
    );
  });

  it("ignores malformed frames", () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();
    expect(() => {
      socket.receive("not json{{");
      socket.receive({ nothing: true });
    }).not.toThrow();
  });

  it("rejects pending requests when the socket closes", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();
    const pending = conn.sendRequest("hello");
    socket.close();
    await expect(pending).rejects.toThrow(/Connection closed/);
  });

  it("dispose rejects pending requests and closes the socket", async () => {
    const socket = createFakeGuestSocket();
    const conn = createRpcConnection(socket.ws);
    conn.listen();
    const pending = conn.sendRequest("hello");
    conn.dispose();
    await expect(pending).rejects.toThrow(/Connection disposed/);
    expect(socket.ws.readyState).not.toBe(socket.ws.OPEN);
    // Further sends are no-ops, not throws.
    expect(() => conn.sendNotification("evt")).not.toThrow();
    await expect(conn.sendRequest("hello")).rejects.toThrow(/disposed/);
  });
});
