// Copyright 2026 the AAI authors. MIT license.
// An EVAL for a WORKFLOW APP: does the run actually do the work? Run it with
// `aai eval`.
//
// `agent.test.ts` asserts about the declaration, drives the four steps one at a
// time, and covers the WAV arithmetic as pure functions. This drives the WHOLE
// BODY — `transcribeFlow` from the top — and what it is here to check is the one
// thing no per-step spec can see: that a recording is really planned, really
// fanned out, and really stitched back into one transcript in the right order.
//
// `describeWorkflowEval` picks the providers for you and says which it picked:
//
//   * with `ASSEMBLYAI_API_KEY` — a LIVE run. The `{ live: true }` case below
//     downloads a real four-minute news clip, converts it with a real ffmpeg,
//     and puts four real requests through the sync endpoint. That spends money
//     and about a minute.
//   * without one — a SCRIPTED run: the same body, the same plan, the same
//     stitch, with the endpoint answered in memory.
//
// Two of the three cases are SCRIPTED IN BOTH MODES, deliberately. Their claims
// are about the PLAN and the SEAM — which window each request got, and what the
// merge does where two segments overlap — and those are facts about arithmetic
// that a live provider can neither confirm nor deny. The live case is the one
// that answers "is the transcript really of the recording".
//
// WHAT NO EVAL HERE COVERS: durability. Imported through vitest with no bundler
// in the path, a workflow body is an ordinary async function — no
// journal, no replay, and no per-step retry, so the resume-after-segment-27
// property this template exists to demonstrate is NOT exercised here, and a
// rate-limited live run fails where a deployed one would have ridden it out.
// `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier that really resumes a
// run.
import { encodeWav } from "@alexkroman1/aai/step";
import { installStubTranscribe, installStubUploads } from "@alexkroman1/aai/testing/vitest";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef, { transcribe } from "./agent.ts";
import { TRANSCRIPT_STREAM } from "./workflows/stitch.ts";
import { SEGMENT_SECONDS } from "./workflows/wav.ts";

/** The id every case uploads under. */
const UPLOAD_ID = "upl_eval";

/** 16 kHz mono 16-bit — the format `normalize.ts` converts everything TO. */
const MONO_16K = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 } as const;
/** Bytes one second of that format occupies. */
const BYTES_PER_SECOND = MONO_16K.sampleRate * MONO_16K.channels * (MONO_16K.bitsPerSample / 8);

/**
 * Long enough to force a THREE-segment fan-out, which is the shape worth
 * driving: one segment exercises no plan, two exercise one seam, three exercise
 * a middle segment that is neither first nor last.
 */
const SCRIPTED_SECONDS = 200;

/**
 * A real, parseable, linear-PCM WAV of silence.
 *
 * Silence is fine here because the scripted cases never send it anywhere: what
 * they assert is which BYTE RANGE each request was handed, and the bytes only
 * have to be as long as the header says. It also takes the fast path through
 * `normalizeRecording` — `parseWav` accepts it, so no ffmpeg is involved, which
 * is what keeps these two cases runnable with no binary on `PATH`.
 */
const SCRIPTED_WAV = encodeWav(new Uint8Array(SCRIPTED_SECONDS * BYTES_PER_SECOND), MONO_16K);

/** The public sample recording — four minutes of real speech, on a real CDN. */
const LIVE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** Publish one in-memory upload store, writable because the converter needs one. */
function publish(bytes: Uint8Array, name: string, type: string) {
  // `writable: true` is not optional for this template: `normalizeRecording`
  // writes the CONVERTED file back as a new upload, and a read-only store would
  // fail that step by name — which is the store telling the truth, and not what
  // these cases are about.
  return installStubUploads({ [UPLOAD_ID]: { bytes, name, type } }, { writable: true });
}

/**
 * Does this request body carry a WAV header?
 *
 * Scanned as BYTES rather than decoded: the body is a multipart envelope around
 * megabytes of audio, so `String(bytes)` is a comma-joined number list — which
 * makes the assertion pass or fail for the wrong reason and prints five
 * megabytes of it when it fails.
 */
function carriesWavHeader(body: Uint8Array | string | undefined): boolean {
  if (!(body instanceof Uint8Array)) return false;
  const riff = [0x52, 0x49, 0x46, 0x46];
  for (let at = 0; at <= body.length - riff.length; at++) {
    if (riff.every((byte, offset) => body[at + offset] === byte)) return true;
  }
  return false;
}

/** The transcript chunks the run streamed, in the order they landed. */
function streamed(run: { emitted: readonly { namespace: string; chunk: unknown }[] }) {
  return run.emitted
    .filter((one) => one.namespace === TRANSCRIPT_STREAM)
    .map((one) => one.chunk as { index: number; startMs: number; endMs: number; text: string });
}

