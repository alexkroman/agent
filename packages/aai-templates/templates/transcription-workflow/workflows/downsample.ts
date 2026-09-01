// Copyright 2026 the AAI authors. MIT license.
/**
 * Making one REQUEST light, where `normalize.ts` makes the whole FILE cuttable.
 *
 * The two look like the same job and are not, and the difference is the reason
 * this module exists at all:
 *
 * | | `normalize.ts` | this |
 * | --- | --- | --- |
 * | fixes | a recording the desk cannot CUT | a request the endpoint cannot FINISH |
 * | works on | the whole file, via ffmpeg | one segment's bytes, in process |
 * | needs | every byte to have arrived | only the segment's own window |
 * | produces | a new upload | a request body, thrown away after |
 *
 * `normalizeRecording` reads the entire recording out of the store, runs ffmpeg
 * over it and writes a second upload back. That is exactly right for the classic
 * flow, and it is unavailable to the streaming one by construction: a file that
 * is still arriving is not a file ffmpeg can transcode, and waiting for the last
 * byte before converting would give up the whole property `stream.ts` exists to
 * demonstrate. So the streaming desk needs the byte saving WITHOUT the whole-file
 * pass, and a segment it has already cut is linear PCM it can resample itself.
 *
 * ## Why it is worth doing at all
 *
 * The sync endpoint deadlines a request at **30 seconds**, wall clock, and that
 * budget covers the upload as well as the transcription. A 92-second segment of
 * 48 kHz 16-bit stereo is **17.66 MB**; the same audio at
 * {@link NORMALIZED_SAMPLE_RATE} mono is **2.94 MB**. Six times the bytes per
 * request, against a fixed deadline, is not a slower run — it is a run that dies:
 *
 * ```text
 *   HTTP 504 — request exceeded 30.0s
 *   sync.assemblyai.com did not answer: ConnectTimeoutError (timeout: 10000ms)
 * ```
 *
 * Both of those are from one real 50-minute stereo recording, where half the
 * segments landed and three burned all six attempts. A 504 is transient, so every
 * one of them is retried the full six times before the body throws — and when it
 * does, every sibling still in flight is discarded and re-billed on the resume.
 *
 * ## It is a BOX FILTER, and that is a real trade
 *
 * Averaging each output frame's window of input frames is a low-pass filter and a
 * decimation in one pass, which is the cheap end of resampling. It is genuinely
 * better than taking every Nth sample — that folds everything above the new
 * Nyquist straight back into the speech band — but it is not what ffmpeg's
 * `swr` does, and at 48 kHz -> 16 kHz it attenuates the top of the kept band by
 * about a third and leaves the first alias image around -12 dB.
 *
 * That is the honest cost, and the classic flow does not pay it: `normalize.ts`
 * has the whole file and uses ffmpeg. This is the streaming flow's option,
 * chosen because 8 kHz of slightly soft speech transcribes and a request that
 * never finishes does not. A desk that cares more about the top octave than
 * about the tail latency should run the classic flow.
 *
 * ## Pure, and deliberately so
 *
 * Nothing here reaches a `node:` builtin or an SDK subpath that does. `stream.ts`
 * is compiled as a `node:vm` Script with no `require` (see `normalize.ts`'s module
 * doc), so a module it imports at module scope may not drag one in — which is why
 * the normalize TARGETS live here, the pure module, and `normalize.ts` imports
 * them rather than the other way round.
 */

import type { PcmFormat } from "@alexkroman1/aai/step";
import { blockAlign, UnsupportedRecordingError, type WavFormat } from "./wav.ts";

/**
 * The rate everything is converted TO.
 *
 * 16 kHz because that is what speech models are trained at — a higher rate
 * carries no information the decoder uses and costs proportional bytes in a
 * fan-out whose width is bounded by bytes in flight (`BYTES_IN_FLIGHT` in
 * `transcribe.ts`) and whose requests are bounded by a 30-second deadline. A
 * converted two-hour recording is 230 MB of 16 kHz mono against 1.4 GB of
 * 48 kHz stereo, which is the difference between a fan-out that saturates on
 * width and one that saturates on the queue.
 */
export const NORMALIZED_SAMPLE_RATE = 16_000;

/**
 * Channels everything is converted TO.
 *
 * Mono, and it is a real loss rather than a free win: a stereo call recording
 * with one party per channel is exactly the file where the channels are the most
 * interesting thing about it, and downmixing throws that away. This desk
 * transcribes rather than diarizes, so it takes the 2x saving; a desk that wants
 * the speakers apart splits the channels first and transcribes each one.
 */
export const NORMALIZED_CHANNELS = 1;

/**
 * Whether sending this format AS IS would make every request too heavy.
 *
 * The format-level half of `normalize.ts`'s `heavierThanNormalized`, which asks
 * the same question of an unparsed header. Both are here rather than there
 * because the streaming flow answers it from a format it already has and must
 * not import a module that reaches ffmpeg.
 *
 * Compared against the normalize targets rather than against a byte budget of
 * its own: the question is literally "would converting make this smaller", and
 * anything at or below {@link NORMALIZED_SAMPLE_RATE} /
 * {@link NORMALIZED_CHANNELS} would only be re-encoded into itself.
 *
 * It deliberately does NOT look at `bitsPerSample`, matching the whole-file
 * predicate so the two flows cannot disagree about which files are heavy. A
 * 24-bit file at 16 kHz mono really would shrink, but that is a 1.5-2x saving
 * on a file already inside the budget.
 */
export function heavierThanNormalizedFormat(
  format: Pick<WavFormat, "sampleRate" | "channels">,
): boolean {
  return format.sampleRate > NORMALIZED_SAMPLE_RATE || format.channels > NORMALIZED_CHANNELS;
}

