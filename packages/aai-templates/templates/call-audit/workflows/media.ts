// Copyright 2026 the AAI authors. MIT license.
/**
 * The pure half of the audit desk: the ffmpeg argv it runs, the two analyses it
 * reads back out, and where it decides to cut.
 *
 * No directive in this file, which is what lets it sit under `workflows/`: the
 * Workflow DevKit's builder scans this directory and transforms only what carries
 * a workflow body or a step. Everything here is a pure function of a
 * journaled value, and that is deliberate rather than tidy — **an ffmpeg pipeline
 * is untestable exactly where it spawns**, so every decision this desk makes is
 * pushed out of the steps and into this module, where a spec drives it with no
 * subprocess, no temp file and no recording.
 *
 * What is left in the steps is materialize, spawn, store.
 *
 * ## The argv is ours, so it is BUILT rather than embedded
 *
 * `runFfmpeg` passes `args` through verbatim — no `-y`, no `-loglevel` — so the
 * standing flags come from `ffmpegBaseArgs` on `@alexkroman1/aai/ffmpeg`, and
 * every invocation's real argv is a value a test can assert on. It is also why
 * the filter strings below carry no shell quoting: each is ONE element of an
 * argv array, so the commas that chain filters and the colons that separate their
 * options never meet a shell.
 *
 * ## Two analyses, and they read their answers back by DIFFERENT routes
 *
 * This is the detail that a first draft gets wrong, and it is a property of the
 * SDK rather than of ffmpeg:
 *
 * - **Loudness comes back on stderr**, because `loudnorm`'s
 *   `print_format=json` writes one fixed-size block after the last frame. The
 *   SDK keeps a capped stderr TAIL (`FFMPEG_STDERR_TAIL_CHARS`, 4000 chars) on
 *   the argument that ffmpeg's log is progress lines and the diagnosis is the
 *   last one — which is exactly true of a block printed at the end. Measured on
 *   ffmpeg 6.1: the JSON is ~330 characters.
 * - **Silence comes back in a FILE**, because `silencedetect` logs an event per
 *   pause, so its output grows with the recording. A two-hour call with a pause
 *   every ten seconds is 720 events, which does not fit in a 4000-character tail
 *   — and what a tail drops is the BEGINNING, so the failure is a desk that cuts
 *   the back half of every long recording and the front half of none. That is
 *   silent, and it is the kind of bug that reproduces only on inputs nobody tests
 *   with. `ametadata=mode=print:file=…` writes ffmpeg's own frame metadata
 *   straight to a path with no cap, and it does so at `-loglevel error`, which is
 *   what keeps the log quiet AND the analysis complete.
 *
 * ## Cutting in the silence is the whole point of the pipeline
 *
 * `transcription-workflow` cuts a recording by arithmetic — every 90 seconds,
 * wherever that lands — because with no decoder that is all it can do, and it
 * pays for it twice: each cut lands mid-word, so segments OVERLAP by two seconds
 * and a stitcher has to find and drop the duplicated words afterwards.
 *
 * With ffmpeg in the path, the pauses are known, so a cut can be placed in one.
 * Three costs disappear at once: the overlap (~2% of the audio, transcribed
 * twice), the stitching (a seam-matching heuristic that can be wrong), and the
 * mid-word decode on both sides of every cut. {@link planSegments} is that, and
 * it stays honest about the case it cannot serve — a stretch of unbroken speech
 * longer than the cap gets the blind cut, and says so.
 */

import { ffmpegBaseArgs } from "@alexkroman1/aai/ffmpeg";
import type { PcmFormat } from "@alexkroman1/aai/step";
import { safeJsonParse } from "@alexkroman1/aai/utils";
import { z } from "zod";

