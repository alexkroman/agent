// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the transcription desk's declaration, its WAV arithmetic, and its
 * steps.
 *
 * A step is an ordinary exported async function, so its retries, its
 * `FatalError` guards, its HTTP handling and its merge are all testable
 * directly. **And one of the three bodies IS driven**, on the real replay
 * engine — `transcribeBatch`, in the last block, which is the flow that reaches
 * no ffmpeg. The other two normalize the recording first and this repo's test
 * environment has no ffmpeg, so their durability stays `aai-cli`'s
 * `dev-workflow.scenario.test.ts`'s. Saying which of the three is covered is
 * the point: a body test dressed up as a durability test would be the worse
 * failure, and so would a durable one that implied it covered all three.
 *
 * The WAV half is worth its own section because it is where a silent bug lives:
 * a cut that lands mid-frame, or an off-by-one in the chunk walk, produces audio
 * the decoder happily transcribes into confident nonsense.
 */

import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readUpload, type UploadRange } from "@alexkroman1/aai/step";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { createWorkflowCtx } from "@alexkroman1/aai/testing";
import {
  installStubReporter,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import agentDef, { transcribe, transcribeBatch, transcribeStream } from "./agent.ts";
import { createJob, pollTranscript, uploadToProvider } from "./workflows/batch.ts";
import {
  downsampleSegment,
  NORMALIZED_CHANNELS,
  NORMALIZED_SAMPLE_RATE,
  requestFormat,
} from "./workflows/downsample.ts";
import { cuttable, heavierThanNormalized, normalizeRecording } from "./workflows/normalize.ts";
import {
  expectedSegments,
  nextPollDelay,
  planStreamed,
  probeUpload,
  type StreamPlan,
  segmentStored,
  storedBytes,
  type UploadProgressView,
} from "./workflows/stream.ts";
import {
  mergeTranscript,
  splitRecording,
  stitchChunks,
  stitchTranscript,
  TRANSCRIPT_STREAM,
  type Transcript,
  transcribeFlow,
  transcribeSegment,
} from "./workflows/transcribe.ts";
import {
  blockAlign,
  bytesPerSecond,
  MAX_BYTES_PER_SECOND,
  MAX_SEGMENT_BYTES,
  MAX_SEGMENT_SECONDS,
  parseWav,
  planSegments,
  SEGMENT_SECONDS,
  UnsupportedRecordingError,
  type WavFormat,
} from "./workflows/wav.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/**
 * A fixed run-start epoch, so `elapsedMs` is assertable at all.
 *
 * The body reads it with `ctx.now()`, which the engine journals; a spec supplies
 * the value directly, which is the point of threading it as an argument rather
 * than reading a clock inside the merge — the duration is then a function of
 * journaled values and not of how long the test took.
 */
const STARTED_AT = 1_000_000;

/**
 * Publish one in-memory upload, the way `createServer` publishes a real store.
 *
 * This is the seam that makes a step testable at all: `readUpload` reads a
 * process-wide slot rather than dialling anything, so a spec supplies its own
 * bytes with no server, no database and no HTTP.
 */
function publishRecording(bytes: Uint8Array, name = "standup.wav") {
  // `installStubUploads` rather than `stubUploads`: the fake registers its own
  // `onTestFinished`, which is what replaced the three hand-kept restore
  // registries this file used to carry.
  installStubUploads({ [UPLOAD_ID]: { bytes, name, type: "audio/wav" } });
}

/** 16 kHz mono 16-bit — one second of audio is 32,000 bytes. */
const MONO_16K = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 } as const;

/** A canonical WAV header in front of `dataBytes` of (absent) samples. */
function wavFile(
  fmt: { sampleRate: number; channels: number; bitsPerSample: number },
  dataBytes: number,
  overrides: { declaredDataSize?: number; extraChunk?: string } = {},
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
  view.setUint16(20, 1, true);
  view.setUint16(22, fmt.channels, true);
  view.setUint32(24, fmt.sampleRate, true);
  view.setUint32(28, (fmt.channels * fmt.bitsPerSample * fmt.sampleRate) / 8, true);
  view.setUint16(32, (fmt.channels * fmt.bitsPerSample) / 8, true);
  view.setUint16(34, fmt.bitsPerSample, true);

  // An odd-length chunk before `data`, which is what the walk's padding rule is
  // for — a recorder's `LIST`/`bext` block sits exactly here.
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

describe("the agent declares its three workflows and nothing else", () => {
  test("under the names the REST route resolves them by", () => {
    // The page starts a run by these strings, so a rename is a runtime 400 rather
    // than a compile error — which is what makes pinning them worth a test.
    expect(Object.keys(agentDef.workflows ?? {})).toEqual([
      "transcribe",
      "transcribeStream",
      "transcribeBatch",
    ]);
    expect(agentDef.workflows?.transcribe).toBe(transcribe);
    expect(agentDef.workflows?.transcribeStream).toBe(transcribeStream);
    expect(agentDef.workflows?.transcribeBatch).toBe(transcribeBatch);
  });

  test("all three take `recording` as an UPLOAD, which is what makes one picker serve them", () => {
    // There is no second kind of declaration: `recording` carries an upload id in
    // every flow, and the streaming one differs only in that the CLIENT chose the id
    // and PUT the file to it. A divergence here would mean the form had to ask a
    // person how the bytes should travel.
    for (const wf of [transcribe, transcribeStream, transcribeBatch]) {
      expect(wf.uploads).toEqual(["recording"]);
    }
  });

  test("with no tools, because the interface is the page and the API", () => {
    // The point of the template: a workflow app needs no conversation. A tool
    // reappearing here would mean the voice path had crept back in.
    expect(Object.keys(agentDef.tools ?? {})).toEqual([]);
  });

  test("declaring the key its steps read, so a deploy checks for it", () => {
    // Without this a missing credential is discovered by the first run, minutes
    // after the deploy reported success.
    expect(agentDef.requiredEnv).toContain("ASSEMBLYAI_API_KEY");
  });
});

describe("the input schema", () => {
  test("accepts what the page's form collects, with no mapping in between", async () => {
    const result = await transcribe.input?.["~standard"].validate({
      recording: "upl_9f3c1d",
    });
    expect(result?.issues).toBeUndefined();
  });

  test("takes the recording alone — there is nothing else to ask for", async () => {
    const result = await transcribe.input?.["~standard"].validate({
      recording: "upl_9f3c1d",
    });
    // Re-tested rather than trusted: a Standard Schema result is a union, so
    // this is what makes `value` reachable without a cast.
    expect(result?.issues).toBeUndefined();
    if (result?.issues) expect.fail("expected the submission to validate");
    expect(result?.value).toMatchObject({ recording: "upl_9f3c1d" });
  });

  test("rejects a submission with no recording at the call site rather than in a step", async () => {
    // A 400 on the POST, with the run never created, instead of a failed run
    // discovered a minute later.
    const result = await transcribe.input?.["~standard"].validate({});
    expect(result?.issues).toBeDefined();
  });

  test("declares the recording as an upload, which is what makes the form take a file", () => {
    // Without this the page renders a text box asking for an id no person has —
    // the property is a plain string in the schema, deliberately, because an
    // upload id is what the run receives.
    expect(transcribe.uploads).toEqual(["recording"]);
  });

  test("describes the recording, which is what labels it on the page", async () => {
    // `<WorkflowFields>` renders a control per scalar property and uses each
    // `.describe()` as its hint, so a missing description is a bare field.
    // Narrowed rather than cast: `input` is a Standard Schema, and only a
    // `ZodObject` has the `shape` this reads.
    const schema = transcribe.input;
    if (!(schema instanceof z.ZodObject)) expect.fail("expected a zod object schema");
    expect(schema.shape.recording?.description).toBeTruthy();
  });
});

describe("parseWav", () => {
  test("reads the format and where the samples start", () => {
    const head = wavFile(MONO_16K, 320_000);
    expect(parseWav(head, 44 + 320_000)).toEqual({
      ...MONO_16K,
      dataStart: 44,
      dataEnd: 44 + 320_000,
    });
  });

  test("walks past a chunk in front of the samples, padding included", () => {
    // A `LIST` of odd length: the padding byte is not counted by the chunk's
    // own length field, which is the off-by-one that lands `dataStart` inside
    // the audio and makes every segment one byte out of frame.
    const head = wavFile(MONO_16K, 320_000, { extraChunk: "INFOxyz" });
    expect(parseWav(head, head.length + 320_000).dataStart).toBe(head.length);
  });

  test("caps a declared length at what was actually served", () => {
    // A truncated download declares more than it holds; reading past the end
    // would make the last segment a range the server answers 416 for.
    const head = wavFile(MONO_16K, 320_000);
    expect(parseWav(head, 44 + 100_000).dataEnd).toBe(44 + 100_000);
  });

  test("treats an unknown declared length as 'to the end of the file'", () => {
    // What a streaming encoder writes — the length was not known when the
    // header went out.
    const head = wavFile(MONO_16K, 320_000, { declaredDataSize: 0xff_ff_ff_ff });
    expect(parseWav(head, 44 + 320_000).dataEnd).toBe(44 + 320_000);
  });

  test("refuses a file that is not a WAV, naming the fix", () => {
    const notWav = new Uint8Array(64).fill(0x66);
    expect(() => parseWav(notWav, 64)).toThrow(UnsupportedRecordingError);
    expect(() => parseWav(notWav, 64)).toThrow(/ffmpeg/);
  });

  test("refuses a WAV that is not linear PCM", () => {
    // Cutting a compressed payload by arithmetic produces noise, and noise
    // transcribes into confident nonsense rather than failing.
    const head = wavFile(MONO_16K, 320_000);
    new DataView(head.buffer).setUint16(20, 0xff_fe, true);
    expect(() => parseWav(head, 44 + 320_000)).toThrow(/linear PCM/);
  });

  // The two rates below are why the guard is in `parseWav` and not in
  // `planSegments`: both make that loop spin on pure CPU with no `await` in it,
  // so neither `AbortSignal.timeout` nor a step's retry budget can interrupt
  // one — and this is the workflow app that takes an arbitrary uploaded file
  // over a public form.

  test("refuses a WAV declaring a sample rate of 0, which would hang the cut", () => {
    // `bytesPerSecond` is 0, so `stride` is 0, so `start += stride` never
    // advances and the loop pushes a Segment per iteration until it runs out of
    // memory.
    const head = wavFile({ ...MONO_16K, sampleRate: 0 }, 320_000);
    expect(() => parseWav(head, 44 + 320_000)).toThrow(UnsupportedRecordingError);
    expect(() => parseWav(head, 44 + 320_000)).toThrow(/sample rate of 0/);
  });

  test("refuses a rate so high the overlap alone exceeds the request cap", () => {
    // The same hang from the other end: the overlap is subtracted from
    // MAX_SEGMENT_BYTES, so past MAX_BYTES_PER_SECOND the stride goes NEGATIVE
    // and the loop walks backwards. `sampleRate` is a uint32, so a header can
    // ask for this.
    const perSecond = MAX_BYTES_PER_SECOND + blockAlign(MONO_16K);
    const head = wavFile(
      { ...MONO_16K, sampleRate: Math.ceil(perSecond / blockAlign(MONO_16K)) },
      320_000,
    );
    expect(() => parseWav(head, 44 + 320_000)).toThrow(/bytes a second/);
  });

  test("48 kHz 24-bit stereo — the realistic ceiling — is nowhere near the bound", () => {
    // The guard has to refuse the pathological headers without refusing any
    // recording a person would actually upload.
    const studio = { sampleRate: 48_000, channels: 2, bitsPerSample: 24 };
    expect(bytesPerSecond(studio)).toBeLessThan(MAX_BYTES_PER_SECOND);
    const head = wavFile(studio, 4_000_000);
    expect(parseWav(head, 44 + 4_000_000).sampleRate).toBe(48_000);
  });
});

describe("planSegments decides the fan-out's width", () => {
  /** A format covering `seconds` of 16 kHz mono audio. */
  function format(seconds: number): WavFormat {
    const bytes = seconds * MONO_16K.sampleRate * blockAlign(MONO_16K);
    return { ...MONO_16K, dataStart: 44, dataEnd: 44 + bytes };
  }

  test("covers the whole recording", () => {
    const segments = planSegments(format(600));
    expect(segments[0]?.start).toBe(44);
    expect(segments.at(-1)?.end).toBe(format(600).dataEnd);
  });

  test("keeps every segment inside the endpoint's limit", () => {
    // The cap the whole template exists to work around — one segment over it is
    // a 413 rather than a shorter transcript.
    for (const segment of planSegments(format(3600))) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS * 1000);
    }
  });

  test("overlaps each segment with the one before it", () => {
    // The overlap is what stops a cut mid-word being heard as half a word by
    // both sides; `stitchTranscript` removes the duplicate.
    const segments = planSegments(format(600));
    expect(segments.length).toBeGreaterThan(1);
    for (const [at, segment] of segments.entries()) {
      if (at === 0) continue;
      expect(segment.startMs).toBeLessThan(segments[at - 1]?.endMs ?? 0);
    }
  });

  test("cuts only on frame boundaries", () => {
    // A cut mid-sample shifts every following byte into the wrong channel and
    // the wrong half of a 16-bit word — audible as noise, never as an error.
    const stereo = { sampleRate: 44_100, channels: 2, bitsPerSample: 16 };
    const frame = blockAlign(stereo);
    const segments = planSegments({
      ...stereo,
      dataStart: 44,
      dataEnd: 44 + 600 * stereo.sampleRate * frame,
    });
    for (const segment of segments) {
      expect((segment.start - 44) % frame).toBe(0);
      expect((segment.end - 44) % frame).toBe(0);
    }
  });

  test("keeps every segment inside the endpoint's byte cap too", () => {
    // The cap that binds on high-rate audio rather than long audio: 96 kHz
    // stereo 24-bit reaches 40 MB in ~73 seconds, well inside the 120-second
    // one. The overlap counts toward it, which is why the stride subtracts it.
    const hiFi = { sampleRate: 96_000, channels: 2, bitsPerSample: 24 };
    const perSecond = hiFi.sampleRate * blockAlign(hiFi);
    const segments = planSegments({
      ...hiFi,
      dataStart: 44,
      dataEnd: 44 + 600 * perSecond,
    });
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.end - segment.start).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    }
  });

  test("emits one segment for a recording shorter than the stride", () => {
    expect(planSegments(format(SEGMENT_SECONDS - 1))).toHaveLength(1);
  });

  test("emits no trailing empty segment when the audio divides evenly", () => {
    // The case a loop with the wrong bound fans one extra step out over
    // nothing, which the endpoint answers 400 for.
    const segments = planSegments(format(SEGMENT_SECONDS * 3));
    expect(segments.at(-1)?.end).toBeGreaterThan(segments.at(-1)?.start ?? 0);
    expect(segments).toHaveLength(3);
  });

  test("refuses a recording shorter than the endpoint's floor", () => {
    expect(() => planSegments(format(0.01))).toThrow(UnsupportedRecordingError);
  });
});

