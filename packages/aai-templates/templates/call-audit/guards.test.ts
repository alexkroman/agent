// Copyright 2026 the AAI authors. MIT license.
/**
 * The three things this desk REFUSES, and what it reports while it works.
 *
 * `agent.test.ts` covers what the desk decides — every ffmpeg argv, both
 * analysis parsers, and where `planSegments` cuts. This file covers the checks
 * standing in front of those decisions, and they are together because they share
 * one property: **each one turns a plausible wrong ANSWER into a loud failure.**
 * That is the failure shape this template's own module docs keep returning to —
 * a truncated upload levelled as though it were the whole call, a plan
 * describing audio past the end of a file, a video with no soundtrack decoded at
 * length before ffmpeg complains about a filter graph. None of them throws on
 * its own; every one of them produces a transcript that reads as complete.
 *
 * They are also the seam where a template is at its most tempting to hand-roll,
 * so what each spec really pins is that the SDK's own verdict is READ rather
 * than re-derived: `stepRequireCompleteUpload` already decided that a
 * still-arriving upload is terminal, and `throwStepError` is the line that makes
 * the engine act on it.
 *
 * Its own file rather than more of `agent.test.ts`, which is already the longest
 * spec in `templates/` — the split is by subject, and `health-assistant` and
 * `pipeline-simple` each carry a second spec for the same reason. It sits
 * beside `agent.ts` rather than under `workflows/` because the package's vitest
 * `include` reaches one level into `templates/`, so a spec any deeper would
 * never run.
 */

import type { MediaInfo } from "@alexkroman1/aai/ffmpeg";
import type { StepInfo, UploadSlice } from "@alexkroman1/aai/step";
import { FatalError } from "@alexkroman1/aai/step-errors";
import { installStubReporter, installStubUploads } from "@alexkroman1/aai/testing/vitest";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  attemptSuffix,
  segmentShortfall,
  segmentWindow,
  transcribeSegment,
} from "./workflows/audit.ts";
import { ingestRecording } from "./workflows/ingest.ts";
import {
  BYTES_PER_SECOND,
  MediaAnalysisError,
  requireAudioStream,
  TEMP_DIR,
  totalFfmpegMs,
} from "./workflows/media.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/** One segment of the plan: the first second of the stored PCM. */
const SEGMENT = {
  index: 0,
  startByte: 0,
  endByte: BYTES_PER_SECOND,
  startMs: 0,
  endMs: 1000,
  cutInSpeech: false,
};

/** What `stepReadUpload` answers, with only the field the check reads. */
function slice(byteLength: number): Pick<UploadSlice, "bytes"> {
  return { bytes: new Uint8Array(byteLength) };
}

/** What ffprobe made of a file, as `probeMedia` reports it. */
function probed(...kinds: string[]): MediaInfo {
  const streams = kinds.map((kind, index) => ({ index, kind, codec: `${kind}-codec` }));
  const audio = streams.find((stream) => stream.kind === "audio");
  // Spread rather than `audio: …`: the repo compiles with
  // `exactOptionalPropertyTypes`, so an OPTIONAL property may be absent but may
  // not be present-and-undefined — which is exactly the shape `probeMedia`
  // returns for a file with no audio track.
  return { format: "mov,mp4,m4a", streams, ...(audio === undefined ? {} : { audio }), raw: {} };
}

beforeEach(() => {
  vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
});

describe("an upload that is still arriving", () => {
  test("fails the run TERMINALLY rather than re-asking six times", async () => {
    // `UploadInfo.size` is the readable PREFIX, so a run started before the bytes
    // are in would level part of a call and report success. The SDK already
    // refuses that and already carries the verdict (`retryable: false`) — but a
    // carried verdict is only read where a caller asks, and this call site sets
    // `maxAttempts: 6`. Without `.catch(throwStepError)` in `ingest.ts` the engine
    // would spend all six inside a millisecond on bytes that arrive on their own
    // schedule.
    installStubUploads({
      [UPLOAD_ID]: { bytes: new Uint8Array(2048), name: "call.m4a", complete: false },
    });
    installStubReporter();

    await expect(ingestRecording(UPLOAD_ID)).rejects.toBeInstanceOf(FatalError);
  });

  test("keeps the SDK's own sentence, which is the one naming the remedy", async () => {
    // `throwStepError` replaces no message, deliberately: what the caller has
    // otherwise is "the step failed", where the SDK's refusal says how many bytes
    // landed and what to do about it.
    installStubUploads({
      [UPLOAD_ID]: { bytes: new Uint8Array(2048), name: "call.m4a", complete: false },
    });
    installStubReporter();

    await expect(ingestRecording(UPLOAD_ID)).rejects.toThrow(/still arriving/);
  });
});

