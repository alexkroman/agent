// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the spoken-summary app's declaration and its four legs.
 *
 * **The body itself is not driven here**, and that is a property of what a
 * workflow template demonstrates rather than a gap: imported through vitest
 * with no bundler in the path, a `"use step"` function is an ordinary async
 * function — so its HTTP handling, its fatal/retryable classification and what
 * it returns are all testable, while durability, suspension and replay are not.
 * A body test that looked like a durability test would be the worse failure;
 * the real thing is exercised end to end by `aai-cli`'s
 * `dev-workflow.scenario.test.ts`.
 *
 * The two legs worth their own sections are the ones the SDK grew for this
 * template. `speak` is where a step SPEAKS and STORES, and the assertion that
 * matters is that it returns an id rather than bytes — a step is journaled by
 * its return value, and audio in one is megabytes replayed on every resume.
 */

import { stubReporter, stubSpeech, stubStepFetch, stubUploads } from "@alexkroman1/aai/testing";
import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
import { readUpload, uploadInfo } from "@alexkroman1/aai/utils";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FatalError, RetryableError } from "workflow";
import agentDef, { spokenSummary } from "./agent.ts";
import { speak, spokenSummaryFlow, summarize } from "./workflows/summarize.ts";
import { countWords, createJob, pollTranscript, uploadToProvider } from "./workflows/transcribe.ts";

/** The id every spec below uploads under. */
const UPLOAD_ID = "upl_test";

/** Slots left published reach the next file, so every one is released here. */
const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

beforeEach(() => {
  // WRITABLE, because this app's whole second half stores a file — and it is
  // opt-in precisely so a step that wrote one nobody meant it to would fail.
  restores.push(
    stubUploads(
      { [UPLOAD_ID]: { bytes: new Uint8Array(64), name: "standup.wav", type: "audio/wav" } },
      { writable: true },
    ),
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
    expect(agentDef.page).toBe("static");
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
    const fetches = stubStepFetch(() => ({ body: { upload_url: "https://cdn/aai/1" } }));
    restores.push(fetches.restore, stubReporter().restore);

    await expect(uploadToProvider(UPLOAD_ID)).resolves.toEqual({
      audioUrl: "https://cdn/aai/1",
    });
    expect(fetches.calls[0]?.url).toBe("https://api.assemblyai.com/v2/upload");
    expect(fetches.calls[0]?.headers.Authorization).toBe("test-key");
    // The bytes really went, and they went as the file rather than as JSON.
    expect(fetches.calls[0]?.body?.length).toBe(64);
  });

  test("a 429 from the provider is RETRYABLE and a 400 is not", async () => {
    const first = stubStepFetch(() => ({ status: 429, body: { error: "slow down" } }));
    restores.push(first.restore, stubReporter().restore);
    await expect(createJob("https://cdn/aai/1")).rejects.toBeInstanceOf(RetryableError);
    first.restore();

    const second = stubStepFetch(() => ({ status: 400, body: { error: "bad model" } }));
    restores.push(second.restore);
    await expect(createJob("https://cdn/aai/1")).rejects.toBeInstanceOf(FatalError);
  });

  test("a job the provider gave up on is FATAL — no number of polls changes it", async () => {
    restores.push(
      stubStepFetch(() => ({ body: { status: "error", error: "corrupt audio" } })).restore,
    );

    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toThrow("corrupt audio");
    await expect(pollTranscript(UPLOAD_ID, "t_1")).rejects.toBeInstanceOf(FatalError);
  });

  test("`done` is decided here, so the body never reads a provider's vocabulary", async () => {
    restores.push(stubStepFetch(() => ({ body: { status: "queued" } })).restore);

    await expect(pollTranscript(UPLOAD_ID, "t_1")).resolves.toEqual({ done: false });
  });

  test("a finished poll carries the transcript, named by the FILENAME", async () => {
    // ONE request, not two: this used to poll for a status and then fetch the
    // identical URL again for the text the poll already had in its hand.
    const fetches = stubStepFetch(() => ({
      body: { status: "completed", text: "  we shipped it  ", audio_duration: 12.4 },
    }));
    restores.push(fetches.restore, stubReporter().restore);

    await expect(pollTranscript(UPLOAD_ID, "t_1")).resolves.toEqual({
      done: true,
      transcript: { source: "standup.wav", durationMs: 12_400, text: "we shipped it" },
    });
    expect(fetches.calls).toHaveLength(1);
  });

  test("a recording of silence is FATAL rather than an empty summary", async () => {
    // The failure this template is most likely to meet: silence transcribes
    // successfully to nothing, and everything downstream would then be asked to
    // summarize and speak no words at all.
    restores.push(
      stubStepFetch(() => ({ body: { status: "completed", text: "   ", audio_duration: 3 } }))
        .restore,
    );

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
    restores.push(stubReporter().restore);

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
    restores.push(stubReporter().restore);

    expect((await summarize("…")).points).toHaveLength(4);
  });

  test("a reply with no spoken script FAILS rather than defaulting to silence", async () => {
    installStubGateway(JSON.stringify({ headline: "Launch is on", points: ["Ship Tuesday"] }));
    restores.push(stubReporter().restore);

    await expect(summarize("…")).rejects.toThrow(/did not match the shape/);
  });
});

