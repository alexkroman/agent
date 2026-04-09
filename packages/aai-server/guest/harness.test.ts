// Copyright 2025 the AAI authors. MIT license.

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { createGuestConnection } from "./harness.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a connected pair of vscode-jsonrpc connections that talk to each
 * other via PassThrough streams. Returns both connections so tests can play
 * the role of both host and guest.
 *
 * guestConn reads from hostToGuest, writes to guestToHost.
 * hostConn reads from guestToHost, writes to hostToGuest.
 */
function createConnectedPair() {
  const guestToHost = new PassThrough();
  const hostToGuest = new PassThrough();

  const guestConn = createMessageConnection(
    new StreamMessageReader(hostToGuest),
    new StreamMessageWriter(guestToHost),
  );

  const hostConn = createMessageConnection(
    new StreamMessageReader(guestToHost),
    new StreamMessageWriter(hostToGuest),
  );

  guestConn.listen();
  hostConn.listen();

  return { guestConn, hostConn, guestToHost, hostToGuest };
}

describe("createGuestConnection", () => {
  it("returns a connection and kv proxy", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    expect(conn).toBeDefined();
    expect(typeof conn.sendRequest).toBe("function");
    expect(typeof conn.onRequest).toBe("function");
    expect(typeof kv.get).toBe("function");
    expect(typeof kv.set).toBe("function");
    expect(typeof kv.del).toBe("function");

    conn.dispose();
  });

  it("KV proxy get — sends kv/get request and resolves with value", async () => {
    const { guestConn, hostConn } = createConnectedPair();
    const guestToHost = new PassThrough();
    const hostToGuest = new PassThrough();

    // Use createGuestConnection with its own stream pair
    const input2 = new PassThrough();
    const output2 = new PassThrough();
    const { conn, kv } = createGuestConnection(input2, output2);

    // Host side reads from output2 (what guest writes) and writes to input2 (what guest reads)
    const hostSide = createMessageConnection(
      new StreamMessageReader(output2),
      new StreamMessageWriter(input2),
    );
    hostSide.onRequest("kv/get", (params: { key: string }) => {
      expect(params.key).toBe("my-key");
      return { value: "stored-value" };
    });
    hostSide.listen();
    conn.listen();

    const result = await kv.get("my-key");
    expect(result).toBe("stored-value");

    conn.dispose();
    hostSide.dispose();
    // Cleanup unused vars
    void guestConn;
    void hostConn;
    void guestToHost;
    void hostToGuest;
  });

  it("KV proxy get — returns null when host returns undefined value", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/get", () => {
      return {}; // no value field
    });
    hostSide.listen();
    conn.listen();

    const result = await kv.get("missing-key");
    expect(result).toBeNull();

    conn.dispose();
    hostSide.dispose();
  });

  it("KV proxy set — sends kv/set request with key, value, and expireIn", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    let received: Record<string, unknown> | undefined;
    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/set", (params: Record<string, unknown>) => {
      received = params;
      return {};
    });
    hostSide.listen();
    conn.listen();

    await kv.set("some-key", { foo: "bar" }, { expireIn: 3600 });

    expect(received).toMatchObject({ key: "some-key", value: { foo: "bar" }, expireIn: 3600 });

    conn.dispose();
    hostSide.dispose();
  });

  it("KV proxy set — sends kv/set without expireIn when not specified", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    let received: Record<string, unknown> | undefined;
    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/set", (params: Record<string, unknown>) => {
      received = params;
      return {};
    });
    hostSide.listen();
    conn.listen();

    await kv.set("k", "v");
    expect(received?.key).toBe("k");
    expect(received?.value).toBe("v");

    conn.dispose();
    hostSide.dispose();
  });

  it("KV proxy del — sends kv/del request and resolves", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    let deletedKey: string | undefined;
    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/del", (params: { key: string }) => {
      deletedKey = params.key;
      return {};
    });
    hostSide.listen();
    conn.listen();

    await kv.del("delete-me");
    expect(deletedKey).toBe("delete-me");

    conn.dispose();
    hostSide.dispose();
  });
});

