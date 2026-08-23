// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-errors` epoch 3.
 *
 * **Epoch 3 ADDS `throwFfmpegStepError` and the six pre-classified callers.**
 * Nothing was removed and no signature narrowed, so epochs 1 and 2 are RETAINED
 * and both compile unchanged beside this file.
 *
 * `throwFfmpegStepError` is the arm `throwStepError` cannot decide: an ffmpeg run
 * that TIMED OUT or was aborted is worth another attempt, and a file ffmpeg
 * refused is not, however many times it is replayed. It recognises the failure
 * STRUCTURALLY rather than with `instanceof`, and that is forced — naming
 * `FfmpegError` would put a `node:child_process` import at MODULE scope of a
 * `workflows/*.ts` bundle, which is a `node:vm` Script with no `require`, so
 * every run would die at replay. Two templates each carried a whole one-function
 * file to keep that reference behind a boundary only a step body crosses.
 *
 * The six `*Classified` callers are the SDK's own step calls with the `.catch`
 * already attached. Their value is the arm that is easiest to forget: a
 * `StepGenerateError` carries the gateway's own `Retry-After`, and a
 * `TranscribeError` carries `retryable: false` for a recording the provider will
 * never read — so the unclassified version re-uploads the same bytes until its
 * attempts run out on a file that was never going to transcribe. Submit and poll
 * are both wrapped for the same reason: they are separate steps with separate
 * budgets, and classifying one gives up in one place and never in the other.
 *
 * None of the six takes a `message`, which is the boundary this epoch draws — a
 * caller with a label worth attaching writes the explicit `.catch` and is back
 * on the three primitives epoch 1 froze.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { requireStepEnv, stepGenerate } from "../../../sdk/step-barrel.ts";
import {
  stepFetchOk,
  stepGenerateClassified,
  stepGenerateJsonClassified,
  stepTranscribePollClassified,
  stepTranscribeSubmitClassified,
  stepTranscribeSyncClassified,
  stepTranscribeUploadClassified,
  throwFatalStepError,
  throwFfmpegStepError,
  throwStepError,
  toStepError,
} from "../../../sdk/step-errors.ts";

/** Unchanged from epoch 2: one call, no `ok` check. */
export async function fetchOrder(id: string): Promise<unknown> {
  "use step";

  const response = await stepFetchOk(`https://api.example.com/orders/${id}`);
  return await response.json();
}

/** Unchanged from epoch 2: a status that is not simply a failure — 404 means gone. */
export async function deleteOrder(id: string): Promise<void> {
  "use step";

  const response = await fetch(`https://api.example.com/orders/${id}`, { method: "DELETE" });
  if (response.status === 404) return;
  if (!response.ok) throw toStepError(response, `Order ${id}: HTTP ${response.status}`);
}

/** Unchanged from epoch 2: the explicit `.catch`, still what a labelled failure wants. */
export async function summarizeLabelled(text: string): Promise<string> {
  "use step";

  return await stepGenerate(text, { system: "Summarize." }).catch((err: unknown) =>
    throwStepError(err, "The summarizer refused this transcript."),
  );
}

/** Unchanged from epoch 2: a failure the step has decided is terminal. */
export function apiKey(): string {
  try {
    return requireStepEnv("ASSEMBLYAI_API_KEY");
  } catch (err: unknown) {
    return throwFatalStepError(err);
  }
}

/** New at epoch 3: the same model call, with nothing left to remember. */
export async function summarize(text: string): Promise<string> {
  "use step";

  return await stepGenerateClassified(text, { system: "Summarize in two sentences." });
}

/** The JSON arm, which classifies the gateway's verdict and not the schema miss. */
export async function extract(text: string): Promise<{ risks: string[] }> {
  "use step";

  return await stepGenerateJsonClassified(text, {
    schema: z.object({ risks: z.array(z.string()) }),
  });
}

/** The one-request transcription, where classifying earns the most. */
export async function transcribe(bytes: Uint8Array): Promise<string> {
  "use step";

  const { text } = await stepTranscribeSyncClassified(bytes);
  return text;
}

/** The async job API: both halves wrapped, because both have their own budget. */
export async function submit(uploadId: string): Promise<string> {
  "use step";

  const { audioUrl } = await stepTranscribeUploadClassified(uploadId);
  const { id } = await stepTranscribeSubmitClassified(audioUrl);
  return id;
}

/** A poll that ANSWERS is not a poll that succeeded — the status is still the job's. */
export async function poll(id: string): Promise<string> {
  "use step";

  const progress = await stepTranscribePollClassified(id);
  return progress.status;
}

/**
 * The ffmpeg arm. `transcodeToWav` is named INSIDE the step body, never at module
 * scope — that is the rule `/ffmpeg` and `/step-files` share, and the reason
 * this classifier lives here rather than beside the runner it classifies.
 */
export async function toPcm(bytes: Uint8Array): Promise<Uint8Array> {
  "use step";

  const { transcodeToWav } = await import("../../../host/ffmpeg.ts");
  return await transcodeToWav(bytes, { sampleRate: 16_000 }).catch(throwFfmpegStepError);
}
