// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the audit desk's declaration, its ffmpeg argv, the two analyses it
 * reads back, and where it decides to cut.
 *
 * **The pipeline is not driven end to end here, and that is the tier rather than
 * a gap.** A unit test may not spawn a subprocess or write a file, so the three
 * steps that run ffmpeg cannot be. What CAN be — and what this file therefore
 * spends most of its lines on — is everything those steps decide, because
 * `media.ts` exists precisely to hold it: the argv is a pure function, so it is a
 * value to assert on rather than a string buried in a step; and both analyses are
 * parsed by pure functions, so ffmpeg's real output can be a fixture.
 *
 * The fixtures below are **captured from ffmpeg 6.1.1**, verbatim, by running the
 * argv these functions build. That matters more than it usually would: every field
 * here is a string ffmpeg chose (`"input_i" : "-16.19"`, tabs and spaces included),
 * so a fixture somebody typed from the documentation would be a spec that passes
 * against a parser no real recording can satisfy.
 *
 * What the ffmpeg steps get instead is the two things a spec can still reach: the
 * argv they will run, and the classification of a failure — which is where a
 * mistake is silent, since a `timeout` called fatal is a run that gives up on work
 * that would have finished.
 *
 * The last block adds a third: the ENGINE's half of that classification, on a
 * real run. `runWorkflow` starts this desk's declared workflow on the replay
 * engine, and with no ffmpeg the first step fails fatally — which is exactly the
 * case worth asserting, because `FatalError` exists to stop the engine spending
 * the six attempts this call site asks for on a file that will never convert.
 */

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { createWorkflowCtx, stubSpeech, WORKFLOW_CTX_NOW } from "@alexkroman1/aai/testing";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { audit } from "./agent.ts";
import {
  auditFlow,
  joinSegments,
  SEGMENT_CONCURRENCY,
  transcribeSegment,
} from "./workflows/audit.ts";
import { analyse, ingestRecording } from "./workflows/ingest.ts";
import {
  ANALYSIS_FORMAT,
  BYTES_PER_SECOND,
  durationSeconds,
  type Loudness,
  MAX_SEGMENT_SECONDS,
  MediaAnalysisError,
  MIN_SILENCE_SECONDS,
  masterArgs,
  measureLoudnessArgs,
  normalizeArgs,
  parseLoudness,
  parseSilences,
  planSegments,
  type Silence,
  speechFraction,
} from "./workflows/media.ts";
import { narrate, summarize } from "./workflows/summarize.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/**
 * `loudnorm`'s first pass, exactly as ffmpeg 6.1.1 printed it to stderr.
 *
 * Kept verbatim — the leading log line, the blank line, the tab indentation, and
 * every value as a STRING. Two of those are load-bearing: the parser has to FIND
 * the block rather than assume the text starts with it, and it has to coerce
 * strings rather than read numbers.
 */
const LOUDNORM_STDERR = `[Parsed_loudnorm_0 @ 0x558882c84140]
{
\t"input_i" : "-16.19",
\t"input_tp" : "-7.42",
\t"input_lra" : "4.80",
\t"input_thresh" : "-26.34",
\t"output_i" : "-16.13",
\t"output_tp" : "-7.48",
\t"output_lra" : "4.80",
\t"output_thresh" : "-26.26",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.13"
}
`;

/**
 * What `ametadata=mode=print:file=…` wrote for a 20-second recording, verbatim.
 *
 * Two things about it are the whole reason `parseSilences` is not a two-line
 * regex, and both were verified rather than assumed:
 *
 * - The event times are NOT the frame's `pts_time`. `silence_start=3` sits on a
 *   frame at 3.599, because the filter needed 0.6s of silence to be sure.
 * - The LAST event has no `silence_end`. The recording ended during a pause, so
 *   the filter never saw the sound come back.
 */
const SILENCE_LOG = `frame:155  pts:158720  pts_time:3.59909
lavfi.silence_start=3
frame:215  pts:220160  pts_time:4.99229
lavfi.silence_end=5.00005
lavfi.silence_duration=2.00005
frame:370  pts:378880  pts_time:8.59138
lavfi.silence_start=7.99998
frame:430  pts:440320  pts_time:9.98458
lavfi.silence_end=10
lavfi.silence_duration=2.00007
frame:585  pts:599040  pts_time:13.5837
lavfi.silence_start=13
frame:645  pts:660480  pts_time:14.9769
lavfi.silence_end=15
lavfi.silence_duration=2.00007
frame:801  pts:820224  pts_time:18.5992
lavfi.silence_start=18
`;

/**
 * Bytes the real normalize pass wrote for the recording {@link SILENCE_LOG} came
 * from, and the exact seconds that is.
 *
 * Not 20 seconds: AAC carries encoder priming samples, so decoding a nominally
 * 20-second file yields 20.015625. The difference is small and it is the whole
 * reason `planSegments` takes a byte count — see `durationSeconds`.
 */
const REAL_PCM_BYTES = 640_500;
const EXACT_SECONDS = durationSeconds(REAL_PCM_BYTES);

/** The measurement above, parsed — the input the second pass's argv is built from. */
const MEASURED: Loudness = {
  inputLufs: -16.19,
  inputTruePeak: -7.42,
  inputRange: 4.8,
  inputThreshold: -26.34,
  targetOffset: 0.13,
};

/**
 * The bytes one stubbed request carried, ASSERTED rather than cast.
 *
 * A `throw` returns `never`, so this narrows without an `as Uint8Array` — and the
 * cast is what a first draft reaches for, which Biome then rejects as unsafe
 * optional chaining, because a missing call would throw on `.byteLength` rather
 * than fail with a message. A typed seam is the repo's remedy for a concentration
 * of identical casts, and two is where it starts paying.
 *
 * A bare `throw` rather than `expect.fail`, which is the shape the repo prefers in
 * a test BODY and which Biome's `noMisplacedAssertion` forbids in a helper — an
 * assertion outside a `test()` is a real hazard, and here the throw is doing type
 * narrowing rather than making a claim.
 */
