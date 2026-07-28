// Copyright 2026 the AAI authors. MIT license.
// Silence-nudge specs: after `silenceTimeoutMs` of user silence the transport
// injects `silencePrompt` as a synthetic user turn (never a user transcript),
// capped at MAX_CONSECUTIVE_SILENCE_NUDGES back-to-back nudges.

import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakeLanguageModel } from "../_pipeline-test-fakes.ts";
import { makeOpts } from "./_pipeline-transport-harness.ts";
import { createSilenceNudger } from "./pipeline-silence.ts";
import { createPipelineTransport } from "./pipeline-transport.ts";

describe("silence nudge", () => {
  test("takes an unprompted turn after silenceTimeoutMs with no user speech", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Still there?" }] });
    const { opts, callbacks } = makeOpts({
      llm,
      silenceTimeoutMs: 30,
      silencePrompt: "Check in now.",
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalled();
    });
    // The injected instruction reaches the LLM as a user message but is
    // never surfaced as a user transcript.
    expect(callbacks.onUserTranscript).not.toHaveBeenCalled();
    expect(JSON.stringify(llm.calls[0]?.prompt)).toContain("Check in now.");
    expect(callbacks.onAgentTranscript).toHaveBeenCalledWith("Still there?", false);
    await t.stop();
  });

  test("uses DEFAULT_SILENCE_PROMPT when silencePrompt is omitted", async () => {
    const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Hello?" }] });
    const { opts } = makeOpts({ llm, silenceTimeoutMs: 30 });
    const t = createPipelineTransport(opts);
    await t.start();
    await vi.waitFor(() => {
      expect(llm.calls.length).toBeGreaterThan(0);
    });
    expect(JSON.stringify(llm.calls[0]?.prompt)).toContain("hasn't said anything for a while");
    await t.stop();
  });

  test("never fires when silenceTimeoutMs is unset", async () => {
    const { opts, callbacks } = makeOpts();
    const t = createPipelineTransport(opts);
    await t.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    await t.stop();
  });

  test("STT partial resets the silence window", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      silenceTimeoutMs: 200,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await new Promise((r) => setTimeout(r, 100));
    stt.last()?.firePartial("um");
    // 200ms from start has passed, but only ~120ms since the partial.
    await new Promise((r) => setTimeout(r, 120));
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
    // ~200ms after the partial the re-armed countdown fires.
    await vi.waitFor(() => {
      expect(callbacks.onReplyStarted).toHaveBeenCalled();
    });
    await t.stop();
  });

  test("caps consecutive nudges until the user speaks again", async () => {
    const { opts, stt, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "anyone?" }] }),
      silenceTimeoutMs: 20,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    // MAX_CONSECUTIVE_SILENCE_NUDGES = 3 back-to-back nudges, then quiet.
    await vi.waitFor(() => {
      expect(callbacks.onReplyDone).toHaveBeenCalledTimes(3);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(callbacks.onReplyDone).toHaveBeenCalledTimes(3);
    // Real user speech resets the budget: one reply for the user turn,
    // then nudging resumes.
    stt.last()?.fireFinal("I'm back");
    const replyDone = callbacks.onReplyDone as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(replyDone.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
    expect(callbacks.onUserTranscript).toHaveBeenCalledWith("I'm back");
    await t.stop();
  });

  test("greeting completion arms the countdown", async () => {
    const { opts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hello?" }] }),
      silenceTimeoutMs: 30,
      sessionConfig: { systemPrompt: "s", greeting: "Hi there!" },
    });
    const t = createPipelineTransport(opts);
    await t.start();
    const replyDone = callbacks.onReplyDone as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      expect(replyDone.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(callbacks.onReplyStarted).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("greeting"),
    );
    expect(callbacks.onAgentTranscript).toHaveBeenLastCalledWith("hello?", false);
    await t.stop();
  });

  test("stop() clears a pending nudge", async () => {
    const { opts, callbacks } = makeOpts({
      llm: createFakeLanguageModel({ script: [{ type: "text", text: "hi" }] }),
      silenceTimeoutMs: 30,
    });
    const t = createPipelineTransport(opts);
    await t.start();
    await t.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(callbacks.onReplyStarted).not.toHaveBeenCalled();
  });
});

describe("createSilenceNudger timer bookkeeping", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeNudger(timeoutMs = 1000) {
    const onNudge = vi.fn();
    const nudger = createSilenceNudger({
      timeoutMs,
      isActive: () => true,
      isTurnInFlight: () => false,
      onNudge,
    });
    return { nudger, onNudge };
  }

  test("per-partial onUserSpeech reuses one long-lived timer instead of re-arming", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { nudger } = makeNudger(1000);

    nudger.arm();
    // A burst of STT partials (~5-10/s while the user speaks) must not
    // clearTimeout+setTimeout per call — only record a timestamp. Stay
    // inside the first window so the single pending timer never fires.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(20);
      nudger.onUserSpeech();
    }
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();
    nudger.clear();
  });

  test("the deadline sleeps out the remainder and nudges only after a full quiet window", () => {
    vi.useFakeTimers();
    const { nudger, onNudge } = makeNudger(1000);

    nudger.arm();
    vi.advanceTimersByTime(600);
    nudger.onUserSpeech(); // re-arms via timestamp — timer fires at t=1000
    vi.advanceTimersByTime(400); // t=1000: only 400 ms since speech → re-sleep
    expect(onNudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(599); // t=1599: still 1 ms short
    expect(onNudge).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // t=1600: full window since last speech
    expect(onNudge).toHaveBeenCalledTimes(1);
    expect(onNudge).toHaveBeenCalledWith(1);
    nudger.clear();
  });

  test("onUserTurn stops the countdown until re-armed", () => {
    vi.useFakeTimers();
    const { nudger, onNudge } = makeNudger(1000);

    nudger.arm();
    vi.advanceTimersByTime(500);
    nudger.onUserTurn();
    vi.advanceTimersByTime(5000);
    expect(onNudge).not.toHaveBeenCalled();

    nudger.arm();
    vi.advanceTimersByTime(1000);
    expect(onNudge).toHaveBeenCalledTimes(1);
    nudger.clear();
  });
});
