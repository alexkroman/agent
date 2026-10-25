// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the spoken-summary-workflow app's declaration and its legs.
 *
 * The legs this template OWNS — summarize, speak — are ordinary exported async
 * functions, so what they return and how they fail are testable directly; the
 * transcription leg is the SDK's `transcribeUploadDurably` and is exercised
 * only through the body. **And the body IS driven**, on the real replay engine
 * — the last block — which is the one tier at which this app's central claim
 * is checkable: the recording is uploaded and transcribed ONCE, however many
 * times the body is walked.
 *
 * `speak` is where a step SPEAKS and STORES, and the assertion that matters is
 * that it returns an id rather than bytes — a step is journaled by its return
 * value, and audio in one is megabytes replayed on every resume.
 */

import {
  parseWav,
  pcmDurationMs,
  STEP_SPEAK_SAMPLE_RATE,
  stepReadUpload,
  stepUploadInfo,
  TRANSCRIBE_DURABLY_STEPS,
  WAV_HEADER_BYTES,
} from "@alexkroman1/aai/step";
import { ASSEMBLYAI_TTS_DEFAULT_VOICE } from "@alexkroman1/aai/tts";
import {
  createWorkflowContext,
  runWorkflow,
  STUB_SPEECH_PCM_BYTES,
  type StubTranscribeOptions,
} from "@alexkroman1/aai-runtime/testing";
import { installStubWorld, type StubWorldOptions } from "@alexkroman1/aai-runtime/testing/vitest";
import { describe, expect, test } from "vitest";
import agentDef, { spokenSummary, VOICES } from "./agent.ts";
import { speak, spokenSummaryFlow, summarize } from "./workflows/summarize.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/**
 * How long a PCM16 payload of `bytes` lasts, measured the way the step does.
 *
 * `pcmDurationMs` at `STEP_SPEAK_SAMPLE_RATE` is exactly the arithmetic
 * `stepSpeak` runs on the synthesizer's answer, so the durations below are
 * DERIVED from the SDK's own rate rather than three unexplained milliseconds.
 */
const spokenMs = (bytes: number) => pcmDurationMs(bytes, { sampleRate: STEP_SPEAK_SAMPLE_RATE });

const SUMMARY = {
  headline: "Launch is on",
  points: ["Ship Tuesday"],
  spoken: "The launch is on for Tuesday.",
};

/**
 * Every seam a run reaches, in one call: the store holding the recording
 * (WRITABLE, because this app's whole second half stores a file — opt-in
 * precisely so a step that wrote one nobody meant it to would fail), the
 * provider, the model and the voice.
 */
function world(options: Omit<StubWorldOptions, "uploads" | "uploadsOptions"> = {}) {
  return installStubWorld({
    uploads: { [UPLOAD_ID]: { bytes: new Uint8Array(64), name: "standup.wav", type: "audio/wav" } },
    uploadsOptions: { writable: true },
    speech: true,
    ...options,
  });
}

/** A provider answering one finished transcript, after `pendingPolls` not-yet polls. */
function provider(options: StubTranscribeOptions = {}): StubTranscribeOptions {
  return {
    audioUrl: "https://cdn/aai/1",
    text: "we ship tuesday and two bugs are left",
    durationSec: 42,
    ...options,
  };
}

describe("the declaration", () => {
  test("takes the recording as an UPLOAD, which is what makes the form a file picker", () => {
    expect(spokenSummary.uploads).toEqual(["recording"]);
  });

  test("offers real voice ids, so the synthesis cannot fail silently in band", async () => {
    const parsed = spokenSummary.input?.["~standard"].validate({
      recording: UPLOAD_ID,
      voice: "not-a-voice",
    });

    expect((await parsed)?.issues).toBeTruthy();
    expect(
      (
        await spokenSummary.input?.["~standard"].validate({
          recording: UPLOAD_ID,
          voice: ASSEMBLYAI_TTS_DEFAULT_VOICE,
        })
      )?.issues,
    ).toBeUndefined();
  });

  test("the voice that fills in when nobody chooses is one the form would have offered", () => {
    // `voice` is OPTIONAL, so an unchosen summary is read by the SDK's own
    // default rather than by anything this template names.
    expect(VOICES).toContain(ASSEMBLYAI_TTS_DEFAULT_VOICE);
  });
});