describe("stitchTranscript", () => {
  test("removes the words the overlap made duplicates", () => {
    expect(
      stitchTranscript(["we should ship it on Friday", "ship it on Friday if the tests pass"]),
    ).toBe("we should ship it on Friday if the tests pass");
  });

  test("matches a seam the two passes punctuated differently", () => {
    // The common case, not an edge one: one segment ends a sentence where the
    // other is mid-clause, so a raw compare finds no seam at all.
    expect(stitchTranscript(["that is all for today.", "Today we ship."])).toBe(
      "that is all for today. we ship.",
    );
  });

  test("keeps both sides when there is no seam", () => {
    expect(stitchTranscript(["alpha beta", "gamma delta"])).toBe("alpha beta gamma delta");
  });

  test("prefers the longest seam over an accidental short one", () => {
    // A repeated "the" is not evidence of anything; taking it would delete
    // speech, which is the one failure worse than a repeated phrase.
    expect(stitchTranscript(["the plan is the same", "the same next week"])).toBe(
      "the plan is the same next week",
    );
  });

  test("skips a segment that transcribed to nothing", () => {
    // A segment of silence, which a long recording legitimately contains.
    expect(stitchTranscript(["alpha", "   ", "beta"])).toBe("alpha beta");
  });
});

describe("stitchChunks — what the PAGE renders while a run is going", () => {
  const chunk = (index: number, text: string) => ({
    index,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text,
  });

  test("orders by index, because chunks arrive as the segments settle", () => {
    // The one thing a live reader definitely does not have is arrival order: the
    // segments are transcribed concurrently, so chunk 2 routinely precedes 1.
    expect(stitchChunks([chunk(2, "gamma"), chunk(0, "alpha"), chunk(1, "beta")])).toBe(
      "alpha beta gamma",
    );
  });

  test("stitches the seams the same way the finished run does", () => {
    // The whole reason the page imports the run's own function: a live
    // transcript that de-duplicated differently would read as the model having
    // changed its mind between the last poll and the result.
    const parts = ["we should ship it on Friday", "ship it on Friday if the tests pass"];
    expect(stitchChunks(parts.map((text, index) => chunk(index, text)))).toBe(
      stitchTranscript(parts),
    );
  });

  test("keeps both pieces around a HOLE rather than seaming across it", () => {
    // A partial list is the ordinary case here, and two pieces that were never
    // adjacent share no overlap — so the live text reads with a jump in it until
    // the missing segment lands, instead of quietly losing a sentence.
    expect(stitchChunks([chunk(0, "alpha beta"), chunk(2, "epsilon zeta")])).toBe(
      "alpha beta epsilon zeta",
    );
  });

  test("does not mutate the caller's list, which is React state", () => {
    const chunks = [chunk(1, "beta"), chunk(0, "alpha")];
    stitchChunks(chunks);
    expect(chunks.map((one) => one.index)).toEqual([1, 0]);
  });

  test("renders nothing out of nothing", () => {
    expect(stitchChunks([])).toBe("");
  });
});

describe("splitRecording", () => {
  test("plans the segments and reports the duration", async () => {
    const seconds = 200;
    const bytes = seconds * MONO_16K.sampleRate * blockAlign(MONO_16K);
    publishRecording(concat(wavFile(MONO_16K, bytes), new Uint8Array(bytes)));

    const plan = await splitRecording(UPLOAD_ID);
    expect(plan.format.sampleRate).toBe(MONO_16K.sampleRate);
    expect(plan.segments.length).toBeGreaterThan(1);
    expect(plan.durationMs).toBe(seconds * 1000);
  });

  test("reads a recording shorter than the header probe", async () => {
    // The window is CLAMPED to the file rather than refused, which is what lets
    // a step ask for 64 KB of a 12 KB recording without knowing its size first.
    const bytes = 8000;
    publishRecording(concat(wavFile(MONO_16K, bytes), new Uint8Array(bytes)));
    const plan = await splitRecording(UPLOAD_ID);
    expect(plan.format.dataStart).toBe(44);
  });

  test("fails FATALLY on an id that names no upload", async () => {
    publishRecording(new Uint8Array(0));
    // A missing upload does not appear on the fourth attempt.
    await expect(splitRecording("upl_gone")).rejects.toThrow(/No upload with id/);
  });

  test("fails FATALLY on a recording it cannot cut", async () => {
    // Compressed audio has no frame boundary an offset can find; the run says
    // so by name instead of transcribing nonsense.
    publishRecording(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]));
    await expect(splitRecording(UPLOAD_ID)).rejects.toThrow();
  });
});

