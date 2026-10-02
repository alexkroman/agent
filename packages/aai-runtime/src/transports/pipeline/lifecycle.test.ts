// Copyright 2026 the AAI authors. MIT license.
// The pipeline lifecycle (`createPipelineLifecycle`), through the transport it
// is assembled into: start() opens both providers, stop() tears down even a
// session still connecting, and a provider failure — at open or mid-session —
// reports the session over and detaches every listener. The greeting, the
// lifecycle's other half, is greeting.test.ts's.
//
// The phase machine underneath (`createPipelinePhase`) is driven directly
// first, over spied effects: there a phase is one `send` away, so orderings
// that need a whole transport to stage — a stop landing mid-open, TTS adopted
// before `open()` settles — are cheap.

import { describe, expect, test, vi } from "vitest";
import { createFailingProvider, createFakeTtsProvider } from "../../_pipeline-test-fakes.ts";
import type { SttOpener, SttSession } from "../../providers/openers.ts";
import { makeOpts, useVirtualTime } from "../_pipeline-transport-harness.ts";
import { createPipelinePhase, type PipelinePhaseEffects } from "./lifecycle.ts";
import { createPipelineTransport } from "./transport.ts";

useVirtualTime();

/** A phase machine over spied effects, with `open()` held until the spec settles it. */
function makePhase() {
  const open = Promise.withResolvers<"ok" | "failed">();
  const order: string[] = [];
  const spies = {
    open: vi.fn(() => open.promise),
    becomeAudible: vi.fn(() => order.push("becomeAudible")),
    armNudger: vi.fn(() => order.push("armNudger")),
    // Never settles: the failure line is "still being spoken" unless a spec
    // sends FAILURE_SPOKEN itself, as the real effect does when it finishes.
    speakStartFailure: vi.fn(() => new Promise<void>(() => undefined)),
    dropHeld: vi.fn(() => order.push("dropHeld")),
  } satisfies PipelinePhaseEffects;
  return { spies, open, order, phase: createPipelinePhase(spies) };
}

describe("the phase machine", () => {
  test("idle until started; START invokes the open, and nothing is audible yet", () => {
    const { spies, phase } = makePhase();
    expect(phase.phase()).toBe("idle");
    phase.send({ type: "START" });
    expect(phase.phase()).toBe("opening");
    expect(spies.open).toHaveBeenCalledTimes(1);
    expect(phase.audible()).toBe(false);
    expect(phase.isTerminated()).toBe(false);
  });

  test("TTS adopted mid-open makes audio flow once; the open settling arms the nudger", async () => {
    const { spies, open, phase } = makePhase();
    phase.send({ type: "START" });
    phase.send({ type: "AUDIO_READY" });
    expect(phase.audible()).toBe(true);
    expect(spies.becomeAudible).toHaveBeenCalledTimes(1);
    // Audio becomes ready ONCE; a repeated announcement is inert.
    phase.send({ type: "AUDIO_READY" });

    open.resolve("ok");
    await phase.settled();
    expect(phase.phase()).toBe("ready");
    expect(spies.becomeAudible).toHaveBeenCalledTimes(1);
    expect(spies.armNudger).toHaveBeenCalledTimes(1);
  });

  test("an open that settles before TTS announced itself greets, THEN arms the nudger", async () => {
    const { open, order, phase } = makePhase();
    phase.send({ type: "START" });
    open.resolve("ok");
    await phase.settled();
    expect(phase.phase()).toBe("ready");
    expect(order).toEqual(["becomeAudible", "armNudger"]);
  });

  test("a failed open speaks the failure, never arms the nudger, and holds lines until it ends", async () => {
    const { spies, open, order, phase } = makePhase();
    phase.send({ type: "START" });
    open.resolve("failed");
    await vi.waitFor(() => expect(phase.phase()).toBe("failing"));
    expect(spies.speakStartFailure).toHaveBeenCalledTimes(1);
    expect(phase.audible()).toBe(false);
    expect(phase.isTerminated()).toBe(false);

    phase.send({ type: "FAILURE_SPOKEN" });
    expect(phase.isTerminated()).toBe(true);
    expect(order).toEqual(["dropHeld"]);
  });

  test("a stop mid-open LEAVES opening, so the open's completion is never delivered", async () => {
    // What deletes the nudger's re-check: start() used to arm it after
    // `await startPromise`, safe only because the nudger re-read isActive().
    const { spies, open, phase } = makePhase();
    phase.send({ type: "START" });
    phase.send({ type: "STOP" });
    expect(phase.isTerminated()).toBe(true);
    expect(spies.dropHeld).toHaveBeenCalledTimes(1);

    open.resolve("ok");
    await phase.settled();
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.armNudger).not.toHaveBeenCalled();
    expect(spies.becomeAudible).not.toHaveBeenCalled();
    // A late TTS adoption cannot make a terminated session audible.
    phase.send({ type: "AUDIO_READY" });
    expect(phase.audible()).toBe(false);
  });

  test("a provider error ends a live session, and a stop before start ends an idle one", () => {
    const live = makePhase();
    live.phase.send({ type: "START" });
    live.phase.send({ type: "AUDIO_READY" });
    live.phase.send({ type: "PROVIDER_ERROR" });
    expect(live.phase.phase()).toBe("terminated");
    expect(live.phase.audible()).toBe(false);

    const idle = makePhase();
    idle.phase.send({ type: "STOP" });
    expect(idle.phase.phase()).toBe("terminated");
    // START after the end is ignored: no provider is opened for a dead session.
    idle.phase.send({ type: "START" });
    expect(idle.spies.open).not.toHaveBeenCalled();
  });
});

