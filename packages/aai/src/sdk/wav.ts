// Copyright 2026 the AAI authors. MIT license.
/**
 * `encodeWav()` — raw PCM samples with a WAV header in front of them.
 *
 * The half of audio handling that has no provider in it. Everything that
 * SPEAKS hands back raw linear PCM — {@link stepSpeak}'s synthesizer, a
 * session's `audio` frames, a byte range cut out of a recording — and almost
 * nothing that PLAYS one will take it: a browser `<audio>`, a file on disk and
 * every transcription API want a container, and for linear PCM the container
 * is 44 bytes of arithmetic.
 *
 * It is here rather than in a template because those 44 bytes are exactly the
 * kind of thing that is copied once per project and gets one field wrong. The
 * two that are wrong most often are both derived rather than passed:
 * `byteRate` (`sampleRate * blockAlign`) and `blockAlign`
 * (`channels * bitsPerSample / 8`) — a header that states them inconsistently
 * plays at the wrong speed rather than failing, which is a bug nobody reads as
 * a header bug.
 *
 * ```ts
 * import { encodeWav, stepSpeak } from "@alexkroman1/aai/step";
 *
 * export async function speak(text: string) {
 *   const spoken = await stepSpeak(text);
 *   // Already a WAV — `stepSpeak` frames it with this. Shown for the shape:
 *   return encodeWav(spoken.pcm, { sampleRate: spoken.sampleRate });
 * }
 * ```
 *
 * ## It takes a LIST as readily as a buffer
 *
 * Because the thing producing the samples is almost always a stream: a
 * synthesizer emits a frame per flush, a capture emits one per tick. Joining
 * them at the call site means every caller writes the same
 * `reduce`-then-`set` loop, and the one that gets it wrong writes a file whose
 * tail is silence. Passing the array is the whole of it.
 *
 * ## The header is separately reachable, and that is a MEMORY affordance
 *
 * {@link wavHeader} writes the 44 bytes on their own, for a caller that is going
 * to hand the header and the samples to something that takes a LIST — a
 * multipart body, a stream. `encodeWav` allocates `44 + N` and copies the
 * samples into it, so a step that encodes a segment and then encodes a request
 * around it holds the same audio twice; two chunks hold it once. Nothing about
 * the bytes on the wire changes, and neither does the time (a `set` over a few
 * megabytes is around a millisecond against a multi-second request) — what
 * changes is the peak, which is what bounds how many segments may be in flight
 * at once.
 *
 * `encodeWav` is written in terms of it rather than beside it, so the two can
 * never disagree about a field.
 *
 * ## What it deliberately does NOT do
 *
 * Resample, mix down, or convert between bit depths. It writes a header over
 * bytes it takes on trust, so `bitsPerSample` describes the samples rather
 * than requesting a conversion — the SDK ships no codec and would have to
 * grow one to honour anything else. The parse direction is likewise absent:
 * reading an arbitrary WAV means walking a chunk list with `LIST`/`bext`
 * chunks in it, which is a template's business (`transcription-workflow`'s
 * `workflows/wav.ts`) rather than a promise this makes.
 *
 * @module wav
 */

/** Bytes of WAV header {@link encodeWav} writes — `RIFF`, `fmt `, and `data`. */
export const WAV_HEADER_BYTES = 44;

/**
 * How to read the samples handed to {@link encodeWav}.
 *
 * Only `sampleRate` is required, because the other two have an answer that is
 * right for every synthesizer and every phone call this SDK talks to, and a
 * caller repeating `channels: 1, bitsPerSample: 16` at every site is a caller
 * who will one day repeat it beside samples that are neither.
 *
 * @public
 */
