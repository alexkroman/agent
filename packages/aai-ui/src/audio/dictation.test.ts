// Copyright 2026 the AAI authors. MIT license.
/**
 * The dictation recorder: the clip comes back as one WAV at the asked rate,
 * the tail flushed on stop is kept, and both ways out release the mic.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  type FakeTrack,
  fakeMediaStream,
  fakeTrack,
  findWorkletNode,
  installAudioMocks,
} from "../_react-test-utils.ts";
import { openDictationRecorder } from "./dictation.ts";

const open = () =>
  openDictationRecorder({ sampleRate: 16_000, maxSeconds: 120, captureWorkletSrc: "cap" });

describe("openDictationRecorder", () => {
  let audio: AudioMockContext;
  beforeEach(() => {
    audio = installAudioMocks();
  });

  test("stop answers every captured sample as one mono 16 kHz WAV", async () => {
    const rec = await open();
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    node.port.simulateMessage({ event: "chunk", buffer: new Int16Array([1, 2]).buffer });
    node.port.simulateMessage({ event: "chunk", buffer: new Int16Array([3]).buffer });

    const wav = await rec.stop();
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(Array.from(new Int16Array(wav.buffer.slice(44)))).toEqual([1, 2, 3]);
  });

  test("stop and cancel both release the microphone, and a second call is inert", async () => {
    const tracks: FakeTrack[] = [];
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async () => {
      const track = fakeTrack();
      tracks.push(track);
      return fakeMediaStream(track);
    });
    const stopped = await open();
    await stopped.stop();
    expect((await stopped.stop()).byteLength).toBe(44);

    const cancelled = await open();
    await cancelled.cancel();
    await cancelled.cancel();
    expect(tracks).toHaveLength(2);
    expect(tracks.every((t) => t.stopped)).toBe(true);
  });
});
