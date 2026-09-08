// Copyright 2026 the AAI authors. MIT license.
/**
 * The cases here are the ones that produce a WRONG ANSWER rather than an error
 * — an odd-length chunk ahead of the samples, a streaming encoder's unknown
 * length, a truncated download — because those are what a 44-byte assumption
 * turns into confident nonsense at the front of a transcript.
 */
import { describe, expect, test } from "vitest";

import {
  blockAlign,
  bytesPerSecond,
  offsetToMs,
  parseWav,
  UnsupportedRecordingError,
  type WavFormat,
} from "./wav-parse.ts";

/** 16 kHz mono 16-bit — one second of audio is 32,000 bytes. */
const MONO_16K = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 } as const;

/**
 * A WAV header in front of `dataBytes` of (absent) samples.
 *
 * `extraChunk` puts a chunk between `fmt ` and `data`, which is where a
 * recorder's `LIST`/`bext` block really sits — and an odd-length one is the
 * padding rule's test case.
 */
function wavFile(
  fmt: { sampleRate: number; channels: number; bitsPerSample: number },
  dataBytes: number,
  overrides: { declaredDataSize?: number; extraChunk?: string; encoding?: number } = {},
): Uint8Array {
  const extra = overrides.extraChunk;
  const extraLength = extra === undefined ? 0 : 8 + extra.length + (extra.length % 2);
  const head = new Uint8Array(44 + extraLength);
  const view = new DataView(head.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + extraLength + dataBytes, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, overrides.encoding ?? 1, true);
  view.setUint16(22, fmt.channels, true);
  view.setUint32(24, fmt.sampleRate, true);
  view.setUint32(28, (fmt.channels * fmt.bitsPerSample * fmt.sampleRate) / 8, true);
  view.setUint16(32, (fmt.channels * fmt.bitsPerSample) / 8, true);
  view.setUint16(34, fmt.bitsPerSample, true);

  let at = 36;
  if (extra !== undefined) {
    write(at, "LIST");
    view.setUint32(at + 4, extra.length, true);
    write(at + 8, extra);
    at += extraLength;
  }
  write(at, "data");
  view.setUint32(at + 4, overrides.declaredDataSize ?? dataBytes, true);
  return head;
}

describe("parseWav", () => {
  test("reads the format and where the samples start", () => {
    const head = wavFile(MONO_16K, 32_000);
    expect(parseWav(head, 44 + 32_000)).toEqual<WavFormat>({
      ...MONO_16K,
      dataStart: 44,
      dataEnd: 44 + 32_000,
    });
  });

  test("walks past a chunk in front of the samples rather than assuming 44", () => {
    // ffmpeg's own output has a LIST/INFO chunk here, so its header is 78
    // bytes on ffmpeg 6.1 and moves whenever its version string changes. A
    // reader that skipped 44 would transcribe this chunk as audio.
    const head = wavFile(MONO_16K, 32_000, { extraChunk: "INFOISFTLavf61.7.100" });
    const format = parseWav(head, head.length + 32_000);
    expect(format.dataStart).toBe(44 + 8 + 20);
    expect(format.dataEnd).toBe(format.dataStart + 32_000);
  });

  test("honours the pad byte an odd-length chunk does not declare", () => {
    // The size field counts 19; the payload occupies 20. Off by one and every
    // later chunk id is read out of the middle of this one.
    const head = wavFile(MONO_16K, 1000, { extraChunk: "INFOISFTLavf61.7.10" });
    expect(parseWav(head, head.length + 1000).dataStart).toBe(44 + 8 + 20);
  });

  test("treats a streaming encoder's unknown length as the file's length", () => {
    for (const declaredDataSize of [0, 0xff_ff_ff_ff]) {
      const head = wavFile(MONO_16K, 64_000, { declaredDataSize });
      expect(parseWav(head, 44 + 64_000).dataEnd).toBe(44 + 64_000);
    }
  });

  test("clamps a declared length past the end of a truncated download", () => {
    const head = wavFile(MONO_16K, 320_000);
    expect(parseWav(head, 44 + 100).dataEnd).toBe(44 + 100);
  });

  test("refuses anything that is not RIFF/WAVE", () => {
    expect(() => parseWav(new TextEncoder().encode("ID3………………"), 1000)).toThrow(
      UnsupportedRecordingError,
    );
    expect(() => parseWav(new Uint8Array(4), 1000)).toThrow(/not a WAV file/);
  });

  test("refuses WAVE_FORMAT_EXTENSIBLE rather than guessing it is PCM", () => {
    // Its real encoding is in a GUID further in, and guessing wrong is noise
    // that transcribes as words rather than an error.
    const head = wavFile(MONO_16K, 1000, { encoding: 0xff_fe });
    expect(() => parseWav(head, 1044)).toThrow(/encoding 65534, not linear PCM/);
  });

  test("refuses a format nothing can be cut on", () => {
    expect(() => parseWav(wavFile({ ...MONO_16K, sampleRate: 0 }, 1000), 1044)).toThrow(
      /sample rate of 0/,
    );
    expect(() => parseWav(wavFile({ ...MONO_16K, channels: 0 }, 1000), 1044)).toThrow(
      /nothing to cut/,
    );
  });

  test("says so when the header runs past the probe", () => {
    const head = wavFile(MONO_16K, 1000).subarray(0, 30);
    expect(() => parseWav(head, 1044)).toThrow(/No `data` chunk in the first 30 bytes/);
  });
});

describe("the derived arithmetic", () => {
  test("blockAlign and bytesPerSecond", () => {
    expect(blockAlign(MONO_16K)).toBe(2);
    expect(bytesPerSecond(MONO_16K)).toBe(32_000);
    expect(bytesPerSecond({ ...MONO_16K, channels: 2 })).toBe(64_000);
  });

  test("offsetToMs subtracts dataStart, so a caller never has to", () => {
    const format = parseWav(wavFile(MONO_16K, 32_000), 44 + 32_000);
    expect(offsetToMs(format, format.dataStart)).toBe(0);
    expect(offsetToMs(format, format.dataStart + 16_000)).toBe(500);
    expect(offsetToMs(format, format.dataEnd)).toBe(1000);
  });
});
