// Copyright 2026 the AAI authors. MIT license.
/**
 * The pure half of the transcription desk: reading a WAV header, deciding where
 * to cut, and writing a header back over each cut.
 *
 * Nothing in this file is a step or a body, and that is legal — a body is
 * whatever is handed a `ctx`, so an ordinary module can sit beside one. It is a
 * separate
 * file because everything here is a pure function of a journaled value, which is
 * what makes it testable without a run at all: `transcribe.ts`'s spec drives
 * these directly.
 *
 * ## Why the chunking is here rather than at the provider
 *
 * AssemblyAI's SYNC endpoint answers in the request — no job id, no polling, no
 * callback — and pays for that with a hard **120-second, 40 MB** limit per
 * request. A two-hour recording is therefore not one call, it is sixty; and the
 * splitting has to happen somewhere that can address the audio by BYTE RANGE,
 * because re-downloading a 700 MB recording once per chunk is the obvious
 * implementation and the wrong one.
 *
 * A linear-PCM WAV is the format that makes that possible without a decoder:
 * every sample is the same size, so a byte offset IS a timestamp
 * (`offset / (sampleRate * blockAlign)`) and a cut at any frame boundary is a
 * clean cut. That is the whole reason this template asks for WAV and refuses
 * anything else by name rather than trying to be clever — an MP3 or an M4A frame
 * boundary cannot be found by arithmetic, and finding it means shipping a
 * decoder into a step.
 *
 * ## Who READS the refusals below
 *
 * {@link UnsupportedRecordingError} is raised from here and handled in two
 * completely different ways, which is worth knowing before editing a message:
 *
 * - The plain `transcribe` flow CONVERTS rather than refusing. `normalize.ts`
 *   calls {@link parseWav} as a QUESTION — a throw is its signal to hand the file
 *   to ffmpeg — so on that path no message here reaches a person, and a file this
 *   module rejects for a huge {@link MAX_BYTES_PER_SECOND} is one that
 *   normalization fixes by downsampling.
 * - `transcribeStream` still refuses, and has to: it cuts a recording while the
 *   bytes are still arriving, and a partial file is not something ffmpeg can
 *   transcode. There the sentences below are the whole of what a person is told,
 *   so they keep naming the `ffmpeg` line that fixes the file.
 */

import {
  blockAlign,
  bytesPerSecond,
  offsetToMs,
  UnsupportedRecordingError,
  type WavFormat,
} from "@alexkroman1/aai/step";

/**
 * What the sync endpoint will accept in one request.
 *
 * **Measured against the live endpoint, the binding limit is a 30-second WALL
 * CLOCK budget rather than this**, and that budget covers the upload as well as
 * the transcription: a 92-second segment that is 17.66 MB comes back
 * `504 — request exceeded 30.0s` well inside the documented cap. The constant is
 * left alone because it is what the service DOCUMENTS and the discrepancy is
 * unconfirmed; what closes the gap today is `downsample.ts`, which makes each
 * request six times lighter so the deadline stops binding. Revisit both together
 * once the real cap is settled — this number is what `planSegments` cuts to.
 */
export const MAX_SEGMENT_SECONDS = 120;

/**
 * Seconds of audio per request, with headroom under the cap.
 *
 * Not `MAX_SEGMENT_SECONDS`: the overlap below is added on top of this, and a
 * segment that lands one frame over the limit is a 413 rather than a shorter
 * transcript.
 */
export const SEGMENT_SECONDS = 90;

/**
 * Seconds each segment repeats from the one before it.
 *
 * A cut lands wherever the arithmetic puts it, which is usually mid-word: the
 * decoder on either side then hears half a word and reports something plausible
 * and wrong. Overlapping the cut means both sides hear the whole word, and
 * `stitchTranscript` drops the duplicate. The cost is 2 seconds of audio
 * transcribed twice per segment — ~2% at `SEGMENT_SECONDS`.
 */
export const SEGMENT_OVERLAP_SECONDS = 2;

/** The sync endpoint's payload cap, which a very high sample rate can reach first. */
export const MAX_SEGMENT_BYTES = 40 * 1024 * 1024;

/** The sync endpoint refuses audio shorter than this. */
export const MIN_SEGMENT_MS = 80;

/**
 * Bytes probed for the WAV header.
 *
 * The canonical header is 44 bytes; a recorder that writes a `LIST` or `bext`
 * chunk in front of the samples pushes the `data` chunk further out, and 64 KB
 * covers every such file anyone has produced by accident.
 *
 * Declared HERE because three callers need the same window, and the third one is
 * what made a shared constant the rule rather than a preference: `splitRecording`
 * cuts on it, `planFromHead` in `stream.ts` cuts on it, and `normalize.ts` decides
 * whether to CONVERT on it. Two of those probing a different amount than the third
 * is a file the desk converts and then cannot cut, or refuses and then converts —
 * both silent, and neither reproducible from any one module.
 */
export const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * The largest `bytesPerSecond` this desk will cut, and the reason it is checked
 * at PARSE time rather than at cut time.
 *
 * `planSegments` divides by a format's bytes-per-second and then subtracts the
 * overlap from the byte cap, so two declared formats make its loop never
 * advance — and this is the one workflow app that takes an arbitrary uploaded
 * file over a public form, so both are reachable by anyone with the URL:
 *
 * - a **zero** sample rate (or zero channels/bits, which
 *   {@link blockAlign} already catches) makes `stride` zero, so `start +=
 *   stride` is a no-op and the loop pushes a `Segment` per iteration until the
 *   process dies of memory;
 * - a **huge** one — `sampleRate` is a `uint32` and `channels`/`bitsPerSample`
 *   are `uint16`, so a header can declare gigabytes a second — makes the
 *   overlap alone exceed {@link MAX_SEGMENT_BYTES}, leaving `stride` NEGATIVE
 *   and the loop walking backwards forever.
 *
 * Both are pure CPU with no `await` in them, so no `AbortSignal.timeout` and no
 * step retry budget can interrupt one: the guard has to come before the loop.
 * Requiring a whole second of audio to fit alongside the overlap is the bound
 * that keeps the stride positive with room to spare; 48 kHz 24-bit stereo is
 * 288 kB/s, four orders of magnitude under it.
 */
