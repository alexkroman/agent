// Copyright 2026 the AAI authors. MIT license.
// WebRTC push-to-talk mic glue: worklet wiring, press lifecycle, teardown.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findWorkletNode,
  installAudioMocks,
  type MockAudioWorkletNode,
} from "./_react-test-utils.ts";
import { CAPTURE_WORKLET_MODULE_URL, createPttRecorder, floatToPcm16 } from "./sync-mic.ts";

let mocks: ReturnType<typeof installAudioMocks>;

beforeEach(() => {
  mocks = installAudioMocks();
});

afterEach(() => {
  mocks.restore();
});

function voicedChunk(samples = 2048): Float32Array {
  return new Float32Array(samples).fill(0.5);
}

function captureNode(): MockAudioWorkletNode {
  return findWorkletNode(mocks.workletNodes(), "aai-sync-capture");
}

function emitChunk(samples: Float32Array): void {
  const node = captureNode();
  (
    node as unknown as { onmessage?: unknown; port: { onmessage: (e: MessageEvent) => void } }
  ).port.onmessage(new MessageEvent("message", { data: { event: "chunk", samples } }));
}

describe("voice capture constraints", () => {
  // The captured signal feeds STT directly, so browser processing that moves
  // levels around (AGC) or gates a quiet room to exact zeros (suppression,
  // isolation) is off. Echo cancellation stays on.
  const RAW_VOICE = {
    autoGainControl: false,
    noiseSuppression: false,
    voiceIsolation: false,
    echoCancellation: true,
  };

  test("createPttRecorder captures raw voice", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(mocks.lastAudioConstraints()).toMatchObject(RAW_VOICE);
    await recorder.stop();
  });
});

describe("createPttRecorder", () => {
  test("registers the inline worklet module as a blob URL", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(mocks.lastContext().audioWorklet.modules).toContain(CAPTURE_WORKLET_MODULE_URL);
    // Blob URL, not a data URI — the agent CSP allows `script-src blob:` only.
    expect(CAPTURE_WORKLET_MODULE_URL.startsWith("blob:")).toBe(true);
    expect(captureNode()).toBeDefined();
    await recorder.close();
  });

  test("records exactly between start() and stop(), across presses", async () => {
    const recorder = createPttRecorder();
    await recorder.start();

    emitChunk(voicedChunk());
    emitChunk(voicedChunk());
    const first = await recorder.stop();
    expect(first.length).toBe(2 * 2048);

    // Frames outside a press are dropped…
    emitChunk(voicedChunk());
    // …and the next press starts clean on the same open mic.
    await recorder.start();
    emitChunk(voicedChunk());
    const second = await recorder.stop();
    expect(second.length).toBe(2048);

    await recorder.close();
    expect(mocks.lastContext().closed).toBe(true);
  });

  test("getUserMedia rejection fails start() and closes the context", async () => {
    const nav = navigator as unknown as {
      mediaDevices: { getUserMedia: () => Promise<unknown> };
    };
    nav.mediaDevices.getUserMedia = () => Promise.reject(new Error("denied"));
    await expect(createPttRecorder().start()).rejects.toThrow("denied");
    expect(mocks.lastContext().closed).toBe(true);
  });
});

describe("floatToPcm16", () => {
  test("scales and clamps", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect([...pcm]).toEqual([0, 32_767, -32_768, 32_767, -32_768, 16_383]);
  });
});
