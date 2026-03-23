import { describe, expect, test, vi } from "vitest";
import {
  BridgedWebSocket,
  createRpcSession,
  isTransferMessage,
  RpcTarget,
  sendTransfer,
  type WorkerPort,
  WorkerPortTransport,
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

// ─── Mock WorkerPort pair ────────────────────────────────────────────────────

function createMockPortPair(): { port1: WorkerPort; port2: WorkerPort } {
  type Listener = (ev: MessageEvent) => void;
  const listeners1: Listener[] = [];
  const listeners2: Listener[] = [];

  const port1: WorkerPort = {
    addEventListener(_type: string, listener: (ev: MessageEvent) => void) {
      listeners1.push(listener);
    },
    postMessage(msg: unknown, transfer?: Transferable[]) {
      const ports = (transfer?.filter((t) => "postMessage" in t) ?? []) as MessagePort[];
      setTimeout(() => {
        const ev = { data: msg, ports } as unknown as MessageEvent;
        for (const l of listeners2) l(ev);
      }, 0);
    },
  };

  const port2: WorkerPort = {
    addEventListener(_type: string, listener: (ev: MessageEvent) => void) {
      listeners2.push(listener);
    },
    postMessage(msg: unknown, transfer?: Transferable[]) {
      const ports = (transfer?.filter((t) => "postMessage" in t) ?? []) as MessagePort[];
      setTimeout(() => {
        const ev = { data: msg, ports } as unknown as MessageEvent;
        for (const l of listeners1) l(ev);
      }, 0);
    },
  };

  return { port1, port2 };
}

// ─── WorkerPortTransport ────────────────────────────────────────────────────

describe("WorkerPortTransport", () => {
  test("sends and receives string messages", async () => {
    const { port1, port2 } = createMockPortPair();
    const t1 = new WorkerPortTransport(port1);
    const t2 = new WorkerPortTransport(port2);

    const receivePromise = t2.receive();
    await t1.send("hello");
    await vi.waitFor(async () => {
      expect(await receivePromise).toBe("hello");
    });
  });

  test("queues messages received before receive() is called", async () => {
    const { port1, port2 } = createMockPortPair();
    const t1 = new WorkerPortTransport(port1);
    const t2 = new WorkerPortTransport(port2);

    await t1.send("first");
    await t1.send("second");

    // Wait for messages to be delivered
    await new Promise((r) => setTimeout(r, 10));

    expect(await t2.receive()).toBe("first");
    expect(await t2.receive()).toBe("second");
  });

  test("forwards non-string messages to onNonRpc callback", async () => {
    const { port1, port2 } = createMockPortPair();
    const received: unknown[] = [];
    new WorkerPortTransport(port1, (data) => received.push(data));
    // Send an object directly (not through RPC)
    port2.postMessage({ _t: "test", value: 42 });

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([{ _t: "test", value: 42 }]);
  });

  test("null message causes receive to reject", async () => {
    const { port1, port2 } = createMockPortPair();
    const t1 = new WorkerPortTransport(port1);

    const receivePromise = t1.receive();
    port2.postMessage(null);

    await expect(vi.waitFor(() => receivePromise)).rejects.toThrow("Peer closed connection.");
  });
});

// ─── RPC Session with RpcTarget ─────────────────────────────────────────────

describe("createRpcSession", () => {
  test("call method on remote RpcTarget", async () => {
    class Adder extends RpcTarget {
      add(a: number, b: number) {
        return a + b;
      }
    }

    const { port1, port2 } = createMockPortPair();
    createRpcSession({ port: port1, localMain: new Adder() });
    // Port2 needs its own session to talk back
    const stub2 = createRpcSession({ port: port2 });

    // stub2 calls methods on Adder (which is localMain on port1's session)
    const result = await stub2.add(3, 4);
    expect(result).toBe(7);
  });

  test("bidirectional RPC", async () => {
    class HostSvc extends RpcTarget {
      greet(name: string) {
        return `Hello, ${name}`;
      }
    }

    class WorkerSvc extends RpcTarget {
      echo(msg: string) {
        return msg.toUpperCase();
      }
    }

    const { port1, port2 } = createMockPortPair();
    const workerStub = createRpcSession({
      port: port1,
      localMain: new HostSvc(),
    });
    const hostStub = createRpcSession({
      port: port2,
      localMain: new WorkerSvc(),
    });

    expect(await workerStub.echo("hello")).toBe("HELLO");
    expect(await hostStub.greet("world")).toBe("Hello, world");
  });

  test("async method on RpcTarget", async () => {
    class AsyncService extends RpcTarget {
      async delayedAdd(a: number, b: number) {
        await new Promise((r) => setTimeout(r, 5));
        return a + b;
      }
    }

    const { port1, port2 } = createMockPortPair();
    createRpcSession({ port: port1, localMain: new AsyncService() });
    const stub = createRpcSession({ port: port2 });

    expect(await stub.delayedAdd(10, 20)).toBe(30);
  });

  test("error from remote method rejects the caller", async () => {
    class FailService extends RpcTarget {
      fail() {
        throw new Error("boom");
      }
    }

    const { port1, port2 } = createMockPortPair();
    createRpcSession({ port: port1, localMain: new FailService() });
    const stub = createRpcSession({ port: port2 });

    await expect(stub.fail()).rejects.toThrow();
  });
});

// ─── TransferMessage ────────────────────────────────────────────────────────

describe("isTransferMessage", () => {
  test("recognizes handleWs messages", () => {
    expect(isTransferMessage({ _t: "handleWs", skipGreeting: false })).toBe(true);
  });

  test("recognizes createWs messages", () => {
    expect(isTransferMessage({ _t: "createWs", url: "wss://x", headers: "{}" })).toBe(true);
  });

  test("rejects non-transfer objects", () => {
    expect(isTransferMessage({ k: 0, d: "test" })).toBe(false);
    expect(isTransferMessage("string")).toBe(false);
    expect(isTransferMessage(null)).toBe(false);
    expect(isTransferMessage(42)).toBe(false);
  });
});

describe("sendTransfer", () => {
  test("sends message with transfer list", () => {
    const sent: { msg: unknown; transfer: Transferable[] }[] = [];
    const port: WorkerPort = {
      addEventListener() {},
      postMessage(msg: unknown, transfer?: Transferable[]) {
        sent.push({ msg, transfer: transfer ?? [] });
      },
    };

    sendTransfer(port, { _t: "handleWs", skipGreeting: true }, []);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg).toEqual({ _t: "handleWs", skipGreeting: true });
  });
});

// ─── BridgedWebSocket ───────────────────────────────────────────────────────

describe("BridgedWebSocket", () => {
  function createMockPort() {
    const sent: { msg: unknown; transfer: Transferable[] }[] = [];
    const port: MessagePort = {
      onmessage: null,
      postMessage(msg: unknown, transfer?: Transferable[]) {
        sent.push({ msg, transfer: transfer ?? [] });
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