/**
 * The format every recording is converted to before anything measures it.
 *
 * 16 kHz mono 16-bit, so one second of audio is exactly 32,000 bytes — and that
 * equality is what the rest of this module rests on. Two consequences worth
 * naming, because they are the reason this desk normalizes at all:
 *
 * - **A byte offset is a timestamp, with no header to parse.** The intermediate
 *   is headerless raw PCM (see {@link normalizeArgs}), so `startByte` is
 *   `seconds * 32000` and nothing walks a RIFF chunk list. Note that assuming a
 *   44-byte WAV header instead would be WRONG: ffmpeg writes a `LIST`/`INFO`
 *   chunk naming its own version, so its WAV output has a 78-byte header on
 *   ffmpeg 6.1 and a different one whenever that string's length changes.
 * - **The provider's byte cap stops binding.** The sync endpoint's limits are
 *   120 seconds and 40 MB; at 32,000 bytes a second, {@link MAX_SEGMENT_SECONDS}
 *   of audio is 3.5 MB. So this desk has ONE cap to plan against where
 *   `transcription-workflow` has two and has to derive which one binds from the
 *   format it was handed.
 *
 * 16 kHz is also what speech models are trained at, so nothing is lost that a
 * decoder would have used.
 */
export const ANALYSIS_FORMAT = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
} as const satisfies PcmFormat;

/** Bytes of {@link ANALYSIS_FORMAT} audio per second of wall clock. */
export const BYTES_PER_SECOND =
  (ANALYSIS_FORMAT.sampleRate * ANALYSIS_FORMAT.channels * ANALYSIS_FORMAT.bitsPerSample) / 8;

/**
 * Integrated loudness everything is normalized to, in LUFS.
 *
 * −16 LUFS is the speech/podcast convention, and the reason to normalize at all
 * is not aesthetics: a conference recording where one party is on a headset and
 * the other is across a room has a 20 dB gap between them, and the quiet side
 * sits near enough the noise floor that {@link SILENCE_FLOOR_DB} cannot tell
 * their pauses from their words. Levelling first is what makes ONE silence
 * threshold work for a whole recording.
 */
export const LOUDNESS_TARGET_LUFS = -16;

/** True-peak ceiling, in dBTP. −1.5 leaves headroom for a lossy re-encode later. */
export const LOUDNESS_TRUE_PEAK_DB = -1.5;

/** Loudness range, in LU. 11 is `loudnorm`'s own default, restated so the argv is explicit. */
export const LOUDNESS_RANGE_LU = 11;

/**
 * What counts as silence, in dB relative to full scale.
 *
 * Applied to audio that has ALREADY been levelled to
 * {@link LOUDNESS_TARGET_LUFS}, which is what makes a single number defensible —
 * see that constant. −35 dB is below room tone and typing and above the digital
 * floor, so it finds pauses rather than absolute quiet.
 */
export const SILENCE_FLOOR_DB = -35;

/**
 * How long a pause must last to be worth cutting in, in seconds.
 *
 * Under ~0.4s this finds the gaps BETWEEN WORDS, and a desk that may cut there
 * has learned nothing over cutting by arithmetic. 0.6s is a breath or a turn
 * change — the places a human would cut a recording.
 */
export const MIN_SILENCE_SECONDS = 0.6;

/**
 * The longest segment this desk will send, in seconds.
 *
 * The sync endpoint's hard cap is 120 seconds. The headroom is smaller here than
 * a blind cut needs (`transcription-workflow` leaves 30s for its overlap) because
 * there is no overlap to add: a segment is exactly the audio between two cut
 * points, so the only thing the margin absorbs is the endpoint measuring a
 * duration slightly differently than the byte count says.
 */
export const MAX_SEGMENT_SECONDS = 110;

/**
 * The shortest segment worth its own request, in seconds.
 *
 * The endpoint refuses audio under 80ms outright; the floor is well above that
 * because a request costs a round trip either way and a 0.3-second tail of a
 * recording holds at most one word. A stretch below this is merged backwards
 * into its predecessor rather than dropped — see {@link planSegments}.
 */
export const MIN_SEGMENT_SECONDS = 1;