function sentBytes(body: unknown): Uint8Array {
  if (!(body instanceof Uint8Array)) {
    throw new TypeError("the stub records a Uint8Array request body");
  }
  return body;
}

/** A pause at each of `starts`, each exactly long enough to be a candidate. */
function pauses(...starts: number[]): Silence[] {
  return starts.map((startSec) => ({ startSec, endSec: startSec + MIN_SILENCE_SECONDS }));
}

beforeEach(() => {
  // The step env, which is where `requireStepEnv`, `stepSpeak` and the gateway
  // read the key. `vi.stubEnv` rather than an assignment: `unstubEnvs` undoes it
  // before every test, so nothing here has to remember to put it back.
  vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
});

describe("the declaration", () => {
  test("is a workflow app with the one workflow the page starts by name", () => {
    // The page calls `api.start("audit", …)`, so a rename here is a runtime 400
    // rather than a compile error. This is what pins it.
    // `toContain` rather than an exact key list: adding a second workflow is an
    // invited edit and must not redden a test the author did not write. The
    // NAME is still pinned, deliberately — the page starts a run by this
    // string, so renaming the key is a runtime 400 rather than a compile
    // error, and this pin is the only thing that says so. Rename it here and
    // in `client.tsx` together.
    expect(Object.keys(agentDef.workflows ?? {})).toContain("audit");
    expect(agentDef.workflows?.audit).toBe(audit);
  });

  test("declares the credential its steps read, so a deploy checks for it", () => {
    // A workflow app has no session, so nothing else in its config could name one
    // — and one AssemblyAI key covers transcription, the model and the voice.
    // Note what is NOT here: ffmpeg. `requiredEnv` checks the environment, and a
    // binary on `PATH` is not an environment variable.
    //
    // `toContain` rather than an exact list: a step of your own that reads a
    // second credential belongs in `requiredEnv` beside this one, and declaring
    // it must not fail this test.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });

  test("takes the recording as an UPLOAD, which is what makes the form a file picker", () => {
    expect(audit.uploads).toEqual(["recording"]);
  });

  test("offers real voice ids, so the synthesis cannot fail silently in band", async () => {
    // A wrong voice is accepted by the socket and refused in band, so the schema
    // is the only thing that can catch one. The list is read from the SDK catalog.
    expect(
      (await audit.input?.["~standard"].validate({ recording: UPLOAD_ID, voice: "not-a-voice" }))
        ?.issues,
    ).toBeTruthy();
    expect(
      (await audit.input?.["~standard"].validate({ recording: UPLOAD_ID, voice: "jane" }))?.issues,
    ).toBeUndefined();
  });

  test("accepts a recording with no voice chosen, so the SDK default applies", async () => {
    expect(
      (await audit.input?.["~standard"].validate({ recording: UPLOAD_ID }))?.issues,
    ).toBeUndefined();
  });
});

describe("the ffmpeg argv", () => {
  test("every invocation is quiet, non-interactive, and overwrites", () => {
    // `-nostdin` is the one that matters in a guest: an ffmpeg that decides to
    // read stdin is a process that never exits.
    for (const argv of [
      measureLoudnessArgs("in.m4a"),
      normalizeArgs("in.m4a", MEASURED, "out.pcm", "silence.txt"),
      masterArgs("spoken.wav", "out.mp3"),
    ]) {
      expect(argv).toEqual(expect.arrayContaining(["-hide_banner", "-nostats", "-nostdin", "-y"]));
    }
  });

  test("the measure pass writes no audio and asks for JSON", () => {
    const argv = measureLoudnessArgs("in.m4a");
    // `-f null -` is what makes this cost a decode and produce five numbers.
    expect(argv.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(argv.join(" ")).toContain("print_format=json");
  });

  test("the measure pass runs at `info`, because that is where the JSON is printed", () => {
    // The failure this pins is silent: at `-loglevel error` the pass still runs
    // and still succeeds, and prints nothing at all — which reads as a parser bug.
    const argv = measureLoudnessArgs("in.m4a");
    expect(argv[argv.indexOf("-loglevel") + 1]).toBe("info");
  });

  test("the normalize pass stays quiet, because its analysis goes to a FILE", () => {
    const argv = normalizeArgs("in.m4a", MEASURED, "out.pcm", "silence.txt");
    expect(argv[argv.indexOf("-loglevel") + 1]).toBe("error");
    // `ametadata` writes the path directly rather than through the log, which is
    // the property that lets this pass be both silent and complete.
    expect(argv.join(" ")).toContain("ametadata=mode=print:file=silence.txt");
  });

  test("the normalize pass feeds back every measured value", () => {
    // A missing `measured_*` makes loudnorm silently run a ONE-pass normalization
    // instead — no error, just a different result — so all five are pinned.
    const filter = normalizeArgs("in.m4a", MEASURED, "out.pcm", "silence.txt").join(" ");
    expect(filter).toContain("measured_I=-16.19");
    expect(filter).toContain("measured_TP=-7.42");
    expect(filter).toContain("measured_LRA=4.8");
    expect(filter).toContain("measured_thresh=-26.34");
    expect(filter).toContain("offset=0.13");
    // One constant gain rather than a moving one, so speech does not pump.
    expect(filter).toContain("linear=true");
  });

  test("the normalize pass writes HEADERLESS PCM in the analysis format", () => {
    // The decision the whole template rests on: `-f s16le`, not `-f wav`, so byte
    // zero is second zero and nothing has to parse a RIFF chunk list.
    const argv = normalizeArgs("in.m4a", MEASURED, "out.pcm", "silence.txt");
    expect(argv.slice(-3)).toEqual(["-f", "s16le", "out.pcm"]);
    expect(argv[argv.indexOf("-ar") + 1]).toBe(String(ANALYSIS_FORMAT.sampleRate));
    expect(argv[argv.indexOf("-ac") + 1]).toBe(String(ANALYSIS_FORMAT.channels));
    expect(argv[argv.indexOf("-c:a") + 1]).toBe("pcm_s16le");
  });

  test("the filter chain is ONE argv element, so its commas never meet a shell", () => {
    // `runFfmpeg` spawns without a shell, which is what makes an unquoted filter
    // graph safe — and what would break if this were ever assembled into a string.
    const argv = normalizeArgs("in.m4a", MEASURED, "out.pcm", "silence.txt");
    const filter = argv[argv.indexOf("-af") + 1] ?? "";
    expect(filter).toContain(",silencedetect=");
    expect(filter.startsWith("loudnorm=")).toBe(true);
  });

  test("the mastering pass encodes MP3, which is the point of running it", () => {
    const argv = masterArgs("spoken.wav", "out.mp3");
    expect(argv[argv.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(argv.at(-1)).toBe("out.mp3");
  });
});

describe("reading the loudness measurement", () => {
  test("parses ffmpeg's own block, strings and all", () => {
    expect(parseLoudness(LOUDNORM_STDERR)).toEqual(MEASURED);
  });

  test("finds the block after whatever info-level chatter preceded it", () => {
    // The pass runs at `-loglevel info`, so the captured stderr tail holds stream
    // descriptions and a muxing-overhead line before the JSON.
    const noisy = `  Stream #0:0(und): Audio: pcm_s16le, 192000 Hz, mono\nsize=N/A time=00:00:17.20\n${LOUDNORM_STDERR}`;
    expect(parseLoudness(noisy)).toEqual(MEASURED);
  });

  test("takes the LAST block, so a retried pass reads its own numbers", () => {
    const twice = LOUDNORM_STDERR + LOUDNORM_STDERR.replace('"-16.19"', '"-20.50"');
    expect(parseLoudness(twice).inputLufs).toBe(-20.5);
  });

  test("names the missing `-loglevel info` when nothing was printed", () => {
    // The most likely way this breaks, so the message says how to fix it rather
    // than reporting a parse failure.
    expect(() => parseLoudness("size=N/A time=00:00:17.20\n")).toThrow(MediaAnalysisError);
    expect(() => parseLoudness("")).toThrow(/-loglevel info/);
  });

  test("names the KEY when a value is missing or unparseable", () => {
    // A silent `NaN` would flow into the second pass's argv as the literal text
    // `NaN` and come back as an ffmpeg option-parsing error about a filter.
    const missing = LOUDNORM_STDERR.replace('"input_tp" : "-7.42",', "");
    expect(() => parseLoudness(missing)).toThrow(/input_tp/);
  });

  test("names the KEY when the value is unreadable, and QUOTES what came", () => {
    // The other half of the case above: the key is there and holds something no
    // number can be read out of — `"n/a"`, which is ffmpeg's own spelling for a
    // value it could not measure, or a type that was never a number. Terminal
    // either way, and the message has to carry the value, which is why the
    // object gate and the value schema are two parses rather than one.
    expect(() => parseLoudness(LOUDNORM_STDERR.replace('"-7.42"', '"n/a"'))).toThrow(
      /input_tp.*got "n\/a"/,
    );
    expect(() => parseLoudness(LOUDNORM_STDERR.replace('"-7.42"', "[1,2]"))).toThrow(/input_tp/);
  });

  test("coerces exactly as `Number(…)` does, corners included", () => {
    // Every value is a STRING on the wire, so the read has always been a
    // coercion — and `Number(null)` is 0, not `NaN`. Pinned rather than
    // tightened: the schema replaced a hand-written reader, so its corners are
    // the ones that reader had, and narrowing them is a change to make on
    // purpose rather than a side effect of declaring a schema.
    const nulled = LOUDNORM_STDERR.replace('"0.13"', "null");
    expect(parseLoudness(nulled).targetOffset).toBe(0);
  });

  test("refuses a block that is not JSON at all", () => {
    expect(() => parseLoudness("[loudnorm] {not json}")).toThrow(MediaAnalysisError);
    expect(() => parseLoudness("[loudnorm] {not json}")).toThrow(/not JSON/);
  });
});

describe("reading the pauses", () => {
  test("parses every event ffmpeg logged, and closes the unterminated one", () => {
    // The trailing `silence_start=18` has no `silence_end` — the recording ended
    // during the pause. It is closed at the duration, which is why this function
    // takes one.
    expect(parseSilences(SILENCE_LOG, EXACT_SECONDS)).toEqual([
      { startSec: 3, endSec: 5.000_05 },
      { startSec: 7.999_98, endSec: 10 },
      { startSec: 13, endSec: 15 },
      { startSec: 18, endSec: EXACT_SECONDS },
    ]);
  });

  test("reads the EVENT time, not the frame's", () => {
    // `silence_start=3` sits on a frame at `pts_time:3.59909`. Reading the frame
    // would put every cut 0.6s late and lose the word before it.
    const [first] = parseSilences(SILENCE_LOG, EXACT_SECONDS);
    expect(first?.startSec).toBe(3);
  });

  test("an empty log is no pauses, not a failure", () => {
    // Verified against ffmpeg 6.1: `ametadata` creates the file at filter-init, so
    // a recording with no pause in it leaves an empty log rather than none.
    expect(parseSilences("", 30)).toEqual([]);
  });

  test("a pause that never ended before a recording that already did is dropped", () => {
    // `durationSec` is measured from the PCM byte count and the log from the same
    // pass, so they agree — but a zero-length pause would produce a cut candidate
    // at the very end, which `planSegments` would then have to reject.
    expect(parseSilences("lavfi.silence_start=30\n", 30)).toEqual([]);
  });

  test("an end without a start is ignored rather than inventing a pause at zero", () => {
    expect(parseSilences("lavfi.silence_end=4\n", 30)).toEqual([]);
  });

  test("a truncated numeric value is skipped rather than read as NaN", () => {
    // A `NaN` boundary would make every downstream comparison false, so the cut
    // planner would silently fall back to blind cuts for the whole recording.
    expect(parseSilences("lavfi.silence_start=\nlavfi.silence_end=4\n", 30)).toEqual([]);
  });
});

describe("planning where to cut", () => {
  test("a recording inside the cap is one segment, whatever its pauses", () => {
    // Nothing to decide, and the pauses must not tempt the planner into cutting: a
    // request per pause would be dozens of requests for a two-minute call.
    const segments = planSegments(pauses(10, 20, 30), 60 * BYTES_PER_SECOND);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ index: 0, startByte: 0, startMs: 0, endMs: 60_000 });
    expect(segments[0]?.endByte).toBe(60 * BYTES_PER_SECOND);
  });

  test("cuts at the LAST pause that still fits, not the first", () => {
    // Greedy from the front, so segments are as long as the cap allows — the
    // alternative is twice as many requests for the same audio.
    const segments = planSegments(pauses(30, 60, 100), 150 * BYTES_PER_SECOND);
    // The pause at 100 spans 100–100.6, so its midpoint is 100.3.
    expect(segments.map((s) => s.endMs)).toEqual([100_300, 150_000]);
  });

  test("the cut is the pause's MIDPOINT, so neither side is clipped", () => {
    // Cutting at the start clips the decay of the word before; cutting at the end
    // clips the attack of the word after.
    const segments = planSegments([{ startSec: 100, endSec: 101 }], 150 * BYTES_PER_SECOND);
    expect(segments[0]?.endMs).toBe(100_500);
  });

  test("segments are contiguous and non-overlapping, which is what deletes the stitcher", () => {
    const segments = planSegments(pauses(50, 100, 160, 210), 260 * BYTES_PER_SECOND);
    expect(segments.length).toBeGreaterThan(1);
    for (const [i, segment] of segments.entries()) {
      if (i === 0) continue;
      expect(segment.startByte).toBe(segments[i - 1]?.endByte);
      expect(segment.startMs).toBe(segments[i - 1]?.endMs);
    }
    expect(segments[0]?.startByte).toBe(0);
    expect(segments.at(-1)?.endByte).toBe(260 * BYTES_PER_SECOND);
  });

  test("no segment exceeds the endpoint's cap", () => {
    const segments = planSegments(pauses(20, 40, 61, 130, 200), 400 * BYTES_PER_SECOND);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS * 1000);
    }
  });

  test("an unbroken monologue falls back to a blind cut, and SAYS so", () => {
    // The case the pretty invariant cannot serve. Refusing it would be the worse
    // trade, so it degrades to exactly what `transcription-workflow` does — and
    // reports it, because a mangled word at a seam is otherwise a mystery.
    const segments = planSegments([], 300 * BYTES_PER_SECOND);
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.endMs)).toEqual([110_000, 220_000, 300_000]);
    expect(segments.map((s) => s.cutInSpeech)).toEqual([true, true, false]);
  });

  test("a cut that landed in a pause is NOT reported as a blind cut", () => {
    const segments = planSegments(pauses(100), 150 * BYTES_PER_SECOND);
    expect(segments.map((s) => s.cutInSpeech)).toEqual([false, false]);
  });

  test("a tail too short to be worth a request joins its predecessor", () => {
    // The endpoint refuses audio under 80ms, and a 0.4-second tail holds at most one
    // word — but the word is a word, so it is merged rather than dropped. A pause at
    // 150 leaves the predecessor well short of the cap, which is what makes the merge
    // legal; see the cap test below for when it is not.
    const segments = planSegments(pauses(150), 200.5 * BYTES_PER_SECOND);
    expect(segments).toHaveLength(2);
    expect(segments.at(-1)?.endMs).toBe(200_500);
  });

  test("a short tail is NOT absorbed into a segment already at the cap", () => {
    // The greedy loop leaves a final segment of at most `MAX_SEGMENT_SECONDS`, so
    // merging a sub-second tail into a predecessor already at the cap would make one
    // 110.5 seconds long — inside the endpoint's own 120-second limit, and outside
    // the bound this module promises. A short final request is the cheaper mistake,
    // and it is still an order of magnitude above the 80ms the endpoint refuses.
    const segments = planSegments([], 110.5 * BYTES_PER_SECOND);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS * 1000);
    }
    // Still contiguous, still covering the whole recording.
    expect(segments[0]?.endByte).toBe(segments[1]?.startByte);
    expect(segments.at(-1)?.endMs).toBe(110_500);
  });

  test("every byte offset lands on a sample-frame boundary", () => {
    // A byte offset mid-sample shifts every sample after it by one byte, which is
    // not a click — it is white noise the decoder transcribes into confident
    // nonsense.
    const frame = (ANALYSIS_FORMAT.channels * ANALYSIS_FORMAT.bitsPerSample) / 8;
    for (const segment of planSegments(pauses(37.333, 88.777, 150.5), 200 * BYTES_PER_SECOND)) {
      expect(segment.startByte % frame).toBe(0);
      expect(segment.endByte % frame).toBe(0);
    }
  });

  test("an empty recording plans nothing rather than one empty request", () => {
    expect(planSegments([], 0)).toEqual([]);
  });

  test("the real 20-second capture is one segment covering all of it", () => {
    // End to end over the captured fixture, which is the case a reader can check
    // against the numbers in `SILENCE_LOG`.
    const silences = parseSilences(SILENCE_LOG, EXACT_SECONDS);
    const segments = planSegments(silences, REAL_PCM_BYTES);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.cutInSpeech).toBe(false);
  });

  test("the last segment never addresses a byte the file does not have", () => {
    // The twelve-byte bug this API shape exists to prevent: planning from a
    // duration rounded to whole milliseconds put `endByte` at 640,512 for a
    // 640,500-byte file. `readUpload` clamps a window to the stored size, so
    // nothing threw — the plan was simply describing audio that does not exist.
    // Found by running the real argv against a real ffmpeg, which is the only
    // place a twelve-byte error was ever going to surface.
    for (const bytes of [REAL_PCM_BYTES, 32_001, 999_999, 2]) {
      const segments = planSegments(parseSilences(SILENCE_LOG, durationSeconds(bytes)), bytes);
      expect(segments.at(-1)?.endByte ?? 0).toBeLessThanOrEqual(bytes);
    }
  });
});

