// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a WAV header — the counterpart to `wav.ts`'s writing half.
 *
 * That module's doc used to say a chunk walk was "a template's business rather
 * than a promise this makes", and the template that owned it is why the stance
 * changed: cutting a recording by byte offset needs to know where the samples
 * START, and the knowledge required to answer that correctly is not
 * recording-specific at all. It is the RIFF container, which is the same
 * everywhere and is got wrong the same way everywhere.
 *
 * **The 44-byte assumption is the bug this exists to make unavailable.**
 * `wavHeader` writes exactly 44 bytes, so it is tempting to read 44 back. Real
 * files do not oblige: ffmpeg writes a `LIST`/`INFO` chunk naming its own
 * version ahead of the samples, so its WAV output has a **78-byte** header on
 * ffmpeg 6.1 and a different length the next time that version string changes.
 * A reader that skips 44 bytes therefore treats `INFO`, the encoder name and
 * the `data` chunk header as PCM — which does not fail, it transcribes as
 * confident nonsense at the front of every recording, and the length of the
 * damage depends on a string in somebody else's build.
 *
 * Three more things the walk has to get right, all of them on files that exist:
 *
 * - **A chunk payload is padded to an even length, and the pad byte is not
 *   counted by the declared size.** Off by one here and every subsequent chunk
 *   id is read from the middle of the previous payload.
 * - **The declared data length is not the file's length.** A streaming encoder
 *   writes `0` or `0xFFFFFFFF` because it did not know the length yet; a
 *   truncated download declares more than it holds. So the sample range is the
 *   INTERSECTION of what the header claims and what is actually there, which is
 *   why `totalBytes` is a parameter rather than something read from the header.
 * - **`WAVE_FORMAT_EXTENSIBLE` (`0xFFFE`) is not PCM**, whatever it usually
 *   wraps. Its real encoding lives in a GUID further into the `fmt ` chunk, and
 *   guessing produces noise rather than an error.
 *
 * What is NOT here is any policy about what to do with the answer — a size cap,
 * a segment plan, a minimum duration. Those are the caller's, and they differ
 * per provider endpoint.
 *
 * @module
 */

/** The three fields a `fmt ` chunk carries, before the samples are located. */
type PcmFields = Pick<WavFormat, "sampleRate" | "channels" | "bitsPerSample">;

/** A WAV's `fmt ` chunk plus where its samples actually live. */
export type WavFormat = {
  /** Samples per second, as the file declares it. */
  sampleRate: number;
  /** Interleaved channel count. */
  channels: number;
  /** Bits per sample. */
  bitsPerSample: number;
  /**
   * Byte offset of the first sample — the END of the `data` chunk's own header,
   * NOT {@link WAV_HEADER_BYTES}. See this module's doc for what assuming 44
   * costs.
   */
  dataStart: number;
  /**
   * Byte offset one past the last readable sample: the declared data length and
   * the file's real length, whichever is smaller.
   */
  dataEnd: number;
};

/**
 * A recording {@link parseWav} will not read.
 *
 * Its own class rather than a `RangeError` because every caller has to decide
 * one thing about it — this is TERMINAL, no retry helps, and the recording
 * needs converting — and a caller distinguishing that from a transient read
 * failure needs to be able to name it.
 *
 * @public
 */
export class UnsupportedRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRecordingError";
  }
}

/**
 * Bytes one sample frame occupies — every channel of one instant.
 *
 * @example
 * ```ts
 * import { blockAlign } from "@alexkroman1/aai/step";
 *
 * blockAlign({ channels: 1, bitsPerSample: 16 }); // 2
 * blockAlign({ channels: 2, bitsPerSample: 16 }); // 4
 * ```
 *
 * @public
 */
export function blockAlign(format: Pick<WavFormat, "channels" | "bitsPerSample">): number {
  return (format.channels * format.bitsPerSample) / 8;
}

/**
 * Bytes of audio per second of wall clock — the constant that converts a byte
 * offset into a timestamp, and a duration into a request size.
 *
 * @example
 * ```ts
 * import { bytesPerSecond } from "@alexkroman1/aai/step";
 *
 * bytesPerSecond({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 }); // 32000
 * ```
 *
 * @public
 */
export function bytesPerSecond(
  format: Pick<WavFormat, "channels" | "bitsPerSample" | "sampleRate">,
): number {
  return blockAlign(format) * format.sampleRate;
}

/**
 * Where a byte offset in the FILE falls in the recording, in milliseconds.
 *
 * Takes a file offset rather than a sample offset, because that is what a
 * ranged read deals in — `dataStart` is subtracted here so no caller has to
 * remember to.
 *
 * @public
 */
export function offsetToMs(format: WavFormat, offset: number): number {
  return Math.round(((offset - format.dataStart) / bytesPerSecond(format)) * 1000);
}

