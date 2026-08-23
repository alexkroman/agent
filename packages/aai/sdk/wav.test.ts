// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { encodeWav, pcmDurationMs, WAV_HEADER_BYTES } from "./wav.ts";

/** Read the header back the way a player does, so the assertions name fields. */
function readHeader(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...wav.subarray(at, at + length));
  return {
    riff: ascii(0, 4),
    riffSize: view.getUint32(4, true),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    fmtSize: view.getUint32(16, true),
    encoding: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
  };
}

describe("encodeWav", () => {
  test("writes a canonical linear-PCM header in front of the samples", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const wav = encodeWav(pcm, { sampleRate: 24_000 });

    expect(wav.length).toBe(WAV_HEADER_BYTES + pcm.length);
    expect(readHeader(wav)).toEqual({
      riff: "RIFF",
      riffSize: 36 + pcm.length,
      wave: "WAVE",
      fmt: "fmt ",
      fmtSize: 16,
      encoding: 1,
      channels: 1,
      sampleRate: 24_000,
      // The two DERIVED fields — see the module doc for why they are the ones a
      // hand-written header gets wrong.
      byteRate: 24_000 * 2,
      blockAlign: 2,
      bitsPerSample: 16,
      data: "data",
      dataSize: pcm.length,
    });
    expect(wav.subarray(WAV_HEADER_BYTES)).toEqual(pcm);
  });

  test("derives byteRate and blockAlign from the format it was given", () => {
    const header = readHeader(
      encodeWav(new Uint8Array(12), { sampleRate: 48_000, channels: 2, bitsPerSample: 24 }),
    );

    expect(header.blockAlign).toBe(6);
    expect(header.byteRate).toBe(48_000 * 6);
    expect(header.bitsPerSample).toBe(24);
    expect(header.channels).toBe(2);
  });

  test("joins a list of chunks in order — the shape a synthesizer emits", () => {
    const wav = encodeWav(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])],
      {
        sampleRate: 16_000,
      },
    );

    expect(wav.subarray(WAV_HEADER_BYTES)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(readHeader(wav).dataSize).toBe(6);
  });

  test("an empty list is a valid, empty file rather than a failure", () => {
    const wav = encodeWav([], { sampleRate: 16_000 });

    expect(wav.length).toBe(WAV_HEADER_BYTES);
    expect(readHeader(wav).dataSize).toBe(0);
  });

  test.each([
    ["a zero rate", { sampleRate: 0 }],
    ["a fractional rate", { sampleRate: 24_000.5 }],
    ["a zero channel count", { sampleRate: 24_000, channels: 0 }],
    ["a bit depth that is not a whole byte", { sampleRate: 24_000, bitsPerSample: 12 }],
  ])("refuses %s", (_label, format) => {
    expect(() => encodeWav(new Uint8Array(4), format)).toThrow(RangeError);
  });
});

describe("pcmDurationMs", () => {
  test("reads a byte count as a duration through the same block align", () => {
    // One second of 24 kHz mono PCM16.
    expect(pcmDurationMs(48_000, { sampleRate: 24_000 })).toBe(1000);
    // The same bytes at two channels is half as long.
    expect(pcmDurationMs(48_000, { sampleRate: 24_000, channels: 2 })).toBe(500);
  });

  test("refuses the formats the encoder refuses, so the two cannot disagree", () => {
    expect(() => pcmDurationMs(48_000, { sampleRate: 0 })).toThrow(RangeError);
  });

  test("names ITSELF in the message, not the encoder the check is shared with", () => {
    // An author who never called `encodeWav` was told `encodeWav:` and went
    // looking for a call they had not made.
    expect(() => pcmDurationMs(48_000, { sampleRate: 0 })).toThrow(/^pcmDurationMs:/);
    expect(() => encodeWav(new Uint8Array(2), { sampleRate: 0 })).toThrow(/^encodeWav:/);
  });

  test("refuses BYTES where a byte count goes, instead of answering NaN", () => {
    // The misuse this signature invites: every neighbour (`encodeWav`,
    // `stepSpeak`, `readUpload`) deals in the bytes themselves, and
    // `bytes / blockAlign` is `NaN` — a duration that is journaled, rendered
    // and reported with nothing on the way naming the call that made it.
    //
    // Spelled as the caller the compiler never saw — a `.mjs` step, or a length
    // read back out of a run's journal — rather than as a cast at a site a
    // typed project would have caught.
    const fromJournal: unknown = new Uint8Array(48_000);
    expect(() => pcmDurationMs(fromJournal as number, { sampleRate: 24_000 })).toThrow(
      /byteLength must be a non-negative number of bytes, got a value of type object/,
    );
    expect(() => pcmDurationMs(Number.NaN, { sampleRate: 24_000 })).toThrow(/got NaN/);
    expect(() => pcmDurationMs(-1, { sampleRate: 24_000 })).toThrow(RangeError);
  });
});