describe("what the page is told about the recording", () => {
  test("speech is the complement of the pauses", () => {
    // 20 seconds with 8 of pause in it.
    expect(
      Math.round(
        speechFraction(
          [
            { startSec: 3, endSec: 5 },
            { startSec: 8, endSec: 10 },
            { startSec: 13, endSec: 15 },
            { startSec: 18, endSec: 20 },
          ],
          20,
        ) * 100,
      ),
    ).toBe(60);
  });

  test("a recording of pure silence is 0% speech, and one with no pause is 100%", () => {
    expect(speechFraction([{ startSec: 0, endSec: 30 }], 30)).toBe(0);
    expect(speechFraction([], 30)).toBe(1);
  });

  test("a zero-length recording answers 0 rather than dividing by it", () => {
    expect(speechFraction([], 0)).toBe(0);
  });
});

describe("joining the segments", () => {
  /** Two segments whose shared boundary is `cutInSpeech` on the first. */
  function pair(cutInSpeech: boolean) {
    return [
      { index: 0, startByte: 0, endByte: 10, startMs: 0, endMs: 10, cutInSpeech },
      { index: 1, startByte: 10, endByte: 20, startMs: 10, endMs: 20, cutInSpeech: false },
    ];
  }

  test("a cut made in a pause becomes a paragraph break", () => {
    // The plan knows where the turn boundaries are, so the transcript can show
    // them. This is the one place `cutInSpeech` changes an output, not a report.
    expect(
      joinSegments(pair(false), [
        { index: 0, text: "Good morning." },
        { index: 1, text: "Let us begin." },
      ]),
    ).toBe("Good morning.\n\nLet us begin.");
  });

  test("a blind cut is joined with a space, because it landed mid-sentence", () => {
    expect(
      joinSegments(pair(true), [
        { index: 0, text: "the number was" },
        { index: 1, text: "roughly four" },
      ]),
    ).toBe("the number was roughly four");
  });

  test("puts the parts in index order however they arrived", () => {
    // `mapConcurrent` resolves in item order, so this is belt and braces — a merge
    // is where an ordering mistake would be invisible rather than loud.
    expect(
      joinSegments(pair(true), [
        { index: 1, text: "second" },
        { index: 0, text: "first" },
      ]),
    ).toBe("first second");
  });

  test("a segment that transcribed to nothing leaves no stray separator", () => {
    // A stretch that is all room tone comes back empty, and a naive join would
    // leave a leading or doubled break in the transcript.
    expect(
      joinSegments(pair(false), [
        { index: 0, text: "" },
        { index: 1, text: "words" },
      ]),
    ).toBe("words");
  });
});