describeWorkflowEval(agentDef, (test) => {
  test("plans the fan-out from the header and gives each request its own window", async ({
    app,
  }) => {
    // Scripted in both modes: the claim is which WINDOW each of the three
    // requests was handed, and a live endpoint cannot answer that — it can only
    // transcribe whatever it is sent. This is the case that catches an
    // off-by-one in the plan, which otherwise produces audio the decoder
    // transcribes into confident nonsense.
    publish(SCRIPTED_WAV, "standup.wav", "audio/wav");
    const provider = installStubTranscribe({
      text: ["the first stretch", "the middle stretch", "the last stretch"],
    });

    const run = await app.run(transcribe, { recording: UPLOAD_ID });

    expect(run.error).toBeUndefined();
    expect(run.status).toBe("completed");
    const output = run.output;
    if (output === undefined) expect.fail("a completed run must carry an output");

    // Three segments over 200 seconds at a 90-second stride, and the durations
    // are the plan: each segment carries the 2-second OVERLAP that stops a cut
    // landing mid-word, so they deliberately do not abut.
    expect(output.segments).toBe(3);
    expect(output.durationMs).toBe(SCRIPTED_SECONDS * 1000);
    expect(streamed(run).map((chunk) => [chunk.index, chunk.startMs, chunk.endMs])).toEqual([
      [0, 0, (SEGMENT_SECONDS + 2) * 1000],
      [1, SEGMENT_SECONDS * 1000, (2 * SEGMENT_SECONDS + 2) * 1000],
      [2, 2 * SEGMENT_SECONDS * 1000, SCRIPTED_SECONDS * 1000],
    ]);

    // One sync request per segment, each carrying a WHOLE WAV — the endpoint
    // decodes every request independently, so a window with no header put back
    // on it is bytes it refuses.
    const sync = provider.calls.filter((call) => call.leg === "sync");
    expect(sync).toHaveLength(3);
    expect(sync.map((call) => carriesWavHeader(call.body))).toEqual([true, true, true]);
    // The first two segments are a full stride plus the overlap; the last is the
    // remainder, and is therefore much smaller. A plan that ran off the end of
    // the file would show up here as a last segment the size of the others.
    const sizes = sync.map((call) => call.body?.length ?? 0);
    expect(sizes[0]).toBeGreaterThan((SEGMENT_SECONDS + 1) * BYTES_PER_SECOND);
    expect(sizes[2]).toBeLessThan(sizes[0] ?? 0);

    // Stitched in INDEX order, not completion order.
    expect(output.transcript).toBe("the first stretch the middle stretch the last stretch");
    // Reported before the fan-out, which is what makes a long run legible.
    expect(run.reported).toContain("Split 3:20 of audio into 3 segments.");
  });

  test("drops the repeated words where two segments overlap", async ({ app }) => {
    // Scripted in both modes for the same reason: the overlap exists so a cut
    // never lands mid-word, and what makes that free is the merge dropping ONE
    // copy of the repeated run. A live provider cannot be asked to produce a
    // seam on demand, and this is where a regression would be invisible — a
    // missed seam repeats a few words, a false one DELETES speech.
    publish(SCRIPTED_WAV, "standup.wav", "audio/wav");
    installStubTranscribe({
      text: [
        "the fire moved north through the valley overnight",
        "through the valley overnight and reached the ridge by dawn",
        "by dawn the crews had contained it",
      ],
    });

    const run = await app.run(transcribe, { recording: UPLOAD_ID });

    expect(run.error).toBeUndefined();
    const transcript = run.output?.transcript ?? "";
    expect(transcript).toBe(
      "the fire moved north through the valley overnight and reached the ridge by dawn the crews had contained it",
    );
    // The repeated runs appear once each, which is the whole claim.
    expect(transcript.match(/overnight/g)).toHaveLength(1);
    expect(transcript.match(/by dawn/g)).toHaveLength(1);
  });

  test(
    "really transcribes a real recording, end to end",
    async ({ app }) => {
      // LIVE ONLY, and it is the case that earns the template its name. Three
      // separate things have to be real for it to pass: ffmpeg has to convert an
      // MP3 into something the plan can cut, the plan has to cover the whole
      // recording, and every segment's request has to come back with the words
      // that are actually in it.
      //
      // It needs `ffmpeg` on `PATH` (or `AAI_FFMPEG_PATH`), which is what the
      // template's own doc says a developer needs for anything that is not
      // already a WAV. A deployed guest's image installs it.
      const response = await fetch(LIVE_RECORDING);
      expect(response.ok).toBe(true);
      const mp3 = new Uint8Array(await response.arrayBuffer());
      publish(mp3, "wildfires.mp3", "audio/mpeg");

      const run = await app.run(transcribe, { recording: UPLOAD_ID });

      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
      const output = run.output;
      if (output === undefined) expect.fail("a completed run must carry an output");

      // ffmpeg ran, and the run said so before spending minutes on it.
      expect(run.reported.some((line) => line.startsWith("Converting wildfires.mp3"))).toBe(true);
      // The FILENAME a reader sees is the one they uploaded, not the converted
      // artifact's — `mergeTranscript` reads the ORIGINAL id for exactly this.
      expect(output.source).toBe("wildfires.mp3");

      // Four and a half minutes, so the plan really fanned out rather than
      // sending one request.
      expect(output.segments).toBeGreaterThanOrEqual(3);
      expect(output.durationMs).toBeGreaterThan(250_000);

      // Every segment came back with words in it, which is how "the whole
      // recording was covered" is checked rather than assumed: a plan that ran
      // past the end would leave a silent tail segment here.
      const chunks = streamed(run);
      expect(chunks).toHaveLength(output.segments);
      for (const chunk of chunks) expect(chunk.text.length).toBeGreaterThan(0);

      // And the transcript is of THIS recording — a news segment about smoke
      // from Canadian wildfires reaching the US east coast.
      expect(output.transcript).toMatch(/wildfire/i);
      expect(output.transcript).toMatch(/canada/i);
      expect(output.transcript).toMatch(/air quality/i);
      // ~4.5 minutes of speech is several hundred words; a stitch that kept only
      // the first segment would land far under this.
      expect(output.words).toBeGreaterThan(400);
    },
    { live: true },
  );
});
