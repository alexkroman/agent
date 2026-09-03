// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the spoken-summary app's declaration and its four legs.
 *
 * The four legs are ordinary exported async functions, so their HTTP handling,
 * their fatal/retryable classification and what they return are all testable
 * directly. **And the body IS driven**, on the real replay engine — the last
 * block — which this file used to say was another tier's job. It is still true
 * that a body test dressed up as a durability test would be the worse failure;
 * what changed is that the durable one is available, so the claim can be made
 * honestly rather than deferred. `aai-cli`'s `dev-workflow.scenario.test.ts`
 * remains the tier above, with a built project and a real queue.
 *
 * The two legs worth their own sections are the ones the SDK grew for this
 * template. `speak` is where a step SPEAKS and STORES, and the assertion that
 * matters is that it returns an id rather than bytes — a step is journaled by
 * its return value, and audio in one is megabytes replayed on every resume.
 */

import { readUpload, uploadInfo } from "@alexkroman1/aai/step";
import { FatalError, RetryableError } from "@alexkroman1/aai/step-errors";
import { createWorkflowCtx, stubGatewayRoute } from "@alexkroman1/aai/testing";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import agentDef, { spokenSummary } from "./agent.ts";
import { speak, spokenSummaryFlow, summarize } from "./workflows/summarize.ts";
import { createJob, pollTranscript, uploadToProvider } from "./workflows/transcribe.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

beforeEach(() => {
  // WRITABLE, because this app's whole second half stores a file — and it is
  // opt-in precisely so a step that wrote one nobody meant it to would fail.
  // `install*` rather than `stub*`: the fake registers its own `onTestFinished`,
  // which is what replaced the hand-kept restore registry this file used to hold.
  installStubUploads(
    { [UPLOAD_ID]: { bytes: new Uint8Array(64), name: "standup.wav", type: "audio/wav" } },
    { writable: true },
  );
  // The step env, which is where `requireStepEnv` and `stepSpeak` read the key.
  // `vi.stubEnv` rather than an assignment: `unstubEnvs` undoes it before every
  // test, so nothing here has to remember to put it back.
  vi.stubEnv("ASSEMBLYAI_API_KEY", "test-key");
});

describe("the declaration", () => {
  test("is a workflow app with the one workflow the page starts by name", () => {
    // The page calls `api.start("spokenSummary", …)`, so a rename here is a
    // runtime 400 rather than a compile error. This is what pins it.
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["spokenSummary"]);
  });

  test("declares no providers and exactly the one credential its steps read", () => {
    // A workflow app has no session, so nothing else in its config could name
    // one — and one AssemblyAI key covers transcription, the model and the voice.
    expect(agentDef.requiredEnv).toEqual(["ASSEMBLYAI_API_KEY"]);
  });

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
      (await spokenSummary.input?.["~standard"].validate({ recording: UPLOAD_ID, voice: "jane" }))
        ?.issues,
    ).toBeUndefined();
  });
});

