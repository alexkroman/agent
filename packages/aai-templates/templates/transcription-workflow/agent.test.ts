// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the transcription desk's declaration, its WAV arithmetic, and its
 * steps.
 *
 * **The body itself is not driven here, and that is a property of what this
 * template demonstrates rather than a gap in the spec.** Imported through vitest
 * with no bundler in the path, a `"use step"` function is an ordinary async
 * function — so its retries, its `FatalError` guards, its HTTP handling and its
 * merge are all testable, while durability, suspension and replay are not. A
 * body test that looked like a durability test would be the worse failure; the
 * real thing is exercised end to end by `aai-cli`'s
 * `dev-workflow.scenario.test.ts`, which builds a project and runs one.
 *
 * The WAV half is worth its own section because it is where a silent bug lives:
 * a cut that lands mid-frame, or an off-by-one in the chunk walk, produces audio
 * the decoder happily transcribes into confident nonsense.
 */

import { stubStepFetch, stubUploads } from "@alexkroman1/aai/testing";
import { readUpload } from "@alexkroman1/aai/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";
import agentDef, { transcribe, transcribeBatch, transcribeStream } from "./agent.ts";
import { createJob, pollTranscript, readTranscript, uploadToProvider } from "./workflows/batch.ts";
import { planStreamed, probeUpload } from "./workflows/stream.ts";

import {
  clock,
  mergeTranscript,
  splitRecording,
  stitchTranscript,
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
  wavWithHeader,
} from "./workflows/wav.ts";