/** A loudness measurement, as `loudnorm`'s first pass reports it. */
export type Loudness = {
  /** Integrated loudness, LUFS. */
  inputLufs: number;
  /** True peak, dBTP. */
  inputTruePeak: number;
  /** Loudness range, LU. */
  inputRange: number;
  /** The gating threshold the measurement used, LUFS. */
  inputThreshold: number;
  /** The correction the second pass must apply, LU. */
  targetOffset: number;
};

/** One pause, in seconds from the start of the recording. */
export type Silence = {
  startSec: number;
  endSec: number;
};

/** One request's worth of audio, addressed as a byte range of the normalized PCM. */
export type Segment = {
  /** Position in the recording — the fan-out's order, and the merge's. */
  index: number;
  /** First byte, frame-aligned and inclusive. */
  startByte: number;
  /** One past the last byte, frame-aligned. */
  endByte: number;
  /** Where this segment starts in the recording. */
  startMs: number;
  /** Where it ends. Does NOT overlap the next segment — see the module doc. */
  endMs: number;
  /**
   * Whether this segment's end landed in speech rather than in a pause.
   *
   * `false` for every segment on an ordinary recording, and the field exists for
   * the case where it is not: a monologue with no 0.6-second pause in 110 seconds
   * leaves nothing to cut in, so the desk cuts by arithmetic exactly as
   * `transcription-workflow` does. Reported rather than hidden, because a
   * transcript with a mangled word at one seam is otherwise a mystery.
   */
  cutInSpeech: boolean;
};

/** Raised when an analysis pass produced something this module cannot read. Always terminal. */
export class MediaAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaAnalysisError";
  }
}

/**
 * Pass one: measure the recording's loudness without writing any audio.
 *
 * `-f null -` is the whole trick — the filter graph runs, every frame is decoded
 * and analysed, and the output goes nowhere. So this costs a decode and produces
 * five numbers.
 *
 * **`-loglevel info` is required and is not a debugging leftover.**
 * `print_format=json` writes through ffmpeg's log at info level, so at `error`
 * the pass runs, succeeds, and prints nothing — a failure that looks like a
 * parser bug. It is the one invocation here that is not quiet, which is why
 * {@link parseLoudness} searches for its block rather than assuming the stderr
 * tail begins with it.
 */
export function measureLoudnessArgs(input: string): string[] {
  return [
    // `info`, not the default `error`: `print_format=json` reports through the
    // LOG, so at `error` this pass runs, succeeds, and prints nothing.
    ...ffmpegBaseArgs({ loglevel: "info" }),
    "-i",
    input,
    "-af",
    `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE_LU}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

/**
 * Read the five numbers pass one printed.
 *
 * The block is JSON, and it is found rather than parsed from a known offset: it
 * is preceded by `[Parsed_loudnorm_0 @ 0x…]` and by however much of ffmpeg's
 * info-level chatter survived the stderr tail. So the reader takes the LAST
 * `{…}` in the text — last because a re-run's block would follow an earlier one,
 * and because nothing else ffmpeg logs at info level is brace-delimited.
 *
 * Both halves of the read are declared below — {@link LoudnessBlock} for "is it
 * an object", {@link LoudnessValues} for the five values, every one of which
 * arrives as a STRING and has to coerce without silently yielding `NaN`.
 */
export function parseLoudness(stderr: string): Loudness {
  const open = stderr.lastIndexOf("{");
  const close = stderr.lastIndexOf("}");
  if (open === -1 || close < open) {
    throw new MediaAnalysisError(
      "The loudness pass printed no JSON block. That is what happens when the argv " +
        "loses `-loglevel info`, since `print_format=json` writes through ffmpeg's log.",
    );
  }
  // Two parses, one per sentence this function can say. The block being an
  // OBJECT and the five values being readable are different failures with
  // different remedies, and the second message quotes the value ffmpeg actually
  // printed — which needs the block still in hand, so the gate cannot be folded
  // into the schema below.
  const block = LoudnessBlock.safeParse(safeJsonParse(stderr.slice(open, close + 1)));
  if (!block.success) {
    throw new MediaAnalysisError("The loudness pass printed a block that is not JSON.");
  }

  const values = LoudnessValues.safeParse(block.data);
  if (!values.success) {
    // Zod reports issues in the schema's own field order, so the first one names
    // the same key the first per-key read named — and there is always a key,
    // the object gate above having already passed.
    const key = String(values.error.issues[0]?.path[0]);
    throw new MediaAnalysisError(
      `The loudness pass reported no usable \`${key}\` (got ${JSON.stringify(block.data[key])}).`,
    );
  }

  return {
    inputLufs: values.data.input_i,
    inputTruePeak: values.data.input_tp,
    inputRange: values.data.input_lra,
    inputThreshold: values.data.input_thresh,
    targetOffset: values.data.target_offset,
  };
}

