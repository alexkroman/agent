// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared test doubles for the session-core test suites: a mock WebSocket
 * with server-message simulation helpers and a config-message builder.
 */
import { lenientParse, SessionCommandSchema } from "@alexkroman1/aai/protocol";
import { isRecord } from "@alexkroman1/aai/utils";
import { vi } from "vitest";

// ─── Mock WebSocket ─────────────────────────────────────────────────────────

/** Track the last created MockWebSocket so tests can simulate server messages. */
export let lastSocket: MockWebSocket | null = null;

/** Reset the tracked socket (call in beforeEach). */
export function resetLastSocket(): void {
  lastSocket = null;
}

/**
 * Add an event envelope to a JSON server frame that lacks one.
 *
 * Non-JSON and non-object payloads pass through: several specs deliberately
 * deliver malformed frames, and mangling those would test the helper instead of
 * the client.
 */
function stampJsonFrame(data: string | ArrayBuffer): string | ArrayBuffer {
  if (typeof data !== "string") return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data;
  }
  if (!isRecord(parsed)) return data;
  if ("meta" in parsed || !("type" in parsed)) return data;
  return JSON.stringify({ ...parsed, meta: { id: "evt_TEST", at: 0 } });
}

export class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  /** Mutable in tests to simulate socket send-queue backpressure. */
  bufferedAmount = 0;
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
    // Real Event instances: partysocket (wrapping this mock as its
    // transport) clones the events it re-dispatches, so a bare `cb()`
    // with no event object would blow up inside its clone helper.
    for (const cb of this._listeners.get("open") ?? []) cb(new Event("open"));
  }

  /**
   * Deliver one server frame.
   *
   * **A JSON frame is STAMPED with an event envelope if it has none**, because
   * this double stands in for the SERVER and a real one always stamps — the
   * envelope is minted once, where the event is recorded
   * (`aai/host/session-event-stream.ts`). Without this every spec here would
   * carry a `meta` it never asserts on, and a spec that forgot one would see its
   * frame silently DROPPED by `lenientParse` rather than fail: the shape of
   * unfaithful-fake bug this package's own fuzz notes warn about.
   *
   * A frame that brings its own `meta` is passed through untouched, which is
   * what lets a spec assert on the envelope (or send a deliberately bad one).
   */
  simulateMessage(data: string | Uint8Array | ArrayBuffer) {
    const payload = data instanceof Uint8Array ? data.buffer : stampJsonFrame(data);
    for (const cb of this._listeners.get("message") ?? []) {
      cb(new MessageEvent("message", { data: payload }));
    }
  }

  /**
   * Fire a raw payload at the `type` listeners, bypassing the typed
   * `simulate*` helpers — for frames a real socket can deliver but those
   * signatures forbid (e.g. a message whose `data` is a number).
   */
  dispatchRaw(type: string, payload: unknown) {
    for (const cb of this._listeners.get(type) ?? []) cb(payload);
  }

  /** Simulate a socket error. Browsers fire "error" with no payload and
   *  always follow it with "close" — tests must call simulateClose after. */
  simulateError() {
    for (const cb of this._listeners.get("error") ?? []) cb(new Event("error"));
  }

  /**
   * Simulate server-initiated close.
   *
   * `reason` is a parameter because the server WRITES one on a refusal and the
   * client is supposed to show it: a guest that cannot build its runtime closes
   * 1011 with "Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY in the agent
   * env." Hard-coding `""` here is what let the close handler discard the field
   * for as long as it did — every spec fed it the one value that made the branch
   * unreachable.
   */
  simulateClose(code = 1000, reason = "") {
    this.readyState = 3;
    for (const cb of this._listeners.get("close") ?? []) {
      // jsdom has no global CloseEvent; a plain Event with the close fields
      // satisfies both session-core and partysocket's event cloning.
      cb(Object.assign(new Event("close"), { code, reason }));
    }
  }
}

export type ConstructorType = import("./types.ts").WebSocketConstructor;

/**
 * {@link MockWebSocket} as the session core's `WebSocket` option.
 *
 * It implements the slice of the constructor contract the core uses but does
 * not structurally satisfy `WebSocketConstructor`, so the narrowing needs a
 * cast. Import THIS rather than casting at each call site; the escape-hatch
 * ratchet counts every occurrence.
 */
export const MockWebSocketConstructor = MockWebSocket as unknown as ConstructorType;

/**
 * A `WebSocket` option whose every instance is handed to `onSocket`, for
 * tests that need the socket the core actually opened. Shares
 * {@link MockWebSocketConstructor}'s narrowing rationale.
 */
export function recordingWebSocketClass(
  onSocket: (socket: MockWebSocket) => void,
): ConstructorType {
  return class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      onSocket(this);
    }
  } as unknown as ConstructorType;
}

// ─── Outbound protocol contract ─────────────────────────────────────────────

/**
 * Assert every string frame the session core sent through `socket` is a
 * valid {@link SessionCommandSchema} message. Binary frames (audio) are
 * skipped. Throws on the first invalid frame — call at the end of a test to
 * pin the outbound wire contract without asserting on individual sends.
 */
export function assertValidClientFrames(socket: MockWebSocket | null): void {
  if (!socket) throw new Error("assertValidClientFrames: no socket");
  for (const call of socket.send.mock.calls) {
    const data = call[0] as unknown;
    if (typeof data !== "string") continue;
    const parsed = lenientParse(SessionCommandSchema, JSON.parse(data));
    if (!parsed.ok) {
      throw new Error(`invalid client frame ${data}: ${parsed.error}`);
    }
  }
}

// ─── Helper to build a config JSON string ───────────────────────────────────

export function makeConfig(
  sampleRate = 16_000,
  ttsSampleRate = 24_000,
  sessionId = "sess-123",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "session.configured",
    audioFormat: "pcm16",
    sampleRate,
    ttsSampleRate,
    sessionId,
    ...extra,
  });
}