describe("summarizing", () => {
  test("asks the model for a spoken script as well as points, and keeps both", async () => {
    const { model } = world({
      model: JSON.stringify({
        headline: "Launch is on",
        points: ["Ship Tuesday", "Two bugs left"],
        spoken: "The launch is on for Tuesday, with two bugs still open.",
      }),
    });

    const summary = await summarize("we ship tuesday");

    expect(summary.headline).toBe("Launch is on");
    expect(summary.points).toEqual(["Ship Tuesday", "Two bugs left"]);
    expect(summary.spoken).toBe("The launch is on for Tuesday, with two bugs still open.");
    // The prompt really carries the transcript, and the schema the SDK appends
    // really asks for the two shapes — a page that got bullets read aloud is
    // the failure this prevents.
    expect(model[0]?.prompt).toContain("we ship tuesday");
    expect(model[0]?.system).toContain("READ ALOUD");
  });

  test("caps the points at what the schema promises the page", async () => {
    world({
      model: JSON.stringify({
        headline: "Many things",
        points: ["a", "b", "c", "d", "e", "f"],
        spoken: "Several things happened.",
      }),
    });

    expect((await summarize("…")).points).toHaveLength(4);
  });

  test("a reply with no spoken script FAILS rather than defaulting to silence", async () => {
    world({ model: JSON.stringify({ headline: "Launch is on", points: ["Ship Tuesday"] }) });

    await expect(summarize("…")).rejects.toThrow(/did not match the shape/);
  });
});

describe("speaking", () => {
  test("stores a WAV and returns its ID — never the bytes", async () => {
    const { speech } = world({ speech: { pcmBytes: 48_000 } });

    const spoken = await speak("The launch is on for Tuesday.");

    // An id, because a step is journaled by its return value: audio in one is
    // megabytes replayed on every resume.
    expect(spoken).toEqual({ audio: "upl_stub_1", durationMs: spokenMs(48_000) });
    expect(speech[0]?.text).toBe("The launch is on for Tuesday.");
  });

  test("what it stored is a real WAV, named and typed for the browser", async () => {
    const PCM_BYTES = 4000;
    world({ speech: { pcmBytes: PCM_BYTES } });

    const { audio } = await speak("Hello.");

    await expect(stepUploadInfo(audio)).resolves.toMatchObject({
      name: "summary.wav",
      // The byte route serves this as `Content-Type`, and a browser will not
      // play inline a file it was handed as octet-stream.
      type: "audio/wav",
      size: WAV_HEADER_BYTES + PCM_BYTES,
    });

    // Handed to the SDK's OWN reader rather than checked for `RIFF`/`WAVE` by
    // hand: `parseWav` THROWS on anything it cannot address by byte offset, so
    // this is the strictest available reading of "a playable file".
    const head = await stepReadUpload(audio, { end: WAV_HEADER_BYTES });
    expect(parseWav(head.bytes, head.info.size)).toEqual({
      sampleRate: STEP_SPEAK_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
      dataStart: WAV_HEADER_BYTES,
      dataEnd: WAV_HEADER_BYTES + PCM_BYTES,
    });
  });

  test("passes a chosen voice through, and omits it entirely when none was chosen", async () => {
    const { speech } = world();

    await speak("Hello.", { voice: "aai-michael" });
    await speak("Hello.");

    expect(speech[0]?.voice).toBe("aai-michael");
    // The SDK's own default, named rather than restated.
    expect(speech[1]?.voice).toBe(ASSEMBLYAI_TTS_DEFAULT_VOICE);
  });
});

