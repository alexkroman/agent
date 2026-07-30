// Copyright 2026 the AAI authors. MIT license.
// WebRTC push-to-talk mic glue: worklet wiring, press lifecycle, teardown.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  findWorkletNode,
  installAudioMocks,
  type MockAudioWorkletNode,
} from "./_react-test-utils.ts";
import { floatToPcm16 } from "./audio.ts";
import { CAPTURE_WORKLET_MODULE_URL, createPttRecorder } from "./sync-mic.ts";

let mocks: ReturnType<typeof installAudioMocks>;

beforeEach(() => {
  mocks = installAudioMocks();
});

afterEach(() => {
  mocks.restore();
});

/** One PCM16 batch as the shared capture worklet posts it. */
function voicedChunk(samples = 2048): ArrayBuffer {
  return new Int16Array(samples).fill(0x20_00).buffer;
}

function captureNode(): MockAudioWorkletNode {
  return findWorkletNode(mocks.workletNodes(), "capture-processor");
}

function emitChunk(buffer: ArrayBuffer): void {
  captureNode().port.simulateMessage({ event: "chunk", buffer });
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
  test("loads the shared capture worklet as a blob URL", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(mocks.lastContext().audioWorklet.modules).toContain(CAPTURE_WORKLET_MODULE_URL);
    // Blob URL, not a data URI — the agent CSP allows `script-src blob:` only.
    expect(CAPTURE_WORKLET_MODULE_URL.startsWith("blob:")).toBe(true);
    expect(captureNode()).toBeDefined();
    await recorder.close();
  });

  test("drives the worklet's start/stop protocol", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(captureNode().port.posted).toContainEqual({ event: "start" });
    await recorder.stop();
    // The stop waits for the worklet's 'stopped' ack (the mock port mirrors
    // it), so the final flush's chunk can never be torn away mid-post.
    expect(captureNode().port.posted).toContainEqual({ event: "stop" });
  });

  test("records exactly between start() and stop(), across presses", async () => {
    const recorder = createPttRecorder();
    await recorder.start();

    emitChunk(voicedChunk());
    emitChunk(voicedChunk());
    const first = await recorder.stop();
    expect(first.length).toBe(2 * 2048);

    // A stray chunk between presses is cleared by the next start(): the next
    // press starts clean on the same open mic.
    emitChunk(voicedChunk());
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

  test("start() after close() refuses instead of reopening a mic nothing can release", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    await recorder.stop();
    await recorder.close();
    await expect(recorder.start()).rejects.toThrow("closed");
  });
});

describe("floatToPcm16", () => {
  test("scales and clamps", () => {
    const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect([...pcm]).toEqual([0, 32_767, -32_768, 32_767, -32_768, 16_383]);
  });
});