/** Where the sync endpoint lives — the one URL these stubs answer differently. */
const SYNC_ORIGIN = "https://sync.assemblyai.com";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/**
 * A fixed run-start epoch, so `elapsedMs` is assertable at all.
 *
 * `startClock` is a step in production; a spec supplies the value directly, which is
 * the point of threading it as an argument rather than reading a clock inside the
 * merge — the duration is then a function of journaled values and not of how long the
 * test took.
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
  restore = stubUploads({ [UPLOAD_ID]: { bytes, name, type: "audio/wav" } });
}

/** Unpublished between specs — a slot left behind reaches the next file. */
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

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
    for (const flow of [transcribe, transcribeStream, transcribeBatch]) {
      expect(flow.uploads).toEqual(["recording"]);
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

describe("wavWithHeader", () => {
  test("writes a header the endpoint can read the rate back out of", () => {
    const samples = new Uint8Array(3200).fill(7);
    const out = wavWithHeader({ ...MONO_16K, dataStart: 44, dataEnd: 3244 }, samples);
    const view = new DataView(out.buffer);

    expect(String.fromCharCode(...out.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...out.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(MONO_16K.sampleRate);
    expect(view.getUint16(22, true)).toBe(MONO_16K.channels);
    // The two lengths, which are what a decoder trusts: RIFF counts everything
    // after itself, `data` counts only the samples.
    expect(view.getUint32(4, true)).toBe(36 + samples.length);
    expect(view.getUint32(40, true)).toBe(samples.length);
    expect(out.subarray(44)).toEqual(samples);
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

describe("clock", () => {
  test("renders a position a reader can find in the recording", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_000)).toBe("1:05");
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
   * `stubStepFetch`, not `vi.stubGlobal("fetch", …)`: the step calls `stepFetch`,
   * which reaches a published slot rather than the global — see
   * `sdk/step-fetch.ts` for why it has to (HTTP/1.1, so a batch of segments gets
   * a socket each instead of N streams on one connection). Stubbing the global
   * still passes, because an unpublished slot falls back to it, and would be
   * asserting against a path production does not take.
   */
  function stubProvider(
    sync: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    publishRecording(new Uint8Array(FORMAT.dataEnd));
    const stub = stubStepFetch(() => ({
      status: sync.status ?? 200,
      body: sync.body ?? { text: "hello there" },
      ...(sync.headers && { headers: sync.headers }),
    }));
    stubs.push(stub.restore);
    return stub.calls;
  }

  /** Unpublished per test — a live one answers the next file's steps. */
  const stubs: (() => void)[] = [];
  afterEach(() => {
    for (const restore of stubs.splice(0)) restore();
  });

  test("sends the segment as a WAV, with the key and the model header", async () => {
    const calls = stubProvider();
    const result = await transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT);

    expect(result).toEqual({ index: 0, text: "hello there" });
    const sync = calls.find((call) => call.url.startsWith(SYNC_ORIGIN));
    // The raw key: this endpoint takes it unprefixed, and `Bearer ` in front of
    // it is a 401 that reads like a wrong key.
    expect(sync?.headers.Authorization).toBe("sk-test");
    expect(sync?.headers["X-AAI-Model"]).toBe("universal-3-5-pro");
    // BYTES, and multipart — `stepFetch` takes no `FormData`, which is the
    // point: a branded object handed to a fetch from another undici realm goes
    // out as the string `[object FormData]`. `multipartBody` builds the envelope.
    expect(sync?.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = sync?.body;
    expect(body).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(body as Uint8Array);
    expect(decoded).toContain('name="audio"; filename="segment-0.wav"');
    // The WAV really rides in the part, header and all.
    expect(decoded).toContain("RIFF");
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
    stubProvider({ status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "30" } });
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
    stubProvider({ status: 429, body: { detail: "slow down" } });
    await expect(transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT)).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  test("fails FATALLY on a rejected request, naming what the endpoint said", async () => {
    stubProvider({ status: 400, body: { error_code: "audio_too_short", message: "too short" } });
    await expect(transcribeSegment(UPLOAD_ID, FORMAT, SEGMENT)).rejects.toThrow(
      /HTTP 400 — too short/,
    );
  });

  test("retries beyond the default, because a rate limit is expected", () => {
    expect(transcribeSegment.maxRetries).toBeGreaterThan(3);
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
 * body is not, because imported through vitest a `"use step"` function is an ordinary
 * async function. Almost nothing here is new — the transcribing and the merging are
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
    restore = stubUploads({
      [UPLOAD_ID]: { bytes, name: "standup.wav", type: "audio/wav", complete },
    });
  }

  test("probeUpload reports what has ARRIVED and whether that is all", async () => {
    publishPartial(1000, 320_000);
    // The poll the body runs. `complete` is separate from `size` because a size that
    // stopped growing is not a claim that the file is finished.
    await expect(probeUpload(UPLOAD_ID)).resolves.toEqual({ size: 44 + 1000, complete: false });
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
    restore = stubUploads({ [UPLOAD_ID]: { bytes, complete: false } });
    await expect(planStreamed(UPLOAD_ID)).rejects.toThrow(/declares no data length/);
  });

  test("planStreamed refuses a file that is not a WAV, terminally", async () => {
    restore = stubUploads({ [UPLOAD_ID]: { bytes: new Uint8Array(2000), complete: false } });
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

  const batchStubs: (() => void)[] = [];
  afterEach(() => {
    for (const undo of batchStubs.splice(0)) undo();
  });

  /** Answer the async API, recording what was sent. */
  function stubBatch(answer: (url: string) => { status?: number; body?: unknown }) {
    const stub = stubStepFetch((req) => answer(req.url));
    batchStubs.push(stub.restore);
    return stub.calls;
  }

  test("uploadToProvider streams the file and answers with the provider's URL", async () => {
    publishRecording(new Uint8Array(5000), "standup.wav");
    const calls = stubBatch(() => ({ body: { upload_url: "https://cdn.example/abc" } }));
    await expect(uploadToProvider(UPLOAD_ID)).resolves.toEqual({
      audioUrl: "https://cdn.example/abc",
    });
    expect(calls.map((one) => one.url)).toEqual(["https://api.assemblyai.com/v2/upload"]);
  });

  test("the file is STREAMED, so a step never holds a whole recording", async () => {
    publishRecording(new Uint8Array(5000), "standup.wav");
    const calls = stubBatch(() => ({ body: { upload_url: "https://cdn.example/abc" } }));
    await uploadToProvider(UPLOAD_ID);
    // `stubStepFetch` drains a streaming body into bytes, so what this asserts is that
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
    const calls = stubBatch(() => ({ status: 400, body: { error: "bad field" } }));
    await expect(createJob("https://cdn.example/abc")).rejects.toBeInstanceOf(FatalError);
    // One call, and it is not the upload.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.assemblyai.com/v2/transcript");
  });

  test("createJob asks for `speech_models`, plural — the singular field is a 400", async () => {
    publishRecording(new Uint8Array(10));
    const calls = stubBatch(() => ({ body: { id: "tr_1" } }));
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
    stubBatch(() => ({ body: { status: "error", error: "audio too quiet" } }));
    // The provider has decided; no number of polls changes it, so this must not come
    // back as "not done yet".
    await expect(pollTranscript("tr_1")).rejects.toBeInstanceOf(FatalError);
  });

  test("pollTranscript answers `done` on completed and not before", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch(() => ({ body: { status: "processing" } }));
    await expect(pollTranscript("tr_1")).resolves.toEqual({ done: false, status: "processing" });
  });

  test("an unknown status is NOT done, so a new one cannot end a run early", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch(() => ({ body: {} }));
    await expect(pollTranscript("tr_1")).resolves.toMatchObject({ done: false });
  });

  test("readTranscript reports the provider's own duration and ONE segment", async () => {
    publishRecording(new Uint8Array(10), "standup.wav");
    stubBatch(() => ({ body: { text: "  hello there  ", audio_duration: 12.5 } }));
    await expect(readTranscript(UPLOAD_ID, "tr_1", STARTED_AT)).resolves.toMatchObject({
      source: "standup.wav",
      // Not a fudge: the async API transcribed the recording in one piece, which is
      // the difference this flow is here to show.
      segments: 1,
      durationMs: 12_500,
      words: 2,
      transcript: "hello there",
    });
  });

  test("a rate limit is RETRYABLE, so a busy minute does not fail the run", async () => {
    publishRecording(new Uint8Array(10));
    stubBatch(() => ({ status: 429, body: { error: "slow down" } }));
    await expect(pollTranscript("tr_1")).rejects.toBeInstanceOf(RetryableError);
  });

  test("all three flows report the same SHAPE, which is what lets one page render any", async () => {
    publishRecording(new Uint8Array(10), "standup.wav");
    stubBatch(() => ({ body: { text: "hi", audio_duration: 1 } }));
    const batched = await readTranscript(UPLOAD_ID, "tr_1", STARTED_AT);
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
