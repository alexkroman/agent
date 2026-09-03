// Copyright 2026 the AAI authors. MIT license.
// An EVAL for a WORKFLOW APP: does the run actually do the work? Run it with
// `aai eval`.
//
// `agent.test.ts` asserts about the declaration and drives the four legs one at
// a time. This drives the WHOLE BODY — `spokenSummaryFlow` from the top — and
// what it is here to check is the thing that is this template's whole reason to
// exist and that no per-step spec can see: the AUDIO ROUND TRIP. A recording
// goes in, and what comes out is a run whose OUTPUT NAMES A FILE that is really
// in the store, put there by the same step that spoke it.
//
// `describeWorkflowEval` picks the providers for you and says which it picked:
//
//   * with `ASSEMBLYAI_API_KEY` — a LIVE run. The `{ live: true }` case below
//     downloads a real four-minute news clip, really transcribes it and really
//     summarizes it. That spends money and about a minute.
//   * without one — a SCRIPTED run: the same body, the same four legs, with the
//     provider answered in memory.
//
// Three of the four cases are SCRIPTED IN BOTH MODES, deliberately. Their claims
// are about WIRING — that the id in the output is the id of the file that was
// written, that the voice was handed the script and not the bullet list, that
// the poll loop asks for its wait — and a live provider can neither confirm nor
// deny any of them: it can only be asked and then have its answer accepted,
// which is not evidence. The live case is the one that answers "is the summary
// really of this recording".
//
// The UPLOAD STORE is faked in both modes, and that is not a mode question: it
// is this app's own storage (a database row and a blob), not a provider, and an
// eval has neither. `{ writable: true }` is what lets the store accept the
// write — opt-in precisely so a step that stored a file nobody meant it to
// still fails.
//
// TWO PROVIDER LEGS ARE NOT REACHABLE LIVE from an eval today, and both are
// named where they are worked around rather than left as a surprise:
//
//   * the streaming UPLOAD leg needs a `stepFetch` — see `liveStepFetch` below.
//   * `stepSpeak` needs a synthesizer, and the engine publishes none by default
//     while `@alexkroman1/aai-runtime` exports no real one to pass. So the VOICE
//     is faked in every case here, live included, and the live case's claim is
//     about the transcript and the summary rather than about audible audio.
//
// WHAT NO EVAL HERE COVERS: durability. Imported through vitest with no bundler
// in the path, a workflow body is an ordinary async function — no
// journal, no replay, and no per-step retry, so a rate-limited live run FAILS
// where a deployed one would have ridden it out, and the resume-replays-the-id
// property that makes speak-and-store ONE step is argued here rather than
// exercised. `run.slept` below is the other half of that admission written as
// an assertion. `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier that
// really suspends and resumes a run.
import { stubGatewayRoute } from "@alexkroman1/aai/testing";
import {
  installStubSpeech,
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef, { spokenSummary } from "./agent.ts";
import { POLL_INTERVAL_MS } from "./workflows/transcribe.ts";

/** The id every case uploads the recording under. */
const UPLOAD_ID = "upl_eval";

/** The public sample recording — four and a half minutes of real speech. */
const LIVE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** What a scripted transcript says, so a summary of it is checkable. */
const TRANSCRIPT =
  "Right, standup. The launch is on for Tuesday the fourth. Two bugs are left in " +
  "checkout, both assigned to Priya, and neither is a blocker. Marketing wants the " +
  "blog post by Monday. If the second bug slips we ship anyway and patch on Wednesday.";

/**
 * The reply the model is scripted to give.
 *
 * The `spoken` script deliberately shares NO wording with `points`, which is
 * what makes "the voice was handed the script" an assertion rather than a
 * coincidence — see the second case.
 */
const REPLY = {
  headline: "Launch is on for Tuesday",
  points: ["Ship Tuesday the fourth", "Two checkout bugs, neither blocking", "Blog post by Monday"],
  spoken:
    "Everything is lined up for the fourth. A couple of small things are still open " +
    "in checkout and Priya has both of them; nothing there is holding the release. " +
    "Marketing needs the write-up at the start of the week.",
};

/**
 * A `stepFetch` for the LIVE legs, and it exists to work around a gap rather
 * than to add anything.
 *
 * The eval engine publishes no `stepFetch`, so a step's HTTP falls back to
 * `globalThis.fetch` — which cannot send this app's UPLOAD leg at all.
 * `stepTranscribeUpload` streams a stored recording window by window, and an
 * iterable body requires `duplex: "half"`; the published fetch adds it (see
 * `sdk/step-fetch.ts`, which says so) and the fallback does not, so a live run
 * dies on `RequestInit: duplex option is required when sending a body` before
 * the provider is ever reached. `EvalWorkflowsOptions.stepFetch` is the
 * documented seam for a host to supply its own, and this is the smallest one
 * that works. Every scripted case below REPLACES it, publishing being a
 * replacement.
 */
const liveStepFetch = (url: string, init: Record<string, unknown> = {}): Promise<Response> =>
  globalThis.fetch(url, { ...init, duplex: "half" } as RequestInit);

/** Publish this app's own store, writable because the last step writes to it. */
function publish(bytes: Uint8Array, name: string, type: string) {
  return installStubUploads({ [UPLOAD_ID]: { bytes, name, type } }, { writable: true });
}

/**
 * Answer every leg of the run in memory: the three transcription calls, and the
 * model.
 *
 * ONE fake, because publishing a `stepFetch` REPLACES — a flow that transcribes
 * AND calls a model cannot install two, which is exactly what `otherwise` is
 * for. BOTH halves are the SDK's own fakes rather than this file's hand-typed
 * wire, and it is the same argument twice: each routes off the SDK's own
 * endpoint constant, so a case cannot pass because the fake and the step agree
 * on a typo. The predicate here used to be `url.includes("llm-gateway")` — a
 * HOST, which the default gateway happens to carry and a `gatewayUrl` pointed
 * anywhere else does not, so the fake would have gone on answering the
 * transcription 404 to a model call it no longer recognised.
 *
 * The reader also hands back DECODED calls, which is why the case below asks
 * `model.calls[0].prompt` what the model was SHOWN: off a raw request body that
 * is the whole serialized request, `model` and `reasoning_effort` included.
 */
function scriptProvider(options: { text?: string; pendingPolls?: number } = {}) {
  const model = stubGatewayRoute(JSON.stringify(REPLY));
  const provider = installStubTranscribe({
    text: options.text ?? TRANSCRIPT,
    durationSec: 42,
    // Passed straight through rather than conditionally spread: the option
    // already admits `undefined`, and `guard-invariants` rule 2 counts the
    // spread.
    pendingPolls: options.pendingPolls,
    otherwise: (request) => model.route(request),
  });
  return { provider, model };
}

describeWorkflowEval(
  agentDef,
  (test) => {
    test("the run's output NAMES a file that one step spoke and stored", async ({ app }) => {
      // Scripted in both modes: the claim is that the id in the output is the id
      // of the file in the store, and no provider can be asked to make that true.
      // This is the case that catches speak-and-store coming apart — a run that
      // returned bytes, or an id nothing wrote, or two ids because the synthesis
      // and the store became two steps.
      const uploads = publish(new Uint8Array(64), "standup.wav", "audio/wav");
      const { provider } = scriptProvider();
      const speech = installStubSpeech({ pcmBytes: 96_000 });

      const run = await app.run(spokenSummary, { recording: UPLOAD_ID });

      // The error FIRST, so a failed run names its own reason instead of
      // reporting "expected 'failed' to be 'completed'".
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
      const output = run.output;
      if (output === undefined) expect.fail("a completed run must carry an output");

      // EXACTLY one write. Two would mean the synthesis and the store had come
      // apart into two steps, which is the mistake this template exists to argue
      // against — a step is journaled by its return value, so an id replays and
      // bytes do not.
      expect(uploads.writes).toHaveLength(1);
      const written = uploads.writes[0];
      if (written === undefined) expect.fail("the speaking step must have stored a file");
      // The output carries the ID of that write, and an id is a string — not the
      // audio. A run's output is read back as JSON.
      expect(output.audio).toBe(written.id);
      expect(typeof output.audio).toBe("string");

      // And the bytes are really there, and are really a WAV: named and typed for
      // a browser, because the byte route serves what it was given and nothing
      // plays a file handed to it as octet-stream.
      expect(written.name).toBe("summary.wav");
      expect(written.type).toBe("audio/wav");
      expect(written.bytes.byteLength).toBe(44 + 96_000);
      expect(String.fromCharCode(...written.bytes.subarray(0, 4))).toBe("RIFF");
      expect(String.fromCharCode(...written.bytes.subarray(8, 12))).toBe("WAVE");
      // 96,000 bytes at 24 kHz mono 16-bit is two seconds, which is what the
      // page prints next to the player.
      expect(output.audioDurationMs).toBe(2000);

      // The rest of the round trip, so a run that stored audio for the wrong text
      // is not mistaken for a working one.
      expect(output.source).toBe("standup.wav");
      expect(output.durationMs).toBe(42_000);
      expect(output.transcript).toBe(TRANSCRIPT);
      expect(output.points).toHaveLength(3);
      expect(speech.calls).toHaveLength(1);

      // Four legs, four narrated lines, in order — which is what a page watching
      // the run renders.
      expect(run.reported[0]).toMatch(/^Uploading standup\.wav /);
      expect(run.reported).toContain("Summarizing the transcript.");
      expect(run.reported.at(-1)).toMatch(/^Recorded a 2s summary in \w+'s voice\.$/);
      // The job finished on its first poll, so no durable wait was asked for.
      expect(run.slept).toEqual([]);
      // One upload of the recording, and one submit — the split that exists so a
      // fault in the submit does not re-upload the file.
      expect(provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
      expect(provider.calls.filter((call) => call.leg === "submit")).toHaveLength(1);
    });

    test("the voice reads the SCRIPT the model was asked for, not the points", async ({ app }) => {
      // Scripted in both modes: what a live voice says is not evidence about
      // which string it was handed. This is the case that catches the template's
      // central prompt decision regressing — synthesize the bullet list and you
      // get a voice reading "one. two. three." with no connective tissue.
      publish(new Uint8Array(64), "standup.wav", "audio/wav");
      const { model } = scriptProvider();
      const speech = installStubSpeech();

      const run = await app.run(spokenSummary, { recording: UPLOAD_ID, voice: "michael" });

      expect(run.error).toBeUndefined();
      const spokenText = speech.calls[0]?.text;
      expect(spokenText).toBe(REPLY.spoken);
      // The script and the points share no wording, so this is the assertion:
      // whatever was spoken, it was not the list.
      for (const point of REPLY.points) expect(spokenText).not.toContain(point);
      // The form's choice really reaches the synthesizer.
      expect(speech.calls[0]?.voice).toBe("michael");
      // Both shapes survive to the output — one to read, one that was heard.
      expect(run.output?.points).toEqual(REPLY.points);
      expect(run.output?.spoken).toBe(REPLY.spoken);

      // And the model was ASKED for both, over the transcript it was given. A
      // prompt that stopped asking for a script is how the field goes missing.
      const asked = model.calls[0];
      if (asked === undefined) expect.fail("the run must have asked the model for a summary");
      expect(asked.prompt).toContain("READ ALOUD");
      expect(asked.prompt).toContain("The launch is on for Tuesday the fourth");
    });

    test("a recording with no speech stops before the model and the voice", async ({ app }) => {
      // Scripted in both modes, and it costs nothing live either way: silence
      // transcribes SUCCESSFULLY to nothing, so without a terminal failure here
      // the run would go on to summarize no words and store half a second of
      // audio — a green run with an empty product.
      const uploads = publish(new Uint8Array(64), "silence.wav", "audio/wav");
      const { model } = scriptProvider({ text: "   " });
      const speech = installStubSpeech();

      const run = await app.run(spokenSummary, { recording: UPLOAD_ID });

      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/no speech in that recording/i);
      expect(run.output).toBeUndefined();
      // Nothing was summarized and nothing was spoken, which is the half that
      // makes this more than an error-message assertion.
      expect(model.calls).toEqual([]);
      expect(speech.calls).toEqual([]);
      expect(uploads.writes).toEqual([]);
      expect(run.reported).not.toContain("Summarizing the transcript.");
    });

    test("an unfinished job is waited out with a DURABLE sleep, not a busy loop", async ({
      app,
    }) => {
      // Scripted in both modes: a live job cannot be asked to stay queued for
      // exactly two polls, and this is the one place the poll loop's shape is
      // visible — one submit, one poll per round, and a recorded wait between
      // them. A loop that re-submitted, or one that spun with no wait, both
      // produce a correct transcript and a wrong bill.
      publish(new Uint8Array(64), "standup.wav", "audio/wav");
      const { provider } = scriptProvider({ pendingPolls: 2 });
      installStubSpeech();

      const run = await app.run(spokenSummary, { recording: UPLOAD_ID });

      expect(run.error).toBeUndefined();
      expect(run.output?.transcript).toBe(TRANSCRIPT);
      // Two waits for three polls: asked for and — this being an eval rather
      // than a deployment — recorded rather than taken.
      expect(run.slept).toEqual([
        { label: "poll", duration: POLL_INTERVAL_MS },
        { label: "poll", duration: POLL_INTERVAL_MS },
      ]);
      expect(provider.calls.filter((call) => call.leg === "poll")).toHaveLength(3);
      // The expensive half happened ONCE, which is the whole reason the upload
      // and the submit are separate steps.
      expect(provider.calls.filter((call) => call.leg === "upload")).toHaveLength(1);
      expect(provider.calls.filter((call) => call.leg === "submit")).toHaveLength(1);
    });

    test(
      "really transcribes and summarizes a real recording",
      async ({ app }) => {
        // LIVE ONLY, and the one case here that measures rather than checks
        // wiring. Three things have to be real for it to pass: the file has to
        // stream to the provider, the transcript has to be of THAT recording, and
        // the model has to write a script from that transcript.
        //
        // The VOICE is faked even here, and that is a harness limit rather than a
        // choice — `stepSpeak` reads a published synthesizer, the eval engine
        // publishes none, and no real one is exported to pass it. So what this
        // case does NOT claim is that the audio is audible; the round trip's
        // structure (one write, an id in the output, real WAV framing) is what
        // the first case pins, in memory, where it is a fact rather than a hope.
        const speech = installStubSpeech({ pcmBytes: 48_000 });
        const response = await fetch(LIVE_RECORDING);
        expect(response.ok).toBe(true);
        const mp3 = new Uint8Array(await response.arrayBuffer());
        const uploads = publish(mp3, "wildfires.mp3", "audio/mpeg");

        const run = await app.run(spokenSummary, { recording: UPLOAD_ID });

        expect(run.error).toBeUndefined();
        expect(run.status).toBe("completed");
        const output = run.output;
        if (output === undefined) expect.fail("a completed run must carry an output");

        // The transcript is of THIS recording — a news segment about smoke from
        // Canadian wildfires reaching the US east coast.
        expect(output.transcript).toMatch(/wildfire/i);
        expect(output.transcript).toMatch(/canada/i);
        expect(output.words).toBeGreaterThan(400);
        // The FILENAME a reader sees is the one they uploaded, not the opaque id.
        expect(output.source).toBe("wildfires.mp3");
        expect(output.durationMs).toBeGreaterThan(250_000);

        // The summary is of the transcript, not of summarizing in general.
        const written = `${output.headline} ${output.points.join(" ")} ${output.spoken}`;
        expect(written).toMatch(/smoke|wildfire|air/i);
        expect(output.points.length).toBeGreaterThan(0);
        expect(output.points.length).toBeLessThanOrEqual(4);
        // A SCRIPT rather than a list: sentences, no bullet markers, and long
        // enough that a voice reading it has something to say. This is the
        // template's central prompt decision, measured against a real model.
        expect(output.spoken).toMatch(/[.!?]/);
        expect(output.spoken).not.toMatch(/^\s*[-*\u2022]/m);
        expect(output.spoken.length).toBeGreaterThan(80);
        // And it is the SCRIPT that was spoken, not the points a page renders.
        expect(speech.calls[0]?.text).toBe(output.spoken);

        // The store really holds what the output names.
        expect(uploads.writes).toHaveLength(1);
        const stored = uploads.read(output.audio);
        if (stored === undefined) expect.fail("the run's `audio` id must name a stored file");
        expect(String.fromCharCode(...stored.bytes.subarray(0, 4))).toBe("RIFF");
      },
      { live: true },
    );
  },
  { stepFetch: liveStepFetch },
);
