// Copyright 2026 the AAI authors. MIT license.
// Fake `ws` WebSocket shared by the TTS adapter specs (AssemblyAI and Rime).
// Import-free on purpose: each test file's `vi.mock("ws", ...)` factory
// imports THIS module, so it must not (transitively) import an adapter —
// which imports "ws" — or the mock factory would re-enter itself.
//
// It used to be AssemblyAI's alone while `rime.test.ts` and
// `stt/soniox.test.ts` each re-implemented it, and the copies had already
// DIVERGED on the property that matters: soniox's starts CONNECTING and
// flips to OPEN when it fires "open", the other two were pinned OPEN from
// the constructor — so a write-before-open regression was catchable in one
// suite and structurally invisible in the other two. This one matches real
// `ws`: `readyState` is CONNECTING until the "open" event. (Soniox's copy
// survives because its adapter speaks binary frames, reads `bufferedAmount`
// and reads the close CODE, none of which this fake models.)

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  /** When true, new sockets black-hole: no "open", no "error" — ever. */
  static neverOpen = false;

  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  readonly url: string;
  readonly options: { headers?: Record<string, string>; perMessageDeflate?: boolean } | undefined;
  private readonly listeners = new Map<string, WsListener[]>();

  constructor(
    url: string,
    opts?: { headers?: Record<string, string>; perMessageDeflate?: boolean },
  ) {
    this.url = url;
    this.options = opts;
    FakeWebSocket.instances.push(this);
    // Real `ws` fires "open" asynchronously and is CONNECTING until then;
    // match both, so a send-before-open is a test failure rather than a
    // silently accepted frame.
    if (!FakeWebSocket.neverOpen) {
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this._fire("open");
      });
    }
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

  listenerCount() {
    let n = 0;
    for (const arr of this.listeners.values()) n += arr.length;
    return n;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._fire("close");
  }

  /**
   * Real `ws`'s abrupt close — no close frame, no handshake.
   *
   * Modelled because `host/step-speak.ts` uses it for the one case where a
   * polite close is pointless (a socket that never opened, or an exchange that
   * already failed), and a fake without it turns that path into a TypeError
   * that reads as a bug in the code under test.
   */
  terminate() {
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