describe("transcribing", () => {
  test("streams the stored recording to the provider and keeps the URL it answered", async () => {
    const provider = installStubTranscribe({ audioUrl: "https://cdn/aai/1" });
    installStubReporter();

    await expect(uploadToProvider(UPLOAD_ID)).resolves.toEqual({
      audioUrl: "https://cdn/aai/1",
    });
    expect(provider.calls[0]?.leg).toBe("upload");
    // The bytes really went, and they went as the file rather than as JSON.
    expect(provider.calls[0]?.body?.length).toBe(64);
  });

  test("a 429 from the provider is RETRYABLE and a 400 is not", async () => {
    const first = installStubTranscribe({ failure: { status: 429, message: "slow down" } });
    installStubReporter();
    await expect(createJob("https://cdn/aai/1")).rejects.toBeInstanceOf(RetryableError);
    // Unpublished by hand: this is a boundary WITHIN one test, which the
    // per-test auto-restore cannot give.
    first.restore();

    installStubTranscribe({ failure: { status: 400, message: "bad model" } });
    await expect(createJob("https://cdn/aai/1")).rejects.toBeInstanceOf(FatalError);
  });

  test("a job the provider gave up on is FATAL — no number of polls changes it", async () => {
    installStubTranscribe({ jobError: "corrupt audio" });

    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toThrow("corrupt audio");
    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toBeInstanceOf(FatalError);
  });

  test("`done` is decided here, so the body never reads a provider's vocabulary", async () => {
    installStubTranscribe({ pendingPolls: 1 });

    await expect(pollTranscript(UPLOAD_ID, "t_1")).resolves.toEqual({ done: false });
  });

  test("a finished poll carries the transcript, named by the FILENAME", async () => {
    // ONE request, not two: this used to poll for a status and then fetch the
    // identical URL again for the text the poll already had in its hand.
    const provider = installStubTranscribe({ text: "  we shipped it  ", durationSec: 12.4 });
    installStubReporter();

    await expect(pollTranscript(UPLOAD_ID, "t_1")).resolves.toEqual({
      done: true,
      transcript: { source: "standup.wav", durationMs: 12_400, text: "we shipped it" },
    });
    expect(provider.calls).toHaveLength(1);
  });

  test("a recording of silence is FATAL rather than an empty summary", async () => {
    // The failure this template is most likely to meet: silence transcribes
    // successfully to nothing, and everything downstream would then be asked to
    // summarize and speak no words at all.
    installStubTranscribe({ text: "   ", durationSec: 3 });

    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toThrow("no speech in that recording");
    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toBeInstanceOf(FatalError);
  });
});

describe("summarizing", () => {
  test("asks the model for a spoken script as well as points, and keeps both", async () => {
    const calls = installStubGateway(
      JSON.stringify({
        headline: "Launch is on",
        points: ["Ship Tuesday", "Two bugs left"],
        spoken: "The launch is on for Tuesday, with two bugs still open.",
      }),
    );
    installStubReporter();

    const summary = await summarize("we ship tuesday");

    expect(summary.headline).toBe("Launch is on");
    expect(summary.points).toEqual(["Ship Tuesday", "Two bugs left"]);
    expect(summary.spoken).toBe("The launch is on for Tuesday, with two bugs still open.");
    // The prompt really carries the transcript, and really asks for the two
    // shapes — a page that got bullets read aloud is the failure this prevents.
    expect(calls[0]?.prompt).toContain("we ship tuesday");
    expect(calls[0]?.prompt).toContain("READ ALOUD");
  });

  test("caps the points at what the schema promises the page", async () => {
    installStubGateway(
      JSON.stringify({
        headline: "Many things",
        points: ["a", "b", "c", "d", "e", "f"],
        spoken: "Several things happened.",
      }),
    );
    installStubReporter();

    expect((await summarize("…")).points).toHaveLength(4);
  });

  test("a reply with no spoken script FAILS rather than defaulting to silence", async () => {
    installStubGateway(JSON.stringify({ headline: "Launch is on", points: ["Ship Tuesday"] }));
    installStubReporter();

    await expect(summarize("…")).rejects.toThrow(/did not match the shape/);
  });
});

describe("speaking", () => {
  test("stores a WAV and returns its ID — never the bytes", async () => {
    const speech = installStubSpeech({ pcmBytes: 48_000 });
    installStubReporter();

    const spoken = await speak("The launch is on for Tuesday.");

    // An id, because a step is journaled by its return value: audio in one is
    // megabytes replayed on every resume.
    expect(spoken).toEqual({ audio: "upl_stub_1", durationMs: 1000 });
    expect(speech.calls[0]?.text).toBe("The launch is on for Tuesday.");
  });

  test("what it stored is a real WAV, named and typed for the browser", async () => {
    installStubSpeech({ pcmBytes: 4000 });
    installStubReporter();

    const { audio } = await speak("Hello.");

    await expect(uploadInfo(audio)).resolves.toMatchObject({
      name: "summary.wav",
      // The byte route serves this as `Content-Type`, and a browser will not
      // play inline a file it was handed as octet-stream.
      type: "audio/wav",
      size: 44 + 4000,
    });
    const { bytes } = await readUpload(audio, { end: 12 });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
  });

  test("passes a chosen voice through, and omits it entirely when none was chosen", async () => {
    const speech = installStubSpeech();
    installStubReporter();

    await speak("Hello.", "michael");
    await speak("Hello.");

    expect(speech.calls[0]?.voice).toBe("michael");
    // The SDK's own default, not one this template restates.
    expect(speech.calls[1]?.voice).toBe("jane");
  });
});

