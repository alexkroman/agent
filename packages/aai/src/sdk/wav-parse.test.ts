// Copyright 2026 the AAI authors. MIT license.
/**
 * The cases here are the ones that produce a WRONG ANSWER rather than an error
 * — an odd-length chunk ahead of the samples, a streaming encoder's unknown
 * length, a truncated download — because those are what a 44-byte assumption
 * turns into confident nonsense at the front of a transcript.
 */
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { wavHeader } from "./wav.ts";
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
      expect(parseWav(head, 44 + 64_000).dataEnd, String(declaredDataSize)).toBe(44 + 64_000);
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
    // A fractional frame: found by the any-bytes property below.
    for (const bitsPerSample of [1, 4, 12]) {
      expect(
        () => parseWav(wavFile({ ...MONO_16K, bitsPerSample }, 1000), 1044),
        String(bitsPerSample),
      ).toThrow(/whole-byte depths/);
    }
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

// ─── Properties ─────────────────────────────────────────────────────────────
//
// The cases above pin the files that are known to exist. These cover the ones
// nobody wrote down: `parseWav` reads the first bytes of whatever was uploaded,
// so its contract has to hold for ANY bytes, not just for headers someone built.

/** A RIFF chunk id that is neither `fmt ` nor `data` — what a `LIST`/`bext`/`JUNK` is. */
const otherChunkId = fc
  .stringMatching(/^[\x20-\x7e]{4}$/)
  .map((id) => (id === "fmt " || id === "data" ? "JUNK" : id));

/** A chunk the walk must step over, at any length — odd ones are the pad-byte case. */
const otherChunk = fc.record({ id: otherChunkId, payload: fc.uint8Array({ maxLength: 40 }) });

