// Copyright 2026 the AAI authors. MIT license.
// Fake `ws` WebSocket for the AssemblyAI TTS adapter specs. Import-free on
// purpose: each test file's `vi.mock("ws", ...)` factory imports THIS module,
// so it must not (transitively) import the adapter — which imports "ws" —
// or the mock factory would re-enter itself.

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

export class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** When true, new sockets black-hole: no "open", no "error" — ever. */
  static neverOpen = false;

  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  readonly url: string;
  readonly options: { headers?: Record<string, string> } | undefined;
  private readonly listeners = new Map<string, WsListener[]>();

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = opts;
    FakeWebSocket.instances.push(this);
    // Real `ws` fires "open" asynchronously; match that timing.
    if (!FakeWebSocket.neverOpen) queueMicrotask(() => this._fire("open"));
  }

  /** Reset the per-test statics — call from beforeEach. */
  static reset(): void {
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.neverOpen = false;
  }

  on(event: string, fn: WsListener) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
  }

  once(event: string, fn: WsListener) {
    const wrapper = (...args: unknown[]) => {
      this.removeListener(event, wrapper);
      fn(...args);
    };
    this.on(event, wrapper);
  }

  removeListener(event: string, fn: WsListener) {
    const arr = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      arr.filter((l) => l !== fn),
    );
  }

  off(event: string, fn: WsListener) {
    this.removeListener(event, fn);
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire("close");
  }

  _fire(event: WsEvent, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  _msg(payload: unknown) {
    this._fire("message", JSON.stringify(payload));
  }

  _frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** Base64 of one PCM16 LE sample per value. */
export function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  for (const [i, v] of samples.entries()) buf.writeInt16LE(v, i * 2);
  return buf.toString("base64");
}
