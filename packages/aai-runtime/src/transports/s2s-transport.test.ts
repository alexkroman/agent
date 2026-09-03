import { S2S_MAX_RESUME_ATTEMPTS } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { makeMockHandle, silentLogger, sleep } from "../_test-utils.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle, S2sWebSocket } from "../s2s.ts";
import { makeCallbacks, type RecordingCallbacks } from "./_transport-recorder.ts";
import { _internals, createS2sTransport, type S2sTransportOptions } from "./s2s-transport.ts";

function makeTransportOptions(overrides: Partial<S2sTransportOptions> = {}): S2sTransportOptions {
  return {
    apiKey: "k",
    s2sConfig: { wssUrl: "wss://fake", inputSampleRate: 16_000, outputSampleRate: 24_000 },
    sessionConfig: { systemPrompt: "test", tools: [] },
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
  callbacks: RecordingCallbacks;
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

describe("S2sTransport lifecycle races", () => {
  test("stop() during an in-flight start() closes the resolved handle (no leak)", async () => {
    const handle = makeMockHandle();
    const connect = Promise.withResolvers<S2sHandle>();
    vi.spyOn(_internals, "connectS2s").mockImplementation(() => connect.promise);

    const t = createS2sTransport(makeTransportOptions());
    const startP = t.start(); // handshake in flight
    await t.stop(); // client disconnected before connect resolved
    connect.resolve(handle); // handshake now completes
    await startP;

    // The resolved socket must be closed, and no session.update sent on it.
    expect(handle.close).toHaveBeenCalled();
    expect(handle.updateSession).not.toHaveBeenCalled();
  });
});

describe("S2sTransport reconnect", () => {
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

    expect(callbacks.reported("reply.cancelled")).toHaveBeenCalledOnce();
    expect(callbacks.reported("error.reported")).not.toHaveBeenCalled();
  });

  test("a tool.result dropped during the resume window is redelivered once resumed", async () => {
    // The provider restores the session server-side with its tool calls
    // still unanswered; a result silently dropped on the dead socket used to
    // stall the resumed turn until the idle timeout.
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");

    // Socket drops while the tool runs; the settled result hits the dead
    // handle, whose send reports failure.
    const h1 = expectAt(handles, 0, "first handle");
    vi.mocked(h1.sendToolResult).mockReturnValue(false);
    cb1.onClose(1005, "");
    t.sendToolResult("call-1", "result-1");

    await vi.waitFor(() => {
      expect(handles.length).toBe(2);
    });
    const h2 = expectAt(handles, 1, "resumed handle");
    vi.mocked(h2.sendToolResult).mockReturnValue(true);
    const cb2 = expectAt(capturedCallbacks, 1, "resumed callbacks");
    cb2.onSessionReady("sess_abc");

    expect(h2.sendToolResult).toHaveBeenCalledWith("call-1", "result-1");
  });

  test("does NOT reconnect on fatal close codes (1008 unauthorized)", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onReplyStarted("rep_1");
    cb1.onClose(1008, "unauthorized");

    await sleep(5);
    expect(handles.length).toBe(1);
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringContaining("S2S closed mid-reply"),
      fatal: true,
    });
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

    await sleep(5);
    expect(handles.length).toBe(1);
    expect(callbacks.reported("error.reported")).not.toHaveBeenCalled();
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

    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringContaining("resume failed"),
      fatal: true,
    });
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

    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringContaining("session expired"),
      fatal: true,
    });
  });

  test("a failed resume emits exactly one error when close fires before the rejection", async () => {
    // Real connectS2s both fires callbacks.onClose AND rejects when the resume
    // socket dies before `open` — the transport must report the failure once.
    const callbacks = makeCallbacks();
    const capturedCallbacks: S2sCallbacks[] = [];
    let connects = 0;
    const spy = vi
      .spyOn(_internals, "connectS2s")
      .mockImplementation(async (o: ConnectS2sOptions) => {
        capturedCallbacks.push(o.callbacks);
        connects++;
        if (connects === 1) return makeMockHandle();
        o.callbacks.onClose(1006, ""); // close-before-open on the resume socket…
        throw new Error("WebSocket closed before open (code: 1006)"); // …then the rejection
      });

    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();
    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, "");

    await vi.waitFor(() => expect(callbacks.reported("error.reported")).toHaveBeenCalled());
    await sleep(5);
    expect(callbacks.reported("error.reported")).toHaveBeenCalledTimes(1);
    // No further resume attempt after the failure (the 1006 close is transient
    // by code, but the retired session must not loop back into resume).
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("a failed resume emits exactly one error when the rejection fires before close", async () => {
    const callbacks = makeCallbacks();
    const capturedCallbacks: S2sCallbacks[] = [];
    let connects = 0;
    const spy = vi
      .spyOn(_internals, "connectS2s")
      .mockImplementation(async (o: ConnectS2sOptions) => {
        capturedCallbacks.push(o.callbacks);
        connects++;
        if (connects === 1) return makeMockHandle();
        throw new Error("connect ECONNREFUSED");
      });

    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();
    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, "");

    await vi.waitFor(() => expect(callbacks.reported("error.reported")).toHaveBeenCalledTimes(1));

    // The dead resume socket's close event trails in with a transient code —
    // it must neither re-emit the error nor kick off another resume loop.
    const cb2 = expectAt(capturedCallbacks, 1, "resume callbacks");
    cb2.onClose(1006, "");
    await sleep(5);
    expect(callbacks.reported("error.reported")).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
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

  test("gives up after the resume-attempt cap on a flapping server", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    // Each resumed socket becomes ready then immediately drops, with NO reply
    // in between — so the flapping-resume counter never resets.
    const cb0 = expectAt(capturedCallbacks, 0, "cb0");
    cb0.onSessionReady("sess");
    cb0.onClose(1006, "");
    for (let attempt = 1; attempt <= S2S_MAX_RESUME_ATTEMPTS; attempt++) {
      await vi.waitFor(() => expect(handles.length).toBe(attempt + 1));
      const cb = expectAt(capturedCallbacks, attempt, `cb${attempt}`);
      cb.onSessionReady("sess");
      cb.onClose(1006, "");
    }

    // The drop past the cap surfaces a fatal error and spawns no further resume.
    await vi.waitFor(() => {
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "connection",
        message: expect.stringContaining("abandoned"),
        fatal: true,
      });
    });
    expect(handles.length).toBe(S2S_MAX_RESUME_ATTEMPTS + 1);
  });

  test("real progress (a reply) resets the resume budget", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    // A reply on each resumed socket proves the session works, resetting the
    // counter — so a session that keeps recovering resumes well past the cap.
    const cycles = S2S_MAX_RESUME_ATTEMPTS + 2;
    const cb0 = expectAt(capturedCallbacks, 0, "cb0");
    cb0.onSessionReady("sess");
    cb0.onReplyStarted("r0");
    cb0.onClose(1006, "");
    for (let i = 1; i <= cycles; i++) {
      await vi.waitFor(() => expect(handles.length).toBe(i + 1));
      const cb = expectAt(capturedCallbacks, i, `cb${i}`);
      cb.onSessionReady("sess");
      cb.onReplyStarted(`r${i}`);
      if (i < cycles) cb.onClose(1006, "");
    }

    expect(callbacks.reported("error.reported")).not.toHaveBeenCalled();
    expect(handles.length).toBe(cycles + 1);
  });

  test("surfaces onError on an unexpected fatal close while idle", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess_x");
    // 1008 is non-transient (not resumable) and no reply is in flight — the
    // provider dropped a live idle session. This must not be swallowed, or the
    // client sits "connected" while every later utterance vanishes.
    cb.onClose(1008, "policy");
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringContaining("closed unexpectedly"),
      fatal: true,
    });
  });

  // Regression: found by `integration/s2s-fuzz.integration.test.ts`. Whether a
  // random walk reaches these two orderings is luck, so each gets a spec of its
  // own — discovery and regression are different jobs.
  test("an in-band service error is reported NON-fatally (the session is still up)", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    // A `session.error` with a non-expiry code (rate limit, rejected field) or a
    // bare `error` frame: nothing closes the socket, and the conversation
    // continues through it. Reported as fatal — onError's default — aai-ui
    // releases the microphone and ends the call, so the agent keeps replying to
    // a session that can no longer hear anyone.
    cb.onError(new Error("slow down"));
    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "internal",
      message: "slow down",
      fatal: false,
    });

    // Still usable: a later reply must reach the client normally.
    cb.onReplyStarted("r1");
    cb.onAudio(new Uint8Array([1, 2]));
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(1);
  });

  test("an in-band resume rejection closes the socket it was rejected on", async () => {
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, "");
    await vi.waitFor(() => expect(handles.length).toBe(2));

    // The service answers our `session.resume` with `session_not_found` IN BAND
    // — it does not close. Retiring the session while leaving that socket open
    // held a live (billed) provider session whose frames kept flowing to a
    // client already told the call was over.
    const cb2 = expectAt(capturedCallbacks, 1, "resume callbacks");
    cb2.onSessionExpired();

    expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
      type: "error.reported",
      code: "connection",
      message: expect.stringContaining("session expired"),
      fatal: true,
    });
    const h2 = expectAt(handles, 1, "resumed handle");
    expect(h2.close).toHaveBeenCalled();

    // And the retired transport relays nothing further from that socket.
    const audioCalls = vi.mocked(callbacks.onAudioChunk).mock.calls.length;
    cb2.onUserTranscript("are you still there");
    expect(callbacks.reported("user-transcript.committed")).not.toHaveBeenCalled();
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(audioCalls);
  });

  test("stop() abandons a resume handshake that has not completed", async () => {
    // The third finding from the property test, shrunk by fast-check to two
    // commands: session.ready, then a transient drop. `stop()`'s own
    // `handle.close()` can only reach a socket that OPENED — a resume still
    // waiting on its `open` has produced no handle — and `ws` sets no
    // handshakeTimeout, so the half-open (billed) provider connection was pinned
    // for the life of the process.
    const signals: (AbortSignal | undefined)[] = [];
    const capturedCallbacks: S2sCallbacks[] = [];
    const resumeHandle = makeMockHandle();
    // The resume socket never opens, so this promise never settles on its own.
    const resume = Promise.withResolvers<S2sHandle>();
    vi.spyOn(_internals, "connectS2s").mockImplementation((o: ConnectS2sOptions) => {
      signals.push(o.signal);
      capturedCallbacks.push(o.callbacks);
      if (signals.length === 1) return Promise.resolve(makeMockHandle());
      return resume.promise;
    });

    const callbacks = makeCallbacks();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();
    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    cb1.onClose(1005, ""); // transient → a resume starts and hangs mid-handshake
    await vi.waitFor(() => expect(signals.length).toBe(2));

    await t.stop();
    expect(signals[1]?.aborted).toBe(true);

    // If the handshake does settle after all, the socket is closed rather than
    // installed, and the client hears nothing: it hung up, so there is no
    // session left to fail.
    resume.resolve(resumeHandle);
    await sleep(5);
    expect(resumeHandle.close).toHaveBeenCalled();
    expect(callbacks.reported("error.reported")).not.toHaveBeenCalled();
  });

  test("a close() that throws does not retire the lifecycle that reads it", async () => {
    // A throw from inside a lifecycle ACTION puts the XState actor into
    // `status: "error"`, after which every later event is ignored — so an
    // unguarded `handle.close()` in `dropLink` would not merely fail to close,
    // it would silently freeze the machine that decides whether inbound frames
    // may still reach a client already told the call is over.
    const { callbacks, handles, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const h1 = expectAt(handles, 0, "first handle");
    vi.mocked(h1.close).mockImplementation(() => {
      throw new Error("close failed");
    });
    const cb1 = expectAt(capturedCallbacks, 0, "first callbacks");
    cb1.onSessionReady("sess_abc");
    // A fatal close: `dropLink` runs, and its close() throws.
    cb1.onClose(1008, "unauthorized");

    // Reported once — the retirement completed despite the throw.
    expect(callbacks.reported("error.reported")).toHaveBeenCalledOnce();
    // And the machine is still answering: a trailing frame is refused rather
    // than relayed, which is what a frozen actor would have allowed through.
    cb1.onUserTranscript("still talking");
    expect(callbacks.reported("user-transcript.committed")).not.toHaveBeenCalled();
  });

  test("cancelReply drops in-flight audio until the next reply starts", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    cb.onReplyStarted("r1");
    cb.onAudio(new Uint8Array([1, 2])); // during the reply → forwarded
    t.cancelReply();
    cb.onAudio(new Uint8Array([3, 4])); // after cancel → dropped
    cb.onReplyStarted("r2");
    cb.onAudio(new Uint8Array([5, 6])); // new reply → forwarded again
    expect(callbacks.onAudioChunk).toHaveBeenCalledTimes(2);
  });

  test("forwards user transcript partials to the session", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    cb.onUserTranscriptPartial("what's the wea");

    expect(callbacks.reported("user-transcript.updated")).toHaveBeenCalledWith({
      type: "user-transcript.updated",
      text: "what's the wea",
    });
  });

  // The reply-text fork, all three arms. A COMPLETED reply commits (it is what
  // the caller heard, so it enters history); an INTERRUPTED one is `.updated`
  // only, because the service trims it to what was actually spoken and history
  // records the heard prefix; and `transcript.agent.delta` DOES arrive from the
  // live service (re-measured — see `_s2s-reply.ts`), forwarded as `.updated`
  // since it is the only carrier of text for a tool-preamble reply that sends no
  // final. This spec used to be titled "S2S never emits agent transcript
  // partials" and fired only the completed arm, so both `.updated` producers —
  // which is to say the whole delta path the transport exists to relay — were
  // covered by nothing, under a name telling the next reader not to look.
  test("a completed agent transcript is committed", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    cb.onReplyStarted("r1");
    cb.onAgentTranscript("It's sunny.", false);

    expect(callbacks.reported("agent-transcript.committed")).toHaveBeenCalledWith({
      type: "agent-transcript.committed",
      text: "It's sunny.",
    });
    expect(callbacks.reported("agent-transcript.updated")).not.toHaveBeenCalled();
  });

  test("an INTERRUPTED agent transcript is updated, never committed", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    cb.onReplyStarted("r1");
    cb.onAgentTranscript("It's sun", true);

    expect(callbacks.reported("agent-transcript.updated")).toHaveBeenCalledWith({
      type: "agent-transcript.updated",
      text: "It's sun",
    });
    expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalled();
  });

  test("forwards agent transcript deltas as interim updates", async () => {
    const { callbacks, capturedCallbacks } = setupSpiedTransport();
    const t = createS2sTransport(makeTransportOptions({ callbacks }));
    await t.start();

    const cb = expectAt(capturedCallbacks, 0, "callbacks");
    cb.onSessionReady("sess");
    cb.onReplyStarted("r1");
    cb.onAgentTranscriptPartial("It's");
    cb.onAgentTranscriptPartial("It's sunny");

    expect(callbacks.reported("agent-transcript.updated")).toHaveBeenNthCalledWith(1, {
      type: "agent-transcript.updated",
      text: "It's",
    });
    expect(callbacks.reported("agent-transcript.updated")).toHaveBeenNthCalledWith(2, {
      type: "agent-transcript.updated",
      text: "It's sunny",
    });
    expect(callbacks.reported("agent-transcript.committed")).not.toHaveBeenCalled();
  });
});
