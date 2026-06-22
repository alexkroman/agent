// Copyright 2025 the AAI authors. MIT license.

export class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  url: string;

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

  override addEventListener(type: "open", listener: () => void): void;
  override addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  override addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  override addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: TypeScript requires `any` for overload implementation signatures when overloads have incompatible parameter types (e.g. `() => void` vs `(event: {data: unknown}) => void`)
  override addEventListener(type: string, listener: any): void {
    super.addEventListener(type, listener);
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  close(code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code: code ?? 1000 }));
  }

  simulateMessage(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  error() {
    this.dispatchEvent(new Event("error"));
  }

  sentJson(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((s) => JSON.parse(s));
  }
}
