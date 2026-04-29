import { afterEach, describe, expect, test, vi } from "vitest";
import { makeMockHandle, silentLogger } from "../_test-utils.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle, S2sWebSocket } from "../s2s.ts";
import { _internals, createS2sTransport, type S2sTransportOptions } from "./s2s-transport.ts";
import type { TransportCallbacks } from "./types.ts";

function makeCallbacks(): TransportCallbacks {
  return {
    onReplyStarted: vi.fn(),
    onReplyDone: vi.fn(),
    onCancelled: vi.fn(),
    onAudioChunk: vi.fn(),
    onAudioDone: vi.fn(),
    onUserTranscript: vi.fn(),
    onAgentTranscript: vi.fn(),
    onToolCall: vi.fn(),
    onError: vi.fn(),
    onSpeechStarted: vi.fn(),
    onSpeechStopped: vi.fn(),
    onSessionReady: vi.fn(),
  };
}

function makeTransportOptions(overrides: Partial<S2sTransportOptions> = {}): S2sTransportOptions {
  return {
    apiKey: "k",
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
    sessionConfig: { systemPrompt: "test", tools: [] },
    toolSchemas: [],
    callbacks: makeCallbacks(),
    sid: "sid-1",
    agent: "a",
    logger: silentLogger,
    ...overrides,
  };
}

describe("S2sTransport", () => {
  test("start() opens an S2S connection and sends session.update", async () => {
    const send = vi.fn();
    const close = vi.fn();
    const target = new EventTarget();
    const ws = Object.assign(target, {
      readyState: 0,
      send,
      close,
      addEventListener: target.addEventListener.bind(target),
    }) as unknown as S2sWebSocket;
    setTimeout(() => {
      (ws as unknown as { readyState: number }).readyState = 1;
      target.dispatchEvent(new Event("open"));
    }, 0);

    const t = createS2sTransport(makeTransportOptions({ createWebSocket: () => ws }));
    await t.start();
    expect(send).toHaveBeenCalled();
    const firstSend = JSON.parse(send.mock.calls[0]?.[0] as string);
    expect(firstSend.type).toBe("session.update");
    await t.stop();
    expect(close).toHaveBeenCalled();
  });
});

/** Capture the S2sCallbacks that the transport hands to connectS2s. */
function setupSpiedTransport(): {
  callbacks: TransportCallbacks;
  handles: S2sHandle[];
  capturedCallbacks: S2sCallbacks[];
} {
  const handles: S2sHandle[] = [];
  const capturedCallbacks: S2sCallbacks[] = [];
  vi.spyOn(_internals, "connectS2s").mockImplementation(async (opts: ConnectS2sOptions) => {
    capturedCallbacks.push(opts.callbacks);
    const h = makeMockHandle();
    handles.push(h);
    return h;
  });
  return { callbacks: makeCallbacks(), handles, capturedCallbacks };
}

function expectAt<T>(arr: T[], index: number, label: string): T {
  const value = arr[index];
  if (!value) throw new Error(`expected ${label} at index ${index}`);
  return value;
}

describe("S2sTransport reconnect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("attempts session.resume on transient close (1005) inside the resume window", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1005, "");

    await vi.waitFor(() => {
      expect(handles.length).toBe(2);
    });

    const newHandle = expectAt(handles, 1, "new handle");
    expect(newHandle.resumeSession).toHaveBeenCalledWith("sess_abc");

    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  test("does NOT reconnect on fatal close codes (1008 unauthorized)", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1008, "unauthorized");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handles.length).toBe(1);
    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("S2S closed mid-reply"),
    );
  });

  test("does NOT reconnect when stop() was called", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    await t.stop();

    // Upstream close after stop() must be treated as clean shutdown, not a transient drop.
    cb1.onClose(1005, "");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handles.length).toBe(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  test("surfaces resume failure when the resumed socket also closes", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1005, "");

    await vi.waitFor(() => expect(handles.length).toBe(2));

    const cb2 = expectAt(capturedCallbacks, 1, "resume callbacks");
    cb2.onClose(1006, "");

    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("resume failed"),
    );
  });

  test("surfaces resume failure when server reports session_not_found", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, "");

    await vi.waitFor(() => expect(handles.length).toBe(2));

    const cb2 = expectAt(capturedCallbacks, 1, "resume callbacks");
    cb2.onSessionExpired();

    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("session expired"),
    );
  });

  test("after a successful resume, a later transient drop also resumes", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, "");
    await vi.waitFor(() => expect(handles.length).toBe(2));

    const cb2 = expectAt(capturedCallbacks, 1, "resume callbacks");
    cb2.onSessionReady("sess_abc");
    cb2.onClose(1006, "");
    await vi.waitFor(() => expect(handles.length).toBe(3));
    expect(expectAt(handles, 2, "second resume handle").resumeSession).toHaveBeenCalledWith(
      "sess_abc",
    );
  });
});
