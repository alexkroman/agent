import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BridgedWebSocket,
  CapnwebEndpoint,
  type CapnwebPort,
  deserializeRequest,
  deserializeResponse,
  serializeRequest,
  serializeResponse,
} from "./capnweb.ts";

// ─── Polyfills for Node (CloseEvent / ErrorEvent) ───────────────────────────

if (typeof globalThis.CloseEvent === "undefined") {
  // biome-ignore lint/suspicious/noExplicitAny: polyfill for test environment
  (globalThis as any).CloseEvent = class CloseEvent extends Event {
    code: number;
    reason: string;
    wasClean: boolean;
    constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
      super(type);
      this.code = init?.code ?? 0;
      this.reason = init?.reason ?? "";
      this.wasClean = init?.wasClean ?? false;
    }
  };
}

if (typeof globalThis.ErrorEvent === "undefined") {
  // biome-ignore lint/suspicious/noExplicitAny: polyfill for test environment
  (globalThis as any).ErrorEvent = class ErrorEvent extends Event {
    message: string;
    constructor(type: string, init?: { message?: string }) {
      super(type);
      this.message = init?.message ?? "";
    }
  };
}

// ─── Mock MessagePort pair ──────────────────────────────────────────────────

function createMockChannel(): { port1: CapnwebPort; port2: CapnwebPort } {
  const port1: CapnwebPort = {
    onmessage: null,
    postMessage(msg: unknown, transfer?: Transferable[]) {
      setTimeout(
        () =>
          port2.onmessage?.({
            data: msg,
            ports: (transfer?.filter((t) => t instanceof MessagePort) ?? []) as MessagePort[],
          } as unknown as MessageEvent),
        0,
      );
    },
  };
  const port2: CapnwebPort = {
    onmessage: null,
    postMessage(msg: unknown, transfer?: Transferable[]) {
      setTimeout(
        () =>
          port1.onmessage?.({
            data: msg,
            ports: (transfer?.filter((t) => t instanceof MessagePort) ?? []) as MessagePort[],
          } as unknown as MessageEvent),
        0,
      );
    },
  };
  return { port1, port2 };
}

// ─── CapnwebEndpoint ────────────────────────────────────────────────────────

describe("CapnwebEndpoint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("call/handle RPC round-trip", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    const ep2 = new CapnwebEndpoint(port2);

    ep2.handle("add", (args) => (args[0] as number) + (args[1] as number));

    const promise = ep1.call("add", [3, 4]);
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result).toBe(7);
  });

  test("call/handle with async handler", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    const ep2 = new CapnwebEndpoint(port2);

    ep2.handle("greet", async (args) => `Hello, ${args[0]}`);

    const promise = ep1.call("greet", ["world"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await promise).toBe("Hello, world");
  });

  test("notify does not return a response", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    const ep2 = new CapnwebEndpoint(port2);

    const calls: unknown[][] = [];
    ep2.handle("log", (args) => {
      calls.push(args);
    });

    ep1.notify("log", ["info", "test message"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["info", "test message"]]);
  });

  test("handler error rejects the caller", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    const ep2 = new CapnwebEndpoint(port2);

    ep2.handle("fail", () => {
      throw new Error("boom");
    });

    const promise = ep1.call("fail", []).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
  });

  test("unknown method rejects the caller", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    new CapnwebEndpoint(port2); // ep2 with no handlers

    const promise = ep1.call("missing", []).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("No handler for missing");
  });

  test("non-RPC messages are ignored", async () => {
    const { port1, port2 } = createMockChannel();
    const ep1 = new CapnwebEndpoint(port1);
    const ep2 = new CapnwebEndpoint(port2);

    ep2.handle("echo", (args) => args[0]);

    // Send garbage directly
    port1.postMessage("not an rpc message");
    port1.postMessage({ random: true });
    port1.postMessage(null);

    // Real call still works
    const promise = ep1.call("echo", [42]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await promise).toBe(42);
  });
});

// ─── Serialization round-trips ──────────────────────────────────────────────

describe("serializeRequest / deserializeRequest", () => {
  test("round-trip GET request without body", async () => {
    const original = new Request("https://example.com/api", { method: "GET" });
    const serialized = await serializeRequest(original);
    const restored = deserializeRequest(serialized);

    expect(restored.url).toBe("https://example.com/api");
    expect(restored.method).toBe("GET");
    expect(restored.body).toBeNull();
  });

  test("round-trip POST request with body and headers", async () => {
    const original = new Request("https://example.com/data", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "value" },
      body: JSON.stringify({ key: "value" }),
    });
    const serialized = await serializeRequest(original);
    const restored = deserializeRequest(serialized);

    expect(restored.url).toBe("https://example.com/data");
    expect(restored.method).toBe("POST");
    expect(restored.headers.get("content-type")).toBe("application/json");
    expect(restored.headers.get("x-custom")).toBe("value");
    expect(await restored.text()).toBe('{"key":"value"}');
  });

  test("serialized form is a tuple of [url, method, headers, body]", async () => {
    const req = new Request("https://test.com", { method: "PUT", body: "hello" });
    const s = await serializeRequest(req);
    expect(s).toHaveLength(4);
    expect(s[0]).toBe("https://test.com/");
    expect(s[1]).toBe("PUT");
    expect(typeof s[2]).toBe("object");
    expect(s[3]).toBe("hello");
  });
});

