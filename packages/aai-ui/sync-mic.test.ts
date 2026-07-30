// Copyright 2026 the AAI authors. MIT license.
// WebRTC mic glue: worklet wiring, VAD-driven turn dispatch, teardown.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  findWorkletNode,
  installAudioMocks,
  type MockAudioWorkletNode,
} from "./_react-test-utils.ts";
import {
  CAPTURE_WORKLET_MODULE_URL,
  createPttRecorder,
  floatToPcm16,
  type SyncMicrophone,
  startSyncMicrophone,
} from "./sync-mic.ts";

let mocks: ReturnType<typeof installAudioMocks>;
let mic: SyncMicrophone | null;

beforeEach(() => {
  mocks = installAudioMocks();
  mic = null;
});

afterEach(async () => {
  await mic?.stop();
  mocks.restore();
});

function voicedChunk(samples = 2048): Float32Array {
  return new Float32Array(samples).fill(0.5);
}

function silentChunk(samples = 2048): Float32Array {
  return new Float32Array(samples);
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

// 2048 samples at 16 kHz = 128ms per chunk; the VAD below is tuned so one
// voiced chunk confirms speech and two silent chunks close the utterance.
const VAD = { minSpeechMs: 100, hangoverMs: 200, prerollMs: 100, maxUtteranceMs: 10_000 };

async function start(overrides: Partial<Parameters<typeof startSyncMicrophone>[0]> = {}) {
  const sendPcm16 = vi.fn().mockResolvedValue({});
  mic = await startSyncMicrophone({
    session: { sendPcm16 },
    vad: VAD,
    ...overrides,
  });
  return { sendPcm16, mic };
}

describe("startSyncMicrophone", () => {
  test("registers the inline worklet and wires mic → capture node", async () => {
    await start();
    expect(mocks.lastContext().audioWorklet.modules).toContain(CAPTURE_WORKLET_MODULE_URL);
    // Blob URL, not a data URI — the agent CSP allows `script-src blob:` only.
    expect(CAPTURE_WORKLET_MODULE_URL.startsWith("blob:")).toBe(true);
    expect(captureNode()).toBeDefined();
  });

  test("an endpointed utterance dispatches one turn with speech callbacks", async () => {
    const onSpeechStart = vi.fn();
    const onSpeechEnd = vi.fn();
    const { sendPcm16 } = await start({ onSpeechStart, onSpeechEnd });

    emitChunk(voicedChunk());
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(mic?.speaking).toBe(true);
    emitChunk(voicedChunk());
    emitChunk(silentChunk());
    emitChunk(silentChunk());

    expect(onSpeechEnd).toHaveBeenCalledOnce();
    expect(mic?.speaking).toBe(false);
    expect(sendPcm16).toHaveBeenCalledOnce();
    const [pcm, rate] = sendPcm16.mock.calls[0] as [Int16Array, number];
    expect(rate).toBe(16_000);
    expect(pcm.length).toBe(4 * 2048);
  });

  test("stop() flushes a trailing utterance and releases everything", async () => {
    const { sendPcm16 } = await start();
    emitChunk(voicedChunk());
    emitChunk(voicedChunk());
    expect(mic?.speaking).toBe(true);

    await mic?.stop();
    expect(sendPcm16).toHaveBeenCalledOnce();
    expect(mocks.lastContext().closed).toBe(true);
    // Frames after stop are ignored.
    emitChunk(voicedChunk());
    expect(sendPcm16).toHaveBeenCalledOnce();
  });

  test("a failed turn surfaces through onError", async () => {
    const onError = vi.fn();
    const sendPcm16 = vi.fn().mockRejectedValue(new Error("server down"));
    mic = await startSyncMicrophone({ session: { sendPcm16 }, vad: VAD, onError });
    emitChunk(voicedChunk());
    emitChunk(silentChunk());
    emitChunk(silentChunk());
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    const turnErr = onError.mock.calls[0]?.[0] as Error;
    expect(turnErr.message).toContain("server down");
  });

  test("a crashed capture worklet surfaces through onError", async () => {
    const onError = vi.fn();
    await start({ onError });
    (captureNode() as unknown as { onprocessorerror: () => void }).onprocessorerror();
    const crashErr = onError.mock.calls[0]?.[0] as Error;
    expect(crashErr.message).toContain("worklet crashed");
  });

  test("getUserMedia rejection fails start() and closes the context", async () => {
    const nav = navigator as unknown as {
      mediaDevices: { getUserMedia: () => Promise<unknown> };
    };
    nav.mediaDevices.getUserMedia = () => Promise.reject(new Error("denied"));
    await expect(startSyncMicrophone({ session: { sendPcm16: vi.fn() } })).rejects.toThrow(
      "denied",
    );
    expect(mocks.lastContext().closed).toBe(true);
  });
});

describe("voice capture constraints", () => {
  // The signal reaches an energy VAD here, so browser processing that moves
  // levels around (AGC) or gates a quiet room to exact zeros (suppression,
  // isolation) is off. Echo cancellation stays on.
  const RAW_VOICE = {
    autoGainControl: false,
    noiseSuppression: false,
    voiceIsolation: false,
    echoCancellation: true,
  };

  test("startSyncMicrophone captures raw voice", async () => {
    await start();
    expect(mocks.lastAudioConstraints()).toMatchObject(RAW_VOICE);
  });

  test("createPttRecorder captures raw voice", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(mocks.lastAudioConstraints()).toMatchObject(RAW_VOICE);
    await recorder.stop();
  });
});

describe("createPttRecorder", () => {
  test("records exactly between start() and stop(), across presses", async () => {
    const recorder = createPttRecorder();
    await recorder.start();
    expect(mocks.lastContext().audioWorklet.modules).toContain(CAPTURE_WORKLET_MODULE_URL);

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
