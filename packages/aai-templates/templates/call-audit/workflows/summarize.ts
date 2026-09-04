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
 * `spoken-summary` owns the audio ROUND TRIP and is the template to read for it:
 * why `stepSpeak` exists at all (a `TtsSession` is an event stream wired into a
 * live pipeline's playback, and a step has no turn to be part of and has to return
 * a VALUE), why `stepWriteUpload` is its other half, and why speaking and storing must
 * be one step. None of that is restated here.
 *
 * **What this file adds is the pass AFTER the synthesis**, and it is the second
 * half of what having a decoder in the pipeline buys. `stepSpeak` answers with a
 * 24 kHz WAV, which is correct and is not a deliverable:
 *
 * - **It is uncompressed.** A 90-second summary is 4.3 MB, and the page downloads
 *   the whole thing through `api.download` before it can play a note of it. The
 *   same summary as VBR MP3 is ~110 KB, which is a fortieth.
 * - **Its level is whatever the voice service chose.** Played straight after a
 *   recording this desk levelled to −16 LUFS, a summary at −24 sounds broken. The
 *   mastering pass puts both on the same scale, which is the whole reason to have
 *   one number for the desk rather than one per stage.
 *
 * So the audio the page plays has been through ffmpeg twice — once on the way in
 * to make it analysable, once on the way out to make it shippable. `media.ts`'s
 * `masterArgs` is the second, and it explains why that one is a SINGLE `loudnorm`
 * pass where the ingest is two.
 */

import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFfmpeg } from "@alexkroman1/aai/ffmpeg";
import { stepReport, stepSpeak } from "@alexkroman1/aai/step";
import { stepGenerateJsonOrFail, throwFfmpegStepError } from "@alexkroman1/aai/step-errors";
import { withTempDir, writeUploadFromFile } from "@alexkroman1/aai/step-files";
import { formatBytes, formatDuration, omitUndefined, plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { masterArgs } from "./media.ts";

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

/** How long the mastering pass may run. Seconds of work; the bound is for a pathological input. */
const MASTER_TIMEOUT_MS = 5 * 60_000;

/**
 * The shape the model must answer in, as something that CHECKS.
 *
 * `stepGenerateJson` validates against this and throws plainly when the reply
 * misses, which is what a retry is for: a model that answered with prose may well
 * obey on the next attempt.
 */
const AuditReply = z.object({
  headline: z.string().trim().min(1),
  // Allowed to be EMPTY, unlike `spoken` below, and the asymmetry is deliberate: a
  // call with nothing worrying in it is a real call, and a schema that demanded a
  // risk would get an invented one. An empty array is an answer.
  risks: z.array(z.string().trim().min(1)),
  actions: z.array(z.string().trim().min(1)),
  // NOT `.default("")` — the whole second half of this workflow has nothing to say
  // without it, and a default would turn a missing field into a silent half-second
  // of audio rather than a retry.
  spoken: z.string().trim().min(1),
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
  const reply = await stepGenerateJsonOrFail(
    `Audit this transcript of a recorded call (${source}, ${formatDuration(durationMs)}).\n\n` +
      "Answer with JSON only, in this shape:\n" +
      `{"headline": "...", "risks": ["..."], "actions": ["..."], "spoken": "..."}\n\n` +
      "- headline: one line naming what the call was about.\n" +
      `- risks: at most ${MAX_RISKS} things a reader should worry about — a ` +
      "commitment nobody owns, a number that was guessed at, a disagreement left " +
      "unresolved. Quote or name the specifics. An EMPTY array if the call really " +
      "had none; never invent one.\n" +
      `- actions: at most ${MAX_ACTIONS} things somebody has to do next, each ` +
      "naming who if the call named them.\n" +
      "- spoken: the same audit written to be READ ALOUD. Full sentences that " +
      "flow, under 150 words, no bullet markers, no headings, no markdown. " +
      "Someone will hear this without seeing the lists.\n\n" +
      `Transcript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
    {
      system: "You audit recorded calls. You answer with JSON and nothing else.",
      schema: AuditReply,
    },
    // The `OrFail` caller is `stepGenerateJson` plus `throwStepError`, which is
    // what reads the gateway's own status: a 429 is worth another attempt and a 400
    // is not, and that is what tells the DevKit which.
  );

  await stepReport(
    `Found ${reply.risks.length} ${plural(reply.risks.length, "risk")} and ` +
      `${reply.actions.length} ${plural(reply.actions.length, "action")}.`,
  );
  return {
    headline: reply.headline,
    risks: reply.risks.slice(0, MAX_RISKS),
    actions: reply.actions.slice(0, MAX_ACTIONS),
    spoken: reply.spoken,
  };
}

/**
 * Read the audit aloud, master it, store it, and answer with its id.
 *
 * **All four halves belong in ONE step**, and the reason is what a journal
 * records: a step is replayed by its RETURN VALUE, so an id is replayed and bytes
 * are not. Split in two, the audio would have to cross the queue between them —
 * megabytes of it, on every resume — and the temp file the mastering pass needs
 * cannot cross a step boundary at all (see `@alexkroman1/aai/step-files`). Together, a resumed
 * run replays the id and re-reads a file that is already there.
 *
 * The cost is that a retried step writes a second upload and abandons the first.
 * Cheap next to a step that cannot retry.
 */
export async function narrate(
  script: string,
  voice?: string,
): Promise<{ audio: string; durationMs: number; bytes: number }> {
  const spoken = await stepSpeak(script, omitUndefined({ voice }));

  return await withTempDir(
    async (dir) => {
      const wav = join(dir, "spoken.wav");
      const mp3 = join(dir, "summary.mp3");

      // `writeFile` rather than a stream, and this is the one place in the template
      // where holding the whole thing in memory is right: `stepSpeak` already
      // returned it as a single `Uint8Array`, so streaming it to disk would be
      // copying from the heap to the heap on the way. It is bounded by the script,
      // which the schema keeps under 150 words.
      await writeFile(wav, spoken.audio);

      await runFfmpeg(masterArgs(wav, mp3), { timeoutMs: MASTER_TIMEOUT_MS }).catch(
        throwFfmpegStepError,
      );
      const bytes = (await stat(mp3)).size;

      const stored = await writeUploadFromFile(mp3, {
        // Named, because this is what a person sees on the download link rather than
        // an opaque id — and typed, because the byte route serves the type it was
        // given and a browser will not play a file it was handed as bytes.
        name: "audit.mp3",
        type: "audio/mpeg",
      });

      await stepReport(
        `Recorded a ${Math.round(spoken.durationMs / 1000)}s audit in ${spoken.voice}'s voice — ` +
          `${formatBytes(bytes)} of MP3, from ${formatBytes(spoken.audio.byteLength)} of WAV.`,
      );
      return { audio: stored.id, durationMs: spoken.durationMs, bytes };
    },
    { prefix: "aai-call-audit-" },
  );
}
