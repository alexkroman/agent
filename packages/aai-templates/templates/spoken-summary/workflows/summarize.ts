// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow body, and the two legs after the transcript: a model reads it,
 * and a voice reads the model back.
 *
 * ```text
 *   transcribe   (workflows/transcribe.ts)   →  the words
 *   summarize    one step, LLM Gateway       →  a headline, points, and a script
 *   speak        one step, streaming TTS     →  a WAV, stored, and its id
 * ```
 *
 * ## Audio in, audio out — and the second half is the part that needed the SDK
 *
 * Reading a file and transcribing it is what `transcription-workflow` already
 * shows. What this template is for is the return trip, which until recently a
 * workflow could not make at all:
 *
 * - **`stepSpeak`** synthesizes from inside a step. The session TTS surface
 *   cannot: a `TtsSession` is an event stream wired into a live pipeline's
 *   playback, and a step has no turn to be part of and has to return a VALUE.
 * - **`writeUpload`** puts that value somewhere. A run's OUTPUT is read back as
 *   JSON, so audio cannot travel in one — the same rule that keeps a
 *   recording's bytes out of a run's INPUT, arriving at the other end of the
 *   run. The bytes go to the store, the output carries the id, and the page
 *   turns it back into something to play with `api.download(id)`.
 *
 * Both are on `@alexkroman1/aai/step`, imported from THERE rather than the
 * root: a `workflows/*.ts` module is bundled separately by the WDK builder, so
 * the root barrel's module graph would ride into the step bundle.
 *
 * ## The model is asked for TWO things, and the difference is the point
 *
 * `points` is for reading and `spoken` is for hearing, and a template that
 * synthesized the bullet list would produce something nobody wants to listen
 * to — a voice reading "one. two. three." with no connective tissue. So the
 * schema asks for a script as well, in sentences, and that is what
 * {@link speak} is handed. It is the same decision `recap-workflow` makes for
 * the sentence it reads down a phone, and it is one prompts get wrong when the
 * shape does not force it.
 *
 * ## Why each leg is its own step
 *
 * They fail differently and cost differently. The transcription is minutes of a
 * provider's queue; the model call is seconds and rate-limited; the synthesis
 * is a socket. Splitting them means a rate-limited model call replays the
 * transcript from the journal instead of transcribing the recording again, and
 * a synthesis that failed does not re-run the model — which is the ordinary
 * reason to split steps, made sharp here because the first leg is the
 * expensive one.
 */

import {
  report,
  stepGenerateJson,
  stepSpeak,
  TRANSCRIBE_API,
  writeUpload,
} from "@alexkroman1/aai/step";
import { throwStepError } from "@alexkroman1/aai/step-errors";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { sleep } from "workflow";
import { z } from "zod";
import {
  countWords,
  createJob,
  MAX_POLLS,
  POLL_INTERVAL,
  pollTranscript,
  type Transcript,
  uploadToProvider,
} from "./transcribe.ts";

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
 * `stepGenerateJson` validates against this and throws plainly when the reply
 * misses, which is what a retry is for: a model that answered with prose may
 * well obey on the next attempt.
 */
const SummaryReply = z.object({
  headline: z.string().trim().min(1),
  points: z.array(z.string().trim().min(1)).min(1),
  // NOT `.default("")` — the whole second half of this workflow has nothing to
  // say without it, and a default would turn a missing field into a silent
  // half-second of audio rather than a retry.
  spoken: z.string().trim().min(1),
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
export async function spokenSummaryFlow(input: {
  recording: string;
  // `| undefined` explicitly, not merely optional: `exactOptionalPropertyTypes`
  // is on repo-wide, and what a zod `.optional()` infers is a property that may
  // be PRESENT and undefined.
  voice?: string | undefined;
}): Promise<SpokenSummary> {
  "use workflow";

  const transcript = await transcribe(input.recording);
  const summary = await summarize(transcript.text);
  const spoken = await speak(summary.spoken, input.voice);

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

/**
 * The whole first leg, factored out of the body.
 *
 * A plain async function rather than a step, and NOT because it is small: it
 * calls steps and it `sleep`s durably between polls, neither of which a step
 * may do. So it runs as part of the BODY and is replayed with it — which is
 * legal here for the ordinary reason, that everything it does is either a step
 * call or a `sleep`, so a replay re-derives exactly the same sequence.
 */
async function transcribe(recording: string): Promise<Transcript> {
  const { audioUrl } = await uploadToProvider(recording);
  const job = await createJob(audioUrl);

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const progress = await pollTranscript(recording, job.id);
    if (progress.done) return progress.transcript;
    await sleep(POLL_INTERVAL);
  }
  // A plain throw: this is the BODY, where the fatal/retryable distinction has
  // nothing to apply to. The transcript is not lost, so the message says where
  // it is rather than only that the wait ran out.
  throw new Error(
    `Transcript ${job.id} was still unfinished after ${MAX_POLLS} polls. It is not lost — ` +
      `read it directly with GET ${TRANSCRIBE_API}/v2/transcript/${job.id}.`,
  );
}

/** Reduce the transcript to a headline, {@link POINTS} points, and a script. */
export async function summarize(
  text: string,
): Promise<{ headline: string; points: string[]; spoken: string }> {
  "use step";

  await report("Summarizing the transcript.");
  const reply = await stepGenerateJson(
    "Summarize this transcript of a recording.\n\n" +
      "Answer with JSON only, in this shape:\n" +
      `{"headline": "...", "points": ["..."], "spoken": "..."}\n\n` +
      "- headline: one line naming what the recording was about.\n" +
      `- points: at most ${POINTS} short points, each a complete thought. Concrete ` +
      `specifics — decisions, numbers, names, what happens next — never "the ` +
      `speaker discussed several topics".\n` +
      "- spoken: the same summary written to be READ ALOUD. Full sentences that " +
      "flow, under 120 words, no bullet markers, no headings, no markdown. " +
      "Someone will hear this without seeing the points.\n\n" +
      `Transcript:\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}`,
    {
      system: "You summarize recordings. You answer with JSON and nothing else.",
      schema: SummaryReply,
    },
    // Classified off the gateway's own status: a 429 is worth another attempt
    // and a 400 is not, and `throwStepError` is what tells the DevKit which.
  ).catch(throwStepError);

  return { headline: reply.headline, points: reply.points.slice(0, POINTS), spoken: reply.spoken };
}

/**
 * Read the summary aloud, store the WAV, and answer with its id.
 *
 * **Both halves belong in ONE step**, and the reason is what a journal records:
 * a step is replayed by its RETURN VALUE, so an id is replayed and bytes are
 * not. Split in two, the audio would have to cross the queue between them —
 * megabytes of it, on every resume. Together, a resumed run replays the id and
 * re-reads a file that is already there.
 */
export async function speak(
  script: string,
  voice?: string,
): Promise<{ audio: string; durationMs: number }> {
  "use step";

  const spoken = await stepSpeak(script, omitUndefined({ voice }));
  const stored = await writeUpload(spoken.audio, {
    // Named, because this is what a person sees on the download link rather
    // than an opaque id — and typed, because the byte route serves the type it
    // was given and a browser will not play a file it was handed as bytes.
    name: "summary.wav",
    type: "audio/wav",
  });

  await report(
    `Recorded a ${Math.round(spoken.durationMs / 1000)}s summary in ${spoken.voice}'s voice.`,
  );
  return { audio: stored.id, durationMs: spoken.durationMs };
}