describe("the whole run", () => {
  // Over the recording context, which runs the steps in order with no journal:
  // what this exercises is the ORDER the legs are wired in and the shape they
  // hand each other. Durability is the next block's claim.
  test("transcribes, summarizes, speaks, and reports the file it made", async () => {
    world({ transcribe: provider(), model: JSON.stringify(SUMMARY) });

    const summary = await spokenSummaryFlow({ recording: UPLOAD_ID }, createWorkflowContext());

    expect(summary).toEqual({
      source: "standup.wav",
      durationMs: 42_000,
      words: 8,
      ...SUMMARY,
      transcript: "we ship tuesday and two bugs are left",
      // The output carries an ID, never the audio — the rule the whole
      // template exists to demonstrate.
      audio: "upl_stub_1",
      audioDurationMs: spokenMs(STUB_SPEECH_PCM_BYTES),
    });
  });

  test("the voice the form chose reaches the synthesizer", async () => {
    const { speech } = world({ transcribe: provider(), model: JSON.stringify(SUMMARY) });

    await spokenSummaryFlow(
      { recording: UPLOAD_ID, voice: "aai-michael" },
      createWorkflowContext(),
    );

    expect(speech[0]).toMatchObject({ text: SUMMARY.spoken, voice: "aai-michael" });
  });

  test("a recording the provider gave up on fails the run rather than half-summarizing", async () => {
    const { model, speech } = world({ transcribe: { jobError: "corrupt audio" } });

    await expect(
      spokenSummaryFlow({ recording: UPLOAD_ID }, createWorkflowContext()),
    ).rejects.toThrow("corrupt audio");
    expect(model).toEqual([]);
    expect(speech).toEqual([]);
  });

  test("a recording of silence is FATAL rather than an empty summary", async () => {
    // Silence transcribes successfully to nothing, and everything downstream
    // would then be asked to summarize and speak no words at all.
    world({ transcribe: provider({ text: "   " }) });

    await expect(
      spokenSummaryFlow({ recording: UPLOAD_ID }, createWorkflowContext()),
    ).rejects.toThrow("no speech in that recording");
  });
});

/**
 * The whole run, on the real replay engine.
 *
 * `runWorkflow` starts the workflow the agent declares under `"spokenSummary"`
 * — the name the page starts a run by — over an in-memory journal, and records
 * a suspension rather than waiting it out. That is what makes the poll cadence
 * free here.
 */
describe("the run is DURABLE", () => {
  const INPUT = { recording: UPLOAD_ID };
  const { upload, submit, poll } = TRANSCRIBE_DURABLY_STEPS;

  test("uploads, submits, then parks on the poll cadence", async () => {
    const { provider: calls } = world({
      transcribe: provider({ pendingPolls: 1 }),
      model: JSON.stringify(SUMMARY),
    });
    const started = Date.now();
    const run = await runWorkflow(agentDef, "spokenSummary", INPUT);

    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThan(started);
    expect(new Set(run.steps.map((step) => step.key))).toEqual(
      new Set([`${upload}#0`, `${submit}#0`, `${poll}#0`]),
    );
    // The recording has crossed the wire once.
    expect(calls.filter((call) => call.leg === "upload")).toHaveLength(1);
  });

  test("resumes past the poll and finishes, without re-uploading the recording", async () => {
    const { provider: calls } = world({
      transcribe: provider({ pendingPolls: 1 }),
      model: JSON.stringify(SUMMARY),
    });
    const run = await runWorkflow(agentDef, "spokenSummary", INPUT);
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      headline: "Launch is on",
      points: ["Ship Tuesday"],
      transcript: "we ship tuesday and two bugs are left",
      // An ID, never the bytes: audio in a journaled step result is megabytes
      // replayed on every resume.
      audio: "upl_stub_1",
    });
    expect(run.deliveries).toBe(2);
    // ONE upload and ONE submit across two walks — both came back out of the
    // journal on the second.
    expect(calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(calls.filter((call) => call.leg === "submit")).toHaveLength(1);
    // Two polls: `#0` was journaled and `#1` is the one that found it done.
    expect(run.steps.filter((step) => step.name === poll)).toHaveLength(2);
  });

  test("a worker that dies at the voice keeps the transcript and the summary", async () => {
    // The whole point of separate steps: reading a summary aloud is cheap,
    // transcribing a recording is not, and a crash at the cheap end must not
    // buy the expensive one again.
    const {
      provider: calls,
      model,
      speech,
    } = world({
      transcribe: provider(),
      model: JSON.stringify(SUMMARY),
    });
    const run = await runWorkflow(agentDef, "spokenSummary", INPUT, { crashAt: "speak" });

    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.name)).toContain("summarize");
    expect(speech).toHaveLength(0);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({ audio: "upl_stub_1" });
    // The voice ran once, and neither the provider nor the model was asked
    // again.
    expect(speech).toHaveLength(1);
    expect(calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(model).toHaveLength(1);
  });
});
