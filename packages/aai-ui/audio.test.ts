// Copyright 2025 the AAI authors. MIT license.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  findWorkletNode,
  installAudioMocks,
  MockAudioContext,
} from "./_test-utils.ts";
import { createVoiceIO } from "./audio.ts";

function noop() {
  /* intentional no-op */
}

function voiceOpts(overrides?: Partial<Parameters<typeof createVoiceIO>[0]>) {
  return {
    sttSampleRate: 16000,
    ttsSampleRate: 24000,
    captureWorkletSrc: "cap",
    playbackWorkletSrc: "play",
    onMicData: noop,
    ...overrides,
  };
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
    expect(typeof io.enqueue).toBe("function");
    expect(typeof io.flush).toBe("function");
    expect(typeof io.close).toBe("function");
    await io.close();
  });

  test("uses TTS sample rate for the AudioContext", async () => {
    const io = await createVoiceIO(voiceOpts());
    expect(audio.lastContext().sampleRate).toBe(24000);
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
        sttSampleRate: 16000,
        ttsSampleRate: 16000,
        onMicData,
      }),
    );
    const capNode = findWorkletNode(audio.workletNodes(), "capture-processor");

    for (let i = 0; i < 13; i++) {
      const buf = new ArrayBuffer(256);
      const view = new Int16Array(buf);
      view.fill(16384);
      capNode.port.simulateMessage({ event: "chunk", buffer: buf });
    }

    expect(onMicData.mock.calls.length > 0).toBe(true);
    const firstCall = onMicData.mock.calls[0] as [ArrayBuffer];
    const pcm16 = new Int16Array(firstCall[0]);
    expect(pcm16[0]).toBe(16384);
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