describe("transcribing one segment", () => {
  /**
   * One second of stored PCM, and a sync endpoint that answers.
   *
   * A published `stepFetch`, not `vi.stubGlobal("fetch", …)`: the step calls
   * `stepFetch`, which reaches a published slot rather than the global. Stubbing
   * the global still passes, because an unpublished slot falls back to it, and
   * would be asserting against a path production does not take.
   */
  function stubProvider(failure?: { status: number; message: string }) {
    installStubUploads({
      [UPLOAD_ID]: {
        bytes: new Uint8Array(BYTES_PER_SECOND),
        name: "call.pcm",
        type: "application/octet-stream",
      },
    });
    installStubReporter();
    // `installStubTranscribe` answers AssemblyAI's own endpoints off the SDK's
    // endpoint constants, so this spec no longer re-types the wire — and a refusal
    // is staged as a STATUS, which is what makes the classification below a test of
    // the SDK's reading of it rather than of a `TranscribeError` a fake minted.
    return installStubTranscribe({
      text: "hello there",
      failure: failure === undefined ? undefined : { leg: "sync", ...failure },
    }).calls;
  }

  const SEGMENT = {
    index: 0,
    startByte: 0,
    endByte: BYTES_PER_SECOND,
    startMs: 0,
    endMs: 1000,
    cutInSpeech: false,
  };

  test("puts a WAV header back on the headerless span before sending it", async () => {
    // The endpoint decodes each request independently, so a slice of raw PCM is
    // meaningless bytes until a header says what they are. `encodeWav` is the SDK's
    // — this template deliberately carries no copy of it.
    const calls = stubProvider();
    await expect(transcribeSegment(UPLOAD_ID, SEGMENT)).resolves.toEqual({
      index: 0,
      text: "hello there",
    });

    // Inside a multipart body, so the header is not at byte zero — what matters is
    // that it is there at all, and immediately followed by `WAVE`.
    const sent = new TextDecoder("latin1").decode(sentBytes(calls[0]?.body));
    expect(sent).toContain("RIFF");
    expect(sent.indexOf("WAVE")).toBe(sent.indexOf("RIFF") + 8);
  });

  test("sends the whole span, header included, and nothing else", async () => {
    const calls = stubProvider();
    await transcribeSegment(UPLOAD_ID, SEGMENT);
    // 44 bytes of canonical header plus one second of audio, inside a multipart
    // body — so the request is strictly larger than the span and close to it.
    const size = sentBytes(calls[0]?.body).byteLength;
    expect(size).toBeGreaterThan(BYTES_PER_SECOND);
    expect(size).toBeLessThan(BYTES_PER_SECOND + 2000);
  });

  test("a rate limit is RETRYABLE, so one busy minute does not fail the run", async () => {
    // The expected failure of a 32-wide fan-out, and the reason the BODY calls
    // this step with more attempts than the default — asserted where the policy
    // now lives, in `the whole run` below.
    stubProvider({ status: 429, message: "slow down" });
    await expect(transcribeSegment(UPLOAD_ID, SEGMENT)).rejects.toBeInstanceOf(RetryableError);
  });

  test("a rejected request is FATAL, so it is not asked five more times", async () => {
    stubProvider({ status: 400, message: "that is not audio" });
    await expect(transcribeSegment(UPLOAD_ID, SEGMENT)).rejects.toBeInstanceOf(FatalError);
  });

  test("the fan-out width is a constant, because the format is", () => {
    // The payoff of normalizing: a segment is at most 3.5 MB whatever was
    // uploaded, so there is no byte budget to divide — see the constant's doc.
    expect(SEGMENT_CONCURRENCY).toBe(32);
    expect(MAX_SEGMENT_SECONDS * BYTES_PER_SECOND * SEGMENT_CONCURRENCY).toBeLessThan(
      640 * 1024 * 1024,
    );
  });
});