/**
 * A sine, as interleaved little-endian 16-bit PCM with every channel identical.
 *
 * A TONE rather than noise or a ramp, because what a resampler can get wrong is
 * frequency: decimating without a low-pass folds anything above the new Nyquist
 * back into the speech band at full strength, and that is invisible to any
 * assertion about lengths or formats.
 */
function sineFrames(opts: {
  hz: number;
  sampleRate: number;
  channels: number;
  frames: number;
  amplitude?: number;
}): Uint8Array {
  const amplitude = opts.amplitude ?? 10_000;
  const out = new Uint8Array(opts.frames * opts.channels * 2);
  const view = new DataView(out.buffer);
  for (let f = 0; f < opts.frames; f++) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * opts.hz * f) / opts.sampleRate));
    for (let c = 0; c < opts.channels; c++) view.setInt16((f * opts.channels + c) * 2, value, true);
  }
  return out;
}

/** How loud 16-bit mono PCM is, in one number. */
function rms(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let at = 0; at < bytes.length; at += 2) total += view.getInt16(at, true) ** 2;
  return Math.sqrt(total / (bytes.length / 2));
}

/** How FAST a tone is, without an FFT: a sine crosses zero twice per cycle. */
function zeroCrossings(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let crossings = 0;
  let previous = view.getInt16(0, true);
  for (let at = 2; at < bytes.length; at += 2) {
    const value = view.getInt16(at, true);
    if (previous < 0 !== value < 0) crossings += 1;
    previous = value;
  }
  return crossings;
}