export type PcmFormat = {
  /** Samples per second, e.g. `24_000`. Must be a positive integer. */
  sampleRate: number;
  /** Interleaved channel count. Defaults to `1` — mono, which speech is. */
  channels?: number | undefined;
  /**
   * Bits per sample. Defaults to `16`, and must be a multiple of 8.
   *
   * DESCRIBES the bytes rather than requesting a conversion: nothing here
   * transcodes, so a wrong value writes a header that misreads samples it
   * never touched.
   */
  bitsPerSample?: number | undefined;
};

/** Bytes one sample frame occupies — every channel of one instant. */
function blockAlign(channels: number, bitsPerSample: number): number {
  return (channels * bitsPerSample) / 8;
}

/**
 * Refuse a format that would produce a header nothing can play.
 *
 * Checked rather than trusted because the values routinely come from a
 * provider's own reply or a run's journaled input, and every one of these
 * lands as audio that plays at the wrong speed or as a division by zero in a
 * duration — never as an error naming the field.
 *
 * `caller` is passed rather than hardcoded: {@link pcmDurationMs} shares this
 * check, and a message that says `encodeWav` points at a function the author
 * never called.
 */
function assertFormat(
  caller: string,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): void {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`${caller}: sampleRate must be a positive integer, got ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new RangeError(`${caller}: channels must be a positive integer, got ${channels}`);
  }
  if (!Number.isInteger(bitsPerSample) || bitsPerSample <= 0 || bitsPerSample % 8 !== 0) {
    throw new RangeError(
      `${caller}: bitsPerSample must be a positive multiple of 8, got ${bitsPerSample}`,
    );
  }
}

/**
 * Refuse a `byteLength` that is not a length.
 *
 * Shared by the two functions that take a COUNT where their neighbours take
 * bytes ({@link wavHeader}, {@link pcmDurationMs}), which is the one misuse
 * either signature invites — and both fail the same way if it is not made: a
 * `NaN` becomes a `0` in a header field and a `NaN` in a duration, neither of
 * which names the call that produced it.
 */
function assertByteLength(caller: string, byteLength: number): void {
  if (Number.isFinite(byteLength) && byteLength >= 0) return;
  // `typeof` for anything that is not a number, never the value: the value
  // handed here is usually the whole buffer, and `String(bytes)` on 48 kB of
  // audio is a comma-separated error message nobody can read.
  const shown =
    typeof byteLength === "number" ? String(byteLength) : `a value of type ${typeof byteLength}`;
  throw new RangeError(
    `${caller}: byteLength must be a non-negative number of bytes, got ${shown}` +
      " — pass `bytes.byteLength`, not the bytes.",
  );
}

/**
 * The 44 bytes, with the name of whoever the author actually called.
 *
 * `caller` is threaded for the reason {@link assertFormat} takes one:
 * {@link encodeWav} is expressed in terms of this, and a message saying
 * `wavHeader:` points at a function that call site never named.
 */
function writeWavHeader(
  caller: string,
  format: PcmFormat,
  byteLength: number,
): Uint8Array<ArrayBuffer> {
  const { sampleRate } = format;
  const channels = format.channels ?? 1;
  const bitsPerSample = format.bitsPerSample ?? 16;
  assertFormat(caller, sampleRate, channels, bitsPerSample);
  assertByteLength(caller, byteLength);

  const frame = blockAlign(channels, bitsPerSample);
  const out = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  // The FIRST of the two lengths this header states, and both are derived from
  // `byteLength`: everything after this field, which is the header minus `RIFF`
  // and this field itself (36) plus the payload.
  view.setUint32(4, 36 + byteLength, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); // `fmt ` payload length, for linear PCM
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  // DERIVED, both of them — see the module doc for why these two are the
  // fields a hand-written header gets wrong.
  view.setUint32(28, sampleRate * frame, true);
  view.setUint16(32, frame, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  // The SECOND length: the payload alone. A decoder reads this one to find the
  // end of the samples and the one at offset 4 to find the end of the file, so
  // a header that derived them from different numbers is a file that plays past
  // its own audio or stops short of it.
  view.setUint32(40, byteLength, true);
  return out;
}

/**
 * The WAV header for a payload of `byteLength` bytes, and nothing else.
 *
 * For a caller handing the header and the samples to something that takes a
 * LIST — {@link multipartBody}, a stream — where {@link encodeWav}'s joined
 * buffer would be a second full copy of the audio held at the same time. Two
 * chunks are the same bytes in the same order on the wire.
 *
 * @param format - How to read the samples the header will sit in front of. See
 *   {@link PcmFormat} for the two defaults.
 * @param byteLength - How many bytes of PCM follow. The header states TWO
 *   lengths and both derive from this one, so a value that does not match what
 *   is actually sent is a file a decoder reads past the end of or stops short
 *   inside.
 * @returns Exactly {@link WAV_HEADER_BYTES} bytes.
 *
 * @throws {RangeError} for a format no header can describe — the same check
 *   {@link encodeWav} makes, so the two cannot disagree about what is legal —
 *   or for a `byteLength` that is not a length.
 *
 * @public
 */
export function wavHeader(format: PcmFormat, byteLength: number): Uint8Array<ArrayBuffer> {
  return writeWavHeader("wavHeader", format, byteLength);
}

/** Join a list of chunks into one buffer, sizing it in a single pass first. */
function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

/**
 * Wrap raw linear-PCM samples in a WAV container.
 *
 * @param samples - The PCM bytes, little-endian and channel-interleaved. A
 *   LIST is joined in order, which is what a synthesizer's or a capture's
 *   frames arrive as.
 * @param format - How to read them. See {@link PcmFormat} for the two defaults.
 * @returns A complete `.wav` file: {@link WAV_HEADER_BYTES} of header followed
 *   by `samples` unchanged.
 *
 * @throws {RangeError} for a format no header can describe — a non-integer or
 *   non-positive rate or channel count, or a bit depth that is not a positive
 *   multiple of 8.
 *
 * @public
 */
export function encodeWav(
  samples: Uint8Array | readonly Uint8Array[],
  format: PcmFormat,
): Uint8Array<ArrayBuffer> {
  const pcm = samples instanceof Uint8Array ? samples : joinChunks(samples);
  // `byteLength`, not `length`: `samples` may be a VIEW into a larger buffer,
  // and for a `Uint8Array` the two agree while for the header they must not be
  // allowed to drift apart — the same confusion `_bytes.ts` records.
  const header = writeWavHeader("encodeWav", format, pcm.byteLength);
  const out = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/**
 * How long a run of PCM samples lasts, in milliseconds.
 *
 * Beside the encoder because it divides by the same derived `blockAlign` the
 * header states, and a duration computed from a different one is how a
 * progress bar and a file disagree. Rounded, since a caller reporting
 * milliseconds has no use for the fraction.
 *
 * It takes a LENGTH where its neighbours take bytes, so a `Uint8Array` handed
 * to it is refused rather than divided: `bytes / blockAlign` is `NaN`, and a
 * `NaN` duration is journaled by a step, rendered into a progress bar and
 * reported to a caller without anything on the way saying which call produced
 * it. That is the one misuse this signature invites — `encodeWav`, `stepSpeak`
 * and `readUpload` all deal in the bytes themselves. {@link wavHeader} is the
 * other function here taking a count, and shares this check for that reason.
 *
 * @throws {RangeError} for a format no header can describe — the same check
 *   {@link encodeWav} makes, so the two cannot disagree about what is legal —
 *   or for a `byteLength` that is not a length.
 *
 * @public
 */
export function pcmDurationMs(byteLength: number, format: PcmFormat): number {
  const channels = format.channels ?? 1;
  const bitsPerSample = format.bitsPerSample ?? 16;
  assertByteLength("pcmDurationMs", byteLength);
  assertFormat("pcmDurationMs", format.sampleRate, channels, bitsPerSample);
  return Math.round(
    (byteLength / (blockAlign(channels, bitsPerSample) * format.sampleRate)) * 1000,
  );
}
