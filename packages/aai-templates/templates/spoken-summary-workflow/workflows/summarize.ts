// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow body: a recording becomes text, a model reads it, and a voice
 * reads the model back.
 *
 * ```text
 *   transcribeUploadDurably   three steps + a durable poll   →  the words
 *   summarize                 one step, LLM Gateway          →  a headline, points, and a script
 *   speak                     one step, streaming TTS        →  a WAV, stored, and its id
 * ```
 *
 * ## Audio in, audio out — and the second half is the part that needed the SDK
 *
 * Reading a file and transcribing it is what `transcription-workflow` already
 * shows, and `transcribeUploadDurably` (`@alexkroman1/aai/step`) is that whole
 * leg — upload, submit, poll on a durable sleep — under three journaled steps
 * of this body's own `ctx`. What this template is for is the return trip, which
 * until recently a workflow could not make at all:
 *
 * - **`stepSpeak`** synthesizes from inside a step. The session TTS surface
 *   cannot: a `TtsSession` is an event stream wired into a live pipeline's
 *   playback, and a step has no turn to be part of and has to return a VALUE.
 * - **`stepWriteUpload`** puts that value somewhere. A run's OUTPUT is read back as
 *   JSON, so audio cannot travel in one — the same rule that keeps a
 *   recording's bytes out of a run's INPUT, arriving at the other end of the
 *   run. The bytes go to the store, the output carries the id, and the page
 *   turns it back into something to play with `api.download(id)`.
 *
 * ## The model is asked for TWO things, and the difference is the point
 *
 * `points` is for reading and `spoken` is for hearing, and a template that
 * synthesized the bullet list would produce something nobody wants to listen
 * to — a voice reading "one. two. three." with no connective tissue. So the
 * schema asks for a script as well, in sentences, and that is what
 * {@link speak} is handed. It is the same decision `meeting-recap-agent` makes for
 * the sentence it reads down a phone, and it is one prompts get wrong when the
 * shape does not force it.
 *
 * ## Why each leg is its own step
 *
 * They fail differently and cost differently. The transcription is minutes of a
 * provider's queue; the model call is seconds and rate-limited; the synthesis
 * is a socket. Splitting them means a rate-limited model call replays the
 * transcript from the journal instead of transcribing the recording again, and
 * a synthesis that failed does not re-run the model.
 */

import type { WorkflowContext, WorkflowInputOf } from "@alexkroman1/aai";
import {
  type SpeakOptions,
  type SpokenAudio,
  stepGenerateJson,
  stepReport,
  stepSpeak,
  stepWriteUpload,
  transcribeUploadDurably,
} from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";
import { countWords } from "@alexkroman1/aai/utils";
import { z } from "zod";
// ERASED at build time: the body names the schema's own output type without a
// runtime cycle back through `agent.ts`.
import type { spokenSummaryInput } from "../agent.ts";

/** Points the summary is reduced to. Enough to be a summary, few enough to scan. */
const POINTS = 4;

/**
 * Characters of transcript handed to the model.
 *
 * The pass-an-id-not-a-payload rule meeting a case where the payload IS the
 * work: the text has to cross the queue between two steps, so it is bounded
 * rather than trusted. 40k characters is roughly four hours of speech — past
 * where another paragraph changes a four-point summary.
 */
const MAX_TRANSCRIPT_CHARS = 40_000;

/**
 * The shape the model must answer in, as something that CHECKS.
 *
 * `stepGenerateJson` renders it into the prompt as JSON Schema — the
 * `.describe()` on each field is the whole instruction for it — validates the
 * reply, and throws plainly when the reply misses, which is what a retry is
 * for.
 */
const SummaryReply = z.object({
  headline: z.string().trim().min(1).describe("One line naming what the recording was about"),
  points: z
    .array(z.string().trim().min(1))
    .min(1)
    .describe(
      `At most ${POINTS} short points, each a complete thought — concrete specifics: ` +
        `decisions, numbers, names, what happens next — never "the speaker discussed several topics"`,
    )
    .transform((points) => points.slice(0, POINTS)),
  // NOT `.default("")` — the whole second half of this workflow has nothing to
  // say without it, and a default would turn a missing field into a silent
  // half-second of audio rather than a retry.
  spoken: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The same summary written to be READ ALOUD: full sentences that flow, under 120 words, " +
        "no bullet markers, no headings, no markdown — someone will hear this without seeing the points",
    ),
});