describe("auditing the transcript", () => {
  test("asks for a script as well as lists, and keeps both", async () => {
    // The two-summaries decision: a voice reading a bullet list says "one. two.
    // three." with no connective tissue, so the schema demands sentences too.
    installStubReporter();
    // The stub answers with TEXT, because that is what a gateway returns — and
    // `stepGenerateJson` parsing it is part of what this exercises.
    installStubGateway(
      JSON.stringify({
        headline: "Renewal call with Northwind",
        risks: ["Nobody owns the migration date"],
        actions: ["Ana to send revised pricing"],
        spoken: "The renewal is close, but the migration date has no owner yet.",
      }),
    );

    const summary = await summarize("… transcript …", "call.m4a", 600_000);
    expect(summary.headline).toBe("Renewal call with Northwind");
    expect(summary.risks).toEqual(["Nobody owns the migration date"]);
    expect(summary.spoken).toContain("migration date");
  });

  test("an empty risk list is an ANSWER, not a retry", async () => {
    // A schema that demanded a risk would get an invented one, which is worse than
    // silence on a call that really had none.
    installStubReporter();
    installStubGateway(
      JSON.stringify({
        headline: "Weekly standup",
        risks: [],
        actions: [],
        spoken: "Nothing was decided and nothing is blocked.",
      }),
    );
    await expect(summarize("…", "standup.wav", 60_000)).resolves.toMatchObject({ risks: [] });
  });

  test("a reply with no spoken script is a RETRY rather than silence", async () => {
    // `spoken` is required rather than defaulted precisely so this fails: a default
    // would turn a missing field into half a second of audio nobody notices.
    installStubReporter();
    installStubGateway(JSON.stringify({ headline: "A call", risks: [], actions: [] }));
    await expect(summarize("…", "call.m4a", 60_000)).rejects.toThrow();
  });
});

