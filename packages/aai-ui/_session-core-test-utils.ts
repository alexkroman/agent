// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared test doubles for the session-core test suites: a mock WebSocket
 * with server-message simulation helpers and a config-message builder.
 */
import { vi } from "vitest";

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

/** Track the last created MockWebSocket so tests can simulate server messages. */
export let lastSocket: MockWebSocket | null = null;

/** Reset the tracked socket (call in beforeEach). */
export function resetLastSocket(): void {
  lastSocket = null;
}

export class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
  private _listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  url: string;
  constructor(url: string) {
    this.url = url;
    lastSocket = this;
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void, opts?: unknown) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)?.add(listener);
    // Track AbortSignal-based cleanup
    const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) {
      signal.addEventListener("abort", () => {
        this._listeners.get(type)?.delete(listener);
      });
    }
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void) {
    this._listeners.get(type)?.delete(listener);
  }

  /** Simulate the WebSocket opening. */
  simulateOpen() {
    this.readyState = 1;
    for (const cb of this._listeners.get("open") ?? []) cb();
  }

  /** Simulate receiving a message from the server (text JSON, binary ArrayBuffer, or Uint8Array). */
  simulateMessage(data: string | Uint8Array | ArrayBuffer) {
    const payload = data instanceof Uint8Array ? data.buffer : data;
    for (const cb of this._listeners.get("message") ?? []) {
      cb({ data: payload });
    }
  }

  /** Simulate server-initiated close. */
  simulateClose(code = 1000) {
    this.readyState = 3;
    for (const cb of this._listeners.get("close") ?? []) {
      cb({ code, reason: "" });
    }
  }
}

export type ConstructorType = import("./types.ts").WebSocketConstructor;

// ─── Helper to build a config JSON string ───────────────────────────────────

export function makeConfig(
  sampleRate = 16_000,
  ttsSampleRate = 24_000,
  sessionId = "sess-123",
): string {
  return JSON.stringify({
    type: "config",
    audioFormat: "pcm16",
    sampleRate,
    ttsSampleRate,
    sessionId,
  });
}
