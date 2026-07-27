// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  findWorkletNode,
  installAudioMocks,
  MockAudioContext,
  voiceOpts,
} from "./_react-test-utils.ts";
import { createVoiceIO } from "./audio.ts";

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

  test("uses TTS sample rate for the AudioContext", async () => {
    const io = await createVoiceIO(voiceOpts());
    expect(audio.lastContext().sampleRate).toBe(24_000);
    await io.close();
  });

  test("loads both worklet modules in parallel", async () => {
    const io = await createVoiceIO(voiceOpts());
    expect(audio.lastContext().audioWorklet.modules.length).toBe(2);
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

  test("capture calls onMicData when worklet sends chunks", async () => {
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

    for (let i = 0; i < 13; i++) {
      const buf = new ArrayBuffer(256);
      const view = new Int16Array(buf);
      view.fill(16_384);
      capNode.port.simulateMessage({ event: "chunk", buffer: buf });
    }

    expect(onMicData).toHaveBeenCalled();
    const firstCall = onMicData.mock.calls[0] as [ArrayBuffer];
    const pcm16 = new Int16Array(firstCall[0]);
    expect(pcm16[0]).toBe(16_384);
    await io.close();
  });

  test("passes the mic chunk size to the capture worklet", async () => {
    const io = await createVoiceIO(voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 16_000 }));
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");
    const opts = capNode.options as { processorOptions?: Record<string, unknown> };
    // MIC_BUFFER_SECONDS (0.1) worth of samples at the STT rate.
    expect(opts.processorOptions?.chunkSamples).toBe(1600);
    await io.close();
  });

  test("forwards a full-size worklet chunk without copying it", async () => {
    const onMicData = vi.fn((_buf: ArrayBuffer) => {
      /* noop */
    });
    const io = await createVoiceIO(
      voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 16_000, onMicData }),
    );
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    const buf = new ArrayBuffer(3200);
    new Int16Array(buf).fill(1234);
    capNode.port.simulateMessage({ event: "chunk", buffer: buf });

    expect(onMicData).toHaveBeenCalledTimes(1);
    // Same ArrayBuffer identity — the worklet transferred ownership, so the
    // main thread must not re-copy it.
    expect(onMicData.mock.calls[0]?.[0]).toBe(buf);
    await io.close();
  });

  test("flushes carried bytes before a chunk that would overflow the accumulator", async () => {
    const onMicData = vi.fn((_buf: ArrayBuffer) => {
      /* noop */
    });
    const io = await createVoiceIO(
      voiceOpts({ sttSampleRate: 16_000, ttsSampleRate: 16_000, onMicData }),
    );
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    // A short flush (below the 3200-byte target) is carried, then a full chunk
    // arrives: both must be delivered, oldest first, and nothing dropped.
    capNode.port.simulateMessage({ event: "chunk", buffer: new ArrayBuffer(400) });
    expect(onMicData).not.toHaveBeenCalled();
    capNode.port.simulateMessage({ event: "chunk", buffer: new ArrayBuffer(6400) });

    expect(onMicData.mock.calls.map((c) => (c[0] as ArrayBuffer).byteLength)).toEqual([400, 6400]);
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

  test("close stops media tracks and closes AudioContext", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    expect(audio.lastContext().closed).toBe(true);
  });

  test("close is idempotent", async () => {
    const io = await createVoiceIO(voiceOpts());
    await io.close();
    await io.close();
  });

  test("cleans up on worklet load error", async () => {
    let _lastContext!: MockAudioContext;
    // Double-cast needed: test assigns an incomplete AudioContext mock that
    // doesn't satisfy the full DOM AudioContext interface.
    const g = globalThis as unknown as Record<string, unknown>;
    g.AudioContext = class extends MockAudioContext {
      constructor(opts?: { sampleRate?: number }) {
        super(opts);
        _lastContext = this;
        this.audioWorklet.addModule = () => Promise.reject(new Error("fail"));
      }
    };

    await expect(createVoiceIO(voiceOpts())).rejects.toThrow("fail");
    expect(_lastContext?.closed).toBe(true);
  });
});