describe("the whole run", () => {
  /**
   * Answer every leg's HTTP, so the BODY can be driven end to end.
   *
   * Imported through vitest, a workflow
   * function is an ordinary async function — so what this exercises is the
   * ORDER the legs are wired in and the shape they hand each other, which is
   * the one thing the per-leg specs above cannot see. Durability, suspension
   * and replay are not testable here and are not what this claims.
   *
   * The job answers `completed` on its FIRST poll, deliberately: a second poll
   * would reach the durable `sleep`, which outside a real run is not a wait
   * this spec should be taking.
   *
   * **The model call goes through this too, not `installStubGateway`.** A
   * published `stepFetch` is what `stepGenerate` makes its request with, so a
   * global-fetch stub is never reached once one exists — which is exactly the
   * point a published `stepFetch` exists to make, and exactly why
   * `stubTranscribe` takes an `otherwise`: publishing REPLACES, so a flow that
   * transcribes AND calls a model cannot install two fakes.
   *
   * The three transcription legs are the SDK's fake rather than this file's
   * hand-typed wire — it routes them off the SDK's own endpoint constants, so a
   * spec cannot pass because the fake and the step agree on a typo.
   */
  function stubProvider(reply: { headline: string; points: string[]; spoken: string }) {
    // The model leg goes through `stubGatewayRoute` for the same reason, which
    // this helper used to claim and not do: it hand-typed the completion
    // envelope and recognised a model call by `llm-gateway`, the HOST. That is a
    // property of one deployment rather than of the request — `stepGenerate`
    // dials `${gatewayUrl ?? ASSEMBLYAI_LLM_GATEWAY_URL}/chat/completions`, so a
    // caller pointing `gatewayUrl` at an OpenAI-compatible proxy of their own
    // stops matching and the transcription fake answers a 404 to a model call.
    const model = stubGatewayRoute(JSON.stringify(reply));
    return installStubTranscribe({
      audioUrl: "https://cdn/aai/1",
      jobIdPrefix: "t_",
      text: "we ship tuesday and two bugs are left",
      durationSec: 42,
      otherwise: (request) => model.route(request),
    });
  }

  test("transcribes, summarizes, speaks, and reports the file it made", async () => {
    stubProvider({
      headline: "Launch is on",
      points: ["Ship Tuesday"],
      spoken: "The launch is on for Tuesday.",
    });
    installStubReporter();
    installStubSpeech();

    const summary = await spokenSummaryFlow({ recording: UPLOAD_ID }, createWorkflowCtx());

    expect(summary).toEqual({
      source: "standup.wav",
      durationMs: 42_000,
      words: 8,
      headline: "Launch is on",
      points: ["Ship Tuesday"],
      spoken: "The launch is on for Tuesday.",
      transcript: "we ship tuesday and two bugs are left",
      // The output carries an ID, never the audio — the rule the whole
      // template exists to demonstrate.
      audio: "upl_stub_1",
      audioDurationMs: 250,
    });
  });

  test("the voice the form chose reaches the synthesizer", async () => {
    stubProvider({ headline: "Launch is on", points: ["Ship Tuesday"], spoken: "Spoken." });
    installStubReporter();
    const speech = installStubSpeech();

    await spokenSummaryFlow({ recording: UPLOAD_ID, voice: "michael" }, createWorkflowCtx());

    expect(speech.calls[0]).toMatchObject({ text: "Spoken.", voice: "michael" });
  });

  test("a recording the provider gave up on fails the run rather than half-summarizing", async () => {
    installStubTranscribe({ jobError: "corrupt audio" });
    installStubReporter();
    installStubSpeech();

    await expect(spokenSummaryFlow({ recording: UPLOAD_ID }, createWorkflowCtx())).rejects.toThrow(
      "corrupt audio",
    );
  });
});

