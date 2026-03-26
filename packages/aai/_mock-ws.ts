// Copyright 2025 the AAI authors. MIT license.

/**
 * A mock WebSocket implementation for testing.
 *
 * Extends `EventTarget` to simulate WebSocket behavior without a real
 * network connection. Records all sent messages in the {@link sent}
 * array and provides helper methods to simulate incoming messages,
 * connection events, and errors.
 *
 * @example
 * ```ts
 * const ws = new MockWebSocket("wss://example.com");
 * ws.send(JSON.stringify({ type: "ping" }));
 * ws.simulateMessage(JSON.stringify({ type: "pong" }));
 * assertEquals(ws.sentJson(), [{ type: "ping" }]);
 * ```
 */
export class MockWebSocket extends EventTarget {
  // mirrors the WebSocket API
  static readonly CONNECTING = 0;
  // mirrors the WebSocket API
  static readonly OPEN = 1;
  // mirrors the WebSocket API
  static readonly CLOSING = 2;
  // mirrors the WebSocket API
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  /** Simulated bufferedAmount for backpressure testing. */
  bufferedAmount = 0;
  /** All messages passed to {@link send}, in order. */
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  url: string;

  /**
   * Create a new MockWebSocket.
   *
   * Automatically transitions to `OPEN` state on the next microtask,
   * dispatching an `"open"` event.
   *
   * @param url - The WebSocket URL.
   * @param _protocols - Ignored; accepted for API compatibility.
   */
  constructor(url: string | URL, _protocols?: string | string[] | Record<string, unknown>) {
    super();
    this.url = typeof url === "string" ? url : url.toString();
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }
    });
  }

  override addEventListener(type: "close" | "open", listener: () => void): void;
  override addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  override addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  override addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: TypeScript requires `any` for overload implementation signatures when overloads have incompatible parameter types (e.g. `() => void` vs `(event: {data: unknown}) => void`)
  override addEventListener(type: string, listener: any): void {
    super.addEventListener(type, listener);
  }

  /**
   * Record a sent message without transmitting it.
   *
   * @param data - The message data to record.
   */
  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  /**
   * Transition to `CLOSED` state and dispatch a `"close"` event.
   *
   * @param code - The close code (defaults to 1000).
   * @param _reason - Ignored; accepted for API compatibility.
   */
  close(code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code: code ?? 1000 }));
  }

  /**
   * Simulate receiving a message from the server.
   *
   * @param data - The message data (string or binary).
   */
  simulateMessage(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  /** Transition to `OPEN` state and dispatch an `"open"` event. */
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  /**
   * Shorthand for {@link simulateMessage}.
   *
   * @param data - The message data to dispatch.
   */
  msg(data: string | ArrayBuffer) {
    this.simulateMessage(data);
  }

  /**
   * Simulate a connection close from the server.
   *
   * @param code - The close code (defaults to 1000).
   */
  disconnect(code = 1000) {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }

  /** Dispatch an `"error"` event on this socket. */
  error() {
    this.dispatchEvent(new Event("error"));
  }

  /**
   * Return all sent string messages parsed as JSON objects.
   *
   * Binary messages are filtered out.
   *
   * @returns An array of parsed JSON objects from sent string messages.
   */
  sentJson(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((s) => JSON.parse(s));
  }
}

const g: { WebSocket: unknown } = globalThis;

/**
 * Replace `globalThis.WebSocket` with {@link MockWebSocket} for testing.
 *
 * Returns a handle that tracks all created mock sockets and can restore the
 * original `WebSocket` constructor. Supports the `using` declaration via
 * `Symbol.dispose` for automatic cleanup.
 *
 * @returns An object with `created` array, `lastWs` getter, `restore()`, and `[Symbol.dispose]()`.
 *
 * @example
 * ```ts
 * using mock = installMockWebSocket();
 * const session = new Session("wss://example.com");
 * const ws = mock.lastWs!;
 * ws.simulateMessage(JSON.stringify({ type: "ready" }));
 * // mock automatically restores WebSocket when disposed
 * ```
 */
export function installMockWebSocket(): {
  restore: () => void;
  created: MockWebSocket[];
  get lastWs(): MockWebSocket | null;
  [Symbol.dispose]: () => void;
} {
  const saved = globalThis.WebSocket;
  const created: MockWebSocket[] = [];

  g.WebSocket = class extends MockWebSocket {
    constructor(url: string | URL, protocols?: string | string[] | Record<string, unknown>) {
      super(url, protocols);
      created.push(this);
    }
  };

  return {
    created,
    get lastWs() {
      return created.at(-1) ?? null;
    },
    restore() {
      globalThis.WebSocket = saved;
    },
    [Symbol.dispose]() {
      this.restore();
    },
  };
}
