import { afterEach, describe, expect, test, vi } from "vitest";
import { makeMockHandle, silentLogger } from "../_test-utils.ts";
import type { S2sCallbacks, S2sHandle } from "../s2s.ts";
import { _internals, createS2sTransport } from "./s2s-transport.ts";
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

describe("S2sTransport", () => {
  test("start() opens an S2S connection and sends session.update", async () => {
    const send = vi.fn();
    const close = vi.fn();
    const ws = Object.assign(new EventTarget(), {
      readyState: 0,
      send,
      close,
      addEventListener: EventTarget.prototype.addEventListener as unknown as (
        type: string,
        listener: EventListener,
      ) => void,
    }) as unknown as import("../s2s.ts").S2sWebSocket;
    setTimeout(() => {
      (ws as unknown as { readyState: number }).readyState = 1;
      (ws as unknown as EventTarget).dispatchEvent(new Event("open"));
    }, 0);

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks: makeCallbacks(),
      sid: "sid-1",
      agent: "a",
      createWebSocket: () => ws,
    });
    await t.start();
    expect(send).toHaveBeenCalled();
    const firstSend = JSON.parse(send.mock.calls[0]?.[0] as string);
    expect(firstSend.type).toBe("session.update");
    await t.stop();
    expect(close).toHaveBeenCalled();
  });
});

// ─── Reconnect tests ────────────────────────────────────────────────────────

/** Capture the S2sCallbacks that the transport hands to connectS2s. */
function setupSpiedTransport(): {
  callbacks: TransportCallbacks;
  handles: S2sHandle[];
  capturedCallbacks: S2sCallbacks[];
  spy: ReturnType<typeof vi.spyOn>;
} {
  const handles: S2sHandle[] = [];
  const capturedCallbacks: S2sCallbacks[] = [];
  const spy = vi
    .spyOn(_internals, "connectS2s")
    .mockImplementation(async (opts: import("../s2s.ts").ConnectS2sOptions) => {
      capturedCallbacks.push(opts.callbacks);
      const h = makeMockHandle();
      handles.push(h);
      return h;
    });
  return {
    callbacks: makeCallbacks(),
    handles,
    capturedCallbacks,
    spy,
  };
}

describe("S2sTransport reconnect", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("attempts session.resume on transient close (1005) inside the resume window", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    // Establish session, start a reply, then drop the socket.
    const cb1 = capturedCallbacks[0];
    if (!cb1) throw new Error("expected first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1005, "");

    // Wait for the async resume() to fire connectS2s a second time.
    await vi.waitFor(() => {
      expect(handles.length).toBe(2);
    });

    // The new handle should have received resumeSession with the prior id.
    const newHandle = handles[1];
    if (!newHandle) throw new Error("expected new handle");
    expect(newHandle.resumeSession).toHaveBeenCalledWith("sess_abc");

    // The in-flight reply was unblocked via onCancelled, NOT a fatal error.
    expect(callbacks.onCancelled).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  test("does NOT reconnect on fatal close codes (1008 unauthorized)", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    const cb1 = capturedCallbacks[0];
    if (!cb1) throw new Error("expected first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1008, "unauthorized");

    // No reconnect — only one connectS2s call total.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handles.length).toBe(1);
    // Fatal error surfaces, since a reply was in flight.
    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("S2S closed mid-reply"),
    );
  });

  test("does NOT reconnect when stop() was called", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    const cb1 = capturedCallbacks[0];
    if (!cb1) throw new Error("expected first callbacks");
    cb1.onSessionReady("sess_abc");
    await t.stop();

    // Simulate the upstream's close arriving after stop() — it should be
    // treated as a clean shutdown, not a transient drop worth resuming.
    cb1.onClose(1005, "");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handles.length).toBe(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  test("surfaces resume failure when the resumed socket also closes", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    capturedCallbacks[0]?.onSessionReady("sess_abc");
    capturedCallbacks[0]?.onReplyStarted("rep_1");
    capturedCallbacks[0]?.onClose(1005, "");

    await vi.waitFor(() => expect(handles.length).toBe(2));

    // The resume socket also drops before its session.ready arrives.
    const cb2 = capturedCallbacks[1];
    if (!cb2) throw new Error("expected resume callbacks");
    cb2.onClose(1006, "");

    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("resume failed"),
    );
  });

  test("surfaces resume failure when server reports session_not_found", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    capturedCallbacks[0]?.onSessionReady("sess_abc");
    capturedCallbacks[0]?.onClose(1005, "");

    await vi.waitFor(() => expect(handles.length).toBe(2));

    capturedCallbacks[1]?.onSessionExpired();

    expect(callbacks.onError).toHaveBeenCalledWith(
      "connection",
      expect.stringContaining("session expired"),
    );
  });

  test("after a successful resume, a later transient drop also resumes", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();

    const t = createS2sTransport({
      apiKey: "k",
      s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
      sessionConfig: { systemPrompt: "test", tools: [] },
      toolSchemas: [],
      callbacks,
      sid: "sid-1",
      agent: "a",
      logger: silentLogger,
    });
    await t.start();

    // First connection establishes, drops, resumes, becomes ready again.
    capturedCallbacks[0]?.onSessionReady("sess_abc");
    capturedCallbacks[0]?.onClose(1005, "");
    await vi.waitFor(() => expect(handles.length).toBe(2));
    capturedCallbacks[1]?.onSessionReady("sess_abc");

    // Second drop — should trigger another resume attempt.
    capturedCallbacks[1]?.onClose(1006, "");
    await vi.waitFor(() => expect(handles.length).toBe(3));
    expect(handles[2]?.resumeSession).toHaveBeenCalledWith("sess_abc");
  });
});