/**
 * One segment's PCM, resampled to something the endpoint can swallow in 30s.
 *
 * Returns the input UNCHANGED when it is already light — same array, same
 * format, no copy — so this is inert on the classic flow, where
 * `normalizeRecording` has already converted the whole file, and on any
 * recording that arrived at 16 kHz mono to begin with. That inertness is what
 * lets `transcribeSegment` call it unconditionally and both flows share the one
 * step.
 *
 * @param bytes - The segment's window, interleaved little-endian linear PCM.
 *   A ragged tail is truncated to whole frames: `dataEnd` is clamped to the
 *   file's real size, which no recorder guarantees is frame-aligned.
 * @param from - The recording's format, from `parseWav`.
 *
 * @returns The bytes to send and the format to write a header with — always
 *   16-bit mono once anything was done, because there is one output path and a
 *   narrower one saves nothing worth a second.
 *
 * @throws {UnsupportedRecordingError} for a bit depth `parseWav` admits and this
 *   cannot read. Terminal, which is right: it answers the same way forever.
 */
export function downsampleSegment(
  bytes: Uint8Array,
  from: Pick<WavFormat, "sampleRate" | "channels" | "bitsPerSample">,
): { bytes: Uint8Array; format: PcmFormat } {
  const format = requestFormat(from);
  if (format === from) return { bytes, format };

  const ratio = from.sampleRate / format.sampleRate;
  const frame = blockAlign(from);
  const inFrames = Math.floor(bytes.length / frame);
  const outFrames = Math.max(1, Math.floor(inFrames / ratio));

  const read = sampleReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), from);
  const out = new Uint8Array(outFrames * 2);
  const wrote = new DataView(out.buffer);
  const sampleBytes = from.bitsPerSample / 8;

  for (let i = 0; i < outFrames; i++) {
    // The window this output frame averages. Half-open, at least one frame wide
    // however the ratio divides — a zero-wide window is a division by zero, and
    // a non-integer ratio (44.1 kHz -> 16 kHz is 2.75625) produces windows of
    // two different widths, which is the box filter tracking the true rate
    // rather than drifting off it.
    const lo = Math.floor(i * ratio);
    const hi = Math.min(inFrames, Math.max(lo + 1, Math.floor((i + 1) * ratio)));

    // Every channel of every frame in the window, in one accumulator: the
    // low-pass and the downmix are the same average, so doing them separately
    // would be two passes for one answer.
    let total = 0;
    for (let f = lo; f < hi; f++) {
      const at = f * frame;
      for (let c = 0; c < from.channels; c++) total += read(at + c * sampleBytes);
    }
    // No clamp: an average of values already inside the 16-bit range is inside
    // it, and `Math.round` cannot carry one out.
    wrote.setInt16(i * 2, Math.round(total / ((hi - lo) * from.channels)), true);
  }

  return { bytes: out, format };
}

/**
 * The format that will go ON THE WIRE for a recording in `from`.
 *
 * Returns `from` ITSELF — identity, not a copy — when nothing needs doing, which
 * is what {@link downsampleSegment} tests to take its fast path. That identity is
 * load-bearing rather than an optimisation: the alternative is two places deciding
 * "is this heavy" and the resampler disagreeing with the fast path about one
 * edge case.
 *
 * Exported because `segmentConcurrency` (`transcribe.ts`) divides a byte budget by
 * a segment's cost, and that budget is bytes UPLOADING — so it has to be asked of
 * what is SENT rather than of what was cut. Deriving both from this is what stops
 * the width and the resampler drifting apart.
 */
export function requestFormat(
  from: Pick<WavFormat, "sampleRate" | "channels" | "bitsPerSample">,
): Pick<WavFormat, "sampleRate" | "channels" | "bitsPerSample"> {
  if (!heavierThanNormalizedFormat(from)) return from;
  return {
    // Never UP. An 8 kHz stereo recording needs the downmix and not the rate, and
    // resampling it to 16 kHz would invent bytes to pay a deadline with.
    sampleRate: Math.min(from.sampleRate, NORMALIZED_SAMPLE_RATE),
    channels: NORMALIZED_CHANNELS,
    bitsPerSample: 16,
  };
}

/**
 * How to read one sample of this format, as a number on the 16-bit scale.
 *
 * Chosen ONCE rather than switched per sample: a 92-second stereo segment is
 * 8.8 million frames, so the branch is the difference between a closure call and
 * a jump table 17.6 million times over.
 *
 * `parseWav` admits only `WAVE_FORMAT_PCM`, so every depth here is a signed
 * little-endian integer — except 8-bit, which RIFF specifies as UNSIGNED and
 * centred on 128. That asymmetry is the one thing in this function worth
 * knowing; reading an 8-bit file as signed is a transcript of loud static.
 */
function sampleReader(
  view: DataView,
  from: Pick<WavFormat, "bitsPerSample">,
): (at: number) => number {
  switch (from.bitsPerSample) {
    case 8:
      return (at) => (view.getUint8(at) - 128) * 256;
    case 16:
      return (at) => view.getInt16(at, true);
    case 24:
      // `getInt8` on the top byte is what sign-extends: the low two are read
      // unsigned and OR'd under it, then the whole thing is shifted down to the
      // 16-bit scale by an ARITHMETIC shift, which preserves that sign.
      return (at) =>
        (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) >> 8;
    case 32:
      return (at) => view.getInt32(at, true) >> 16;
    default:
      throw new UnsupportedRecordingError(
        `That WAV holds ${from.bitsPerSample}-bit samples, which this desk can cut but not ` +
          "resample. Re-encode it with `-c:a pcm_s16le`.",
      );
  }
}
