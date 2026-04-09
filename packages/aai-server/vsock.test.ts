// Copyright 2025 the AAI authors. MIT license.

import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRpcChannel } from "./vsock.ts";

function createMockStream(): Duplex {
  return new Duplex({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: required Duplex override
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

describe("createRpcChannel", () => {
  it("sends a request and resolves when matching response arrives", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const channel = createRpcChannel(stream);

    const responsePromise = channel.request({ type: "ping" });

    // Parse what was written to get the id
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    const sent = JSON.parse(written[0] as string);
    expect(sent.type).toBe("ping");
    expect(sent.id).toMatch(/^h:\d+$/);

    // Simulate incoming response
    stream.push(`${JSON.stringify({ id: sent.id, result: "pong" })}\n`);

    const response = await responsePromise;
    expect(response.id).toBe(sent.id);
    expect(response.result).toBe("pong");
  });

  it("rejects with timeout error when no response arrives", async () => {
    const stream = createMockStream();
    const channel = createRpcChannel(stream);

    await expect(channel.request({ type: "slow-op" }, { timeout: 50 })).rejects.toThrow(
      "RPC timeout after 50ms: slow-op",
    );
  });

  it("handles concurrent requests with out-of-order responses", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const channel = createRpcChannel(stream);

    const p1 = channel.request({ type: "op-a" });
    const p2 = channel.request({ type: "op-b" });
    const p3 = channel.request({ type: "op-c" });

    await vi.waitFor(() => expect(written.length).toBe(3));

    const msgs = written.map((w) => JSON.parse(w));
    const ids = msgs.map((m) => m.id);

    // Send responses out of order: c, a, b
    stream.push(`${JSON.stringify({ id: ids[2], value: "c-result" })}\n`);
    stream.push(`${JSON.stringify({ id: ids[0], value: "a-result" })}\n`);
    stream.push(`${JSON.stringify({ id: ids[1], value: "b-result" })}\n`);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.value).toBe("a-result");
    expect(r2.value).toBe("b-result");
    expect(r3.value).toBe("c-result");
  });

  it("silently ignores malformed JSON lines", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const channel = createRpcChannel(stream);
    const responsePromise = channel.request({ type: "ping" });

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    const sent = JSON.parse(written[0] as string);

    // Push malformed lines — should not throw or crash
    stream.push("not json at all\n");
    stream.push("{broken\n");
    stream.push(`${JSON.stringify({ id: sent.id, ok: true })}\n`);

    const response = await responsePromise;
    expect(response.ok).toBe(true);
  });

  it("rejects all pending requests when stream closes", async () => {
    const stream = createMockStream();
    const channel = createRpcChannel(stream);

    const p1 = channel.request({ type: "op-a" }, { timeout: 5000 });
    const p2 = channel.request({ type: "op-b" }, { timeout: 5000 });

    // Simulate stream close
    stream.destroy();

    await expect(p1).rejects.toThrow("Connection closed");
    await expect(p2).rejects.toThrow("Connection closed");
  });

  it("dispatches incoming requests to registered handlers and sends response", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const channel = createRpcChannel(stream);
    const handler = vi.fn().mockResolvedValue({ status: "done" });
    channel.onRequest("execute", handler);

    // Simulate incoming request from peer
    stream.push(`${JSON.stringify({ id: "g:1", type: "execute", payload: "some-code" })}\n`);

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "execute", payload: "some-code", id: "g:1" }),
    );

    const reply = JSON.parse(written[0] as string);
    expect(reply.id).toBe("g:1");
    expect(reply.status).toBe("done");
  });

  it("notify sends a fire-and-forget message with no id", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const channel = createRpcChannel(stream);
    channel.notify({ type: "heartbeat", tick: 42 });

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    const msg = JSON.parse(written[0] as string);
    expect(msg.type).toBe("heartbeat");
    expect(msg.tick).toBe(42);
    expect(msg.id).toBeUndefined();
  });

  it("close rejects all pending requests and tears down the channel", async () => {
    const stream = createMockStream();
    const channel = createRpcChannel(stream);

    const p1 = channel.request({ type: "op-a" }, { timeout: 5000 });
    channel.close();

    await expect(p1).rejects.toThrow("Connection closed");
  });
});
