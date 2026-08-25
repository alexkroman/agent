// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit specs for the OpenAI Realtime connection's lifecycle statechart.
 *
 * Exercised through injected effects with no socket anywhere, for the reason
 * `s2s-lifecycle.test.ts` states: `openai-realtime-transport.test.ts` asserts
 * the same rules end-to-end through a fake WebSocket, and every one of those
 * specs has to build a connection before it can describe an ordering.
 *
 * The load-bearing group is "one reply reset, three ways out" — those three
 * paths each carried their own copy of it, and the copy is what this file
 * exists to stop coming back.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createOpenaiRealtimeLifecycle,
  type OpenaiRealtimeLifecycleEffects,
} from "./openai-realtime-lifecycle.ts";

/**
 * A lifecycle over spied effects.
 *
 * `satisfies` rather than a cast, for the reason the sibling's helper gives: it
 * checks the shape against the real effects type while keeping each field's
 * `Mock` type, so a field whose signature drifts is a compile error here.
 */
function makeLifecycle() {
  const spies = {
    replyStarted: vi.fn((_replyId: string) => undefined),
    replyCompleted: vi.fn(),
    replyCancelled: vi.fn(),
    cancelResponse: vi.fn(),
    clearTurnBuffers: vi.fn(),
    reportFatal: vi.fn((_detail: string) => undefined),
    log: vi.fn(
      (_level: "info" | "warn", _message: string, _fields?: Record<string, unknown>) => undefined,
    ),
  } satisfies OpenaiRealtimeLifecycleEffects;
  return { spies, lifecycle: createOpenaiRealtimeLifecycle(spies) };
}

/** An open socket with a reply running — the position most rules are about. */
function replying() {
  const made = makeLifecycle();
  made.lifecycle.send({ type: "OPEN" });
  made.lifecycle.send({ type: "REPLY_STARTED", replyId: "resp_1" });
  made.spies.clearTurnBuffers.mockClear();
  return made;
}

describe("phases", () => {
  test("starts connecting and opens into live", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.phase()).toBe("connecting");
    lifecycle.send({ type: "OPEN" });
    expect(lifecycle.phase()).toBe("live");
  });

  test("a close nobody asked for ends the session, reported once", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "CLOSED", code: 1006, reason: "" });
    expect(lifecycle.phase()).toBe("ended");
    expect(spies.reportFatal).toHaveBeenCalledExactlyOnceWith("OpenAI Realtime closed (code=1006)");
  });

  test("a close before the socket ever opened ends it too", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "CLOSED", code: 4001, reason: "unauthorized" });
    expect(lifecycle.phase()).toBe("ended");
    expect(spies.reportFatal).toHaveBeenCalledTimes(1);
  });

  test("the client hanging up reports nothing — it asked", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "STOP" });
    lifecycle.send({ type: "CLOSED", code: 1000, reason: "" });
    expect(lifecycle.phase()).toBe("closed");
    expect(spies.reportFatal).not.toHaveBeenCalled();
    expect(spies.log).toHaveBeenCalledWith("info", "OpenAI Realtime closed", {
      code: 1000,
      reason: "",
    });
  });

  test("a mid-reply close names the reply it lost", () => {
    // The diagnostic the boolean latch could not give: `replyInFlight` was a
    // bare flag, so a close mid-reply named nothing.
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "CLOSED", code: 1006, reason: "" });
    expect(spies.log).toHaveBeenCalledWith(
      "warn",
      "OpenAI Realtime closed with active reply",
      expect.objectContaining({ activeReplyId: "resp_1" }),
    );
  });
});

describe("one reply reset, three ways out", () => {
  test("response.done clears the buffers and reports completion", () => {
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "REPLY_DONE" });
    expect(spies.clearTurnBuffers).toHaveBeenCalledTimes(1);
    expect(spies.replyCompleted).toHaveBeenCalledTimes(1);
    expect(lifecycle.replying()).toBe(false);
  });

  test("a server-VAD barge-in clears them and reports the cancellation", () => {
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "SPEECH_STARTED" });
    expect(spies.clearTurnBuffers).toHaveBeenCalledTimes(1);
    expect(spies.replyCancelled).toHaveBeenCalledTimes(1);
    expect(lifecycle.replying()).toBe(false);
  });

  test("a client cancel clears them, asks the provider to stop, and reports NOTHING", () => {
    // The session's own `cancel` command emits `reply.cancelled` itself, so
    // firing it here would double-emit the frame.
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "CANCEL" });
    expect(spies.clearTurnBuffers).toHaveBeenCalledTimes(1);
    expect(spies.cancelResponse).toHaveBeenCalledTimes(1);
    expect(spies.replyCancelled).not.toHaveBeenCalled();
    expect(spies.replyCompleted).not.toHaveBeenCalled();
  });

  test("hanging up mid-reply clears them too, so no turn residue is left", () => {
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "STOP" });
    expect(spies.clearTurnBuffers).toHaveBeenCalledTimes(1);
  });

  test("an event that does NOT end the reply leaves the buffers alone", () => {
    // The nine-line comment this replaces: an in-band `error` interrupts a
    // response that is still running, and clearing its transcript buffer left
    // the later `…transcript.done` reading "" — the caller heard the whole
    // reply and nothing entered history. As a state it is just "no transition".
    const { spies, lifecycle } = replying();
    lifecycle.send({ type: "REPLY_STARTED", replyId: "resp_2" });
    expect(spies.clearTurnBuffers).not.toHaveBeenCalled();
    expect(lifecycle.replying()).toBe(true);
  });
});

describe("what the latches used to allow", () => {
  test("a cancel with no reply in flight does nothing", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "CANCEL" });
    expect(spies.cancelResponse).not.toHaveBeenCalled();
  });

  test("speech with no reply in flight is not a barge-in", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "SPEECH_STARTED" });
    expect(spies.replyCancelled).not.toHaveBeenCalled();
  });

  test("a reply cannot start on a session the client has ended", () => {
    // `stop()` left `replyInFlight` alone, so a late `response.created` still
    // called `onReplyStarted` for a call that was over.
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "STOP" });
    lifecycle.send({ type: "REPLY_STARTED", replyId: "resp_late" });
    expect(spies.replyStarted).not.toHaveBeenCalled();
    expect(lifecycle.replying()).toBe(false);
  });

  test("a reply cannot start on a session that already died", () => {
    const { spies, lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "CLOSED", code: 1006, reason: "" });
    lifecycle.send({ type: "REPLY_STARTED", replyId: "resp_late" });
    expect(spies.replyStarted).not.toHaveBeenCalled();
  });
});

describe("reportsErrors", () => {
  test("true while the connection is opening or live", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.reportsErrors()).toBe(true);
    lifecycle.send({ type: "OPEN" });
    expect(lifecycle.reportsErrors()).toBe(true);
  });

  test("false once the client has hung up", () => {
    const { lifecycle } = makeLifecycle();
    lifecycle.send({ type: "STOP" });
    expect(lifecycle.reportsErrors()).toBe(false);
  });

  test("false once the session has died, so a client is not torn down twice", () => {
    // `closing` covered only the hang-up, so a socket error arriving after an
    // unexpected close was still reported at the client.
    const { lifecycle } = makeLifecycle();
    lifecycle.send({ type: "OPEN" });
    lifecycle.send({ type: "CLOSED", code: 1006, reason: "" });
    expect(lifecycle.reportsErrors()).toBe(false);
  });
});