/**
 * Is the found `{…}` an object at all?
 *
 * The reachable failure is {@link safeJsonParse} answering `undefined` — a brace pair
 * found in ffmpeg's chatter with something other than JSON between them — and
 * that is a different sentence from a value being unreadable, which is why this
 * gate exists at all rather than being folded into {@link LoudnessValues}.
 *
 * `looseObject`, not `object`: it asks the ONE question and says nothing about
 * keys, which matters because ffmpeg prints ten and the schema below reads five.
 */
const LoudnessBlock = z.looseObject({});

/**
 * The five numbers, in the order {@link parseLoudness} reports them missing.
 *
 * `z.coerce.number()` is the load-bearing choice: every value arrives as a
 * STRING (`"input_i" : "-16.19"`), which is ffmpeg's shape and not a quirk of
 * one version, so the schema has to coerce exactly as `Number(…)` did. What it
 * adds is the check — zod 4's `z.number()` refuses `NaN` and both infinities,
 * so a key ffmpeg stopped printing fails HERE with its name attached instead of
 * flowing into pass two's argv as the literal text `NaN` and coming back as an
 * ffmpeg option-parsing error about a filter.
 */
const LoudnessValues = z.object({
  input_i: z.coerce.number(),
  input_tp: z.coerce.number(),
  input_lra: z.coerce.number(),
  input_thresh: z.coerce.number(),
  target_offset: z.coerce.number(),
});

/**
 * Pass two: apply the measurement, find the pauses, and write the audio.
 *
 * ONE invocation doing three things, which is a decode saved rather than a
 * shortcut: levelling and silence detection are both filters on the same graph,
 * so chaining them costs nothing over running either alone. It also makes the
 * silence map STRICTLY more useful — the pauses are found in the levelled signal,
 * which is the signal a single {@link SILENCE_FLOOR_DB} can actually judge.
 *
 * `linear=true` asks for one constant gain over the whole recording instead of a
 * moving one. That is what you want for speech (a dynamic normalizer audibly
 * pumps between a loud sentence and a quiet one) and ffmpeg falls back to dynamic
 * on its own when the linear gain would clip the true peak, so it is a preference
 * rather than a demand.
 *
 * The output is headerless raw PCM — see {@link ANALYSIS_FORMAT} for why that is
 * the shape that makes byte arithmetic legal.
 *
 * @param silenceLog - Where `ametadata` writes the pause events. A path rather
 *   than stderr, and the module doc carries why that is load-bearing.
 */