/** The `fmt ` chunk's three fields, refusing anything that is not linear PCM. */
function readFmtChunk(view: DataView, payload: number): PcmFields {
  const encoding = view.getUint16(payload, true);
  // 1 is WAVE_FORMAT_PCM. 0xFFFE is WAVE_FORMAT_EXTENSIBLE, whose real encoding
  // lives in a GUID further in; refused rather than guessed, because guessing
  // wrong produces noise that transcribes as words.
  if (encoding !== 1) {
    throw new UnsupportedRecordingError(
      `That WAV holds encoding ${encoding}, not linear PCM — re-encode it with \`-c:a pcm_s16le\`.`,
    );
  }
  return {
    channels: view.getUint16(payload + 2, true),
    sampleRate: view.getUint32(payload + 4, true),
    bitsPerSample: view.getUint16(payload + 14, true),
  };
}

/**
 * Refuse a `data` chunk whose format nothing can be addressed by byte offset.
 *
 * Asserts rather than returns, so the caller keeps the narrowing. Every check
 * is here rather than spread down the file because everything downstream
 * DIVIDES by these: a rate of zero is an infinite bytes-per-second, and every
 * loop that strides by one hangs.
 */
function assertCuttableFormat(fmt: PcmFields | undefined): asserts fmt is PcmFields {
  if (fmt === undefined) {
    throw new UnsupportedRecordingError("That WAV has no `fmt ` chunk before its data.");
  }
  if (blockAlign(fmt) <= 0) {
    throw new UnsupportedRecordingError(
      `That WAV declares ${fmt.channels} channels at ${fmt.bitsPerSample} bits — nothing to cut.`,
    );
  }
  if (fmt.sampleRate <= 0) {
    throw new UnsupportedRecordingError(
      "That WAV declares a sample rate of 0, so nothing in it can be given a timestamp.",
    );
  }
}

/** Four bytes read as ASCII — a RIFF chunk id. */
function chunkId(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4));
}

/**
 * Read a WAV header out of the first bytes of a recording.
 *
 * @param head - The start of the file. Must reach past the `data` chunk's own
 *   header: this walks the chunk list, and a file with a large `LIST` or `bext`
 *   chunk ahead of its samples pushes that well past 44 bytes. 64 KiB is a
 *   comfortable probe; the failure for too little is an error naming the
 *   shortfall, never a wrong answer.
 * @param totalBytes - The size of the whole file, from `Content-Range` or
 *   `Content-Length`. Bounds `dataEnd`, because the header cannot be trusted for
 *   it — see this module's doc.
 *
 * @throws {UnsupportedRecordingError} for anything that is not linear-PCM WAV,
 *   for a format nothing can be cut on (a zero rate, or zero bytes per frame),
 *   and for a header longer than `head`.
 *
 * @example
 * ```ts
 * import { blockAlign, bytesPerSecond, parseWav } from "@alexkroman1/aai/step";
 *
 * declare const head: Uint8Array;
 * const format = parseWav(head, 1_000_000);
 * const seconds = (format.dataEnd - format.dataStart) / bytesPerSecond(format);
 * const frame = blockAlign(format);
 * ```
 *
 * @public
 */
export function parseWav(head: Uint8Array, totalBytes: number): WavFormat {
  if (head.length < 12 || chunkId(head, 0) !== "RIFF" || chunkId(head, 8) !== "WAVE") {
    throw new UnsupportedRecordingError(
      "That is not a WAV file. Linear-PCM WAV is the only container that can be cut by byte " +
        "offset, so a compressed recording has to be converted first " +
        "(`ffmpeg -i in.m4a -c:a pcm_s16le out.wav`).",
    );
  }
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let fmt: PcmFields | undefined;

  // The chunk list. Each entry is a 4-byte id, a 4-byte little-endian length,
  // and a payload padded to an even length — the padding byte is not counted by
  // the length, which is the off-by-one this loop exists to get right once.
  for (let at = 12; at + 8 <= head.length; ) {
    const id = chunkId(head, at);
    const size = view.getUint32(at + 4, true);
    const payload = at + 8;

    if (id === "fmt " && payload + 16 <= head.length) {
      fmt = readFmtChunk(view, payload);
    } else if (id === "data") {
      assertCuttableFormat(fmt);
      // See the module doc: `0` and `0xFFFFFFFF` both mean "unknown", and any
      // declared length is capped by what was actually served.
      const declared = size === 0 || size === 0xff_ff_ff_ff ? Number.POSITIVE_INFINITY : size;
      return { ...fmt, dataStart: payload, dataEnd: Math.min(payload + declared, totalBytes) };
    }

    at = payload + size + (size % 2);
  }

  throw new UnsupportedRecordingError(
    `No \`data\` chunk in the first ${head.length} bytes of that WAV — its header is longer than ` +
      "that probe. Read more of the file and parse again.",
  );
}