export const MAX_BYTES_PER_SECOND = MAX_SEGMENT_BYTES / (SEGMENT_OVERLAP_SECONDS + 1);

/**
 * The WAV reading is the SDK's — `@alexkroman1/aai/step` publishes `parseWav`,
 * the chunk walk behind it, `WavFormat`, `UnsupportedRecordingError` and the
 * three derived arithmetic helpers.
 *
 * ~110 lines lived here, and none of it was ever about transcription: it is the
 * RIFF container, which is the same everywhere and is got wrong the same way
 * everywhere. Re-exported under the same names so the rest of this template and
 * its spec read unchanged.
 *
 * What stayed is this desk's POLICY, which the SDK deliberately has no opinion
 * about: {@link MAX_BYTES_PER_SECOND} (a cap that exists because of the sync
 * endpoint's request size, checked in {@link assertCuttable} below) and
 * {@link planSegments}.
 */
export {
  blockAlign,
  bytesPerSecond,
  offsetToMs,
  parseWav,
  UnsupportedRecordingError,
  type WavFormat,
} from "@alexkroman1/aai/step";

/** One request's worth of audio, addressed as a byte range of the source. */
export type Segment = {
  /** Position in the recording — the fan-out's order, and the merge's. */
  index: number;
  /** First byte, frame-aligned and inclusive. */
  start: number;
  /** One past the last byte, frame-aligned. */
  end: number;
  /** Where this segment starts in the recording, for the progress log. */
  startMs: number;
  /** Where it ends. Overlaps the next segment's `startMs` — see the module doc. */
  endMs: number;
};

/**
 * Refuse a recording this desk cannot cut into requests the sync endpoint takes.
 *
 * The SDK's {@link parseWav} refuses what is not readable WAV; this refuses what
 * is readable and still too heavy, which is a property of the ENDPOINT rather
 * than of the container — see {@link MAX_BYTES_PER_SECOND}. Kept as a separate
 * pass so `normalize.ts` can ask the two questions independently: a file that
 * only fails HERE is one downsampling fixes.
 */
export function assertCuttable(format: WavFormat): WavFormat {
  const perSecond = bytesPerSecond(format);
  if (perSecond > MAX_BYTES_PER_SECOND) {
    throw new UnsupportedRecordingError(
      `That WAV declares ${format.sampleRate} Hz across ${format.channels} channels at ${format.bitsPerSample} bits — ${perSecond} bytes a second, past the ${MAX_BYTES_PER_SECOND} this desk can cut into ${MAX_SEGMENT_BYTES}-byte requests.`,
    );
  }
  return format;
}

/** Round an offset down to a frame boundary, so a cut never lands mid-sample. */
function alignDown(offset: number, frame: number): number {
  return Math.floor(offset / frame) * frame;
}

/**
 * Cut a recording into segments the sync endpoint will accept.
 *
 * The fan-out's width comes from this, and it is a pure function of a journaled
 * value (the format, which a step returned) — the ordinary determinism rule: a
 * replay has to re-derive the same list, in the same order, or the DevKit hands
 * the Nth journal entry to a different call.
 */
export function planSegments(format: WavFormat): Segment[] {
  const frame = blockAlign(format);
  const perSecond = bytesPerSecond(format);
  const audioBytes = format.dataEnd - format.dataStart;
  if (audioBytes < (perSecond * MIN_SEGMENT_MS) / 1000) {
    throw new UnsupportedRecordingError(
      `That recording is ${Math.round((audioBytes / perSecond) * 1000)}ms long — the sync endpoint needs at least ${MIN_SEGMENT_MS}ms.`,
    );
  }

  // The overlap is decided FIRST, because both of the stride's caps have to
  // leave room for it: a segment is `stride + overlap` long, so subtracting it
  // here is what keeps that sum inside the endpoint's two limits. Getting this
  // backwards is a 413 on exactly the inputs that reach a cap.
  const overlap = alignDown(
    Math.min(
      SEGMENT_OVERLAP_SECONDS * perSecond,
      (MAX_SEGMENT_SECONDS - SEGMENT_SECONDS) * perSecond,
    ),
    frame,
  );
  // Whichever cap binds first. A 96 kHz stereo 24-bit recording reaches 40 MB
  // at ~73 seconds, so on that input the byte cap is the one that decides;
  // ordinary speech audio is nowhere near it and the duration cap decides.
  const stride = alignDown(
    Math.min(SEGMENT_SECONDS * perSecond, MAX_SEGMENT_BYTES - overlap),
    frame,
  );

  const segments: Segment[] = [];
  for (let start = format.dataStart; start < format.dataEnd; start += stride) {
    const end = Math.min(start + stride + overlap, format.dataEnd);
    segments.push({
      index: segments.length,
      start,
      end,
      startMs: offsetToMs(format, start),
      endMs: offsetToMs(format, end),
    });
    // The overlap means the last segment reaches the end one stride early, and
    // without this the loop would emit a final empty one.
    if (end >= format.dataEnd) break;
  }
  return segments;
}
