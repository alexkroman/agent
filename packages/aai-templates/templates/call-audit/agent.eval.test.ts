// Copyright 2026 the AAI authors. MIT license.
// An EVAL for a WORKFLOW APP: does the run actually do the work? Run it with
// `aai eval`.
//
// `agent.test.ts` covers everything this desk DECIDES — every ffmpeg argv, both
// analysis parsers, and where `planSegments` cuts — as pure functions, because
// `workflows/media.ts` exists so that it can. What it cannot do is spawn, so
// the one thing it never sees is whether ffmpeg AGREES: whether the argv this
// desk builds really produces the pauses it plans against, and whether a plan
// derived from those pauses really addresses audio that exists.
//
// That is what this file is for. **Every case here runs a real ffmpeg** — five
// invocations per run, over audio built sample by sample so the pauses in it
// are known — and then checks where the desk cut. The twelve-byte planning bug
// `durationSeconds` documents was found exactly this way, and it is the class of
// bug that cannot be found any other way.
//
// It therefore needs `ffmpeg` and `ffprobe` on `PATH` (or `AAI_FFMPEG_PATH` /
// `AAI_FFPROBE_PATH`), which is what the template's own doc says a developer
// needs for anything that is not already a WAV. Measured against ffmpeg 7.1.5.
// A missing binary fails these cases with the SDK's installable message, which
// is the same thing `aai dev` does on a laptop without one.
//
// `describeWorkflowEval` picks the providers for you and says which it picked:
//
//   * with `ASSEMBLYAI_API_KEY` — a LIVE run. The `{ live: true }` case below
//     downloads a real four-and-a-half-minute recording, levels it with a real
//     ffmpeg, fans three real requests out at its real pauses, and asks a real
//     model to audit what came back. That spends money and about a minute.
//   * without one — a SCRIPTED run: the same ffmpeg, the same plan, the same
//     seams, with the transcription endpoint and the model answered in memory.
//
// Three of the four cases are SCRIPTED IN BOTH MODES, deliberately. Their claims
// are about WHERE THE DESK CUT and what it did at the seam, and a live provider
// can neither confirm nor deny either — it can only transcribe whatever it is
// sent. The live case is the one that answers "is the transcript really of the
// recording, and is the audit really of the transcript".
//
// TWO THINGS ARE FAKED IN EVERY MODE, and both are harness limits rather than
// choices:
//
//   * the UPLOAD STORE, because it is this app's own storage (a row and a blob)
//     rather than a provider, and an eval has neither. `{ writable: true }` is
//     not optional here: this desk WRITES two files.
//   * the VOICE — see `speakATone` below, which carries both reasons.
//
// WHAT NO EVAL HERE COVERS: durability. Imported through vitest with no bundler
// in the path, a workflow body is an ordinary async function — no
// journal, no replay, and no per-step retry, so the resume-after-segment-27
// property is NOT exercised and a rate-limited live run fails where a deployed
// one would have ridden it out. `aai-cli`'s `dev-workflow.scenario.test.ts` is
// the tier that really resumes a run.
import { spawnSync } from "node:child_process";
import { encodeWav } from "@alexkroman1/aai/step";
import { stubGatewayRoute } from "@alexkroman1/aai/testing";
import { installStubTranscribe, installStubUploads } from "@alexkroman1/aai/testing/vitest";
import { describeWorkflowEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { describe, expect, test } from "vitest";
import agentDef, { audit } from "./agent.ts";
import { ANALYSIS_FORMAT, BYTES_PER_SECOND, MAX_SEGMENT_SECONDS } from "./workflows/media.ts";

/**
 * Both binaries, or neither — every case here decodes, and three of the four
 * read `ffprobe` back to check what the desk did.
 */
const HAVE_FFMPEG = ["ffmpeg", "ffprobe"].every(
  (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0,
);

const HOW_TO =
  "Install ffmpeg (`apt-get install ffmpeg`, `brew install ffmpeg`) or point\n" +
  "AAI_FFMPEG_PATH / AAI_FFPROBE_PATH at binaries. A deployed guest always has them.";

// Biome's `noSkippedTests` flags the `describe.skip(…)` CALL form, so the gated
// suite references it instead — exactly as `aai/host/ffmpeg.scenario.test.ts`
// and `_pg-test-utils.ts` do.
const skipSuite = describe.skip;

/**
 * `describeWorkflowEval`, gated on a real ffmpeg — and the skip ANNOUNCES itself.
 *
 * This file used to call `describeWorkflowEval` directly, on the reasoning (still
 * in the header above) that "a missing binary fails these cases with the SDK's
 * installable message, which is the same thing `aai dev` does on a laptop without
 * one". That is right for a laptop and wrong for a RUNNER: `check.yml` installs
 * ffmpeg on the Linux leg only — deliberately, because the scenario suite it was
 * added for is OS-independent and brew costs minutes — so when `check:eval` joined
 * that same job, the macOS leg went permanently red on a binary nobody had decided
 * it should have.
 *
 * So this follows `describeWithFfmpeg` (`aai/host/ffmpeg.scenario.test.ts`), which
 * follows `describeWithPg`: skip loudly, and let **`AAI_REQUIRE_FFMPEG`** — which
 * the Linux leg's install step sets — turn the skip into a hard failure, so a
 * broken install step cannot read as a green run. The coverage is unchanged on
 * every machine that has the binary, which includes all of CI's Linux legs.
 */
const describeWorkflowEvalWithFfmpeg: typeof describeWorkflowEval = (agent, define, options) => {
  if (HAVE_FFMPEG) {
    describeWorkflowEval(agent, define, options);
    return;
  }
  if ((process.env.AAI_REQUIRE_FFMPEG ?? "") !== "") {
    throw new Error(`AAI_REQUIRE_FFMPEG is set but no ffmpeg was found.\n${HOW_TO}`);
  }
  // A direct stderr write, not `console.warn`: vitest intercepts `console`, and
  // which reporter it hands the capture to is chosen for you — unset
  // `reporters` resolves to vitest's AGENT reporter when it detects one, and
  // that reporter prints a passing file's output nowhere. A skip passes. So the
  // announcement that keeps this skip from being silent was dropped for exactly
  // the reader most likely to miss it. `announceEvalMode` in the SDK carries the
  // measurement.
  process.stderr.write(`\n[skipped: no ffmpeg] ${agent.name} eval not run.\n${HOW_TO}\n`);
  skipSuite(agent.name, () => {
    // Named `test`, not aliased: Biome's `noMisplacedAssertion` matches the
    // CALLEE IDENTIFIER, so an `expect` inside a `vitestTest(…)` is an error.
    // Same trap `describeEval`'s own signature documents.
    test("needs a real ffmpeg", () => {
      expect(HAVE_FFMPEG).toBe(true);
    });
  });
};

/** The id every case uploads the recording under. */
const UPLOAD_ID = "upl_eval";

/** The public sample recording — four and a half minutes of real speech. */
const LIVE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** Long enough to force a cut: the desk's cap is 110 seconds. */
const OVER_THE_CAP_SECONDS = 130;

/** What the model is scripted to answer with. */
const REPLY = {
  headline: "Renewal call with Northwind",
  risks: ["Nobody owns the migration date"],
  actions: ["Ana to send revised pricing by Friday"],
  spoken:
    "The renewal is close to done, but the migration date still has nobody's name on it. " +
    "Ana is sending revised pricing before the end of the week.",
};

/**
 * One span of a synthetic recording: `loud` is speech, quiet is a pause.
 *
 * A 220 Hz sine at about 40% of full scale, which is ~27 dB above the desk's
 * −35 dB silence floor, so `silencedetect` reads it as speech; a run of zero
 * samples is what it reads as a pause. Built sample by sample rather than
 * captured, because the POINT is that the pauses are at second 60 and second 62
 * and nowhere else — which is the only way "did it cut in the pause" has a
 * right answer.
 */
type Span = { seconds: number; loud: boolean };

/** A 16 kHz mono 16-bit WAV of the spans, ready to hand ffmpeg. */
function recording(spans: readonly Span[]): Uint8Array {
  const samples = spans.reduce((total, span) => total + Math.round(span.seconds * 16_000), 0);
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  let at = 0;
  for (const span of spans) {
    const count = Math.round(span.seconds * 16_000);
    for (let i = 0; i < count; i += 1, at += 1) {
      // `setInt16(…, true)` rather than an `Int16Array`: little-endian is what
      // `s16le` means, and a typed array would be whatever the platform is.
      const value = span.loud
        ? Math.round(13_000 * Math.sin((2 * Math.PI * 220 * at) / 16_000))
        : 0;
      view.setInt16(at * 2, value, true);
    }
  }
  return encodeWav(pcm, ANALYSIS_FORMAT);
}

/**
 * The synthesizer every case here runs on, live included — and it answers with a
 * TONE rather than silence.
 *
 * Two reasons, and the second is a measurement:
 *
 *   * `stepSpeak` reads a PUBLISHED synthesizer, the eval engine publishes none
 *     by default, and `@alexkroman1/aai-runtime` exports no real one to pass —
 *     so there is no arrangement in which the voice is real. The live case
 *     therefore claims nothing about audible audio.
 *   * it may not answer with SILENCE, which is what `installStubSpeech` does.
 *     `libmp3lame` ABORTS on pure digital silence — `Assertion failed:
 *     (el >= 0), psymodel.c:576`, exit 134 on ffmpeg 7.1.5 — so the mastering
 *     pass this template exists to demonstrate would fail on the fixture rather
 *     than on the code, and the failure would read as a broken template.
 */
const speakATone = (request: { text: string; sampleRate: number }): Promise<Uint8Array> => {
  // A second of tone per twenty characters, so a longer script really is a
  // longer file and `audioDurationMs` is a number that means something.
  const samples = Math.max(1, Math.round((request.text.length / 20) * request.sampleRate));
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let at = 0; at < samples; at += 1) {
    view.setInt16(
      at * 2,
      Math.round(9000 * Math.sin((2 * Math.PI * 180 * at) / request.sampleRate)),
      true,
    );
  }
  return Promise.resolve(pcm);
};

/** Publish this app's own store, writable because this desk writes two files. */
function publish(bytes: Uint8Array, name: string, type: string) {
  return installStubUploads({ [UPLOAD_ID]: { bytes, name, type } }, { writable: true });
}

/**
 * Answer the sync transcription endpoint and the model in memory.
 *
 * ONE fake, because publishing a `stepFetch` REPLACES — a flow that transcribes
 * AND calls a model cannot install two, which is what `otherwise` is for. BOTH
 * halves are the SDK's own fakes rather than this file's hand-typed wire, and
 * for the same reason: each routes off the SDK's own endpoint constant, so a
 * case cannot pass because the fake and the step agree on a typo. The gateway
 * envelope is the half where that matters most — it is a WIRE shape, so getting
 * a field wrong does not fail: `stepGenerate` reads no content, reports an empty
 * completion, and the case blames the desk.
 *
 * `route` answers `undefined` for anything that is not a completion request, so
 * it drops straight into `otherwise` and the transcription legs still reach the
 * fake below it.
 */
function scriptProvider(text: readonly string[]) {
  const model = stubGatewayRoute(JSON.stringify(REPLY));
  return installStubTranscribe({ text, otherwise: (request) => model.route(request) });
}

describeWorkflowEvalWithFfmpeg(
  agentDef,
  (test) => {
    test("cuts where ffmpeg heard a PAUSE, and reads the seam as a paragraph", async ({ app }) => {
      // The case this template exists for, and the one that cannot be written
      // without a real decoder: a 2-second pause at second 60 of a 130-second
      // recording is the only place a cut may land, and where it landed decides
      // both the byte ranges and how the transcript reads at the seam.
      const uploads = publish(
        recording([
          { seconds: 60, loud: true },
          { seconds: 2, loud: false },
          { seconds: 68, loud: true },
        ]),
        "call.wav",
        "audio/wav",
      );
      const provider = scriptProvider([
        "so that is the renewal settled",
        "on the migration date nobody has committed yet",
      ]);

      const run = await app.run(audit, { recording: UPLOAD_ID });

      // The error FIRST, so a failed run names its own reason instead of
      // reporting "expected 'failed' to be 'completed'".
      expect(run.error).toBeUndefined();
      expect(run.status).toBe("completed");
      const output = run.output;
      if (output === undefined) expect.fail("a completed run must carry an output");

      // ffmpeg really ran: this is ffprobe's reading of the file, and the
      // duration is the normalized PCM's own byte count rather than anything a
      // container claimed.
      expect(output.codec).toBe("pcm_s16le");
      expect(output.durationMs).toBe(OVER_THE_CAP_SECONDS * 1000);

      // TWO segments, and NEITHER is a blind cut — which is the whole claim.
      // The desk found the pause, cut in the middle of it, and therefore owes
      // no overlap, no seam matching and no de-duplication.
      expect(output.segments).toBe(2);
      expect(output.blindCuts).toBe(0);

      // And the cut is at the pause's MIDPOINT, second 61 — not at 110, which
      // is where a desk with no decoder would have had to cut.
      const sync = provider.calls.filter((call) => call.leg === "sync");
      expect(sync).toHaveLength(2);
      const first = sync[0]?.body?.length ?? 0;
      const second = sync[1]?.body?.length ?? 0;
      // 61 seconds of audio plus a WAV header inside a multipart envelope.
      expect(first).toBeGreaterThan(61 * BYTES_PER_SECOND);
      expect(first).toBeLessThan(61 * BYTES_PER_SECOND + 2000);
      // 69 seconds — and together they are the whole recording, exactly once.
      expect(second).toBeGreaterThan(69 * BYTES_PER_SECOND);
      expect(second).toBeLessThan(69 * BYTES_PER_SECOND + 2000);

      // A cut placed in a pause is a turn boundary, so the seam is a PARAGRAPH
      // break. This is the one place `cutInSpeech` changes an output rather
      // than a report, and the assertion that pairs with the next case.
      expect(output.transcript).toBe(
        "so that is the renewal settled\n\non the migration date nobody has committed yet",
      );

      // 2 seconds of pause in 130 is 98% speech, measured by ffmpeg rather
      // than assumed, and the loudness is a real measurement of real audio.
      expect(output.speechPercent).toBe(98);
      expect(output.loudnessBefore).toBeLessThan(0);
      expect(output.loudnessBefore).toBeGreaterThan(-70);

      // The narration says what it found, which is what makes a long run
      // legible — and names the ONE pause it cut in.
      expect(run.reported[0]).toMatch(/^Reading call\.wav \(/);
      expect(run.reported).toContain("Levelling 2:10 of pcm_s16le to 16 kHz mono.");
      expect(run.reported).toContain(
        `Levelled 2:10 from ${output.loudnessBefore} LUFS, 98% speech across 1 pause.`,
      );
      expect(run.reported).toContain("Transcribing 0:00–1:01.");
      expect(run.reported).toContain("Transcribing 1:01–2:10.");

      // Two files written: the levelled PCM everything downstream addresses,
      // and the mastered audit. Nothing durable was asked for.
      expect(uploads.writes.map((one) => one.name)).toEqual(["call.pcm", "audit.mp3"]);
      expect(run.slept).toEqual([]);
    });

    test("an unbroken monologue gets a BLIND cut, and says so", async ({ app }) => {
      // The case the desk cannot serve, driven rather than argued: 130 seconds
      // of unbroken speech has no pause to cut in, so it gets the arithmetic
      // cut `transcription-workflow` always makes — at exactly the cap. Hiding
      // that would leave a reader looking at a mangled word with no
      // explanation, which is why `cutInSpeech` is counted and rendered.
      publish(
        recording([{ seconds: OVER_THE_CAP_SECONDS, loud: true }]),
        "monologue.wav",
        "audio/wav",
      );
      const provider = scriptProvider(["and then the second thing we agreed", "was the pricing"]);

      const run = await app.run(audit, { recording: UPLOAD_ID });

      expect(run.error).toBeUndefined();
      const output = run.output;
      if (output === undefined) expect.fail("a completed run must carry an output");

      expect(output.segments).toBe(2);
      // ONE blind cut — the first segment's end. The recording's own end is
      // not a cut this planner invented, so it is not counted.
      expect(output.blindCuts).toBe(1);
      // 100% speech, because ffmpeg found no pause at all.
      expect(output.speechPercent).toBe(100);
      expect(run.reported).toContain(
        `Levelled 2:10 from ${output.loudnessBefore} LUFS, 100% speech across 0 pauses.`,
      );

      // The cut is at the cap exactly, which is what "no candidate in range"
      // means — and the first request is therefore 110 seconds of audio.
      expect(run.reported).toContain("Transcribing 0:00–1:50.");
      const sync = provider.calls.filter((call) => call.leg === "sync");
      const first = sync[0]?.body?.length ?? 0;
      expect(first).toBeGreaterThan(MAX_SEGMENT_SECONDS * BYTES_PER_SECOND);
      expect(first).toBeLessThan(MAX_SEGMENT_SECONDS * BYTES_PER_SECOND + 2000);

      // A blind cut landed MID-SENTENCE, so the seam is a space rather than a
      // paragraph break. The pair with the previous case is the point: the same
      // recording length, the same two segments, a different reading.
      expect(output.transcript).toBe("and then the second thing we agreed was the pricing");
    });

    test("the audit comes back as a real MP3 that the run's output NAMES", async ({ app }) => {
      // The way OUT, which is the second thing having a decoder buys: a step
      // speaks, ffmpeg masters what it said, and the run's output carries an
      // upload ID rather than the bytes. A short recording, because what this
      // case is about is the last invocation rather than the fan-out.
      const uploads = publish(recording([{ seconds: 5, loud: true }]), "quick.wav", "audio/wav");
      scriptProvider(["short and to the point"]);

      const run = await app.run(audit, { recording: UPLOAD_ID });

      expect(run.error).toBeUndefined();
      const output = run.output;
      if (output === undefined) expect.fail("a completed run must carry an output");
      // Under the cap, so no cut at all.
      expect(output.segments).toBe(1);
      expect(output.blindCuts).toBe(0);

      // TWO writes, in this order, and the output names the SECOND. A run that
      // returned the levelled PCM's id would be handing a page a headerless
      // file nothing can play.
      expect(uploads.writes).toHaveLength(2);
      const [pcm, mp3] = uploads.writes;
      if (pcm === undefined || mp3 === undefined) expect.fail("both files must be written");
      // Named after the recording, and typed HONESTLY: raw samples with no
      // container, so not `audio/wav` and not `audio/L16` either.
      expect(pcm.name).toBe("quick.pcm");
      expect(pcm.type).toBe("application/octet-stream");
      expect(pcm.bytes.byteLength).toBe(5 * BYTES_PER_SECOND);
      expect(output.audio).toBe(mp3.id);
      expect(mp3.name).toBe("audit.mp3");
      // Typed for the browser: the byte route serves what it was given, and
      // nothing plays inline a file handed over as octet-stream.
      expect(mp3.type).toBe("audio/mpeg");

      // And it is really an MP3, which is a claim about ffmpeg's output rather
      // than about our naming: an MPEG audio frame begins with eleven set bits,
      // or the file opens with an ID3 tag.
      const head = mp3.bytes.subarray(0, 3);
      const framed = head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0;
      const tagged = String.fromCharCode(...head) === "ID3";
      expect(framed || tagged).toBe(true);
      expect(output.audioBytes).toBe(mp3.bytes.byteLength);
      expect(output.audioBytes).toBeGreaterThan(0);
      // The compression is the reason the pass exists: the WAV that went in is
      // 2 bytes per sample at 24 kHz, and the MP3 is a fraction of it.
      const wavBytes = 44 + (output.audioDurationMs / 1000) * 24_000 * 2;
      expect(output.audioBytes).toBeLessThan(wavBytes / 4);
      // The run says both numbers, which is what makes the trade visible.
      expect(run.reported.at(-1)).toMatch(
        /^Recorded a \d+s audit in \w+'s voice — .* of MP3, from .* of WAV\.$/,
      );

      // The model really read the transcript, and the audit really reached the
      // output — including the empty-array case being an ANSWER.
      expect(output.headline).toBe(REPLY.headline);
      expect(output.risks).toEqual(REPLY.risks);
      expect(output.spoken).toBe(REPLY.spoken);
      // The RUN's own clock, from two journaled steps rather than a body-level
      // `Date.now()` a replay would re-read.
      expect(output.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test(
      "really levels, cuts and audits a real call recording",
      async ({ app }) => {
        // LIVE ONLY, and the case that earns the template its name. Four things
        // have to be real: ffmpeg has to decode an MP3 nobody here made, the
        // pauses it finds have to cover the whole recording, every segment's
        // request has to come back with the words that are in it, and the model
        // has to audit what came back.
        const response = await fetch(LIVE_RECORDING);
        expect(response.ok).toBe(true);
        const mp3 = new Uint8Array(await response.arrayBuffer());
        const uploads = publish(mp3, "wildfires.mp3", "audio/mpeg");

        const run = await app.run(audit, { recording: UPLOAD_ID });

        expect(run.error).toBeUndefined();
        expect(run.status).toBe("completed");
        const output = run.output;
        if (output === undefined) expect.fail("a completed run must carry an output");

        // ffprobe read the container it really was, and the FILENAME a reader
        // sees is the one they uploaded rather than the converted artifact's.
        expect(output.codec).toBe("mp3");
        expect(output.source).toBe("wildfires.mp3");
        expect(output.durationMs).toBeGreaterThan(250_000);

        // Four and a half minutes against a 110-second cap is at least three
        // segments, and real speech has pauses — so the cuts should be in them.
        expect(output.segments).toBeGreaterThanOrEqual(3);
        expect(output.blindCuts).toBe(0);
        // A real recording is mostly speech and not all of it.
        expect(output.speechPercent).toBeGreaterThan(50);
        expect(output.speechPercent).toBeLessThan(100);
        expect(output.loudnessBefore).toBeLessThan(0);

        // Every segment came back with words, which is how "the whole recording
        // was covered" is checked rather than assumed: a plan that ran past the
        // end would leave a silent tail segment and a short transcript.
        expect(output.words).toBeGreaterThan(400);
        expect(output.transcript).toMatch(/wildfire/i);
        expect(output.transcript).toMatch(/canada/i);
        expect(output.transcript).toMatch(/air quality/i);

        // The audit is of THIS transcript, and the spoken half is a SCRIPT
        // rather than a list — the template's central prompt decision,
        // measured against a real model.
        expect(output.headline.length).toBeGreaterThan(0);
        expect(`${output.headline} ${output.spoken}`).toMatch(/smoke|wildfire|air|health/i);
        expect(output.risks.length).toBeLessThanOrEqual(4);
        expect(output.actions.length).toBeLessThanOrEqual(4);
        expect(output.spoken).toMatch(/[.!?]/);
        expect(output.spoken).not.toMatch(/^\s*[-*•]/m);

        // And the mastering pass ran on what the voice produced.
        expect(uploads.writes.map((one) => one.name)).toEqual(["wildfires.pcm", "audit.mp3"]);
        expect(uploads.read(output.audio)?.type).toBe("audio/mpeg");
        expect(output.audioBytes).toBeGreaterThan(0);
      },
      { live: true },
    );
  },
  { speech: speakATone },
);