describe("speaking", () => {
  test("stores a WAV and returns its ID — never the bytes", async () => {
    const speech = stubSpeech({ pcmBytes: 48_000 });
    restores.push(speech.restore, stubReporter().restore);

    const spoken = await speak("The launch is on for Tuesday.");

    // An id, because a step is journaled by its return value: audio in one is
    // megabytes replayed on every resume.
    expect(spoken).toEqual({ audio: "upl_stub_1", durationMs: 1000 });
    expect(speech.calls[0]?.text).toBe("The launch is on for Tuesday.");
  });

  test("what it stored is a real WAV, named and typed for the browser", async () => {
    restores.push(stubSpeech({ pcmBytes: 4000 }).restore, stubReporter().restore);

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
    const speech = stubSpeech();
    restores.push(speech.restore, stubReporter().restore);

    await speak("Hello.", "michael");
    await speak("Hello.");

    expect(speech.calls[0]?.voice).toBe("michael");
    // The SDK's own default, not one this template restates.
    expect(speech.calls[1]?.voice).toBe("jane");
  });
});

describe("countWords", () => {
  test("counts words rather than characters, and answers 0 for nothing", () => {
    expect(countWords("we shipped it on tuesday")).toBe(5);
    expect(countWords("  ")).toBe(0);
  });
});

describe("the whole run", () => {
  /**
   * Answer every leg's HTTP, so the BODY can be driven end to end.
   *
   * Imported through vitest with no bundler in the path, a `"use workflow"`
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
   * point `stubStepFetch` exists to make.
   */
  function stubProvider(reply: { headline: string; points: string[]; spoken: string }) {
    return stubStepFetch((request) => {
      if (request.url.includes("llm-gateway")) {
        return { body: { choices: [{ message: { content: JSON.stringify(reply) } }] } };
      }
      if (request.url.endsWith("/v2/upload")) return { body: { upload_url: "https://cdn/aai/1" } };
      if (request.method === "POST") return { body: { id: "t_1" } };
      // One GET, carrying both the status and the text. It used to take two —
      // a poll that read a status and threw the transcript away, then a fetch
      // of the identical URL for the text it had just discarded.
      return {
        body: {
          status: "completed",
          text: "we ship tuesday and two bugs are left",
          audio_duration: 42,
        },
      };
    });
  }

  test("transcribes, summarizes, speaks, and reports the file it made", async () => {
    restores.push(
      stubProvider({
        headline: "Launch is on",
        points: ["Ship Tuesday"],
        spoken: "The launch is on for Tuesday.",
      }).restore,
      stubReporter().restore,
      stubSpeech().restore,
    );

    const summary = await spokenSummaryFlow({ recording: UPLOAD_ID });

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
    const speech = stubSpeech();
    restores.push(
      stubProvider({ headline: "Launch is on", points: ["Ship Tuesday"], spoken: "Spoken." })
        .restore,
      stubReporter().restore,
      speech.restore,
    );

    await spokenSummaryFlow({ recording: UPLOAD_ID, voice: "michael" });

    expect(speech.calls[0]).toMatchObject({ text: "Spoken.", voice: "michael" });
  });

  test("a recording the provider gave up on fails the run rather than half-summarizing", async () => {
    restores.push(
      stubStepFetch((request) =>
        request.url.endsWith("/v2/upload")
          ? { body: { upload_url: "https://cdn/aai/1" } }
          : request.method === "POST"
            ? { body: { id: "t_1" } }
            : { body: { status: "error", error: "corrupt audio" } },
      ).restore,
      stubReporter().restore,
      stubSpeech().restore,
    );

    await expect(spokenSummaryFlow({ recording: UPLOAD_ID })).rejects.toThrow("corrupt audio");
  });
});
