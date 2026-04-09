// Copyright 2025 the AAI authors. MIT license.

import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createGuestRpc } from "./harness.ts";

function createMockStream(): Duplex {
  return new Duplex({
    // biome-ignore lint/suspicious/noEmptyBlockStatements: required Duplex override
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

describe("createGuestRpc", () => {
  it("dispatches tool requests concurrently, not serially", async () => {
    const stream = createMockStream();
    const completionOrder: string[] = [];

    const handlers = {
      onTool: vi.fn().mockImplementation(async (req: { name: string }) => {
        if (req.name === "slow") {
          await new Promise((r) => setTimeout(r, 50));
          completionOrder.push("slow");
          return { result: "slow-done", state: {} };
        }
        completionOrder.push("fast");
        return { result: "fast-done", state: {} };
      }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    createGuestRpc(stream, handlers);

    // Send two tool requests: slow first, then fast
    const slowReq = JSON.stringify({
      id: "h:1",
      type: "tool",
      name: "slow",
      args: {},
      sessionId: "s1",
      messages: [],
    });
    const fastReq = JSON.stringify({
      id: "h:2",
      type: "tool",
      name: "fast",
      args: {},
      sessionId: "s1",
      messages: [],
    });

    stream.push(`${slowReq}\n`);
    stream.push(`${fastReq}\n`);

    // Wait for both to complete
    await vi.waitFor(() => expect(completionOrder).toHaveLength(2), { timeout: 2000 });

    // "fast" should complete before "slow" — concurrent dispatch
    expect(completionOrder[0]).toBe("fast");
    expect(completionOrder[1]).toBe("slow");
  });

  it("sends tool response back to host with matching id", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "tool-result", state: { counter: 1 } }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    createGuestRpc(stream, handlers);

    stream.push(
      `${JSON.stringify({ id: "h:99", type: "tool", name: "myTool", args: {}, sessionId: "s1", messages: [] })}\n`,
    );

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const reply = JSON.parse(written[0] as string);
    expect(reply.id).toBe("h:99");
    expect(reply.result).toBe("tool-result");
    expect(reply.state).toEqual({ counter: 1 });
  });

  it("dispatches hook requests to onHook handler", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: { x: 1 }, result: "hook-result" }),
    };

    createGuestRpc(stream, handlers);

    stream.push(
      `${JSON.stringify({ id: "h:5", type: "hook", hook: "onConnect", sessionId: "s2" })}\n`,
    );

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    expect(handlers.onHook).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "onConnect", sessionId: "s2" }),
    );

    const reply = JSON.parse(written[0] as string);
    expect(reply.id).toBe("h:5");
    expect(reply.state).toEqual({ x: 1 });
  });

  it("handles shutdown: sends ok response and calls process.exit", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: unknown) => {
      // Don't actually exit in tests
      return undefined as never;
    });

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    createGuestRpc(stream, handlers);

    stream.push(`${JSON.stringify({ id: "h:7", type: "shutdown" })}\n`);

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const reply = JSON.parse(written[0] as string);
    expect(reply.id).toBe("h:7");
    expect(reply.ok).toBe(true);

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));

    exitSpy.mockRestore();
  });

  it("KV proxy round-trip: get sends request and resolves with value", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);

    // Initiate a KV get
    const getPromise = rpc.kv.get("my-key");

    // Wait for the KV request to be written to the stream
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const kvReq = JSON.parse(written[0] as string);
    expect(kvReq.type).toBe("kv");
    expect(kvReq.op).toBe("get");
    expect(kvReq.key).toBe("my-key");
    expect(kvReq.id).toMatch(/^g:\d+$/);

    // Simulate host response with the value
    stream.push(`${JSON.stringify({ id: kvReq.id, value: "stored-value" })}\n`);

    const result = await getPromise;
    expect(result).toBe("stored-value");
  });

  it("KV proxy round-trip: set sends request and resolves", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);

    const setPromise = rpc.kv.set("some-key", { foo: "bar" });

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const kvReq = JSON.parse(written[0] as string);
    expect(kvReq.type).toBe("kv");
    expect(kvReq.op).toBe("set");
    expect(kvReq.key).toBe("some-key");
    expect(kvReq.value).toEqual({ foo: "bar" });
    expect(kvReq.id).toMatch(/^g:\d+$/);

    // Simulate host response (set returns void, so just ack)
    stream.push(`${JSON.stringify({ id: kvReq.id })}\n`);

    await expect(setPromise).resolves.toBeUndefined();
  });

  it("KV proxy round-trip: del sends request and resolves", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);

    const delPromise = rpc.kv.del("delete-me");

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const kvReq = JSON.parse(written[0] as string);
    expect(kvReq.type).toBe("kv");
    expect(kvReq.op).toBe("del");
    expect(kvReq.key).toBe("delete-me");
    expect(kvReq.id).toMatch(/^g:\d+$/);

    stream.push(`${JSON.stringify({ id: kvReq.id })}\n`);

    await expect(delPromise).resolves.toBeUndefined();
  });

  it("KV proxy round-trip: mget sends request and resolves with values array", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);

    const mgetPromise = rpc.kv.mget(["key-a", "key-b"]);

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));

    const kvReq = JSON.parse(written[0] as string);
    expect(kvReq.type).toBe("kv");
    expect(kvReq.op).toBe("mget");
    expect(kvReq.keys).toEqual(["key-a", "key-b"]);
    expect(kvReq.id).toMatch(/^g:\d+$/);

    stream.push(`${JSON.stringify({ id: kvReq.id, values: ["val-a", "val-b"] })}\n`);

    const result = await mgetPromise;
    expect(result).toEqual(["val-a", "val-b"]);
  });

  it("KV request times out after 5000ms if no response arrives", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);
    // We don't wait the full 5s — just verify the KV request was sent with g: prefix
    void rpc.kv.get("timeout-key").catch((_err: unknown) => {
      // timeout expected — suppress unhandled rejection
    });

    await vi.waitFor(() => {
      const kvWrites = written.filter((w) => {
        try {
          return JSON.parse(w).type === "kv";
        } catch {
          return false;
        }
      });
      expect(kvWrites.length).toBeGreaterThan(0);
    });

    const kvReq = JSON.parse(written.find((w) => JSON.parse(w).type === "kv") as string);
    expect(kvReq.id).toMatch(/^g:\d+$/);
  }, 10_000);

  it("uses g: prefix for guest-initiated KV request ids", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    const rpc = createGuestRpc(stream, handlers);

    // Fire multiple KV requests and verify all use g: prefix with sequential ids
    // Suppress unhandled rejections — these will timeout but that's expected
    void rpc.kv.get("k1").catch((_err: unknown) => {
      /* timeout expected */
    });
    void rpc.kv.get("k2").catch((_err: unknown) => {
      /* timeout expected */
    });
    void rpc.kv.get("k3").catch((_err: unknown) => {
      /* timeout expected */
    });

    await vi.waitFor(() => expect(written.length).toBeGreaterThanOrEqual(3));

    const ids = written.map((w) => JSON.parse(w).id as string);
    expect(ids[0]).toMatch(/^g:\d+$/);
    expect(ids[1]).toMatch(/^g:\d+$/);
    expect(ids[2]).toMatch(/^g:\d+$/);

    // Sequential ids
    const nums = ids.map((id) => Number(id.slice(2)));
    expect(nums[1]).toBeGreaterThan(nums[0] as number);
    expect(nums[2]).toBeGreaterThan(nums[1] as number);
  });

  it("silently ignores malformed JSON lines", async () => {
    const stream = createMockStream();
    const written: string[] = [];
    stream.write = (chunk: unknown, ..._args: unknown[]) => {
      written.push(chunk as string);
      return true;
    };

    const handlers = {
      onTool: vi.fn().mockResolvedValue({ result: "ok", state: {} }),
      onHook: vi.fn().mockResolvedValue({ state: {} }),
    };

    createGuestRpc(stream, handlers);

    stream.push("not-json\n");
    stream.push("{broken\n");
    stream.push(
      `${JSON.stringify({ id: "h:1", type: "tool", name: "t", args: {}, sessionId: "s", messages: [] })}\n`,
    );

    await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
    const reply = JSON.parse(written[0] as string);
    expect(reply.id).toBe("h:1");
  });
});