/** What a finished run reports. Small and JSON-shaped, like every step result. */
export type SpokenSummary = {
  /** The uploaded file's own name. */
  source: string;
  /** The recording's length, as the provider measured it. */
  durationMs: number;
  /** Words in the transcript. */
  words: number;
  /** One line naming what the recording was about. */
  headline: string;
  /** The summary, for reading. */
  points: string[];
  /** The summary, for hearing — what {@link speak} was handed. */
  spoken: string;
  /** The whole transcript, so the page can show its work. */
  transcript: string;
  /**
   * The upload id of the spoken summary — a WAV, in this app's own store.
   *
   * An ID rather than the bytes, and that is the rule rather than a
   * preference: a run's output is read back as JSON. `api.download(id)` is the
   * browser half.
   */
  audio: string;
  /** How long the spoken summary lasts. */
  audioDurationMs: number;
};

/** Transcribe a recording, summarize it, and read the summary back. */
export async function spokenSummaryFlow(
  input: WorkflowInputOf<typeof spokenSummaryInput>,
  ctx: WorkflowContext,
): Promise<SpokenSummary> {
  // The async API rather than the sync one, because this app's subject is the
  // ROUND TRIP: cutting a long recording up is a whole subject with its own
  // template (`transcription-workflow`), and here the transcription should be
  // the boring leg. The SDK's composition journals it as three steps and a
  // poll of this body's `ctx`, so a resumed run replays the upload and the
  // submit and polls the same job.
  const transcript = await transcribeUploadDurably(ctx, input.recording);
  await ctx.report(
    "transcribed",
    `Transcribed ${transcript.source}: ${countWords(transcript.text)} words.`,
  );
  const summary = await ctx.step("summarize", () => summarize(transcript.text));
  // The form's choice reaches the synthesizer as the SDK's OWN option bag, so
  // an app that later wants a different `sampleRate` (a phone line is 8 kHz)
  // adds a key here rather than a parameter to {@link speak}.
  const spoken = await ctx.step("speak", () => speak(summary.spoken, { voice: input.voice }));

  return {
    source: transcript.source,
    durationMs: transcript.durationMs,
    words: countWords(transcript.text),
    headline: summary.headline,
    points: summary.points,
    spoken: summary.spoken,
    transcript: transcript.text,
    audio: spoken.audio,
    audioDurationMs: spoken.durationMs,
  };
}

/** Reduce the transcript to a headline, {@link POINTS} points, and a script. */
export async function summarize(
  text: string,
): Promise<{ headline: string; points: string[]; spoken: string }> {
  await stepReport("Summarizing the transcript.");
  // `orFail`: a 429 is worth another attempt and a 400 is not, and the
  // classification is what tells the engine which.
  return await orFail(stepGenerateJson)(
    `Summarize this transcript of a recording.\n\nTranscript:\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}`,
    { system: "You summarize recordings.", schema: SummaryReply },
  );
}

/**
 * Read the summary aloud, store the WAV, and answer with its id.
 *
 * **Both halves belong in ONE step**, and the reason is what a journal records:
 * a step is replayed by its RETURN VALUE, so an id is replayed and bytes are
 * not. Split in two, the audio would have to cross the queue between them —
 * megabytes of it, on every resume. Together, a resumed run replays the id and
 * re-reads a file that is already there.
 *
 * It takes `SpeakOptions` WHOLE rather than the one field this app sets. An
 * omitted `voice` is already the SDK's default — the option is declared
 * `string | undefined`, so there is nothing to strip on the way in — and every
 * other knob (`language`, `sampleRate`, `apiKeyEnv`) then costs a fork zero
 * edits here.
 */
export async function speak(
  script: string,
  options: SpeakOptions = {},
): Promise<{ audio: string; durationMs: number }> {
  // Annotated because the two `audio`s in this function are NOT the same thing
  // and the contrast is the whole lesson: `SpokenAudio.audio` is the WAV's
  // bytes, and what this returns under that name is an upload id.
  const spoken: SpokenAudio = await stepSpeak(script, options);
  const stored = await stepWriteUpload(spoken.audio, {
    // Named, because this is what a person sees on the download link rather
    // than an opaque id — and typed, because the byte route serves the type it
    // was given and a browser will not play a file it was handed as bytes.
    name: "summary.wav",
    type: "audio/wav",
  });

  await stepReport(
    `Recorded a ${Math.round(spoken.durationMs / 1000)}s summary with voice ${spoken.voice}.`,
  );
  return { audio: stored.id, durationMs: spoken.durationMs };
}