describe("pipeline lifecycle", () => {
  describe("start()", () => {
    test("opens both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()).toBeDefined();
      expect(tts.last()).toBeDefined();
      await t.stop();
    });

    test("passes correct keys and sample rate to STT opener", async () => {
      const { opts, stt } = makeOpts({
        providerKeys: { stt: "MY_STT_KEY", tts: "t" },
        sttSampleRate: 8000,
        sttPrompt: "be brief",
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(stt.last()?.options.sampleRate).toBe(8000);
      expect(stt.last()?.options.apiKey).toBe("MY_STT_KEY");
      expect(stt.last()?.options.sttPrompt).toBe("be brief");
      await t.stop();
    });
  });

  describe("stop()", () => {
    test("closes both STT and TTS sessions", async () => {
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      expect(stt.last()?.close).toHaveBeenCalled();
      expect(tts.last()?.close).toHaveBeenCalled();
    });

    test("stop() is idempotent", async () => {
      const { opts, stt } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      await t.stop();
      await t.stop();
      expect(stt.last()?.close).toHaveBeenCalled();
    });

    test("stop() waits for an in-flight start() and tears down the mid-connect session", async () => {
      // STT open hangs, simulating a client that disconnects while providers
      // are still connecting. stop() must not resolve until the open settles,
      // and the session that lands after the abort must be closed (not leaked).
      const closeStt = vi.fn(async () => undefined);
      const open = Promise.withResolvers<SttSession>();
      const slowStt: SttOpener = { name: "slow-stt", open: () => open.promise };
      const { opts } = makeOpts({ stt: slowStt });
      const t = createPipelineTransport(opts);

      void t.start();
      const stopResolved = vi.fn();
      const stopP = t.stop().then(stopResolved);

      await vi.advanceTimersByTimeAsync(0);
      expect(stopResolved).not.toHaveBeenCalled(); // blocked on the in-flight open

      const landed: SttSession = {
        sendAudio: vi.fn(),
        on: (() => () => undefined) as SttSession["on"],
        close: closeStt,
      };
      open.resolve(landed);
      await stopP;

      expect(stopResolved).toHaveBeenCalled();
      expect(closeStt).toHaveBeenCalled();
    });
  });

  describe("provider errors", () => {
    test("STT error fires onError('stt', ...) and terminates transport", async () => {
      const { opts, stt, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      stt.last()?.fireError("stt_stream_error", "stt failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "stt failed",
        fatal: true,
      });
      await t.stop();
    });

    test("TTS error fires onError('tts', ...) and terminates transport", async () => {
      const { opts, tts, callbacks } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      tts.last()?.fireError("tts_stream_error", "tts failed");
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts failed",
        fatal: true,
      });
      await t.stop();
    });

    test("a terminate detaches the provider listeners, the way stop() does", async () => {
      // Teardown's job is that nothing further happens. A terminate that left
      // every STT/TTS listener attached rested instead on four separate
      // downstream guards each staying true — the audio gate, the two
      // `isTerminated` checks, the aborted session signal — so the unsubscribe
      // belongs in the part both teardown paths share.
      const { opts, stt, tts } = makeOpts();
      const t = createPipelineTransport(opts);
      await t.start();
      const sttEmitter = stt.last()?.emitter;
      const ttsEmitter = tts.last()?.emitter;
      expect(sttEmitter?.events.partial?.length).toBeGreaterThan(0);
      expect(ttsEmitter?.events.audio?.length).toBeGreaterThan(0);

      stt.last()?.fireError("stt_stream_error", "stt failed");

      expect(sttEmitter?.events.partial ?? []).toHaveLength(0);
      expect(ttsEmitter?.events.audio ?? []).toHaveLength(0);
      await t.stop();
    });

    test("STT open failure fires onError('stt', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        stt: createFailingProvider("stt_connect_failed", "connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect failed",
        fatal: true,
      });
      await t.stop();
    });

    test("TTS open failure fires onError('tts', ...) via reportOpenRejection", async () => {
      const { opts, callbacks } = makeOpts({
        tts: createFailingProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "tts",
        message: "tts connect failed",
        fatal: true,
      });
      await t.stop();
    });

    test("a session that cannot start says so instead of holding a silent line", async () => {
      // STT and TTS open independently, so the usual failure leaves a working
      // voice and nothing to listen with. Silence is indistinguishable from a
      // dead call from the caller's side.
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "Sorry, I cannot hear you. Please call back.",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();

      expect(tts.last()?.textChunks.join("")).toContain("cannot hear you");
      // Spoken, and surfaced as a transcript so captions match the audio.
      expect(callbacks.reported("agentTranscript.committed")).toHaveBeenCalledWith({
        type: "agentTranscript.committed",
        text: expect.stringContaining("cannot hear you"),
        // ...and tagged as a recovery phrase, which is what keeps it out of the
        // conversation every reader reconstructs from the stream.
        recovery: "session-failed",
      });
      // Still a failed start: the client must learn the session is dead.
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
        fatal: true,
      });
      await t.stop();
    });

    test("stays silent when TTS is the side that failed", async () => {
      // Nothing to speak with; the phrase must not wedge the teardown waiting
      // on a provider that never opened.
      const { opts, callbacks } = makeOpts({
        tts: createFailingProvider("tts_connect_failed", "tts connect failed"),
      });
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agentTranscript.committed")).not.toHaveBeenCalled();
      await t.stop();
    });

    test('startFailurePhrase "" disables the spoken failure', async () => {
      const tts = createFakeTtsProvider();
      const { opts, callbacks } = makeOpts(
        {
          stt: createFailingProvider("stt_connect_failed", "connect timed out"),
          tts,
          startFailurePhrase: "",
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      expect(callbacks.reported("agentTranscript.committed")).not.toHaveBeenCalled();
      expect(callbacks.reported("error.reported")).toHaveBeenCalledWith({
        type: "error.reported",
        code: "stt",
        message: "connect timed out",
        fatal: true,
      });
      await t.stop();
    });

    test("when STT fails, TTS session is still opened but then immediately closed", async () => {
      const tts = createFakeTtsProvider();
      const { opts } = makeOpts(
        {
          stt: createFailingProvider("stt_connect_failed", "bad key"),
          tts,
        },
        { tts },
      );
      const t = createPipelineTransport(opts);
      await t.start();
      // Promise.allSettled opens both concurrently; STT failure then closes TTS.
      expect(tts.last()?.close).toHaveBeenCalled();
      await t.stop();
    });
  });
});