export function normalizeArgs(
  input: string,
  measured: Loudness,
  output: string,
  silenceLog: string,
): string[] {
  const loudnorm = [
    `loudnorm=I=${LOUDNESS_TARGET_LUFS}`,
    `TP=${LOUDNESS_TRUE_PEAK_DB}`,
    `LRA=${LOUDNESS_RANGE_LU}`,
    `measured_I=${measured.inputLufs}`,
    `measured_TP=${measured.inputTruePeak}`,
    `measured_LRA=${measured.inputRange}`,
    `measured_thresh=${measured.inputThreshold}`,
    `offset=${measured.targetOffset}`,
    "linear=true",
  ].join(":");

  return [
    // Quiet, and the analysis still arrives: `ametadata` writes its file
    // directly rather than through the log, which is the property that lets this
    // pass be both silent and complete.
    ...ffmpegBaseArgs(),
    "-i",
    input,
    "-af",
    `${loudnorm},silencedetect=noise=${SILENCE_FLOOR_DB}dB:duration=${MIN_SILENCE_SECONDS},ametadata=mode=print:file=${silenceLog}`,
    // No video, and the channel/rate/codec triple that makes the output match
    // `ANALYSIS_FORMAT` exactly. `-f s16le` rather than `-f wav`: raw samples,
    // no header, so byte zero is second zero.
    "-vn",
    "-ac",
    String(ANALYSIS_FORMAT.channels),
    "-ar",
    String(ANALYSIS_FORMAT.sampleRate),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    output,
  ];
}

/**
 * Read the pauses out of `ametadata`'s log.
 *
 * The format is a block per event — a `frame:… pts:… pts_time:…` line followed by
 * the `lavfi.silence_*` keys that frame carried:
 *
 * ```text
 * frame:155  pts:158720  pts_time:3.59909
 * lavfi.silence_start=3
 * frame:215  pts:220160  pts_time:4.99229
 * lavfi.silence_end=5.00005
 * lavfi.silence_duration=2.00005
 * ```
 *
 * Note the event times are NOT the frame's `pts_time`: `silence_start=3` on a
 * frame at 3.599 is the filter reporting where the silence really began, having
 * needed 0.6 seconds of it to be sure. So the `lavfi.` keys are what is read and
 * the frame lines are skipped.
 *
 * **A trailing `silence_start` with no `silence_end` is normal and has to be
 * handled**, verified against ffmpeg 6.1: a recording that ends during a pause
 * gets an opening event and nothing to close it, because the filter never sees
 * the sound come back. It is closed at `durationSec`, which is why this function
 * takes a duration it could otherwise derive nothing from — and why the caller
 * measures that duration from the PCM byte count rather than from this log.
 */
export function parseSilences(log: string, durationSec: number): Silence[] {
  const silences: Silence[] = [];
  let openedAt: number | undefined;

  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    const start = value(trimmed, "lavfi.silence_start=");
    if (start !== undefined) {
      // A second `start` before an `end` cannot happen in ffmpeg's output, and if
      // it ever did, keeping the FIRST is the reading that does not lose audio:
      // the pause is at least as long as the first opening claimed.
      openedAt ??= Math.max(0, start);
      continue;
    }
    const end = value(trimmed, "lavfi.silence_end=");
    if (end !== undefined && openedAt !== undefined) {
      if (end > openedAt) silences.push({ startSec: openedAt, endSec: Math.min(end, durationSec) });
      openedAt = undefined;
    }
  }

  // The recording ended inside a pause. See this function's doc.
  if (openedAt !== undefined && durationSec > openedAt) {
    silences.push({ startSec: openedAt, endSec: durationSec });
  }
  return silences;
}

/**
 * Seconds of audio in a stored PCM file, exactly.
 *
 * Exact rather than rounded, and that distinction cost a bug: `pcmDurationMs`
 * answers whole MILLISECONDS, so a 640,500-byte file reports 20,016 ms where it
 * really holds 20,015.625. Planning from the rounded number put the last segment's
 * `endByte` at 640,512 — twelve bytes past the end of the file. `readUpload` clamps
 * a window to the stored size, so nothing threw; the plan was simply describing
 * audio that does not exist. Verified against a real ffmpeg, which is the only
 * place a 12-byte error was ever going to show up.
 *
 * So {@link planSegments} takes the BYTE COUNT and derives its own seconds. The
 * milliseconds a page displays can round; the offsets a fan-out reads must not.
 */
export function durationSeconds(totalBytes: number): number {
  return totalBytes / BYTES_PER_SECOND;
}