describe("classifying a failure", () => {
  /**
   * The FFMPEG verdict is no longer tested here, and its absence is the change
   * rather than a gap: `throwFfmpegStepError` on `@alexkroman1/aai/step-errors` owns
   * it now, with both arms pinned in `sdk/step-errors.test.ts` — including the case
   * this template contributed, a cause that is not an ffmpeg failure at all.
   *
   * What stays is what is still THIS desk's: `analyse`, which decides that an
   * analysis `media.ts` cannot read is terminal.
   */
  test("an analysis this desk cannot read is fatal, because a retry reads it again", () => {
    // ffmpeg SUCCEEDED and printed something unrecognized — a renamed key, a lost
    // `-loglevel info`. Every retry runs the same binary and prints the same thing.
    expect(() =>
      analyse(() => {
        throw new MediaAnalysisError("no JSON block");
      }),
    ).toThrow(FatalError);
  });

  test("an analysis helper's OTHER failures are not swallowed", () => {
    // Only `MediaAnalysisError` is a verdict. Anything else is a bug in the parser,
    // and turning that into a terminal step failure would hide it.
    const bug = new TypeError("cannot read properties of undefined");
    expect(() =>
      analyse(() => {
        throw bug;
      }),
    ).toThrow(bug);
  });
});

describe("the mastered narration", () => {
  test("is not driven here, and the spec says why rather than pretending", () => {
    // `narrate` speaks, writes a temp file, spawns ffmpeg and stores the result. A
    // unit test may do none of those, so what is covered is `masterArgs` above and
    // the classification below — and `stubSpeech` is imported to make the omission
    // deliberate rather than an oversight: filling only that slot would leave the
    // step failing on the subprocess, which is a test of the tier, not the code.
    expect(typeof stubSpeech).toBe("function");
    expect(masterArgs("in.wav", "out.mp3").at(-1)).toBe("out.mp3");
  });
});

