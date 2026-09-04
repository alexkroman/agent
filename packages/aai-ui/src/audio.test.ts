// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  crashWorklet,
  fakeTrack,
  findWorkletNode,
  g,
  installAudioMocks,
  MockAudioContext,
  voiceOpts,
} from "./_react-test-utils.ts";
import { createVoiceIO, type PlaybackStats } from "./audio.ts";

function noop() {
  /* silence expected console.error output */
}

/**
 * The turn id the host most recently posted with a 'done'. The worklet echoes
 * it on the matching 'stop' (see `stopTurn`), and the host only settles a wait
 * on a stop carrying the id it is waiting for — so a simulated stop has to
 * carry one too.
 */
function currentTurn(node: import("./_react-test-utils.ts").MockAudioWorkletNode): number {
  const dones = node.port.posted.filter(
    (m): m is { event: "done"; turn: number } => (m as { event?: string }).event === "done",
  );
  const last = dones.at(-1);
  if (!last) throw new Error("no 'done' was posted to the playback worklet");
  return last.turn;
}

/** A worklet drain-stop for the turn the host is currently waiting on. */
function drainStop(node: import("./_react-test-utils.ts").MockAudioWorkletNode): void {
  node.port.simulateMessage({ event: "stop", reason: "done", turn: currentTurn(node) });
}