/**
 * Where to cut, given where the pauses are.
 *
 * Greedy from the front: a segment grows until the next cut candidate would take
 * it past {@link MAX_SEGMENT_SECONDS}, so it ends at the LAST pause that still
 * fits. Segments are therefore contiguous and non-overlapping — together they are
 * the whole recording, each one addressable as a single `readUpload` window.
 *
 * Three properties, each of which a simpler version gets wrong:
 *
 * - **The cut is the pause's MIDPOINT**, not its start or its end. Cutting at the
 *   start clips the decay of the last word before it; cutting at the end clips the
 *   attack of the first word after. The middle of a 0.6-second pause leaves 0.3
 *   seconds of room on both sides, which is more than any consonant needs.
 * - **A pause is a candidate, not a cut.** A recording with a pause every three
 *   seconds has hundreds of them; cutting at each would be hundreds of requests
 *   for a twenty-minute call. The silence between two kept spans stays INSIDE a
 *   segment, which is both cheaper and what keeps the byte range contiguous.
 * - **No candidate in range means a blind cut**, at exactly
 *   {@link MAX_SEGMENT_SECONDS}, flagged with `cutInSpeech`. An unbroken monologue
 *   is a real recording, and refusing it to preserve the pretty invariant would be
 *   the worse trade.
 *
 * Pure, and a pure function of journaled values — the silence list and the byte
 * count both come out of a step result. That is the ordinary determinism rule: a
 * replay must re-derive the same list in the same order, or the DevKit hands the
 * Nth journal entry to a different call.
 *
 * @param totalBytes - Size of the stored PCM, which is what the segments are byte
 *   ranges OF. The duration is derived from it rather than passed in; see
 *   {@link durationSeconds} for the twelve-byte bug that is there to prevent.
 */
export function planSegments(silences: readonly Silence[], totalBytes: number): Segment[] {
  const durationSec = durationSeconds(totalBytes);
  if (durationSec <= 0) return [];

  // Midpoints, in order, of every reported pause.
  //
  // **The threshold is NOT re-applied here, and that is a fix rather than an
  // omission.** `silencedetect` already enforced {@link MIN_SILENCE_SECONDS}, so a
  // second `endSec - startSec >= 0.6` looks free and is a floating-point trap: a
  // pause from 30 to 30.6 measures 0.5999999999999996, so the check drops it and
  // the desk falls back to a blind cut on a recording that had a perfectly good
  // pause to cut in. Caught by a spec, which is the argument for this module being
  // pure. What is left is the one condition the parser can produce and the planner
  // cannot use: an empty pause, or one at either edge of the recording.
  const candidates = silences
    .filter((gap) => gap.endSec > gap.startSec)
    .map((gap) => (gap.startSec + gap.endSec) / 2)
    .filter((at) => at > 0 && at < durationSec);

  const cuts: number[] = [];
  let at = 0;
  while (durationSec - at > MAX_SEGMENT_SECONDS) {
    const limit = at + MAX_SEGMENT_SECONDS;
    // The last candidate that still fits, and strictly after where we are — a
    // candidate at `at` would make a zero-length segment and never advance.
    let chosen: number | undefined;
    for (const candidate of candidates) {
      if (candidate > at && candidate <= limit) chosen = candidate;
      if (candidate > limit) break;
    }
    cuts.push(chosen ?? limit);
    at = chosen ?? limit;
  }

  // Whether a boundary is a cut this planner INVENTED, rather than a pause it found
  // or the recording's own end. One expression, used by both branches below —
  // computing it twice is how they came to disagree in a first draft.
  const blind = (endSec: number): boolean => cuts.includes(endSec) && !candidates.includes(endSec);

  const bounds = [0, ...cuts, durationSec];
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const startSec = bounds[i] ?? 0;
    const endSec = bounds[i + 1] ?? durationSec;
    // A tail too short to be worth a request joins its predecessor rather than
    // being dropped: the words in it are words, and one longer request is cheaper
    // than one more round trip.
    //
    // **Only if the merge stays under the cap.** The greedy loop leaves a final
    // segment of at most {@link MAX_SEGMENT_SECONDS}, so absorbing a
    // sub-{@link MIN_SEGMENT_SECONDS} tail into a segment already at the cap makes
    // one 110.9 seconds long — still inside the endpoint's own 120-second limit,
    // and outside the bound this module promises. A short final request is the
    // cheaper mistake, and it is still an order of magnitude above the 80ms the
    // endpoint refuses.
    const previous = segments.at(-1);
    const merged = previous === undefined ? 0 : endSec - previous.startMs / 1000;
    if (
      endSec - startSec < MIN_SEGMENT_SECONDS &&
      previous !== undefined &&
      merged <= MAX_SEGMENT_SECONDS
    ) {
      previous.endByte = byteAt(endSec);
      previous.endMs = Math.round(endSec * 1000);
      previous.cutInSpeech = blind(endSec);
      continue;
    }
    segments.push({
      index: segments.length,
      startByte: byteAt(startSec),
      endByte: byteAt(endSec),
      startMs: Math.round(startSec * 1000),
      endMs: Math.round(endSec * 1000),
      // Only a bound this planner INVENTED is a cut through speech; a bound that
      // came from `candidates` is a pause, and the recording's own end is neither.
      cutInSpeech: blind(endSec),
    });
  }
  return segments;
}