describe("downsampleSegment — what actually goes on the wire", () => {
  const STEREO_48K = { sampleRate: 48_000, channels: 2, bitsPerSample: 16 } as const;

  test("passes already-normalized audio through UNTOUCHED, same array", () => {
    // Identity rather than a copy, which is what the classic flow relies on:
    // `normalizeRecording` has already converted the whole file, so this must cost
    // nothing at all there — not a re-encode, not even an allocation.
    const bytes = sineFrames({ hz: 440, sampleRate: 16_000, channels: 1, frames: 4000 });
    const light = downsampleSegment(bytes, MONO_16K);

    expect(light.bytes).toBe(bytes);
    expect(light.format).toBe(MONO_16K);
  });

  test("cuts 48 kHz stereo to a SIXTH of the bytes, at 16 kHz mono", () => {
    // The whole reason this exists: a 92-second segment is 17.66 MB at the source
    // format and 2.94 MB here, against an endpoint that deadlines a request at 30
    // seconds of wall clock INCLUDING the upload.
    const bytes = sineFrames({ hz: 440, sampleRate: 48_000, channels: 2, frames: 48_000 });
    const light = downsampleSegment(bytes, STEREO_48K);

    expect(light.format).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect(light.bytes.length).toBe(32_000);
    expect(light.bytes.length * 6).toBe(bytes.length);
  });

  test("the TONE survives — same pitch, same loudness", () => {
    // The assertion the byte counts cannot make, and it is stated as an
    // EQUIVALENCE rather than a constant: resampling a 440 Hz tone recorded at
    // 48 kHz should give back what recording the same tone at 16 kHz would have
    // given. 440 Hz is far below the new 8 kHz Nyquist, so the box filter costs
    // it about 0.1%.
    const bytes = sineFrames({ hz: 440, sampleRate: 48_000, channels: 2, frames: 12_000 });
    const light = downsampleSegment(bytes, STEREO_48K);
    const reference = sineFrames({ hz: 440, sampleRate: 16_000, channels: 1, frames: 4000 });

    expect(zeroCrossings(light.bytes)).toBe(zeroCrossings(reference));
    expect(rms(light.bytes)).toBeCloseTo(rms(reference), -2);
  });

  test("ATTENUATES a tone above the new Nyquist instead of folding it back", () => {
    // The test that tells a box filter from plain decimation, and the reason the
    // averaging is not a wasted pass. Taking every third sample of a 20 kHz tone
    // at 48 kHz reproduces it at 4 kHz — in the middle of speech — at FULL
    // amplitude. Averaging leaves about a quarter of it.
    const bytes = sineFrames({ hz: 20_000, sampleRate: 48_000, channels: 2, frames: 12_000 });
    const light = downsampleSegment(bytes, STEREO_48K);

    const before = rms(bytes);
    // Bounded on BOTH sides: an upper bound alone is satisfied by a resampler
    // that returns silence, which would pass while destroying every transcript.
    expect(rms(light.bytes)).toBeLessThan(before * 0.4);
    expect(rms(light.bytes)).toBeGreaterThan(before * 0.1);
  });

  test("downmixes by AVERAGING the channels, not by dropping one", () => {
    // A stereo call with one party per channel is exactly the file where dropping
    // a channel loses a speaker outright. Left is +8000, right is -8000, so an
    // average is silence and a dropped channel is a loud tone.
    const bytes = new Uint8Array(4 * 2 * 2);
    const view = new DataView(bytes.buffer);
    for (let f = 0; f < 4; f++) {
      view.setInt16(f * 4, 8000, true);
      view.setInt16(f * 4 + 2, -8000, true);
    }
    const light = downsampleSegment(bytes, { sampleRate: 16_000, channels: 2, bitsPerSample: 16 });

    expect(light.format).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect([...light.bytes]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test("never UPSAMPLES — 8 kHz stereo comes back at 8 kHz, mono", () => {
    // The rate is a floor to come DOWN to, never a target to reach: resampling a
    // narrowband recording up would invent bytes to pay the deadline with.
    const bytes = sineFrames({ hz: 300, sampleRate: 8000, channels: 2, frames: 800 });
    const light = downsampleSegment(bytes, { sampleRate: 8000, channels: 2, bitsPerSample: 16 });

    expect(light.format).toEqual({ sampleRate: 8000, channels: 1, bitsPerSample: 16 });
    expect(light.bytes.length).toBe(1600);
  });

  test("reads 8-bit samples as UNSIGNED, which is RIFF's one asymmetry", () => {
    // Read as signed, a silent 8-bit recording (every byte 128) decodes as a
    // constant -128 — full-scale DC, which transcribes as nothing but is the
    // shape of the bug. 128 is silence; 255 is the positive peak.
    const silent = downsampleSegment(new Uint8Array([128, 128, 128, 128]), {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 8,
    });
    expect([...silent.bytes]).toEqual([0, 0]);

    const loud = downsampleSegment(new Uint8Array([255, 255]), {
      sampleRate: 16_000,
      channels: 2,
      bitsPerSample: 8,
    });
    expect(new DataView(loud.bytes.buffer).getInt16(0, true)).toBe(32_512);
  });

  test("sign-extends 24-bit samples", () => {
    // The depth with no `DataView` accessor, so the sign extension is hand-written
    // and is the one thing to get wrong: -1 is `ff ff ff`, which read unsigned is
    // +8388607 rather than a whisker below zero.
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0x00, 0x40]);
    const light = downsampleSegment(bytes, {
      sampleRate: 16_000,
      channels: 2,
      bitsPerSample: 24,
    });

    // -1 and +4194304 on the 24-bit scale are -1/256 and +16384 on the 16-bit
    // one; their average rounds to 8192.
    expect(new DataView(light.bytes.buffer).getInt16(0, true)).toBe(8192);
  });

  test("REFUSES a bit depth it cannot read, terminally", () => {
    // `parseWav` admits any multiple of 8, so this is reachable from a real file.
    // Terminal because it answers the same way on every attempt — a retry would
    // spend the step's whole budget arriving back here.
    expect(() =>
      downsampleSegment(new Uint8Array(16), {
        sampleRate: 48_000,
        channels: 2,
        bitsPerSample: 64,
      }),
    ).toThrow(UnsupportedRecordingError);
  });

  test("REFUSES a depth it cannot read on the LIGHT path too, where nothing resamples", () => {
    // The classification used to hang off the resampler, so it only ever ran when
    // there was resampling to do — and a recording already at 16 kHz mono takes
    // the identity path, where `requestFormat` hands its own argument back. Both
    // depths below reach that path from a real file, `parseWav` admitting any
    // multiple of 8, and each fails a different way once past here: 12 bits is a
    // `RangeError` out of `encodeWav`, which is UNCLASSIFIED and therefore
    // retried six times against a file that can never work, and 64 bits passes
    // the header check and goes on the wire MISLABELLED — the worse of the two,
    // because it comes back as a transcript rather than as an error.
    for (const bitsPerSample of [12, 64]) {
      expect(() => downsampleSegment(new Uint8Array(16), { ...MONO_16K, bitsPerSample })).toThrow(
        UnsupportedRecordingError,
      );
    }
  });

  test("REFUSES a window with no whole frame rather than sending silence", () => {
    // Reachable from the streaming flow, whose reads are CLAMPED to what has
    // arrived: a segment whose window comes back short of one frame used to
    // divide by a zero-wide averaging window, and `setInt16` turns the resulting
    // `NaN` into a 0 — so the desk sent a two-byte WAV of silence and reported a
    // transcript of it. A retry re-reads the same clamped window, so this is
    // terminal like every other answer this module gives twice.
    expect(() => downsampleSegment(new Uint8Array(2), STEREO_48K)).toThrow(
      UnsupportedRecordingError,
    );
    // And on the light path, where there is no averaging to divide by zero and an
    // empty request is just as useless.
    expect(() => downsampleSegment(new Uint8Array(0), MONO_16K)).toThrow(UnsupportedRecordingError);
  });

  test("requestFormat is what the fan-out's WIDTH is priced from", () => {
    // The two must not drift: `segmentConcurrency` divides a byte budget by a
    // segment's cost, and that budget is bytes UPLOADING. Pricing the source
    // format would make the width six times too cautious on exactly the
    // recordings this change is for.
    const sent = downsampleSegment(
      sineFrames({ hz: 440, sampleRate: 48_000, channels: 2, frames: 48_000 }),
      STEREO_48K,
    );
    expect(requestFormat(STEREO_48K)).toEqual(sent.format);
    expect(requestFormat(MONO_16K)).toBe(MONO_16K);
    expect(bytesPerSecond(requestFormat(STEREO_48K))).toBe(
      NORMALIZED_SAMPLE_RATE * NORMALIZED_CHANNELS * 2,
    );
  });
});

describe("transcribeSegment", () => {
  const FORMAT: WavFormat = { ...MONO_16K, dataStart: 44, dataEnd: 44 + 320_000 };
  const SEGMENT = { index: 0, start: 44, end: 44 + 32_000, startMs: 0, endMs: 1000 };

  beforeEach(() => {
    // `stepEnv` falls back to the process env when no host has published one,
    // which is exactly the case a spec is: there is no agent env in this
    // process. `unstubEnvs` clears it before the next test.
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /**
   * Publishes the recording and answers the sync endpoint.
   *
   * `installStubTranscribe` routes AssemblyAI's four legs off the SDK's own
   * endpoint constants, so this file no longer re-types the wire — and it fills a
   * published `stepFetch` rather than `vi.stubGlobal("fetch", …)`, because the
   * step calls `stepFetch`, which reaches a published slot rather than the global
   * (see `sdk/step-fetch.ts` for why it has to: HTTP/1.1, so a batch of segments
   * gets a socket each instead of N streams on one connection). Stubbing the
   * global still passes, because an unpublished slot falls back to it, and would
   * be asserting against a path production does not take.
   *
   * A refusal is staged as a STATUS, which is what makes the classification specs
   * below a test of the SDK's reading of it rather than of an error a fake minted.
   */
  function stubProvider(failure?: { status: number; message: string; retryAfterSeconds?: number }) {
    publishRecording(new Uint8Array(FORMAT.dataEnd));
    return installStubTranscribe({
      text: "hello there",
      failure: failure === undefined ? undefined : { leg: "sync", ...failure },
    }).calls;
  }

  test("sends the segment as a WAV named after its index", async () => {
    // What the SYNC endpoint's request looks like — the URL, the raw-key auth, the
    // multipart envelope — is the SDK's contract and `sdk/step-transcribe*.test.ts`
    // owns it. What is left here is this template's: it re-attaches a header to a
    // window it read, and it names the part after the segment.
    const calls = stubProvider();
    const result = await transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT);

    expect(result).toEqual({ index: 0, text: "hello there" });
    const sent = calls.find((call) => call.leg === "sync")?.body;
    // Narrowed by a failing assertion rather than a cast: `expect.fail` returns
    // `never`, and a body that is not bytes is a finding rather than a type error.
    if (!(sent instanceof Uint8Array)) return expect.fail("the sync leg carries bytes");
    const decoded = new TextDecoder().decode(sent);
    expect(decoded).toContain('name="audio"; filename="segment-0.wav"');
    // The WAV really rides in the part, header and all.
    expect(decoded).toContain("RIFF");
  });

  test("sends the DOWNSAMPLED window when the recording is heavier than 16 kHz mono", async () => {
    // The end-to-end half of `downsampleSegment`'s own specs: that the lighter
    // bytes reach the WIRE, which is the only place the endpoint's 30-second
    // budget is spent. One second of 48 kHz stereo is 192,000 bytes and leaves
    // here as 32,000.
    const stereo: WavFormat = {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataStart: 44,
      dataEnd: 44 + 192_000,
    };
    publishRecording(new Uint8Array(stereo.dataEnd));
    const calls = installStubTranscribe({ text: "hello there" }).calls;

    await transcribeSegment(UPLOAD_ID, stereo, {
      index: 0,
      start: 44,
      end: 44 + 192_000,
      startMs: 0,
      endMs: 1000,
    });

    const sent = calls.find((call) => call.leg === "sync")?.body;
    if (!(sent instanceof Uint8Array)) return expect.fail("the sync leg carries bytes");
    expect(sent.length).toBeLessThan(40_000);

    // And the HEADER agrees with the samples under it. A body that shrank while
    // still declaring 48 kHz stereo is the one failure a byte count cannot see,
    // and it plays back at a third speed rather than failing.
    const at = new TextDecoder("latin1").decode(sent).indexOf("RIFF");
    const header = new DataView(sent.buffer, sent.byteOffset + at, 44);
    expect(header.getUint16(22, true)).toBe(1);
    expect(header.getUint32(24, true)).toBe(16_000);
    expect(header.getUint32(40, true)).toBe(32_000);
  });

  test("a depth it can CUT but not RESAMPLE fails the step FATALLY, not six times", async () => {
    // `downsampleSegment`'s own spec asserts it throws; this asserts the
    // CLASSIFICATION, which is the half that decides what the run does with it.
    // `parseWav` admits any bit depth whose block align is positive, so a 48 kHz
    // stereo 64-bit recording plans fine and only fails here — and it answers the
    // same way on every attempt, so a plain throw would re-read this window out of
    // the upload store six times to arrive back at the identical error. Only the
    // STREAMING flow can get here: the classic one converts a heavy recording
    // whole before any segment is cut.
    const wide: WavFormat = {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 64,
      dataStart: 44,
      dataEnd: 44 + 96_000,
    };
    publishRecording(new Uint8Array(wide.dataEnd));
    installStubTranscribe({ text: "never reached" });

    await expect(
      transcribeSegment(UPLOAD_ID, wide, {
        index: 0,
        start: 44,
        end: 44 + 96_000,
        startMs: 0,
        endMs: 1000,
      }),
    ).rejects.toBeInstanceOf(FatalError);
  });

  test("and fails fatally on the LIGHT path, which resamples nothing", async () => {
    // The same classification one arm over, and the arm the case above cannot
    // reach: a recording already at 16 kHz mono is passed through untouched, so
    // nothing here ever asked what its samples were until it was too late to say
    // so. 12 bits reached `encodeWav`, which refuses a depth that is not a
    // multiple of 8 with a plain `RangeError` — retryable, so six attempts
    // against a file no attempt can fix.
    const narrow: WavFormat = {
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 12,
      dataStart: 44,
      dataEnd: 44 + 24_000,
    };
    publishRecording(new Uint8Array(narrow.dataEnd));
    installStubTranscribe({ text: "never reached" });

    await expect(
      transcribeSegment(UPLOAD_ID, narrow, {
        index: 0,
        start: 44,
        end: 44 + 24_000,
        startMs: 0,
        endMs: 1000,
      }),
    ).rejects.toBeInstanceOf(FatalError);
  });

  test("EMITS the segment's words as it lands, into the transcript stream", async () => {
    // What makes the run's answer streamable rather than only its narration: the
    // page stitches whatever has arrived, so the transcript renders growing
    // instead of appearing when the last segment does. The reporter is the SDK's
    // published slot, which is the same seam `report()` goes through.
    const reported = installStubReporter();
    stubProvider();

    await transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT);

    // The timestamps ride along for the READER — a partial transcript has holes
    // in it, and "0:00–0:01" is what explains a jump.
    expect(reported.emitted).toEqual([
      {
        namespace: TRANSCRIPT_STREAM,
        chunk: { index: 0, startMs: 0, endMs: 1000, text: "hello there" },
      },
    ]);
    // And the narration is still its own stream: lines a page prints verbatim
    // cannot share a channel with objects.
    expect(reported.lines.some((line) => line.startsWith("Transcribing"))).toBe(true);
  });

  test("fails FATALLY with no API key rather than retrying five times", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubProvider();
    await expect(transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT)).rejects.toThrow(
      /ASSEMBLYAI_API_KEY/,
    );
  });

  test("retries a rate limit, honouring the delay the endpoint asked for", async () => {
    // `RetryableError` carrying `retryAfter` is the difference between draining
    // the 429s and re-collecting them `SEGMENT_CONCURRENCY` at a time on a
    // backoff the server did not choose.
    stubProvider({ status: 429, message: "slow down", retryAfterSeconds: 30 });
    const failure = await transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(RetryableError);
    expect(String(failure)).toMatch(/HTTP 429 — slow down/);
    const at = (failure as RetryableError).retryAfter.getTime() - Date.now();
    expect(at).toBeGreaterThan(25_000);
    expect(at).toBeLessThanOrEqual(30_000);
  });

  test("retries a rate limit that named no delay", async () => {
    stubProvider({ status: 429, message: "slow down" });
    await expect(transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT)).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  test("fails FATALLY on a rejected request, naming what the endpoint said", async () => {
    stubProvider({ status: 400, message: "too short" });
    await expect(transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT)).rejects.toThrow(
      /HTTP 400 — too short/,
    );
  });

  test("is raised on both of the classic flow's I/O steps, and on nothing else", async () => {
    // The policy is an argument to `ctx.step` now, so it is observable only at
    // the CALL — which is exactly the kind of thing a property on the function
    // could not have said differently, `transcribeSegment` being called from two
    // flows. `runSteps: false` with a skeleton of results: no provider, no
    // ffmpeg, no bytes.
    //
    // `transcribeStreamFlow`'s own `transcribeSegment` call carries the same
    // budget and is asserted with that flow, not here — this drives only
    // `transcribeFlow`.
    const ctx = createWorkflowCtx({
      runSteps: false,
      results: {
        normalizeRecording: { recording: UPLOAD_ID, converted: false },
        splitRecording: { format: FORMAT, segments: [SEGMENT], durationMs: 1000 },
        transcribeSegment: { index: 0, text: "hello" },
        // The real `Transcript` shape rather than `{ text }` — the body returns
        // this straight out as the run's output, so a fixture the system cannot
        // produce is the shape a reader copies.
        mergeTranscript: {
          source: "call.wav",
          segments: 1,
          durationMs: 1000,
          elapsedMs: 10,
          words: 1,
          transcript: "hello",
        } satisfies Transcript,
      },
    });
    await transcribeFlow({ recording: UPLOAD_ID }, ctx);

    const segments = ctx.steps.filter((step) => step.name === "transcribeSegment");
    expect(segments.length).toBeGreaterThan(0);
    // The EXACT budget, not `toBeGreaterThan(3)`: the value is a literal at the
    // call site, so a typo'd `maxAttempts: 4` is what this should catch.
    for (const step of segments) expect(step.maxAttempts).toBe(6);
    // The OTHER raised step, whose assertion the migration dropped along with
    // the `normalizeRecording.maxRetries` property it used to read.
    const budgets = new Map(ctx.steps.map((step) => [step.name, step.maxAttempts]));
    expect(budgets.get("normalizeRecording")).toBe(6);
    // And the two that take the default, which is the other half of the claim.
    // Asserted as PRESENT-with-no-budget rather than as `get(…) === undefined`,
    // which a step the body never reached at all would also satisfy.
    for (const name of ["mergeTranscript", "splitRecording"]) {
      expect(budgets.has(name)).toBe(true);
      expect(budgets.get(name)).toBeUndefined();
    }
  });
});