describe("serializeResponse / deserializeResponse", () => {
  test("round-trip 200 response with body", async () => {
    const original = new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const serialized = await serializeResponse(original);
    const restored = deserializeResponse(serialized);

    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toBe("text/plain");
    expect(await restored.text()).toBe("OK");
  });

  test("round-trip 404 response", async () => {
    const original = new Response("Not Found", { status: 404 });
    const serialized = await serializeResponse(original);
    const restored = deserializeResponse(serialized);

    expect(restored.status).toBe(404);
    expect(await restored.text()).toBe("Not Found");
  });

  test("serialized form has status, headers, body", async () => {
    const resp = new Response("test", { status: 201, headers: { "X-Id": "1" } });
    const s = await serializeResponse(resp);
    expect(s.status).toBe(201);
    expect(s.headers["x-id"]).toBe("1");
    expect(s.body).toBe("test");
  });
});

// ─── BridgedWebSocket ───────────────────────────────────────────────────────

describe("BridgedWebSocket", () => {
  function createMockPort() {
    const sent: { msg: unknown; transfer?: Transferable[] | undefined }[] = [];
    const port: MessagePort = {
      onmessage: null,
      postMessage(msg: unknown, transfer?: Transferable[]) {
        sent.push({ msg, transfer });
      },
    } as unknown as MessagePort;
    return { port, sent };
  }

  function deliver(port: MessagePort, data: unknown) {
    (port as unknown as { onmessage: ((ev: MessageEvent) => void) | null }).onmessage?.({
      data,
      ports: [],
    } as unknown as MessageEvent);
  }

  test("open bridge message sets readyState to 1 and dispatches open event", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);
    expect(ws.readyState).toBe(0);

    const onOpen = vi.fn();
    ws.addEventListener("open", onOpen);

    deliver(port, { k: 3 });
    expect(ws.readyState).toBe(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test("data bridge message dispatches message event with string", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);

    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    deliver(port, { k: 0, d: "hello" });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0].data).toBe("hello");
  });

  test("data bridge message dispatches message event with ArrayBuffer", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);

    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    const buf = new ArrayBuffer(4);
    deliver(port, { k: 0, d: buf });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0].data).toBe(buf);
  });

  test("close bridge message sets readyState to 3 and dispatches close event", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open first

    const onClose = vi.fn();
    ws.addEventListener("close", onClose);

    deliver(port, { k: 2, code: 1000, reason: "normal" });
    expect(ws.readyState).toBe(3);
    expect(onClose).toHaveBeenCalledTimes(1);
    const ev = onClose.mock.calls[0]?.[0] as CloseEvent;
    expect(ev.code).toBe(1000);
    expect(ev.reason).toBe("normal");
  });

  test("error bridge message dispatches error event", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);

    const onError = vi.fn();
    ws.addEventListener("error", onError);

    deliver(port, { k: 4, m: "connection failed" });
    expect(onError).toHaveBeenCalledTimes(1);
    const ev = onError.mock.calls[0]?.[0] as ErrorEvent;
    expect(ev.message).toBe("connection failed");
  });

  test("send string when open posts data bridge message", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open

    ws.send("test");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toEqual({ k: 0, d: "test" });
  });

  test("send ArrayBuffer when open posts data with transfer", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open

    const buf = new ArrayBuffer(8);
    ws.send(buf);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.msg as { k: number }).k).toBe(0);
    expect((sent[0]?.msg as { d: unknown }).d).toBeInstanceOf(ArrayBuffer);
    expect(sent[0]?.transfer).toEqual([buf]);
  });

  test("send Uint8Array when open posts sliced ArrayBuffer with transfer", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open

    const arr = new Uint8Array([1, 2, 3, 4]);
    ws.send(arr);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.msg as { k: number }).k).toBe(0);
    expect((sent[0]?.msg as { d: unknown }).d).toBeInstanceOf(ArrayBuffer);
    expect(sent[0]?.transfer).toHaveLength(1);
  });

  test("send is ignored when readyState is not OPEN", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    // readyState is 0 (CONNECTING)

    ws.send("should be dropped");
    expect(sent).toHaveLength(0);
  });

  test("close posts close bridge message and sets readyState to 2", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open

    ws.close(1000, "done");
    expect(ws.readyState).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toEqual({ k: 2, code: 1000, reason: "done" });
  });

  test("close is ignored when readyState >= 2", () => {
    const { port, sent } = createMockPort();
    const ws = new BridgedWebSocket(port);
    deliver(port, { k: 3 }); // open

    ws.close(1000);
    const countAfterFirst = sent.length;
    ws.close(1001); // should be ignored
    expect(sent).toHaveLength(countAfterFirst);
  });

  test("non-bridge messages are ignored", () => {
    const { port } = createMockPort();
    const ws = new BridgedWebSocket(port);

    const onMessage = vi.fn();
    ws.addEventListener("message", onMessage);

    deliver(port, "not a bridge message");
    deliver(port, { random: true });
    deliver(port, null);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
