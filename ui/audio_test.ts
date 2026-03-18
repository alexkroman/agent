// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { findWorkletNode, MockAudioContext, withAudioMocks } from "./_test_utils.ts";
import { createVoiceIO } from "./audio.ts";

function noop() {}

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
  test(
    "returns a VoiceIO with enqueue, flush, close",
    withAudioMocks(async () => {
      const io = await createVoiceIO(voiceOpts());
      expect(typeof io.enqueue).toBe("function");
      expect(typeof io.flush).toBe("function");
      expect(typeof io.close).toBe("function");
      await io.close();
    }),
  );

  test(
    "uses TTS sample rate for the AudioContext",
    withAudioMocks(async ({ lastContext }) => {
      const io = await createVoiceIO(voiceOpts());
      expect(lastContext().sampleRate).toBe(24000);
      await io.close();
    }),
  );

  test(
    "loads both worklet modules in parallel",
    withAudioMocks(async ({ lastContext }) => {
      const io = await createVoiceIO(voiceOpts());
      expect(lastContext().audioWorklet.modules.length).toBe(2);
      await io.close();
    }),
  );

  test(
    "creates capture node with channelCount: 1",
    withAudioMocks(async ({ workletNodes }) => {
      const io = await createVoiceIO(voiceOpts());
      const capNode = findWorkletNode(workletNodes(), "capture-processor");
      const opts = capNode.options as Record<string, unknown>;
      expect(opts.channelCount).toBe(1);
      expect(opts.channelCountMode).toBe("explicit");
      await io.close();
    }),
  );

  test(
    "capture sends start event on init",
    withAudioMocks(async ({ workletNodes }) => {
      const io = await createVoiceIO(voiceOpts());
      const capNode = findWorkletNode(workletNodes(), "capture-processor");
      expect(
        capNode.port.posted.some((p: unknown) => {
          try {
            expect(p).toEqual({ event: "start" });
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(true);
      await io.close();
    }),
  );

  test(
    "capture calls onMicData when worklet sends chunks",
    withAudioMocks(async ({ workletNodes }) => {
      const onMicData = vi.fn((_buf: ArrayBuffer) => {});
      const io = await createVoiceIO(
        voiceOpts({
          sttSampleRate: 16000,
          ttsSampleRate: 16000,
          onMicData,
        }),
      );
      const capNode = findWorkletNode(workletNodes(), "capture-processor");

      // Each worklet chunk is 128 samples * 2 bytes = 256 bytes
      // bufferSamples = 16000 * 0.1 = 1600 samples = 3200 bytes
      // Need ~13 chunks to fill the buffer
      for (let i = 0; i < 13; i++) {
        const buf = new ArrayBuffer(256);
        const view = new Int16Array(buf);
        view.fill(16384); // 0.5 in int16
        capNode.port.simulateMessage({ event: "chunk", buffer: buf });
      }

      expect(onMicData.mock.calls.length > 0).toBe(true);
      const pcm16 = new Int16Array(onMicData.mock.calls[0]?.[0]);
      expect(pcm16[0]).toBe(16384);
      await io.close();
    }),
  );

  test(
    "enqueue posts write event to playback worklet",
    withAudioMocks(async ({ workletNodes }) => {
      const io = await createVoiceIO(voiceOpts());

      io.enqueue(new Int16Array([100, -200, 300]).buffer);

      const playNode = findWorkletNode(workletNodes(), "playback-processor");
      const writes = playNode.port.posted.filter((p) => (p as { event: string }).event === "write");
      expect(writes.length).toBe(1);
      await io.close();
    }),
  );

  test(
    "enqueue is a no-op after close",
    withAudioMocks(async ({ workletNodes }) => {
      const io = await createVoiceIO(voiceOpts());

      await io.close();
      const countBefore = workletNodes().length;
      io.enqueue(new Int16Array([100]).buffer);
      // No new playback node should be created after close
      expect(workletNodes().length).toBe(countBefore);
    }),
  );

  test(
    "flush sends interrupt to playback worklet",
    withAudioMocks(async ({ workletNodes }) => {
      const io = await createVoiceIO(voiceOpts());

      io.enqueue(new Int16Array([1, 2, 3]).buffer);
      const playNode = findWorkletNode(workletNodes(), "playback-processor");
      io.flush();

      expect(
        playNode.port.posted.some((p: unknown) => {
          try {
            expect(p).toEqual({ event: "interrupt" });
            return true;
          } catch {
            return false;
          }
        }),
      ).toBe(true);
      await io.close();
    }),
  );

  test(
    "close stops media tracks and closes AudioContext",
    withAudioMocks(async ({ lastContext }) => {
      const io = await createVoiceIO(voiceOpts());
      await io.close();
      expect(lastContext().closed).toBe(true);
    }),
  );

  test(
    "close is idempotent",
    withAudioMocks(async () => {
      const io = await createVoiceIO(voiceOpts());
      await io.close();
      await io.close(); // should not throw
    }),
  );

  test(
    "cleans up on worklet load error",
    withAudioMocks(async () => {
      let _lastContext: MockAudioContext;
      // Override AudioContext to inject worklet failure
      const g = globalThis as unknown as Record<string, unknown>;
      g.AudioContext = class extends MockAudioContext {
        constructor(opts?: { sampleRate?: number }) {
          super(opts);
          _lastContext = this;
          this.audioWorklet.addModule = () => Promise.reject(new Error("fail"));
        }
      };

      let caught = false;
      try {
        await createVoiceIO(voiceOpts());
      } catch {
        caught = true;
      }
      expect(caught).toBe(true);
      expect(_lastContext?.closed).toBe(true);
    }),
  );
});