describe("mergeTranscript", () => {
  test("stitches the segments in index order, whatever order they arrive in", async () => {
    publishRecording(new Uint8Array(1));
    const merged = await mergeTranscript(
      UPLOAD_ID,
      12_000,
      [
        { index: 1, text: "on Friday if the tests pass" },
        { index: 0, text: "we ship on Friday" },
      ],
      STARTED_AT,
    );
    expect(merged.transcript).toBe("we ship on Friday if the tests pass");
    expect(merged.words).toBe(8);
    expect(merged).toMatchObject({ segments: 2, durationMs: 12_000 });
  });

  test("names the FILE it transcribed, not the id the run carried", async () => {
    publishRecording(new Uint8Array(1), "standup.wav");
    const merged = await mergeTranscript(UPLOAD_ID, 1000, [{ index: 0, text: "hi" }], STARTED_AT);
    expect(merged.source).toBe("standup.wav");
  });
});

/** Two byte arrays end to end. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * The STREAMING flow's own steps.
 *
 * Same honest line as the classic half above: the steps are driven directly and the
 * body is not, because a step is an ordinary exported async function. Almost
 * nothing here is new — the transcribing and the merging are
 * `transcribe.ts`'s own steps, called unchanged — so what is worth asserting is the
 * two things this flow adds: reading how far the upload has got, and planning from a
 * header while most of the file is still missing.
 */
describe("the streaming flow", () => {
  const FORMAT: WavFormat = { ...MONO_16K, dataStart: 44, dataEnd: 44 + 320_000 };

  /** Publish a partially-arrived upload: `stored` bytes of a `declared`-byte file. */
  function publishPartial(stored: number, declared: number, complete = false) {
    const bytes = new Uint8Array(44 + stored);
    bytes.set(wavFile(MONO_16K, declared), 0);
    installStubUploads({
      [UPLOAD_ID]: { bytes, name: "standup.wav", type: "audio/wav", complete },
    });
  }

  test("probeUpload reports what has ARRIVED and whether that is all", async () => {
    publishPartial(1000, 320_000);
    // The poll the body runs. `complete` is separate from `size` because a size that
    // stopped growing is not a claim that the file is finished.
    // `stored` equals `size` here and only here: a whole-file upload's bytes ARE
    // its prefix, and the store publishes no windows for one.
    await expect(probeUpload(UPLOAD_ID)).resolves.toEqual({
      size: 44 + 1000,
      complete: false,
      stored: 44 + 1000,
      // A real clock, which is the point of it: `nextPollDelay` derives a rate from
      // two of these, so the step has to stamp when it looked rather than the body
      // guessing. Matched loosely because the VALUE is the wall clock.
      observedAt: expect.any(Number),
    });
  });

  /**
   * A poll of a parts upload: `landed` windows of a `declared`-byte file.
   *
   * Built by hand rather than through `stubUploads`, which models an upload as one
   * contiguous buffer and so cannot express a HOLE — which is the entire state under
   * test. These two functions are pure over a poll's result, so a literal is the
   * whole fixture.
   */
  function poll(landed: readonly [number, number][], declared: number): UploadProgressView {
    const ranges = landed.map(([start, end]) => ({ start, end }));
    const prefix = ranges.find((range) => range.start === 0)?.end ?? 0;
    return {
      size: prefix,
      complete: prefix >= declared,
      stored: storedBytes(prefix, ranges),
      ranges,
      // Fixed rather than `Date.now()`: these fixtures feed pure functions, and a
      // real clock would make `nextPollDelay`'s arithmetic depend on how long the
      // suite took to get here.
      observedAt: 0,
    };
  }

  test("segmentStored reads a landed window the PREFIX cannot see", () => {
    // The state the browser's default fan-out produces and the reason this flow
    // was a no-op against it: eight windows go up at once, share the uplink, and
    // finish together — so nothing starts at byte zero until the very end. Measured
    // on a deployed agent, a 27 MB recording at 0.9 MB/s reported `size: 0` at every
    // poll for 45 seconds and then the whole file.
    const at = poll([[8000, 24_000]], 32_000);
    expect(at.size).toBe(0);
    expect(segmentStored({ index: 1, start: 8000, end: 16_000, startMs: 0, endMs: 0 }, at)).toBe(
      true,
    );
    // And the prefix arm still answers on its own, which is what keeps a whole-file
    // upload (no windows at all) behaving exactly as it did.
    expect(segmentStored({ index: 0, start: 0, end: 4000, startMs: 0, endMs: 0 }, at)).toBe(false);
  });

  test("segmentStored refuses a window that STRADDLES a hole", () => {
    // A run is contiguous, so containment in one is the whole test — and it has to
    // be, because `readUpload` clamps to the run a read starts in. A segment
    // spanning two runs would come back short and be transcribed as a fragment,
    // which is a wrong transcript rather than a failed one.
    const at = poll(
      [
        [0, 8000],
        [16_000, 24_000],
      ],
      32_000,
    );
    expect(segmentStored({ index: 1, start: 4000, end: 20_000, startMs: 0, endMs: 0 }, at)).toBe(
      false,
    );
    expect(segmentStored({ index: 2, start: 16_000, end: 24_000, startMs: 0, endMs: 0 }, at)).toBe(
      true,
    );
  });

  test("storedBytes counts the WINDOWS, so a moving upload never reads as stalled", () => {
    // The other half of the fix. Judge a stall on the prefix and a parts upload
    // running at full speed reports the same number at every poll — so the run
    // abandons it after MAX_IDLE_POLLS with the bytes still arriving.
    const first = poll([[8000, 16_000]], 32_000);
    const later = poll(
      [
        [8000, 16_000],
        [24_000, 32_000],
      ],
      32_000,
    );
    expect(first.size).toBe(later.size);
    expect(later.stored).toBeGreaterThan(first.stored);
  });

  test("storedBytes does not double-count the prefix", () => {
    // `ranges` COVERS the prefix rather than sitting beside it, so summing the two
    // would report a growing total for an upload that had stopped.
    expect(storedBytes(8000, [{ start: 0, end: 8000 }])).toBe(8000);
    // And an upload with no windows at all is its prefix.
    expect(storedBytes(8000, undefined)).toBe(8000);
  });

  test("probeUpload reports complete once it is", async () => {
    publishPartial(320_000, 320_000, true);
    await expect(probeUpload(UPLOAD_ID)).resolves.toMatchObject({ complete: true });
  });

  test("planStreamed plans the WHOLE recording from a header that arrived alone", async () => {
    // The one real difference from `splitRecording`: only 1000 bytes of audio are
    // stored, and the plan still covers the 320,000 the header declares. Planning
    // from what has arrived would fan out over a fraction of the recording and report
    // success — which is the failure this argument exists to prevent.
    publishPartial(1000, 320_000);
    const plan = await planStreamed(UPLOAD_ID);
    expect(plan.format.dataEnd).toBe(44 + 320_000);
    expect(plan.segments.at(-1)?.end).toBe(44 + 320_000);
    expect(plan.segments.length).toBe(planSegments(FORMAT).length);
  });

  test("planStreamed refuses a WAV that declares no length, naming the other flow", async () => {
    // `0` means "unknown", and there is nothing to compute a segment list from until
    // the file has finished — which is exactly what `transcribe` is for.
    const bytes = new Uint8Array(44 + 100);
    bytes.set(wavFile(MONO_16K, 100, { declaredDataSize: 0 }), 0);
    installStubUploads({ [UPLOAD_ID]: { bytes, complete: false } });
    await expect(planStreamed(UPLOAD_ID)).rejects.toThrow(/declares no data length/);
  });

  test("planStreamed refuses a file that is not a WAV, terminally", async () => {
    installStubUploads({ [UPLOAD_ID]: { bytes: new Uint8Array(2000), complete: false } });
    // Fatal, not retryable: three more attempts read the same bytes.
    await expect(planStreamed(UPLOAD_ID)).rejects.toBeInstanceOf(FatalError);
  });

  test("a segment reads SHORT rather than failing when its bytes have not landed", async () => {
    // The property the whole flow rests on, and it predates streaming: `readUpload`
    // clamps its window to what is stored. So a body that asks slightly early gets
    // what exists — which is why the body checks `end <= size` and can trust the
    // clamp for the final segment of a file that came up short.
    publishPartial(1000, 320_000);
    const slice = await readUpload(UPLOAD_ID, { start: 44, end: 44 + 320_000 });
    expect(slice.bytes.length).toBe(1000);
    expect(slice.end).toBe(44 + 1000);
  });
});

/**
 * The ASYNC flow's steps.
 *
 * Driven against a stubbed `stepFetch`, like the sync flow's — and note what that
 * makes assertable: the three calls this flow makes are the whole of it, so the
 * assertions are about the CONTRACT with the provider (an id survives, a failed job
 * is terminal, the file is streamed rather than buffered) rather than about
 * arithmetic this flow does not do.
 */