/**
 * The whole run, on the real replay engine.
 *
 * `runWorkflow` (`@alexkroman1/aai-runtime/testing`) starts the declared
 * workflow on the engine `aai dev` uses, over an in-memory journal, and records
 * a suspension rather than waiting it out. That is what makes the poll cadence
 * — fifteen seconds a turn in a deployment — free here, and it is the only tier
 * at which this app's central claim is checkable: **the recording is uploaded
 * and transcribed ONCE**, however many times the body is walked.
 *
 * Three published slots have to agree for a whole run, and one of them is a
 * shared seam: `stubTranscribe` publishes `stepFetch`, and publishing REPLACES —
 * so the model call cannot have a stub of its own and is routed through
 * `otherwise` instead. `installStubSpeech` and `installStubUploads` are
 * different slots and compose freely.
 */
describe("the run is DURABLE", () => {
  const SUMMARY = JSON.stringify({
    headline: "Launch is on",
    points: ["Ship Tuesday"],
    spoken: "The launch is on for Tuesday.",
  });

  /** The provider, the model and the voice — one world for a whole run. */
  function stubWorld({ pendingPolls = 0 } = {}) {
    const model = stubGatewayRoute(SUMMARY);
    const provider = installStubTranscribe({
      pendingPolls,
      text: "We shipped it on Tuesday.",
      durationSec: 30,
      // Anything that is not a transcription leg — which here is the model call
      // — because this fake owns the one published `stepFetch`.
      otherwise: (request) => model.route(request),
    });
    const speech = installStubSpeech({ pcmBytes: 48_000 });
    installStubReporter();
    return { model, provider, speech };
  }

  const INPUT = { recording: UPLOAD_ID };

  test("uploads, submits, then parks on the poll cadence", async () => {
    const world = stubWorld({ pendingPolls: 1 });
    const started = Date.now();
    const run = await runWorkflow(spokenSummary, INPUT, { name: "spokenSummary" });

    expect(run.status).toBe("running");
    expect(run.wakeAt).toBeGreaterThan(started);
    expect(run.steps.map((step) => step.key)).toEqual([
      "createJob#0",
      "pollTranscript#0",
      "uploadToProvider#0",
    ]);
    // The recording has crossed the wire once. It is the expensive step — it
    // streams the whole file, which is why it is the one with extra patience.
    expect(world.provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
  });

  test("resumes past the poll and finishes, without re-uploading the recording", async () => {
    const world = stubWorld({ pendingPolls: 1 });
    const run = await runWorkflow(spokenSummary, INPUT, { name: "spokenSummary" });
    await run.advanceSleep();

    expect(run.status).toBe("completed");
    expect(run.output).toMatchObject({
      headline: "Launch is on",
      points: ["Ship Tuesday"],
      transcript: "We shipped it on Tuesday.",
      // An ID, never the bytes: audio in a journaled step result is megabytes
      // replayed on every resume.
      audio: "upl_stub_1",
    });
    expect(run.deliveries).toBe(2);
    // ONE upload and ONE submit across two walks — both came back out of the
    // journal on the second.
    expect(world.provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(world.provider.calls.filter((call) => call.leg === "submit")).toHaveLength(1);
    // Two polls, which is the loop doing its job: `pollTranscript#0` was
    // journaled and `#1` is the one that found it done.
    expect(run.steps.filter((step) => step.name === "pollTranscript")).toHaveLength(2);
  });

  test("a worker that dies at the voice keeps the transcript and the summary", async () => {
    // The whole point of three steps rather than one: reading a summary aloud
    // is cheap, transcribing a recording is not, and a crash at the cheap end
    // must not buy the expensive one again.
    const world = stubWorld();
    const run = await runWorkflow(spokenSummary, INPUT, {
      name: "spokenSummary",
      crashAt: "speak",
    });

    expect(run.crashed).toBe(true);
    expect(run.steps.map((step) => step.name)).toContain("summarize");
    expect(world.speech.calls).toHaveLength(0);

    await run.restart();
    expect(run.status).toBe("completed");
    expect(run.output?.audio).toBe("upl_stub_1");
    // The voice ran once, and neither the provider nor the model was asked
    // again.
    expect(world.speech.calls).toHaveLength(1);
    expect(world.provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
    expect(world.model.calls).toHaveLength(1);
  });
});
