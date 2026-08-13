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
 * `dev-workflow.integration.test.ts`, which builds a project and runs one.
 *
 * The WAV half is worth its own section because it is where a silent bug lives:
 * a cut that lands mid-frame, or an off-by-one in the chunk walk, produces audio
 * the decoder happily transcribes into confident nonsense.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import agentDef, { transcribe } from "./agent.ts";
import {
  clock,
  mergeTranscript,
  splitRecording,
  stitchTranscript,
  transcribeSegment,
} from "./workflows/transcribe.ts";
import {
  blockAlign,
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

describe("the agent declares its workflow and nothing else", () => {
  test("under the name the REST route resolves it by", () => {
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["transcribe"]);
    expect(agentDef.workflows?.transcribe).toBe(transcribe);
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
      recordingUrl: "https://example.com/standup.wav",
      languageCode: "en",
    });
    expect(result?.issues).toBeUndefined();
  });

  test("defaults the language, so the picker's absence is not an error", async () => {
    const result = await transcribe.input?.["~standard"].validate({
      recordingUrl: "https://example.com/standup.wav",
    });
    // Re-tested rather than trusted: a Standard Schema result is a union, so
    // this is what makes `value` reachable without a cast.
    expect(result?.issues).toBeUndefined();
    if (result?.issues) expect.fail("expected the submission to validate");
    expect(result?.value).toMatchObject({ languageCode: "en" });
  });

  test("rejects something that is not a URL at the call site rather than in a step", async () => {
    // A 400 on the POST, with the run never created, instead of a failed run
    // discovered a minute later.
    const result = await transcribe.input?.["~standard"].validate({ recordingUrl: "standup.wav" });
    expect(result?.issues).toBeDefined();
  });

  test("rejects a language the endpoint does not know", async () => {
    const result = await transcribe.input?.["~standard"].validate({
      recordingUrl: "https://example.com/a.wav",
      languageCode: "kl",
    });
    expect(result?.issues).toBeDefined();
  });

  test("describes both fields, which is what labels them on the page", async () => {
    // `<WorkflowFields>` renders a control per scalar property and uses each
    // `.describe()` as its hint, so a missing description is a bare field.
    // Narrowed rather than cast: `input` is a Standard Schema, and only a
    // `ZodObject` has the `shape` this reads.
    const schema = transcribe.input;
    if (!(schema instanceof z.ZodObject)) expect.fail("expected a zod object schema");
    expect(schema.shape.recordingUrl?.description).toBeTruthy();
    expect(schema.shape.languageCode?.description).toBeTruthy();
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
  /** A `fetch` serving `file` and honouring `Range` the way a CDN does. */
  function serve(file: Uint8Array, opts: { honourRange?: boolean } = {}) {
    const honourRange = opts.honourRange ?? true;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const header = String((init.headers as Record<string, string>).Range ?? "");
        calls.push(header);
        if (!honourRange) return new Response(file.slice(), { status: 200 });
        const [start, end] = header.replace("bytes=", "").split("-").map(Number);
        return new Response(file.slice(start, (end ?? 0) + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${file.length}` },
        });
      }),
    );
    return calls;
  }

  test("asks for only the header, not the whole recording", async () => {
    // The reason a sixty-segment run moves the recording once rather than
    // sixty times: every read is a byte range.
    const calls = serve(concat(wavFile(MONO_16K, 320_000), new Uint8Array(320_000)));
    await splitRecording("https://example.com/a.wav");
    expect(calls[0]).toMatch(/^bytes=0-\d+$/);
  });

  test("plans the segments and reports the duration", async () => {
    const seconds = 200;
    const bytes = seconds * MONO_16K.sampleRate * blockAlign(MONO_16K);
    serve(concat(wavFile(MONO_16K, bytes), new Uint8Array(bytes)));

    const plan = await splitRecording("https://example.com/a.wav");
    expect(plan.format.sampleRate).toBe(MONO_16K.sampleRate);
    expect(plan.segments.length).toBeGreaterThan(1);
    expect(plan.durationMs).toBe(seconds * 1000);
  });

  test("still works against a server that ignores Range", async () => {
    // "Wherever your recording is hosted" is not a server this template gets to
    // choose, so a 200 carrying the whole file has to be sliced here.
    const bytes = 320_000;
    serve(concat(wavFile(MONO_16K, bytes), new Uint8Array(bytes)), { honourRange: false });
    const plan = await splitRecording("https://example.com/a.wav");
    expect(plan.format.dataStart).toBe(44);
  });

  test("fails FATALLY on a URL that will never answer differently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    // A 404 does not become a 200 on the fourth attempt.
    await expect(splitRecording("https://example.com/gone.wav")).rejects.toThrow(/HTTP 404/);
  });

  test("throws plainly on a server error, which is what a retry wants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(splitRecording("https://example.com/a.wav")).rejects.toThrow(/HTTP 503/);
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

  /** Records the audio fetch and the sync request; answers both. */
  function stubProvider(sync: { status?: number; body?: unknown } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.startsWith(SYNC_ORIGIN)) {
          return new Response(JSON.stringify(sync.body ?? { text: "hello there" }), {
            status: sync.status ?? 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(new Uint8Array(SEGMENT.end - SEGMENT.start), {
          status: 206,
          headers: { "Content-Range": `bytes 44-32043/${FORMAT.dataEnd}` },
        });
      }),
    );
    return calls;
  }

  test("sends the segment as a WAV, with the key and the model header", async () => {
    const calls = stubProvider();
    const result = await transcribeSegment("https://example.com/a.wav", FORMAT, SEGMENT, "en");

    expect(result).toEqual({ index: 0, text: "hello there" });
    const sync = calls.find((call) => call.url.startsWith(SYNC_ORIGIN));
    const headers = sync?.init.headers as Record<string, string>;
    // The raw key: this endpoint takes it unprefixed, and `Bearer ` in front of
    // it is a 401 that reads like a wrong key.
    expect(headers.Authorization).toBe("sk-test");
    expect(headers["X-AAI-Model"]).toBe("universal-3-5-pro");
    expect(sync?.init.body).toBeInstanceOf(FormData);
  });

  test("carries the language the run asked for", async () => {
    const calls = stubProvider();
    await transcribeSegment("https://example.com/a.wav", FORMAT, SEGMENT, "de");
    const body = calls.find((call) => call.url.startsWith(SYNC_ORIGIN))?.init.body as FormData;
    expect(await (body.get("config") as Blob).text()).toContain('"de"');
  });

  test("fails FATALLY with no API key rather than retrying five times", async () => {
    vi.stubEnv("ASSEMBLYAI_API_KEY", "");
    stubProvider();
    await expect(
      transcribeSegment("https://example.com/a.wav", FORMAT, SEGMENT, "en"),
    ).rejects.toThrow(/ASSEMBLYAI_API_KEY/);
  });

  test("throws plainly on a rate limit, which is the expected failure", async () => {
    stubProvider({ status: 429, body: { detail: "slow down" } });
    await expect(
      transcribeSegment("https://example.com/a.wav", FORMAT, SEGMENT, "en"),
    ).rejects.toThrow(/HTTP 429 — slow down/);
  });

  test("fails FATALLY on a rejected request, naming what the endpoint said", async () => {
    stubProvider({ status: 400, body: { error_code: "audio_too_short", message: "too short" } });
    await expect(
      transcribeSegment("https://example.com/a.wav", FORMAT, SEGMENT, "en"),
    ).rejects.toThrow(/HTTP 400 — too short/);
  });

  test("retries beyond the default, because a rate limit is expected", () => {
    expect(transcribeSegment.maxRetries).toBeGreaterThan(3);
  });
});

describe("mergeTranscript", () => {
  test("stitches the segments in index order, whatever order they arrive in", async () => {
    const merged = await mergeTranscript("https://example.com/a.wav", 12_000, [
      { index: 1, text: "on Friday if the tests pass" },
      { index: 0, text: "we ship on Friday" },
    ]);
    expect(merged.transcript).toBe("we ship on Friday if the tests pass");
    expect(merged.words).toBe(8);
    expect(merged).toMatchObject({ segments: 2, durationMs: 12_000 });
  });

  test("carries the source through, so a run says what it transcribed", async () => {
    const merged = await mergeTranscript("https://example.com/a.wav", 1000, [
      { index: 0, text: "hi" },
    ]);
    expect(merged.source).toBe("https://example.com/a.wav");
  });
});

/** Two byte arrays end to end. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
