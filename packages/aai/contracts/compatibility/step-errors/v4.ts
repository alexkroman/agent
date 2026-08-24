// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-errors` epoch 4.
 *
 * **Epoch 4 ADDS `sendToChannelClassified`.** Nothing was removed and no
 * signature narrowed, so epochs 1 through 3 are RETAINED and each compiles
 * unchanged beside this file.
 *
 * It is the seventh member of the `*Classified` family and the first whose call
 * is not this SDK's own step vocabulary: `sendToChannel` lives on
 * `@alexkroman1/aai/channels`, which may not name the DevKit, so the wrapper
 * lands here for the reason the other six do — importing it IS the opt-in, and
 * whether a terminal failure should burn a step's remaining attempts is the
 * caller's decision.
 *
 * What it classifies is a `ChannelDeliveryError`, which carries the platform's
 * own verdict the way `StepGenerateError` and `TranscribeError` do. That is the
 * arm worth freezing: a webhook 4xx — revoked, unpublished, a variable name
 * matching nothing — answers identically on every attempt, so the unclassified
 * version spends three more attempts to arrive at the same sentence minutes
 * later.
 *
 * The rest of this file is epoch 3 verbatim; see `../channels/v1.ts` for what
 * the channel half of this promise is, and `../agent/v3.ts` for what "frozen"
 * obliges and why the imports are relative.
 */

import { z } from "zod";
import { slack } from "../../../sdk/channels-barrel.ts";
import { requireStepEnv, stepGenerate } from "../../../sdk/step-barrel.ts";
import {
  sendToChannelClassified,
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

/** New at epoch 4: a post whose failure is already the DevKit's verdict. */
export async function announce(webhookUrl: string, headline: string): Promise<string> {
  "use step";

  return await sendToChannelClassified(slack({ webhookUrl }), { text: headline });
}