/** Serialize chunks the way a RIFF writer does: id, size, payload, pad byte. */
function serializeChunks(chunks: readonly { id: string; payload: Uint8Array }[]): Uint8Array {
  const length = chunks.reduce((n, c) => n + 8 + c.payload.length + (c.payload.length % 2), 0);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const { id, payload } of chunks) {
    for (let i = 0; i < 4; i++) out[at + i] = id.charCodeAt(i);
    view.setUint32(at + 4, payload.length, true);
    out.set(payload, at + 8);
    at += 8 + payload.length + (payload.length % 2);
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The bytes a hostile or broken upload could start with: pure noise, or a real
 * `RIFF`/`WAVE` preamble followed by chunks whose ids and sizes are noise —
 * without the preamble almost every draw stops at the first check.
 */
const untrustedHead = fc.oneof(
  fc.uint8Array({ maxLength: 128 }),
  fc
    .array(
      fc.record({
        id: fc.oneof(fc.constantFrom("fmt ", "data"), otherChunkId),
        // Lies about its own length as often as not: the size field is the
        // value the walk trusts, so it is the one worth corrupting.
        size: fc.oneof(fc.nat({ max: 64 }), fc.constantFrom(0xff_ff_ff_fe, 0xff_ff_ff_ff)),
        payload: fc.uint8Array({ maxLength: 40 }),
      }),
      { maxLength: 6 },
    )
    .map((chunks) => {
      const body = chunks.map(({ id, size, payload }) => {
        const out = new Uint8Array(8 + payload.length);
        for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
        new DataView(out.buffer).setUint32(4, size, true);
        out.set(payload, 8);
        return out;
      });
      return concat(new TextEncoder().encode("RIFF\0\0\0\0WAVE"), ...body);
    }),
  // A well-formed PCM `fmt ` chunk with noise in its three fields, then `data`:
  // the only way a draw reaches the format checks, since a random encoding is
  // almost never 1.
  fc
    .record({
      channels: fc.oneof(fc.nat({ max: 8 }), fc.nat({ max: 0xff_ff })),
      sampleRate: fc.oneof(fc.nat({ max: 48_000 }), fc.nat({ max: 0xff_ff_ff_ff })),
      bitsPerSample: fc.oneof(fc.nat({ max: 33 }), fc.nat({ max: 0xff_ff })),
    })
    .map(({ channels, sampleRate, bitsPerSample }) => {
      const head = new Uint8Array(44);
      const view = new DataView(head.buffer);
      head.set(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "));
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, channels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint16(34, bitsPerSample, true);
      head.set(new TextEncoder().encode("data"), 36);
      return head;
    }),
);

/** A format {@link wavHeader} can describe: the writer's own legal range. */
const pcmFormat = fc.record({
  sampleRate: fc.integer({ min: 1, max: 384_000 }),
  channels: fc.integer({ min: 1, max: 8 }),
  bitsPerSample: fc.constantFrom(8, 16, 24, 32),
});

describe("parseWav, for any bytes", () => {
  test("answers a cuttable format or throws UnsupportedRecordingError — nothing else", () => {
    fc.assert(
      fc.property(untrustedHead, fc.nat({ max: 1 << 20 }), (head, extra) => {
        // A probe is a prefix of the file, so the file is at least that long.
        const totalBytes = head.length + extra;
        let format: WavFormat;
        try {
          format = parseWav(head, totalBytes);
        } catch (error) {
          expect(error).toBeInstanceOf(UnsupportedRecordingError);
          return;
        }
        // Everything downstream divides by these and strides by a frame, so an
        // answer is only an answer if all of it can be cut on.
        expect(Number.isInteger(blockAlign(format))).toBe(true);
        expect(blockAlign(format)).toBeGreaterThan(0);
        expect(format.sampleRate).toBeGreaterThan(0);
        expect(Number.isFinite(bytesPerSecond(format))).toBe(true);
        expect(format.dataStart).toBeGreaterThanOrEqual(12 + 8);
        expect(format.dataStart).toBeLessThanOrEqual(head.length);
        expect(format.dataEnd).toBeGreaterThanOrEqual(format.dataStart);
        expect(format.dataEnd).toBeLessThanOrEqual(totalBytes);
      }),
      { numRuns: 500 },
    );
  });

  test("a header written by wavHeader reads back, wherever other chunks sit", () => {
    fc.assert(
      fc.property(
        pcmFormat,
        fc.oneof(fc.nat({ max: 1 << 24 }), fc.constant(0)),
        fc.array(otherChunk, { maxLength: 3 }),
        fc.array(otherChunk, { maxLength: 3 }),
        fc.nat({ max: 1 << 24 }),
        (format, dataBytes, beforeFmt, afterFmt, slack) => {
          // Split the writer's 44 bytes into its preamble, its `fmt ` chunk and
          // its `data` chunk header, and put foreign chunks either side of `fmt `.
          const written = wavHeader(format, dataBytes);
          const head = concat(
            written.subarray(0, 12),
            serializeChunks(beforeFmt),
            written.subarray(12, 36),
            serializeChunks(afterFmt),
            written.subarray(36),
          );
          const totalBytes = head.length + slack;
          // `0` is a streaming encoder's "unknown", read as "to the end of file".
          const declaredEnd = dataBytes === 0 ? totalBytes : head.length + dataBytes;
          expect(parseWav(head, totalBytes)).toEqual<WavFormat>({
            ...format,
            dataStart: head.length,
            dataEnd: Math.min(declaredEnd, totalBytes),
          });
        },
      ),
    );
  });

  test("a probe cut short of the samples throws rather than guessing", () => {
    fc.assert(
      fc.property(
        pcmFormat,
        fc.array(otherChunk, { maxLength: 3 }),
        fc.nat(),
        (format, chunks, cut) => {
          const written = wavHeader(format, 1000);
          const head = concat(
            written.subarray(0, 36),
            serializeChunks(chunks),
            written.subarray(36),
          );
          const probe = head.subarray(0, cut % head.length);
          expect(() => parseWav(probe, head.length + 1000)).toThrow(UnsupportedRecordingError);
        },
      ),
    );
  });
});