/**
 * Pass three: the spoken summary, mastered.
 *
 * The other direction, and the reason this template runs ffmpeg twice rather than
 * once. `stepSpeak` answers with a 24 kHz WAV, which is correct and is not a
 * deliverable: it is uncompressed (a two-minute summary is 5.8 MB, which a page
 * downloads before it plays anything) and its level is whatever the voice service
 * chose, so a summary played after the recording it summarizes is jarringly
 * louder or quieter.
 *
 * So: level it to the same {@link LOUDNESS_TARGET_LUFS} as everything else, and
 * encode it as MP3. One `loudnorm` pass rather than two here, deliberately — a
 * two-pass measure is worth a decode on a recording of unknown provenance, and
 * this is 90 seconds of synthesis whose level is already consistent.
 * `-q:a 4` is VBR at roughly 128 kbit/s, which is transparent for one voice and
 * about a fortieth of the WAV.
 */
export function masterArgs(input: string, output: string): string[] {
  return [
    ...ffmpegBaseArgs(),
    "-i",
    input,
    "-af",
    `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE_LU}`,
    "-c:a",
    "libmp3lame",
    "-q:a",
    "4",
    "-ac",
    "1",
    output,
  ];
}

/** How much of a recording is speech, as a fraction — the one line a summary needs. */
export function speechFraction(silences: readonly Silence[], durationSec: number): number {
  if (durationSec <= 0) return 0;
  const quiet = silences.reduce((total, gap) => total + Math.max(0, gap.endSec - gap.startSec), 0);
  return Math.max(0, Math.min(1, (durationSec - quiet) / durationSec));
}

/**
 * A second, as a byte offset on a sample-frame boundary.
 *
 * Rounded DOWN to a frame, because a byte offset mid-sample shifts every sample
 * after it by one byte — which is not a click, it is white noise that a decoder
 * transcribes into confident nonsense.
 */
function byteAt(seconds: number): number {
  const frame = (ANALYSIS_FORMAT.channels * ANALYSIS_FORMAT.bitsPerSample) / 8;
  return Math.floor((seconds * BYTES_PER_SECOND) / frame) * frame;
}

/**
 * `lavfi.silence_start=3` → `3`, for the one key asked about.
 *
 * The empty check is not defensive padding — `Number("")` is **0**, not `NaN`, so a
 * truncated line (`lavfi.silence_start=`, which a log cut off mid-write really
 * produces) would otherwise read as a pause beginning at second zero. That is a cut
 * candidate at the very start of the recording, which is exactly the kind of wrong
 * answer that looks like a plausible one.
 */
function value(line: string, key: string): number | undefined {
  if (!line.startsWith(key)) return undefined;
  const text = line.slice(key.length).trim();
  if (text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