describe("the ffmpeg steps, up to the spawn", () => {
  /**
   * These reach the point where ffmpeg would run and stop there, DETERMINISTICALLY
   * — which is the trick that makes them unit tests rather than scenario tests.
   *
   * `AAI_FFMPEG_PATH` / `AAI_FFPROBE_PATH` name the binary the SDK resolves, so
   * pointing them at a path that does not exist produces `kind: "missing-binary"`
   * on every machine: one where ffmpeg is installed, one where it is not, and CI's
   * Linux leg alike. A test that instead relied on ffmpeg being ABSENT would pass
   * here and behave differently in CI, which is the green-locally/red-in-CI
   * asymmetry this repo is built to avoid.
   *
   * What they cover is everything before the subprocess — reading the upload,
   * materializing it, building the argv — plus the classification of the failure.
   * They also pin the behaviour a developer actually meets: `aai dev` on a laptop
   * with no ffmpeg is the one place dev/prod parity is partial, and it must fail
   * FATALLY with an installable remedy rather than retry four times.
   */
  beforeEach(() => {
    vi.stubEnv("AAI_FFMPEG_PATH", "/nonexistent/aai-test/ffmpeg");
    vi.stubEnv("AAI_FFPROBE_PATH", "/nonexistent/aai-test/ffprobe");
  });

  test("ingestRecording materializes the upload, then fails fatally with no ffprobe", async () => {
    installStubUploads({
      [UPLOAD_ID]: { bytes: new Uint8Array(2048), name: "call.m4a", type: "audio/mp4" },
    });
    installStubReporter();
    // Fatal, not retryable: four more attempts find the same missing binary, and the
    // message already carries the install instructions.
    await expect(ingestRecording(UPLOAD_ID)).rejects.toBeInstanceOf(FatalError);
  });

  test("narrate speaks first, then fails fatally with no ffmpeg to master with", async () => {
    // `stepSpeak` runs — the synthesis is not what is broken here — so this also
    // pins the ORDER: a step that mastered before speaking would fail without ever
    // calling the voice service.
    const speech = installStubSpeech();
    installStubReporter();
    installStubUploads({}, { writable: true });

    await expect(narrate("Read this back.", "jane")).rejects.toBeInstanceOf(FatalError);
    expect(speech.calls.length).toBe(1);
    expect(speech.calls[0]?.text).toBe("Read this back.");
  });

  test("the temp directory is gone even though the mastering pass failed", async () => {
    // The `finally` in `withTempDir`, on the path that matters: a guest's disk is
    // small, and a step that leaked a directory per failed run would fill it.
    const before = await readdir(tmpdir());
    installStubSpeech();
    installStubReporter();
    installStubUploads({}, { writable: true });

    await expect(narrate("Read this back.")).rejects.toBeInstanceOf(FatalError);
    const after = await readdir(tmpdir());
    expect(after.filter((name) => name.startsWith("aai-call-audit-"))).toEqual(
      before.filter((name) => name.startsWith("aai-call-audit-")),
    );
  });
});

describe("the body's step policy", () => {
  /**
   * A `ctx.now` that answers each reach from `samples`, in order.
   *
   * The last value repeats rather than running out: a spec naming two reads
   * should fail on the DURATION if the body grows a third, not on an
   * `undefined` from the fake.
   */
  const clockReads = (...samples: readonly number[]) => {
    let reach = 0;
    return () => samples[Math.min(reach++, samples.length - 1)] ?? 0;
  };

  /**
   * A `ctx` that walks the whole body without running a single step.
   *
   * `runSteps: false` plus one journaled result per step name: no ffmpeg, no
   * provider, no model. Both specs below need the identical skeleton and each
   * only reads `ctx.steps` afterwards, so it is built once.
   */
  const walkedCtx = () =>
    createWorkflowCtx({
      runSteps: false,
      // The body reads the clock at both ends with `ctx.now()`, which the engine
      // journals under `now!0` and `now!1`. A PRODUCER here rather than a fixed
      // number, so the two reaches differ and `elapsedMs` is assertable — based
      // on `WORKFLOW_CTX_NOW`, the instant the fake otherwise freezes at, rather
      // than on a second arbitrary epoch nobody can relate to the first.
      now: clockReads(WORKFLOW_CTX_NOW, WORKFLOW_CTX_NOW + 3000),
      results: {
        ingestRecording: {
          audio: "upl_pcm",
          source: "call.wav",
          codec: "pcm_s16le",
          durationMs: 20_000,
          bytes: 60 * BYTES_PER_SECOND,
          silences: pauses(10, 20, 30),
          loudness: MEASURED,
        },
        transcribeSegment: { index: 0, text: "hello" },
        summarize: { headline: "H", risks: [], actions: [], spoken: "S." },
        narrate: { audio: "upl_wav", durationMs: 500, bytes: 32 },
      },
    });

  test("raises the attempt budget on both steps whose failure is transient I/O", async () => {
    // The retry policy is an argument to `ctx.step` now rather than a
    // `maxRetries` property, so the CALL is the only place it is observable —
    // which is also the honest place for it, since the same function called from
    // two sites may deserve different patience.
    const ctx = walkedCtx();

    await auditFlow({ recording: UPLOAD_ID }, ctx);

    const budgets = new Map(ctx.steps.map((step) => [step.name, step.maxAttempts]));
    // The EXACT number, not `toBeGreaterThan(3)`: the value is a literal in the
    // body and a typo'd `maxAttempts: 4` is exactly what this should catch.
    expect(budgets.get("ingestRecording")).toBe(6);
    expect(budgets.get("transcribeSegment")).toBe(6);
    // The clock and the two model-shaped steps take the default, which is the
    // other half of the claim: a raised budget is a decision about ONE step.
    // Asserted as PRESENT-with-no-budget rather than as `get(…) === undefined`,
    // which a step the body never reached at all would also satisfy.
    for (const name of ["narrate", "summarize"]) {
      expect(budgets.has(name)).toBe(true);
      expect(budgets.get(name)).toBeUndefined();
    }
  });

  test("reads the clock with `ctx.now()` at each end, and subtracts in the body", async () => {
    // Two reaches of one method, keyed `now!0` and `now!1` and journaled
    // separately by the engine. This used to be two NAMED steps over an exported
    // one-line clock read, and the names existed only so a person reading the
    // run's history could tell the ends apart; the affordance journals the read
    // itself. What is left to assert is that the body subtracts two journaled
    // values rather than re-reading a clock, which is what makes a replay report
    // the same elapsed.
    const ctx = walkedCtx();

    const output = await auditFlow({ recording: UPLOAD_ID }, ctx);

    expect(output.elapsedMs).toBe(3000);
    // And the clock is no longer a step, which is the other half of the claim: a
    // name here would mean the migration left one behind.
    expect(ctx.steps.map((step) => step.name)).not.toContain("clockStart");
  });
});