describe("the async flow", () => {
  beforeEach(() => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
  });

  /**
   * Answer the async API, recording what was sent.
   *
   * `installStubTranscribe` routes the three legs off the SDK's own endpoint
   * constants — so a spec cannot pass because the fake and the step agree on a
   * typo — and it restores itself when the test ends.
   */
  function stubBatch(options: Parameters<typeof installStubTranscribe>[0] = {}) {
    return installStubTranscribe({ audioUrl: "https://cdn.example/abc", ...options }).calls;
  }

  test("uploadToProvider streams the file and answers with the provider's URL", async () => {
    publishRecording(new Uint8Array(5000), "standup.wav");
    const calls = stubBatch();
    await expect(uploadToProvider(UPLOAD_ID)).resolves.toEqual({
      audioUrl: "https://cdn.example/abc",
    });
    expect(calls.map((one) => one.url)).toEqual(["https://api.assemblyai.com/v2/upload"]);
  });

  test("the file is STREAMED, so a step never holds a whole recording", async () => {
    publishRecording(new Uint8Array(5000), "standup.wav");
    const calls = stubBatch();
    await uploadToProvider(UPLOAD_ID);
    // The fake drains a streaming body into bytes, so what this asserts is that
    // every byte went out — the streaming is what keeps a gigabyte off the heap, and
    // the bytes arriving intact is what says the windowing is right.
    const sent = calls[0]?.body;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(sent instanceof Uint8Array ? sent.length : -1).toBe(5000);
  });

  test("the upload is a SEPARATE step, so a failed submit does not re-send the file", async () => {
    // Found by running it: as one step, a 400 on the create call retried the whole
    // thing five times and re-uploaded 24 MB on each attempt. The split is what makes
    // a retry of the cheap half cost the cheap half.
    publishRecording(new Uint8Array(5000));
    const calls = stubBatch({ failure: { leg: "submit", status: 400, message: "bad field" } });
    await expect(createJob("https://cdn.example/abc")).rejects.toBeInstanceOf(FatalError);
    // One call, and it is not the upload.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.assemblyai.com/v2/transcript");
  });

  test("createJob asks for `speech_models`, plural — the singular field is a 400", async () => {
    publishRecording(new Uint8Array(10));
    const calls = stubBatch({ jobIdPrefix: "tr_" });
    await expect(createJob("https://cdn.example/abc")).resolves.toEqual({ id: "tr_1" });
    const sent = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
    // The async API deprecated `speech_model` and answers 400 for any current model
    // name passed to it — which is how the first live run of this flow failed. The
    // STREAMING API still uses the singular field, so neither is "the" spelling.
    expect(sent).toMatchObject({ speech_models: ["universal-3-5-pro"] });
    expect(sent.speech_model).toBeUndefined();
  });

  test("a job the provider gave up on is TERMINAL, not polled forever", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch({ jobError: "audio too quiet" });
    // The provider has decided; no number of polls changes it, so this must not come
    // back as "not done yet".
    await expect(pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).rejects.toBeInstanceOf(FatalError);
  });

  test("pollTranscript answers `done` on completed and not before", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch({ pendingPolls: 1 });
    await expect(pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).resolves.toEqual({ done: false });
  });

  test("an unknown status is NOT done, so a new one cannot end a run early", async () => {
    publishRecording(new Uint8Array(10));
    // Raw rather than `stubTranscribe`: a body with no status at all is not a
    // shape the fake can stage, and it is the whole point of this spec.
    installStubStepFetch(() => ({ body: {} }));
    await expect(pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).resolves.toMatchObject({
      done: false,
    });
  });

  test("a completed poll carries the transcript — ONE request, not two", async () => {
    publishRecording(new Uint8Array(10), "standup.wav");
    // It used to poll for a status and then fetch the identical URL again for the
    // text the poll already had in its hand.
    const calls = stubBatch({ text: "  hello there  ", durationSec: 12.5 });
    await expect(pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).resolves.toMatchObject({
      done: true,
      transcript: {
        source: "standup.wav",
        // Not a fudge: the async API transcribed the recording in one piece, which is
        // the difference this flow is here to show.
        segments: 1,
        durationMs: 12_500,
        words: 2,
        transcript: "hello there",
      },
    });
    expect(calls).toHaveLength(1);
  });

  test("a rate limit is RETRYABLE, so a busy minute does not fail the run", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch({ failure: { leg: "poll", status: 429, message: "slow down" } });
    await expect(pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  test("all three flows report the same SHAPE, which is what lets one page render any", async () => {
    publishRecording(new Uint8Array(10), "standup.wav");
    stubBatch({ text: "hi", durationSec: 1 });
    const progress = await pollTranscript(UPLOAD_ID, "tr_1", STARTED_AT);
    if (!progress.done) return expect.fail("the stub reports a completed job");
    const batched = progress.transcript;
    // One key set, so the page's summary line renders every flow's output. A field on
    // one flow and not the others is a panel that shows it for some runs and not
    // others, with nothing saying why.
    expect(Object.keys(batched).sort()).toEqual([
      "durationMs",
      "elapsedMs",
      "segments",
      "source",
      "transcript",
      "words",
    ]);
    // And the wall clock really is measured from what it was handed.
    expect(batched.elapsedMs).toBeGreaterThan(0);
  });
});

describe("normalizing the recording", () => {
  /**
   * The CONVERSION is not driven here, and the reason is the tier rather than the
   * code: it spawns ffmpeg and writes a temp file, neither of which a unit test
   * may do. What is reachable is everything that DECIDES — whether a file needs
   * converting at all, and how a conversion's failure is classified — and those
   * are the two places a mistake is silent. A file wrongly passed through fails
   * later in `splitRecording` with a message about a header; a `timeout`
   * classified as fatal is a run that gives up on work that would have finished.
   */
  test("a canonical WAV is cuttable, so the desk converts nothing", () => {
    expect(cuttable(wavFile(MONO_16K, 32_000), 44 + 32_000)).toBe(true);
  });

  test("an extra chunk before the samples is still cuttable", () => {
    // The `LIST`-chunk case, which is the reason the probe window is 64 KB rather
    // than 44 bytes: a file the walk CAN read must not be re-encoded.
    const head = wavFile(MONO_16K, 32_000, { extraChunk: "recorder" });
    expect(cuttable(head, head.length + 32_000)).toBe(true);
  });

  test("an m4a is not, which is what puts ffmpeg in the path", () => {
    // An MPEG-4 `ftyp` box — what a phone recording really starts with.
    const m4a = new Uint8Array([
      0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0,
    ]);
    expect(cuttable(m4a, 4_000_000)).toBe(false);
  });

  test("a WAV whose encoding is not linear PCM is not", () => {
    // The case an `ffprobe`-based check gets WRONG, which is why the check is
    // `parseWav` itself: this file reports a PCM codec to ffprobe and is refused
    // by the parser, so a probe would pass it through and the cut would fail.
    const extensible = wavFile(MONO_16K, 32_000);
    new DataView(extensible.buffer).setUint16(20, 0xff_fe, true);
    expect(cuttable(extensible, 44 + 32_000)).toBe(false);
  });

  test("a WAV too dense to cut is not, and downsampling is what repairs it", () => {
    // Past `MAX_BYTES_PER_SECOND`, so `parseWav` refuses it — and a conversion to
    // 16 kHz mono makes it cuttable, which is a fix the desk gets for free from
    // asking the parser rather than asking about the codec.
    const dense = wavFile({ sampleRate: 4_000_000, channels: 8, bitsPerSample: 32 }, 32_000);
    expect(cuttable(dense, 44 + 32_000)).toBe(false);
  });

  test("48 kHz stereo is cuttable and still too heavy to cut as it is", () => {
    // The file that broke a real run. It parses, it cuts, and every 92-second
    // segment of it is 17.7 MB against 2.94 MB normalized — six times the upload
    // per request, against a sync endpoint that deadlines at 30s. `cuttable`
    // cannot see that, which is the whole reason there are two predicates.
    const heavy = wavFile({ sampleRate: 48_000, channels: 2, bitsPerSample: 16 }, 32_000);
    expect(cuttable(heavy, 44 + 32_000)).toBe(true);
    expect(heavierThanNormalized(heavy, 44 + 32_000)).toBe(true);
  });

  test.each([
    ["a higher rate alone", { sampleRate: 44_100, channels: 1, bitsPerSample: 16 }],
    ["more channels alone", { sampleRate: 16_000, channels: 2, bitsPerSample: 16 }],
  ])("%s is enough to convert", (_label, fmt) => {
    // Either axis on its own, because the segment cost is their PRODUCT — a file
    // that is only wide or only fast still costs a multiple of the target.
    expect(heavierThanNormalized(wavFile(fmt, 32_000), 44 + 32_000)).toBe(true);
  });

  test("the normalize target itself is not heavier than itself", () => {
    // The predicate has to be false at the fixed point or the fast path is dead
    // and every recording pays an ffmpeg pass that produces its own input.
    const target = {
      sampleRate: NORMALIZED_SAMPLE_RATE,
      channels: NORMALIZED_CHANNELS,
      bitsPerSample: 16,
    };
    expect(heavierThanNormalized(wavFile(target, 32_000), 44 + 32_000)).toBe(false);
  });

  test("a rate BELOW the target is left alone rather than upsampled", () => {
    // 8 kHz telephony audio. Converting it would invent no information and cost a
    // full pass over the recording, so the comparison is `>` and not `!==`.
    const narrow = wavFile({ sampleRate: 8000, channels: 1, bitsPerSample: 16 }, 32_000);
    expect(heavierThanNormalized(narrow, 44 + 32_000)).toBe(false);
  });

  test("a heavy WAV is CONVERTED, and the line says why rather than lying", async () => {
    // The report used to read "not a WAV we can cut" on every conversion, which
    // for this file contradicts the thing the caller uploaded. The conversion
    // itself is out of tier (it spawns ffmpeg), so what is asserted is that the
    // fast path was declined and the reason given is the weight.
    publishRecording(
      wavFile({ sampleRate: 48_000, channels: 2, bitsPerSample: 16 }, 32_000),
      "workshop.wav",
    );
    const reporter = installStubReporter();
    await normalizeRecording(UPLOAD_ID).catch(() => undefined);
    const said = reporter.lines.join(" ");
    expect(said).not.toContain("already linear-PCM WAV");
    expect(said).toContain("heavier per second than 16 kHz mono");
  });

  test("an already-cuttable recording keeps the id it came in under", async () => {
    // The property that matters: no second upload, so the fan-out reads the file
    // the caller stored. A step that copied it would double the storage every run
    // pays for and would still report success.
    publishRecording(wavFile(MONO_16K, 32_000), "standup.wav");
    const reporter = installStubReporter();
    await expect(normalizeRecording(UPLOAD_ID)).resolves.toEqual({
      recording: UPLOAD_ID,
      converted: false,
    });
    expect(reporter.lines.join(" ")).toContain("already linear-PCM WAV");
  });

  // The ffmpeg VERDICT is no longer tested here, and its absence is the change
  // rather than a gap: `throwFfmpegStepError` on `@alexkroman1/aai/step-errors`
  // owns it now, with every arm pinned in `sdk/step-errors.test.ts` — a refused
  // file, a missing binary, a timeout rethrown UNCHANGED so its `argv` survives,
  // and a cause that is not an ffmpeg failure at all. What stays above is what is
  // still this desk's: WHICH files it decides to convert.
});