describe("a file with no audio track", () => {
  test("is refused, and the complaint names what ffprobe DID find", () => {
    // The one file the form's "anything ffmpeg can read" honestly admits and this
    // desk cannot use. Naming the streams is what tells somebody they uploaded
    // the silent screen recording rather than the meeting.
    expect(() => requireAudioStream(probed("video"))).toThrow(MediaAnalysisError);
    expect(() => requireAudioStream(probed("video"))).toThrow(/no audio track/);
    expect(() => requireAudioStream(probed("video", "subtitle"))).toThrow(/video, subtitle/);
  });

  test("a file ffprobe found nothing in at all still gets a sentence", () => {
    // `streams: []` is what a PDF dragged into the picker looks like, and
    // `found.join(", ")` on an empty list would have produced "ffprobe found .".
    expect(() => requireAudioStream(probed())).toThrow(/no streams at all/);
  });

  test("a recording WITH sound passes the track through, codec and all", () => {
    // The happy path is the other half of the claim: the codec now comes off the
    // track rather than off an optional chain, so `unknown` means "ffprobe named
    // no codec" and no longer doubles as "there was nothing to name".
    expect(requireAudioStream(probed("video", "audio")).codec).toBe("audio-codec");
  });
});

describe("a stored file smaller than the plan", () => {
  test("a whole window is no shortfall", () => {
    expect(segmentShortfall(SEGMENT, slice(BYTES_PER_SECOND))).toBe(0);
  });

  test("a CLAMPED read is counted, because nothing else would notice it", () => {
    // The twelve-byte bug `durationSeconds` documents, as a number: the store
    // clamps a window to what it holds, so a plan describing audio past the end of
    // the file produced a short slice, a shorter WAV, and a transcript missing its
    // tail with nothing anywhere saying so.
    expect(segmentShortfall(SEGMENT, slice(BYTES_PER_SECOND - 12))).toBe(12);
  });

  test("a read LONGER than asked for is not a negative shortfall", () => {
    // Cannot happen through the store, and clamping at zero is what keeps the
    // caller's `> 0` test honest if it ever did.
    expect(segmentShortfall(SEGMENT, slice(BYTES_PER_SECOND + 12))).toBe(0);
  });

  test("the STEP refuses rather than transcribing a hole", async () => {
    // The check driven where it lives: the store holds one second of PCM and the
    // plan asks for one second and twelve bytes, exactly as the rounding bug
    // produced. `stepReadUpload` clamps, so nothing throws on its own — the run
    // used to transcribe the short slice and report success.
    installStubUploads({
      [UPLOAD_ID]: {
        bytes: new Uint8Array(BYTES_PER_SECOND),
        name: "call.pcm",
        type: "application/octet-stream",
      },
    });
    installStubReporter();
    // No transcription stub, which is the other half of the claim: the step must
    // fail BEFORE it spends a request on audio it knows is incomplete.
    const overrun = { ...SEGMENT, endByte: BYTES_PER_SECOND + 12 };

    await expect(transcribeSegment(UPLOAD_ID, overrun)).rejects.toBeInstanceOf(FatalError);
    await expect(transcribeSegment(UPLOAD_ID, overrun)).rejects.toThrow(/12 byte\(s\) short/);
  });

  test("the window is the plan's own half-open pair, unmodified", () => {
    // A rename rather than arithmetic: the store owns the conversion to HTTP's
    // inclusive range, so a `- 1` here would silently drop the last sample frame
    // of every segment.
    expect(segmentWindow(SEGMENT)).toEqual({ start: 0, end: BYTES_PER_SECOND });
  });
});

describe("what the run reports about ffmpeg itself", () => {
  test("sums the passes and rounds, because a page renders it", () => {
    // `runFfmpeg` measures with `performance.now()`, so each duration is a float
    // and a page would otherwise print 1502.3999999999999 ms.
    expect(totalFfmpegMs({ durationMs: 1200.4 }, { durationMs: 301.9 })).toBe(1502);
  });

  test("no passes is zero rather than NaN", () => {
    expect(totalFfmpegMs()).toBe(0);
  });

  test("both steps materialize under ONE prefix, which is what the leak spec matches", () => {
    // Two files write temp directories — the ingest and the narration — and each
    // used to name the prefix itself. The spec proving nothing leaks matches
    // directories by this string, so a rename in one file would have left the
    // other's leaks unwatched while the test still passed.
    expect(TEMP_DIR.prefix).toBe("aai-call-audit-");
  });
});

describe("the progress line while a fan-out is retrying", () => {
  /** `stepInfo()`'s answer, as the engine publishes it mid-attempt. */
  const attempt = (n: number): StepInfo => ({
    name: "transcribeSegment",
    key: `transcribeSegment!${n}`,
    attempt: n,
    maxAttempts: 6,
    isLastAttempt: n === 6,
  });

  test("says nothing on a first attempt, so an ordinary run reads as it did", () => {
    // The eval pins the whole line — `Transcribing 0:00–1:01.` — so a suffix that
    // appeared on attempt one would be a change to the desk's narration rather
    // than an addition to it.
    expect(attemptSuffix(attempt(1))).toBe("");
  });

  test("names the attempt and the budget once it is really retrying", () => {
    // A thirty-segment fan-out riding out a 429 otherwise re-prints the line it
    // already printed, which looks exactly like a run that has stalled.
    expect(attemptSuffix(attempt(3))).toBe(" (attempt 3 of 6)");
  });

  test("outside a step is ORDINARY and reads as `not retrying`", () => {
    // `stepInfo()` answers `undefined` in a body, in a tool, and in a spec driving
    // the step directly — which is what the first attempt would have said anyway.
    expect(attemptSuffix(undefined)).toBe("");
  });
});