describe("guest connection RPC dispatch", () => {
  it("tool/execute — dispatched to handler and response returned", async () => {
    const { guestConn, hostConn } = createConnectedPair();

    const toolResult = { result: "tool-output", state: { count: 1 } };
    guestConn.onRequest("tool/execute", () => toolResult);

    const response = await hostConn.sendRequest("tool/execute", {
      name: "myTool",
      args: { x: 1 },
      sessionId: "s1",
      messages: [],
    });

    expect(response).toEqual(toolResult);

    guestConn.dispose();
    hostConn.dispose();
  });

  it("hook/invoke — dispatched to handler and response returned", async () => {
    const { guestConn, hostConn } = createConnectedPair();

    const hookResult = { state: { x: 1 }, result: "hook-output" };
    guestConn.onRequest("hook/invoke", () => hookResult);

    const response = await hostConn.sendRequest("hook/invoke", {
      hook: "onConnect",
      sessionId: "s2",
    });

    expect(response).toEqual(hookResult);

    guestConn.dispose();
    hostConn.dispose();
  });

  it("concurrent tool requests — fast completes before slow", async () => {
    const { guestConn, hostConn } = createConnectedPair();
    const completionOrder: string[] = [];

    guestConn.onRequest("tool/execute", async (params: { name: string }) => {
      if (params.name === "slow") {
        await new Promise((r) => setTimeout(r, 50));
        completionOrder.push("slow");
        return { result: "slow-done", state: {} };
      }
      completionOrder.push("fast");
      return { result: "fast-done", state: {} };
    });

    // Fire both requests concurrently
    const [slowResult, fastResult] = await Promise.all([
      hostConn.sendRequest("tool/execute", {
        name: "slow",
        args: {},
        sessionId: "s1",
        messages: [],
      }),
      hostConn.sendRequest("tool/execute", {
        name: "fast",
        args: {},
        sessionId: "s1",
        messages: [],
      }),
    ]);

    expect(slowResult).toEqual({ result: "slow-done", state: {} });
    expect(fastResult).toEqual({ result: "fast-done", state: {} });

    // fast should have completed before slow (concurrent dispatch)
    expect(completionOrder[0]).toBe("fast");
    expect(completionOrder[1]).toBe("slow");

    guestConn.dispose();
    hostConn.dispose();
  });

  it("shutdown notification — disposes connection and calls process.exit", async () => {
    const { guestConn, hostConn } = createConnectedPair();

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: unknown) => undefined as never);
    const disposeSpy = vi.spyOn(guestConn, "dispose");

    guestConn.onNotification("shutdown", () => {
      guestConn.dispose();
      process.exit(0);
    });

    hostConn.sendNotification("shutdown");

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(disposeSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    hostConn.dispose();
  });
});

describe("full RPC round-trip via createGuestConnection", () => {
  it("kv/get round-trip returns correct value", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);

    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/get", (_params: { key: string }) => ({ value: 42 }));
    hostSide.listen();
    conn.listen();

    const result = await kv.get("answer");
    expect(result).toBe(42);

    conn.dispose();
    hostSide.dispose();
  });

  it("multiple sequential kv operations complete in order", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { conn, kv } = createGuestConnection(input, output);
    const store = new Map<string, unknown>();

    const hostSide = createMessageConnection(
      new StreamMessageReader(output),
      new StreamMessageWriter(input),
    );
    hostSide.onRequest("kv/set", (params: { key: string; value: unknown }) => {
      store.set(params.key, params.value);
      return {};
    });
    hostSide.onRequest("kv/get", (params: { key: string }) => ({
      value: store.get(params.key) ?? null,
    }));
    hostSide.onRequest("kv/del", (params: { key: string }) => {
      store.delete(params.key);
      return {};
    });
    hostSide.listen();
    conn.listen();

    await kv.set("foo", "bar");
    expect(await kv.get("foo")).toBe("bar");
    await kv.del("foo");
    expect(await kv.get("foo")).toBeNull();

    conn.dispose();
    hostSide.dispose();
  });
});