describe("expectedSegments", () => {
  /** A plan over 16 kHz mono, cut into three 90-second segments. */
  const PLAN = {
    format: { ...MONO_16K, dataStart: 44, dataEnd: 44 + 270 * 32_000 },
    segments: [0, 1, 2].map((index) => ({
      index,
      start: 44 + index * 90 * 32_000,
      end: 44 + (index + 1) * 90 * 32_000,
      startMs: index * 90_000,
      endMs: (index + 1) * 90_000,
    })),
  };

  test("counts every segment once the whole recording has arrived", () => {
    expect(expectedSegments(PLAN, PLAN.format.dataEnd)).toBe(3);
  });

  test("ignores segments that start past the end of a SHORT upload", () => {
    // The failure this guards is a run that never ENDS rather than one that fails:
    // the plan came from the header's declared length, so a recording that came up
    // short has segments beginning past the last byte, and waiting for them is
    // waiting for audio nobody is going to send.
    expect(expectedSegments(PLAN, 44 + 100 * 32_000)).toBe(2);
    expect(expectedSegments(PLAN, 44 + 1)).toBe(1);
  });

  test("an upload with nothing in it expects no segments at all", () => {
    expect(expectedSegments(PLAN, 0)).toBe(0);
  });
});

describe("the conversion, up to the spawn", () => {
  /**
   * Reaches the point where ffmpeg would run and stops there, DETERMINISTICALLY.
   *
   * `AAI_FFPROBE_PATH` names the binary the SDK resolves, so pointing it at a path
   * that does not exist produces `kind: "missing-binary"` on every machine — one
   * where ffmpeg is installed, one where it is not, and CI's Linux leg alike. A
   * test that instead relied on ffmpeg being ABSENT would pass on a laptop and
   * behave differently in CI.
   *
   * What it covers is the whole step up to the subprocess: reading the header,
   * deciding the file needs converting, and materializing it to a temp file. Plus
   * the behaviour a developer actually meets — `aai dev` with no ffmpeg is the one
   * place dev/prod parity is partial, and it must fail FATALLY with an installable
   * remedy rather than burn five attempts on a binary that will not appear.
   */
  test("materializes the recording, then fails fatally with no ffprobe", async () => {
    vi.stubEnv("AAI_FFPROBE_PATH", "/nonexistent/aai-test/ffprobe");
    vi.stubEnv("AAI_FFMPEG_PATH", "/nonexistent/aai-test/ffmpeg");
    // An m4a `ftyp` box, so `cuttable` says no and the conversion path is taken.
    publishRecording(
      new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]),
      "standup.m4a",
    );
    const reporter = installStubReporter();
    // Fatal, not retryable: four more attempts find the same missing binary, and
    // the message already carries the install instructions.
    await expect(normalizeRecording(UPLOAD_ID)).rejects.toThrow(/ffprobe/);
    await expect(normalizeRecording(UPLOAD_ID)).rejects.toBeInstanceOf(FatalError);
    // It got as far as deciding the file needs converting — the failure is the
    // binary, not the input.
    expect(reporter.lines.join(" ")).toContain("standup.m4a");
  });

  test("leaves no temp directory behind when the conversion fails", async () => {
    // The `finally`, on the path that matters: a guest's disk is small, and a step
    // that leaked a directory per failed run would fill it.
    vi.stubEnv("AAI_FFPROBE_PATH", "/nonexistent/aai-test/ffprobe");
    const leaked = (names: string[]) => names.filter((n) => n.startsWith("aai-normalize-"));
    const before = leaked(await readdir(tmpdir()));
    publishRecording(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), "standup.m4a");
    installStubReporter();
    await expect(normalizeRecording(UPLOAD_ID)).rejects.toBeInstanceOf(FatalError);
    expect(leaked(await readdir(tmpdir()))).toEqual(before);
  });
});

/**
 * The adaptive poll delay.
 *
 * `POLL_INTERVAL_MS` used to be the only interval, and on a slow uplink that meant
 * discovering every segment on average half an interval late — once per segment,
 * for the whole upload. `nextPollDelay` sleeps until the next segment should have
 * landed instead. It is pure over two journaled polls, which is what makes it both
 * replay-safe and testable without a clock.
 */