/**
 * `auditFlow` on the real replay engine — as far as this tier can take it.
 *
 * The block above drives the body through `createWorkflowCtx` with
 * `runSteps: false` and a journaled result per step, which is what makes it
 * affordable: `ingestRecording` shells out to the ffmpeg toolchain, which this
 * tier cannot usefully feed — the `ingestRecording` and `narrate` specs above
 * assert the `FatalError` that produces, unconditionally.
 *
 * **The run fails here whether or not ffmpeg is installed, and the two failures
 * do not say the same thing** — which is what the assertion below has to be
 * written against. With no binary on `PATH` the step reports the missing
 * toolchain as an instruction (the template's own doc promises that rather than
 * `spawn ffmpeg ENOENT`); WITH one, the step gets a step further and `ffprobe`
 * rejects the 2 KB stub above with `ffprobe exited with code 1`. This docblock
 * used to state "this repo's test environment has none" as a premise, and the
 * spec below matched `/ffmpeg/i` on the strength of it — so the test passed only
 * on a machine where ffmpeg was ABSENT, and a developer with Homebrew's ffmpeg
 * saw a red suite on a clean checkout of `main`. CI has no ffmpeg, so nothing
 * caught it.
 *
 * So a whole run of this desk is not reachable here and this file does not
 * pretend otherwise; `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier
 * with a built project. What IS reachable, and what nothing else asserts, is the
 * ENGINE's half of the fatal/retryable contract: a step that throws a
 * `FatalError` must fail its run on the first attempt rather than spending the
 * six this body asks for. The step specs above assert the class; only a real
 * engine can assert what the class is FOR.
 */
describe("the run is DURABLE, as far as ffmpeg allows", () => {
  beforeEach(() => {
    installStubUploads({
      [UPLOAD_ID]: { bytes: new Uint8Array(2048), name: "call.m4a", type: "audio/mp4" },
    });
    installStubReporter();
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
    // Neither binary is this block's subject (see its doc), and a real
    // conversion here would make a developer with ffmpeg installed run a
    // slower, different test from CI, which has none.
    vi.stubEnv("AAI_FFMPEG_PATH", "/nonexistent/ffmpeg");
    vi.stubEnv("AAI_FFPROBE_PATH", "/nonexistent/ffprobe");
  });

  test("a FatalError in the first step fails the run on ONE attempt, not six", async () => {
    const run = await runWorkflow(audit, { recording: UPLOAD_ID }, { name: "audit" });

    expect(run.status).toBe("failed");
    // Either member of the toolchain, for the reason this block's doc gives: the
    // step names `ffmpeg` when the binary is missing and `ffprobe` when it is
    // present, and this spec is about neither. What it is about is the two
    // assertions below — the ENGINE honouring `FatalError`.
    expect(run.error).toMatch(/ff(mpeg|probe)/i);
    const ingest = run.steps.find((step) => step.name === "ingestRecording");
    // The whole point of `FatalError`: `maxAttempts: 6` is the budget this call
    // site asks for, and a failure that cannot change must not spend it. A step
    // that burned all six here would delay the real error by minutes in
    // production and cost five more conversions of a file that is not going to
    // convert.
    expect(ingest?.status).toBe("failed");
    expect(ingest?.attempts).toBe(1);
  });

  test("the failure is DURABLE: a redelivery reports it rather than trying again", async () => {
    const run = await runWorkflow(audit, { recording: UPLOAD_ID }, { name: "audit" });
    expect(run.status).toBe("failed");

    // A terminal run is done, and a redelivery of one is ordinary rather than an
    // error — the platform's queue acks on a 200, so any delivery whose ack was
    // lost arrives again after the run finished.
    await run.restart();
    expect(run.status).toBe("failed");
    expect(run.steps.filter((step) => step.name === "ingestRecording")).toHaveLength(1);
    expect(run.deliveries).toBe(2);
  });

  test("the clock is journaled BEFORE the step that fails, so the run's start survives", async () => {
    // `ctx.now()` and the ingest are issued together in one `Promise.all`, so a
    // failing ingest must not lose the clock read that went out beside it. It is
    // journaled through the same append a step is, into a key space of its own —
    // which is why it reads back off `reads` rather than `steps`.
    const run = await runWorkflow(audit, { recording: UPLOAD_ID }, { name: "audit" });

    const clock = run.reads.find((read) => read.key === "now!0");
    expect(clock?.kind).toBe("now");
    expect(typeof clock?.value).toBe("number");
  });
});
