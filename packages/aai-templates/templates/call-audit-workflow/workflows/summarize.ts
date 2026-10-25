// Copyright 2026 the AAI authors. MIT license.
/**
 * The two steps after the transcript: a model reads the call, and a voice reads
 * the model back — through ffmpeg on the way out.
 *
 * ```text
 *   summarize   one step, LLM Gateway        →  headline, risks, actions, script
 *   narrate     one step, TTS + ffmpeg       →  an MP3, stored, and its id
 * ```
 *
 * `spoken-summary-workflow` owns the audio ROUND TRIP and is the template to read for it:
 * why `stepSpeak` exists at all, why `stepWriteUpload` is its other half, and
 * why speaking and storing must be one step. None of that is restated here.
 *
 * **What this file adds is the pass AFTER the synthesis**, and it is the second
 * half of what having a decoder in the pipeline buys. `stepSpeak` answers with a
 * 24 kHz WAV, which is correct and is not a deliverable: a 90-second summary is
 * 4.3 MB, and the page downloads the whole thing through `api.download` before
 * it can play a note of it. The same summary as VBR MP3 is ~110 KB, which is a
 * fortieth. `stepSpeakToUpload` (`@alexkroman1/aai/step-files`) is that pass —
 * speak, master to MP3, store — as one step.
 */

import { stepGenerateJson, stepReport } from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";
import { stepSpeakToUpload } from "@alexkroman1/aai/step-files";
import { formatBytes, formatDuration, omitUndefined, plural } from "@alexkroman1/aai/utils";
import { z } from "zod";

/** Risks the summary is reduced to. Enough to be useful, few enough to act on. */
const MAX_RISKS = 4;

/** Actions the summary is reduced to. */
const MAX_ACTIONS = 4;

/**
 * Characters of transcript handed to the model.
 *
 * The pass-an-id-not-a-payload rule meeting a case where the payload IS the work:
 * the text has to cross the queue between two steps, so it is bounded rather than
 * trusted. 40k characters is roughly four hours of speech — past where another
 * paragraph changes a four-point summary.
 */
const MAX_TRANSCRIPT_CHARS = 40_000;

/**
 * The shape the model must answer in, as something that CHECKS.
 *
 * `stepGenerateJson` renders it into the prompt as JSON Schema — each field's
 * `.describe()` is the whole instruction for it — validates the reply, and
 * throws plainly when the reply misses, which is what a retry is for.
 */
const AuditReply = z.object({
  headline: z.string().trim().min(1).describe("One line naming what the call was about"),
  // Allowed to be EMPTY, unlike `spoken` below, and the asymmetry is deliberate: a
  // call with nothing worrying in it is a real call, and a schema that demanded a
  // risk would get an invented one. An empty array is an answer.
  risks: z
    .array(z.string().trim().min(1))
    .describe(
      `At most ${MAX_RISKS} things a reader should worry about — a commitment nobody owns, ` +
        "a number that was guessed at, a disagreement left unresolved. Quote or name the " +
        "specifics. An EMPTY array if the call really had none; never invent one",
    )
    .transform((risks) => risks.slice(0, MAX_RISKS)),
  actions: z
    .array(z.string().trim().min(1))
    .describe(
      `At most ${MAX_ACTIONS} things somebody has to do next, each naming who if the call named them`,
    )
    .transform((actions) => actions.slice(0, MAX_ACTIONS)),
  // NOT `.default("")` — the whole second half of this workflow has nothing to say
  // without it, and a default would turn a missing field into a silent half-second
  // of audio rather than a retry.
  spoken: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The same audit written to be READ ALOUD: full sentences that flow, under 150 words, " +
        "no bullet markers, no headings, no markdown — someone will hear this without seeing the lists",
    ),
});

/** What the model made of the call. */
export type CallSummary = {
  headline: string;
  risks: string[];
  actions: string[];
  /** The same summary, written to be READ ALOUD — see {@link summarize}. */
  spoken: string;
};

/**
 * Reduce the transcript to a headline, the risks, the actions, and a script.
 *
 * **The model is asked for TWO summaries, and the difference is the point.**
 * `risks`/`actions` are for reading and `spoken` is for hearing; a template that
 * synthesized its own bullet list produces a voice reading "one. two. three." with
 * no connective tissue. So the schema asks for a script as well, in sentences, and
 * that is what {@link narrate} is handed. It is a decision a prompt alone does not
 * hold, which is why the field is required rather than defaulted.
 */
export async function summarize(
  transcript: string,
  source: string,
  durationMs: number,
): Promise<CallSummary> {
  await stepReport("Reading the transcript.");
  // `orFail`: a 429 is worth another attempt and a 400 is not, and the
  // classification is what tells the engine which.
  const reply = await orFail(stepGenerateJson)(
    `Audit this transcript of a recorded call (${source}, ${formatDuration(durationMs)}).\n\n` +
      `Transcript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
    { system: "You audit recorded calls.", schema: AuditReply },
  );

  await stepReport(
    `Found ${reply.risks.length} ${plural(reply.risks.length, "risk")} and ` +
      `${reply.actions.length} ${plural(reply.actions.length, "action")}.`,
  );
  return reply;
}

/**
 * Read the audit aloud, master it to MP3, store it, and answer with its id.
 *
 * **All of it is ONE step**, and the reason is what a journal records: a step is
 * replayed by its RETURN VALUE, so an id is replayed and bytes are not. Split in
 * two, the audio would have to cross the queue between them — megabytes of it,
 * on every resume — and the temp file the mastering pass needs cannot cross a
 * step boundary at all. `stepSpeakToUpload` is that composition, with the
 * encoder in reach; the cost is that a retried step writes a second upload and
 * abandons the first, which is cheap next to a step that cannot retry.
 */
export async function narrate(
  script: string,
  voice?: string,
): Promise<{ audio: string; durationMs: number; bytes: number }> {
  const stored = await stepSpeakToUpload(script, {
    ...omitUndefined({ voice }),
    master: "mp3",
    // Named, because this is what a person sees on the download link rather than
    // an opaque id; the type follows the master.
    name: "audit.mp3",
  });

  await stepReport(
    `Recorded a ${Math.round(stored.durationMs / 1000)}s audit with voice ${stored.voice} — ` +
      `${formatBytes(stored.size)} of MP3.`,
  );
  return { audio: stored.id, durationMs: stored.durationMs, bytes: stored.size };
}