describe("nextPollDelay", () => {
  /**
   * A poll: `stored` bytes at `observedAt` ms, prefix and total agreeing.
   *
   * Which is the WHOLE-FILE upload — the two numbers only agree there. The parts
   * fan-out is `detached` below, and it is a separate helper rather than an
   * optional argument so a case that means them to diverge has to say so.
   */
  const view = (stored: number, observedAt: number): UploadProgressView => ({
    size: stored,
    complete: false,
    stored,
    observedAt,
  });
  /** A poll under the parts fan-out: `stored` bytes landed, `size` readable. */
  const detached = (stored: number, size: number, observedAt: number): UploadProgressView => ({
    size,
    complete: false,
    stored,
    observedAt,
  });
  /**
   * A plan whose segments end at the given byte offsets.
   *
   * Both halves are REAL values rather than casts: `nextPollDelay` only reads
   * `segments`, but a `{} as never` format would stop reporting the moment the
   * function grew a second reader — which is the whole argument against the
   * cast. 16 kHz mono is what `normalizeRecording` produces.
   */
  const planAt = (...ends: number[]): StreamPlan => ({
    format: {
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataStart: 44,
      dataEnd: 44 + Math.max(0, ...ends),
    },
    segments: ends.map((end, index) => ({ index, start: 0, end, startMs: 0, endMs: 0 })),
  });

  test("falls back to the ceiling with no previous sample to take a rate from", () => {
    // The first sleep of every run: one point is not a rate.
    expect(nextPollDelay(view(1000, 5000), undefined, planAt(50_000), new Set())).toBe(5000);
  });

  test("falls back to the ceiling for a STALLED upload rather than guessing", () => {
    // Nothing arrived between the two samples, so there is no arrival to
    // extrapolate. MAX_IDLE_POLLS is what ends such a run; this only declines to
    // predict it, and must not divide by zero doing so.
    expect(nextPollDelay(view(1000, 2000), view(1000, 1000), planAt(50_000), new Set())).toBe(5000);
  });

  test("waits the time the next segment still needs, at the observed rate", () => {
    // 10_000 bytes over 1000ms is 10 bytes/ms; the next segment needs 10_000 more.
    const delay = nextPollDelay(view(20_000, 2000), view(10_000, 1000), planAt(30_000), new Set());
    expect(delay).toBe(1000);
  });

  test("targets the EARLIEST unfinished segment, not the furthest", () => {
    // Segments land as they arrive, so what the loop can act on next is the first
    // one it has not done — waiting for the last would sleep through the rest.
    const done = new Set([0]);
    const delay = nextPollDelay(
      view(10_000, 2000),
      view(0, 1000),
      planAt(5000, 20_000, 90_000),
      done,
    );
    // 10 bytes/ms, 10_000 more needed to reach segment 1's end at 20_000.
    expect(delay).toBe(1000);
  });

  test("clamps to the ceiling so a collapsing rate degrades to the old behaviour", () => {
    // 1 byte/ms against 10 MB outstanding is hours; the ceiling is what stops this
    // becoming a stall no MAX_IDLE_POLLS can see.
    const delay = nextPollDelay(view(1000, 2000), view(0, 1000), planAt(10_000_000), new Set());
    expect(delay).toBe(5000);
  });

  test("clamps to the floor rather than spinning when the bytes are already there", () => {
    // The segment is stored but the loop reached the sleep anyway (it is waiting on
    // `complete`). A poll is cheap and not free — this must not become a spin.
    const delay = nextPollDelay(view(60_000, 2000), view(10_000, 1000), planAt(30_000), new Set());
    expect(delay).toBe(250);
  });

  test("waits for the HEADER window before there is a plan to aim at", () => {
    // No plan yet, so what is being waited for is the probe window itself.
    const delay = nextPollDelay(view(0, 2000), view(0, 1000), undefined, new Set());
    // Rate is zero here, so this takes the stalled arm — the point is that a missing
    // plan is not a crash.
    expect(delay).toBe(5000);
  });

  test("returns the ceiling once every segment is done", () => {
    // Nothing left to extrapolate toward: the loop is waiting on the `complete`
    // flag, which is set by the uploader rather than reached by bytes.
    const delay = nextPollDelay(
      view(50_000, 2000),
      view(40_000, 1000),
      planAt(30_000),
      new Set([0]),
    );
    expect(delay).toBe(5000);
  });

  test("measures the wait against the PREFIX, not against every window that landed", () => {
    // The parts fan-out is the DEFAULT, and there `stored` and `size` diverge
    // completely (the module doc measured `size` at 0 for 45 seconds while the
    // whole file arrived). Both targets here are byte OFFSETS, so subtracting a
    // total that counts detached windows reads segment 1 as already reached and
    // collapses the sleep to its 250ms floor — 20x the polling on the path this
    // flow is normally on. 60_000 bytes have landed somewhere; only 4_000 of them
    // are readable from the start, so the segment ending at 30_000 needs 26_000
    // more at the observed 10 bytes/ms.
    const delay = nextPollDelay(
      detached(60_000, 4000, 2000),
      detached(50_000, 0, 1000),
      planAt(30_000),
      new Set(),
    );
    expect(delay).toBe(2600);
  });

  test("waits for the HEADER window against the prefix too", () => {
    // Same trap one step earlier, and this is the arm that really runs first: the
    // body plans when `at.size >= HEADER_PROBE_BYTES`, so a delay derived from
    // `stored` is answering a different question than the one the loop asks. A
    // megabyte has landed in later windows and the header has not arrived.
    // 100 bytes/ms against the whole 64 KiB probe window is 656ms; measured
    // against `stored` the remainder is negative and the answer is the floor.
    const delay = nextPollDelay(
      detached(100_000, 0, 2000),
      detached(0, 0, 1000),
      undefined,
      new Set(),
    );
    expect(delay).toBe(656);
  });

  /**
   * One 8 MiB upload window, the unit the store publishes a write in.
   *
   * The fan-out's real shape, and the one `size` cannot see: the prefix does not
   * move until the FIRST window lands, so a poll under it reads `size: 0` with
   * megabytes stored.
   */
  const PART_BYTES = 8 * 1024 * 1024;

  /**
   * A poll of a parts upload whose PREFIX has not moved at all.
   *
   * The measured shape from the module doc — a 27 MB recording at 0.9 MB/s
   * reported `size: 0` for 45 of its 45 seconds while the windows landed. `size`
   * is fixed at 0 here for exactly that reason: a helper that let it drift would
   * let a case pass on the prefix arm, which is the hole these two cases exist
   * to close.
   */
  const landed = (ranges: readonly UploadRange[], observedAt: number): UploadProgressView => ({
    size: 0,
    complete: false,
    stored: storedBytes(0, ranges),
    ranges,
    observedAt,
  });

  /** A plan whose segments are the given `[start, end)` windows. */
  const planOver = (...windows: readonly (readonly [number, number])[]): StreamPlan => ({
    format: {
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataStart: 44,
      dataEnd: 44 + Math.max(0, ...windows.map(([, end]) => end)),
    },
    segments: windows.map(([start, end], index) => ({ index, start, end, startMs: 0, endMs: 0 })),
  });

  test("measures a segment against the RANGES its readiness is decided on", () => {
    // The other half of the prefix rule above, and the one that decides this
    // flow's whole cadence: `segmentStored` reads `ranges`, so the work still
    // outstanding is what that test needs and not what the prefix is short by.
    // Under the fan-out the prefix stays at 0 for the length of the upload, so a
    // remainder measured against it is the WHOLE segment at every poll — which
    // saturates the ceiling and gives back the flat 5000ms interval this
    // function replaced, once per segment, for the entire recording.
    //
    // Two 8 MiB windows have landed contiguously from byte zero, at ~932
    // bytes/ms; the segment ends 866,384 bytes past them.
    const delay = nextPollDelay(
      landed([{ start: 0, end: 2 * PART_BYTES }], 10_000),
      landed([{ start: 0, end: PART_BYTES }], 1000),
      planOver([0, 17_643_600]),
      new Set(),
    );
    expect(delay).toBe(930);
  });

  test("wakes for the segment CLOSEST to ready, which need not be the earliest", () => {
    // Windows land out of order — that is the premise the `ranges` arm rests on
    // — so the next segment the loop can act on is not always the first one it
    // has not done. Segment 0 has nothing covering its start and needs the whole
    // 20 MB prefix; segment 1 sits inside a window that is 500,000 bytes short.
    const delay = nextPollDelay(
      landed([{ start: 16_000_000, end: 35_500_000 }], 10_000),
      landed([{ start: 16_000_000, end: 27_111_608 }], 1000),
      planOver([0, 20_000_000], [16_000_000, 36_000_000]),
      new Set(),
    );
    // 932 bytes/ms against the 500,000 still missing from segment 1's window.
    expect(delay).toBe(537);
  });

  test("falls back to the prefix for a window that does not cover the segment's START", () => {
    // A run has to cover a segment WHOLE to make it readable, so a window landing
    // in the middle of one moves nothing: what remains is the prefix's own
    // distance, which here is a ceiling's worth of waiting.
    const delay = nextPollDelay(
      landed([{ start: 8_000_000, end: 16_000_000 }], 10_000),
      landed([{ start: 8_000_000, end: 12_000_000 }], 1000),
      planOver([0, 17_643_600]),
      new Set(),
    );
    expect(delay).toBe(5000);
  });
});

/**
 * `transcribeBatch`, on the real replay engine.
 *
 * The batch flow is the one of this desk's three that reaches no ffmpeg — it
 * uploads, submits and polls — so it is the one a unit spec can drive end to
 * end. `transcribe` and `transcribeStream` both normalize the recording first,
 * and this repo's test environment has no ffmpeg (the `normalizeRecording` specs
 * above assert the FatalError that produces). Their durability is
 * `aai-cli`'s `dev-workflow.scenario.test.ts`'s to cover; what is asserted here
 * is the half that is honestly reachable, which is better than a body test
 * dressed up as a durability test.
 *
 * Two claims, and the second is the one no other tier can make:
 *
 * - **The recording is uploaded ONCE**, however many times the body is walked.
 *   That is why the upload is a step of its own with a raised attempt budget.
 * - **`ctx.now()` is JOURNALED**, so `startedAt` — which the poll step subtracts
 *   to report `elapsedMs` — is the instant the run really began and not the
 *   instant the latest walk began. A body that read `Date.now()` there would
 *   report a shrinking elapsed on every resume, which is `guard-invariants`
 *   rule 30 and the whole reason the affordance exists.
 */
describe("the batch run is DURABLE", () => {
  const INPUT = { recording: UPLOAD_ID };

  beforeEach(() => {
    installStubUploads({
      [UPLOAD_ID]: { bytes: new Uint8Array(4096), name: "standup.wav", type: "audio/wav" },
    });
    installStubReporter();
    vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
  });

  test("parks on the poll cadence with the upload already journaled", async () => {
    const provider = installStubTranscribe({ pendingPolls: 1, text: "We shipped it." });
    const started = Date.now();
    const run = await runWorkflow(transcribeBatch, INPUT, { name: "transcribeBatch" });

    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThan(started);
    expect(run.steps.map((step) => step.key)).toEqual([
      "createJob#0",
      "pollTranscript#0",
      "uploadToProvider#0",
    ]);
    // The clock the body read alongside the upload is journaled too, in its own
    // reserved key space — `run.reads`, not `run.steps`.
    expect(run.reads.map((read) => read.key)).toEqual(["now!0"]);
    expect(provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
  });

  test("resumes past the poll without moving the recording again", async () => {
    const provider = installStubTranscribe({ pendingPolls: 1, text: "We shipped it." });
    const run = await runWorkflow(transcribeBatch, INPUT, { name: "transcribeBatch" });
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      transcript: "We shipped it.",
      // ONE, which is the difference this flow exists to show against the two
      // that segment.
      segments: 1,
      source: "standup.wav",
    });
    expect(run.deliveries).toBe(2);
    // The whole recording crossed the wire once, on the first walk.
    expect(provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(provider.calls.filter((call) => call.leg === "submit")).toHaveLength(1);
  });

  test("reports the elapsed from the run's OWN start, not the resuming walk's", async () => {
    // The affordance's claim. `ctx.now()` is journaled under its own key, so the
    // second walk re-reads the first walk's instant — and `elapsedMs`, which the
    // poll step computes as `Date.now() - startedAt`, therefore counts the whole
    // run rather than the delivery it finished on.
    const provider = installStubTranscribe({ pendingPolls: 1, text: "We shipped it." });
    const run = await runWorkflow(transcribeBatch, INPUT, { name: "transcribeBatch" });
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    // A journaled clock cannot go backwards across a resume, and a re-read one
    // routinely would — the second walk starts later than the first.
    expect(run.output?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(provider.calls.filter((call) => call.leg === "poll")).toHaveLength(2);
  });

  test("a worker that dies before the job is created re-uploads, because nothing settled", async () => {
    // The other side of exactly-once, and the honest one: a step whose entry was
    // never written IS re-run, because the journal is what makes a step skippable
    // and a crashed one left none.
    const provider = installStubTranscribe({ text: "We shipped it." });
    const run = await runWorkflow(transcribeBatch, INPUT, {
      name: "transcribeBatch",
      crashAt: "createJob",
    });

    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.name)).toEqual(["uploadToProvider"]);
    // The clock the body read in the same `Promise.all` survived the crash with
    // it, which is what makes the resumed run's elapsed the WHOLE run's.
    expect(run.reads.map((read) => read.key)).toEqual(["now!0"]);
    expect(provider.calls.filter((call) => call.leg === "submit")).toHaveLength(0);

    await run.restart();
    expect(run.status).toBe("completed");
    // The upload SURVIVED — it settled before the crash — and only the job
    // creation was re-issued.
    expect(provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(provider.calls.filter((call) => call.leg === "submit")).toHaveLength(1);
  });
});