describe("createVoiceIO", () => {
  let audio: AudioMockContext & { restore: () => void };

  beforeEach(() => {
    audio = installAudioMocks();
  });

  afterEach(() => {
    audio.restore();
  });

  test("returns a VoiceIO with enqueue, flush, close", async () => {
    const io = await createVoiceIO(voiceOpts());
    expect(io.enqueue).toBeTypeOf("function");
    expect(io.flush).toBeTypeOf("function");
    expect(io.close).toBeTypeOf("function");
    await io.close();
  });

  test("plays back on a context at the TTS sample rate", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
    expect(playNode.ctx.sampleRate).toBe(24_000);
    await io.close();
  });

  test("loads each worklet module on the context that runs it", async () => {
    const io = await createVoiceIO(voiceOpts());
    const loaded = audio.contexts().flatMap((c) => c.audioWorklet.modules);
    expect(loaded).toEqual(expect.arrayContaining(["cap", "play"]));
    await io.close();
  });

  test("captures through its own context at the STT sample rate", async () => {
    // The browser's resampler is properly band-limited; the worklet's is a
    // linear interpolation, so the conversion belongs to the browser whenever
    // it will do it.
    const io = await createVoiceIO(voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 24_000 }));

    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
    const playNodeCtxRates = audio.contexts().map((c) => c.sampleRate);
    expect(playNodeCtxRates).toContain(16_000);
    expect(playNodeCtxRates).toContain(24_000);
    // The worklet gets no rate option: the context it runs on is already at
    // the STT rate (asserted), and it reads its global sampleRate.
    expect(capNode.ctx.sampleRate).toBe(16_000);
    await io.close();
  });

  test("fails when the browser will not give a context the requested rate", async () => {
    // Sending 48 kHz audio to a socket that declared 16 kHz garbles it, and
    // silently resampling in the worklet would alias. Neither is worth
    // shipping over a clear failure.
    const forced = installAudioMocks({ forceSampleRate: 48_000 });
    try {
      await expect(
        createVoiceIO(voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 24_000 })),
      ).rejects.toThrow(/sample rate/i);
      // The failed init must not leave contexts or mic tracks behind.
      expect(forced.contexts().every((c) => c.closed)).toBe(true);
    } finally {
      forced.restore();
    }
  });

  test("reuses a single context when the capture and playback rates match", async () => {
    const io = await createVoiceIO(voiceOpts({ sttSampleRate: 24_000, ttsSampleRate: 24_000 }));
    expect(audio.contexts()).toHaveLength(1);
    await io.close();
  });

  test("closes both contexts", async () => {
    const io = await createVoiceIO(voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 24_000 }));
    await io.close();
    expect(audio.contexts().every((c) => c.closed)).toBe(true);
  });

  test("captures raw voice: no gain control, noise suppression, or isolation", async () => {
    // These processors are all off deliberately. Each one rewrites the signal
    // before STT (and before the sync path's energy VAD) sees it: AGC rides
    // the noise floor up during silence, and suppression/isolation can gate a
    // quiet room to exact zeros. Echo cancellation stays on — the mic is open
    // while the agent speaks, so without it the agent hears itself.
    const io = await createVoiceIO(voiceOpts());
    const constraints = audio.lastAudioConstraints() as Record<string, unknown>;
    expect(constraints.autoGainControl).toBe(false);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.voiceIsolation).toBe(false);
    expect(constraints.echoCancellation).toBe(true);
    await io.close();
  });

  test("creates capture node with channelCount: 1", async () => {
    const io = await createVoiceIO(voiceOpts());
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
    const opts = capNode.options as Record<string, unknown>;
    expect(opts.channelCount).toBe(1);
    expect(opts.channelCountMode).toBe("explicit");
    await io.close();
  });

  test("capture sends start event on init", async () => {
    const io = await createVoiceIO(voiceOpts());
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
    expect(capNode.port.posted).toContainEqual({ event: "start" });
    await io.close();
  });

  test("capture forwards each batched worklet chunk to onMicData", async () => {
    const onMicData = vi.fn((_buf: ArrayBuffer) => {
      /* noop */
    });
    const io = await createVoiceIO(
      voiceOpts({
        sttSampleRate: 16_000,
        ttsSampleRate: 16_000,
        onMicData,
      }),
    );
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    // The worklet batches ~MIC_BUFFER_SECONDS itself, so each chunk message
    // maps 1:1 to an onMicData call — no main-thread accumulation.
    const buf = new ArrayBuffer(3200);
    new Int16Array(buf).fill(16_384);
    capNode.port.simulateMessage({ event: "chunk", buffer: buf });
    capNode.port.simulateMessage({ event: "other", buffer: new ArrayBuffer(2) });

    expect(onMicData).toHaveBeenCalledTimes(1);
    const firstCall = onMicData.mock.calls[0] as [ArrayBuffer];
    expect(firstCall[0].byteLength).toBe(3200);
    expect(new Int16Array(firstCall[0])[0]).toBe(16_384);
    await io.close();
  });

  test("enqueue posts write event to playback worklet", async () => {
    const io = await createVoiceIO(voiceOpts());

    io.enqueue(new Int16Array([100, -200, 300]).buffer);

    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
    const writes = playNode.port.posted.filter((p) => (p as { event: string }).event === "write");
    expect(writes.length).toBe(1);
    await io.close();
  });

  test("enqueue is a no-op after close", async () => {
    const io = await createVoiceIO(voiceOpts());

    await io.close();
    const countBefore = audio.workletNodes().length;
    io.enqueue(new Int16Array([100]).buffer);
    expect(audio.workletNodes().length).toBe(countBefore);
  });

  test("flush sends interrupt to playback worklet", async () => {
    const io = await createVoiceIO(voiceOpts());

    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");
    io.flush();

    expect(playNode.port.posted).toContainEqual({ event: "interrupt" });
    await io.close();
  });

  test("reports a turn's concealment stats to the caller", async () => {
    const seen: PlaybackStats[] = [];
    const io = await createVoiceIO(voiceOpts({ onPlaybackStats: (s) => seen.push(s) }));
    // The playback node is created lazily on first enqueue.
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    const stats: PlaybackStats = {
      concealedSamples: 480,
      silentConcealedSamples: 120,
      concealmentEvents: 2,
      silentConcealmentEvents: 1,
    };
    playNode.port.simulateMessage({ event: "stop", reason: "done", stats });

    expect(seen).toEqual([stats]);
    await io.close();
  });

  test("does not report stats for a turn that concealed nothing", async () => {
    const seen: PlaybackStats[] = [];
    const io = await createVoiceIO(voiceOpts({ onPlaybackStats: (s) => seen.push(s) }));
    // The playback node is created lazily on first enqueue.
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    playNode.port.simulateMessage({
      event: "stop",
      reason: "done",
      stats: {
        concealedSamples: 0,
        silentConcealedSamples: 0,
        concealmentEvents: 0,
        silentConcealmentEvents: 0,
      },
    });

    expect(seen).toEqual([]);
    await io.close();
  });

  test("reports stats from an interrupted turn, whose stop it otherwise drops", async () => {
    const seen: PlaybackStats[] = [];
    const io = await createVoiceIO(voiceOpts({ onPlaybackStats: (s) => seen.push(s) }));
    // The playback node is created lazily on first enqueue.
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    // Concealment before a barge-in is real playback trouble; the stop itself
    // is dropped (it belongs to a turn flush() already settled) but the
    // measurement must not be dropped with it.
    playNode.port.simulateMessage({
      event: "stop",
      reason: "interrupt",
      stats: {
        concealedSamples: 240,
        silentConcealedSamples: 0,
        concealmentEvents: 1,
        silentConcealmentEvents: 0,
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.concealedSamples).toBe(240);
    await io.close();
  });

  test("forwards the capture worklet's dead-mic report", async () => {
    const silent = vi.fn();
    const io = await createVoiceIO(voiceOpts({ onMicSilent: silent }));
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    capNode.port.simulateMessage({ event: "silent" });

    expect(silent).toHaveBeenCalledTimes(1);
    await io.close();
  });

  test("an interrupt's stop does not resolve a later done early", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    // Interrupt the current turn: the worklet will post a reason-tagged
    // 'stop' for it on its next tick, after this turn's done() has settled.
    io.flush();

    // Next turn registers its own done() before the interrupt's stop arrives.
    const resolved = vi.fn();
    void io.done().then(resolved);
    playNode.port.simulateMessage({ event: "stop", reason: "interrupt", turn: null });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    drainStop(playNode);
    await vi.waitFor(() => expect(resolved).toHaveBeenCalled());
    await io.close();
  });

  test("a drain-stop in flight when flush fires cannot settle the next turn", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    // Turn 1 drains and the worklet posts its stop — but a barge-in lands
    // first, so flush() settles turn 1 before that stop is delivered.
    const firstResolved = vi.fn();
    void io.done().then(firstResolved);
    const staleTurn = currentTurn(playNode);
    io.flush();
    await vi.waitFor(() => expect(firstResolved).toHaveBeenCalled());

    // Turn 2 is already waiting when turn 1's stop finally arrives. Settling
    // on it would report the live reply finished while it is still speaking.
    const resolved = vi.fn();
    io.enqueue(new Int16Array([4, 5, 6]).buffer);
    void io.done().then(resolved);
    playNode.port.simulateMessage({ event: "stop", reason: "done", turn: staleTurn });
    playNode.port.simulateMessage({ event: "stop", reason: "interrupt", turn: staleTurn });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    // Turn 2's own drain-stop settles it.
    drainStop(playNode);
    await vi.waitFor(() => expect(resolved).toHaveBeenCalled());
    await io.close();
  });

  test("flush settles a pending done instead of stranding it", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new Int16Array([1, 2, 3]).buffer);

    const resolved = vi.fn();
    void io.done().then(resolved);
    io.flush();
    await vi.waitFor(() => expect(resolved).toHaveBeenCalled());
    await io.close();
  });

  test("a second done settles the promise it replaces", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new Int16Array([1, 2, 3]).buffer);
    const playNode = findWorkletNode(audio.workletNodes(), "playback-processor");

    const firstResolved = vi.fn();
    const secondResolved = vi.fn();
    void io.done().then(firstResolved);
    void io.done().then(secondResolved);
    await vi.waitFor(() => expect(firstResolved).toHaveBeenCalled());
    expect(secondResolved).not.toHaveBeenCalled();

    drainStop(playNode);
    await vi.waitFor(() => expect(secondResolved).toHaveBeenCalled());
    await io.close();
  });

  test("close stops media tracks and closes AudioContext", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    expect(audio.lastContext().closed).toBe(true);
  });

  test("close is idempotent", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    const afterFirst = audio.contexts().length;

    // The second close must resolve rather than reject on an already-closed
    // AudioContext, and must not open anything new — a page that unmounts
    // while disconnecting calls this twice.
    await expect(io.close()).resolves.toBeUndefined();

    expect(audio.contexts()).toHaveLength(afterFirst);
    expect(audio.contexts().every((c) => c.closed)).toBe(true);
  });

  test("done() resolves immediately when nothing was ever enqueued", async () => {
    const io = await createVoiceIO(voiceOpts());
    await expect(io.done()).resolves.toBeUndefined();
    await io.close();
  });

  test("done() resolves immediately when the playback context is not running", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new ArrayBuffer(2));
    // Capture runs on its own context; done() waits on the playback one.
    findWorkletNode(audio.workletNodes(), "playback-processor").ctx.state = "suspended";
    await expect(io.done()).resolves.toBeUndefined();
    await io.close();
  });

  // Subsumes a "done resolves on the worklet's stop message" duplicate that
  // used to sit up in the flush block: same settle, asserted through a spy
  // instead of the promise, and without the posted-`done` check below.
  test("done() resolves when the playback worklet reports stop", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new ArrayBuffer(2));
    const play = findWorkletNode(audio.workletNodes(), "playback-processor");
    const done = io.done();
    expect(play.port.posted).toContainEqual({ event: "done", turn: currentTurn(play) });
    drainStop(play);
    await expect(done).resolves.toBeUndefined();
    await io.close();
  });

  test("done() settles via the poll when the playback context suspends mid-wait", async () => {
    vi.useFakeTimers();
    try {
      const io = await createVoiceIO(voiceOpts());
      io.enqueue(new ArrayBuffer(2));
      const done = io.done();
      // No stop message arrives; the context suspends (backgrounded tab).
      findWorkletNode(audio.workletNodes(), "playback-processor").ctx.state = "suspended";
      await vi.advanceTimersByTimeAsync(1100);
      await expect(done).resolves.toBeUndefined();
      await io.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("enqueue drops empty buffers", async () => {
    const io = await createVoiceIO(voiceOpts());
    io.enqueue(new ArrayBuffer(0));
    // The playback node is created lazily — an empty write must not create it.
    expect(audio.workletNodes().some((n) => n.name === "playback-processor")).toBe(false);
    await io.close();
  });

  test("a capture worklet crash surfaces through onError", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const onError = vi.fn();
    const io = await createVoiceIO(voiceOpts({ onError }));
    const cap = findWorkletNode(audio.workletNodes(), "capture-processor");
    crashWorklet(cap);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("capture") }),
    );
    await io.close();
  });

  test("a playback worklet crash settles a pending done() and surfaces onError", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const onError = vi.fn();
    const io = await createVoiceIO(voiceOpts({ onError }));
    io.enqueue(new ArrayBuffer(2));
    const play = findWorkletNode(audio.workletNodes(), "playback-processor");
    const done = io.done();
    crashWorklet(play);
    await expect(done).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("playback") }),
    );
    await io.close();
  });

  test("non-chunk capture messages are ignored", async () => {
    const onMicData = vi.fn();
    const io = await createVoiceIO(voiceOpts({ onMicData }));
    const cap = findWorkletNode(audio.workletNodes(), "capture-processor");
    cap.port.simulateMessage({ event: "started" });
    expect(onMicData).not.toHaveBeenCalled();
    await io.close();
  });

  test("Symbol.asyncDispose releases the audio resources", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io[Symbol.asyncDispose]();
    expect(audio.lastContext().closed).toBe(true);
  });

  test("releases the mic when a parallel init step fails after getUserMedia resolves", async () => {
    // getUserMedia succeeds and hands out real tracks, but worklet
    // registration fails: init must still stop every track (no orphaned
    // "recording" indicator in the browser chrome) and close the context.
    //
    // Subsumes a "cleans up on worklet load error" duplicate that re-declared
    // the same failing-`addModule` subclass to assert only the context close.
    const tracks = [fakeTrack(), fakeTrack()];
    const nav = g.navigator as { mediaDevices: { getUserMedia: unknown } };
    nav.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => tracks });

    let lastCtx!: MockAudioContext;
    g.AudioContext = class extends MockAudioContext {
      constructor(opts?: { sampleRate?: number }) {
        super(opts);
        lastCtx = this;
        this.audioWorklet.addModule = () => Promise.reject(new Error("module load failed"));
      }
    };

    await expect(createVoiceIO(voiceOpts())).rejects.toThrow("module load failed");
    // Track release rides the streamPromise continuation, so it can land a
    // microtask after the rejection surfaces.
    await vi.waitFor(() => {
      expect(tracks.every((t) => t.stopped)).toBe(true);
    });
    expect(lastCtx.closed).toBe(true);
  });

  test("done() resolves at the 65s hard cap when no stop ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const io = await createVoiceIO(voiceOpts());
      io.enqueue(new ArrayBuffer(2));
      // The context stays "running" and the worklet never posts 'stop' —
      // a silently dead processor. The hard cap must settle done() so
      // session state can't hang in "speaking" forever.
      const resolved = vi.fn();
      void io.done().then(resolved);
      await vi.advanceTimersByTimeAsync(64_000);
      expect(resolved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolved).toHaveBeenCalled();
      await io.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("close waits for the capture stop ack so the flushed mic tail reaches onMicData", async () => {
    const onMicData = vi.fn((_buf: ArrayBuffer) => {
      /* noop */
    });
    const io = await createVoiceIO(voiceOpts({ onMicData }));
    const cap = findWorkletNode(audio.workletNodes(), "capture-processor");

    const closing = io.close();
    // close() posts 'stop' synchronously; the MockMessagePort echoes
    // 'stopped' on a microtask, so a tail chunk simulated in between mirrors
    // the worklet's final flush racing teardown — it must still be delivered.
    expect(cap.port.posted).toContainEqual({ event: "stop" });
    const tail = new Int16Array([7, 8, 9]).buffer;
    cap.port.simulateMessage({ event: "chunk", buffer: tail });

    await expect(closing).resolves.toBeUndefined();
    expect(onMicData).toHaveBeenCalledWith(tail);
    expect(audio.lastContext().closed).toBe(true);
  });
});
