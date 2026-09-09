// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 1.
 *
 * Epoch 2 is COLLATERAL, and this file is the evidence that collateral is all
 * it was. Nothing a step body calls changed signature; what changed is a type
 * this surface REACHES — `stepDelegate` takes a `SubagentDef`, whose `tools`
 * are `ToolDef`s, and `ToolDef` gained an optional `onError` while `Message`
 * gained optional `toolName` and `toolCallId`. Both are additive, so every
 * call below compiles exactly as an epoch-1 author wrote it, including the
 * delegation that dragged the change in.
 *
 * The front half is a step body doing the four things this subpath exists for,
 * because a step's whole contract is what it may NAME: it has no
 * `ToolContext`, no session and no `ctx`, so `stepFetch` rather than `fetch`
 * (HTTP/1.1, one connection per request — a fan-out over HTTP/2 is where a
 * capacity limit stops being a status a retry policy can read), `stepEnv` and
 * `requireStepEnv` rather than `process.env`, `stepInfo()` to degrade on a
 * last attempt rather than fail, and `stepSpeak` plus the WAV framing to make
 * audio a later step can pick up.
 *
 * That is the whole promise — nothing on this surface moved. If a later epoch
 * changes what a body may reach for, this file reddens, which is the signal to
 * DROP the epoch rather than to edit the example.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 1's 42 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 1's does.
 *
 * @module
 */

import { z } from "zod";

import type { DelegateOptions, DelegateResult, SubagentDef } from "../../../index.ts";
import type {
  MultipartBody,
  MultipartPart,
  PcmFormat,
  Settled,
  SpeakOptions,
  SpokenAudio,
  StepFetchInit,
  StepGenerateJsonOptions,
  StepGenerateOptions,
  StepInfo,
  WavFormat,
} from "../../../sdk/step-barrel.ts";
import {
  blockAlign,
  bytesPerSecond,
  encodeWav,
  isTransientStatus,
  mapConcurrent,
  mapSettled,
  multipartBody,
  offsetToMs,
  parseWav,
  partitionSettled,
  pcmDurationMs,
  requireStepEnv,
  retryAfter,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  StepGenerateError,
  StepTransportError,
  stepDelegate,
  stepEmit,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stepInfo,
  stepReport,
  stepSpeak,
  stepWebhookUrl,
  stripJsonFence,
  UnsupportedRecordingError,
  WAV_HEADER_BYTES,
  wavHeader,
} from "../../../sdk/step-barrel.ts";

// ─── Fetching, with the transport rules a step owes ──────────────────────────

/**
 * One upload, over the client this subpath publishes rather than global
 * `fetch`, and reading its refusal as a POLICY rather than as an exception.
 */
async function upload(url: string, part: MultipartPart): Promise<Response> {
  const form: MultipartBody = multipartBody(part, {
    name: "kind",
    bytes: new TextEncoder().encode("audio"),
  });
  const init: StepFetchInit = {
    method: "POST",
    headers: { ...form.headers, Authorization: `Bearer ${requireStepEnv("MEDIA_TOKEN")}` },
    body: form.body,
  };
  const res = await stepFetch(url, init);
  if (!res.ok && isTransientStatus(res.status)) {
    // The server said when, so the engine does not have to guess.
    const when: Date | undefined = retryAfter(res);
    throw new StepGenerateError(`upload refused with ${res.status}`, {
      status: res.status,
      retryable: true,
      ...(when === undefined ? {} : { retryAfter: when }),
    });
  }
  return res;
}

// ─── Audio, framed without a dependency ──────────────────────────────────────

/** What a caller's recording turns out to be, read off its first bytes. */
export function describeRecording(head: Uint8Array, totalBytes: number) {
  if (head.byteLength < WAV_HEADER_BYTES) {
    throw new UnsupportedRecordingError("The recording is too short to carry a WAV header.");
  }
  const format: WavFormat = parseWav(head, totalBytes);
  return {
    frameBytes: blockAlign(format),
    rate: bytesPerSecond(format),
    startsAtMs: offsetToMs(format, format.dataStart),
    durationMs: pcmDurationMs(format.dataEnd - format.dataStart, format),
  };
}

/**
 * Say something and hand back the bytes, framed twice over: `encodeWav` for a
 * caller who wants one buffer, and `wavHeader` for one handing header and
 * samples to something that takes a LIST.
 */
export async function say(text: string): Promise<{ spoken: SpokenAudio; parts: MultipartPart }> {
  const options: SpeakOptions = {
    voice: "michael",
    sampleRate: STEP_SPEAK_SAMPLE_RATE,
    apiKeyEnv: "ASSEMBLYAI_API_KEY",
    signal: AbortSignal.timeout(STEP_SPEAK_TIMEOUT_MS),
  };
  const spoken = await stepSpeak(text, options);
  const pcm: PcmFormat = { sampleRate: spoken.sampleRate, channels: 1, bitsPerSample: 16 };
  const whole = encodeWav(spoken.pcm, pcm);
  return {
    spoken,
    parts: {
      name: "audio",
      // No second copy of the audio to put the header in front of it.
      bytes: [wavHeader(pcm, spoken.pcm.byteLength), spoken.pcm],
      filename: `line-${whole.byteLength}.wav`,
      type: "audio/wav",
    },
  };
}

// ─── The step body itself ────────────────────────────────────────────────────

const verdict = z.object({ theme: z.string(), keep: z.boolean() });

/**
 * A fan-out that degrades on its LAST attempt instead of failing, which is the
 * one thing `stepInfo` is read for.
 */
export async function summarizeCalls(urls: readonly string[], reviewer: SubagentDef) {
  const info: StepInfo | undefined = stepInfo();
  const width = info?.isLastAttempt === true ? 1 : 4;
  await stepReport(`Summarizing ${urls.length} recordings (attempt ${info?.attempt ?? 1}).`);

  const settled: Settled<string, string>[] = await mapSettled(urls, width, async (url) => {
    const res = await upload(`${stepEnv("MEDIA_URL") ?? "https://media.example"}/ingest`, {
      name: "source",
      bytes: new TextEncoder().encode(url),
    });
    if (!res.ok) throw new StepTransportError(url, { cause: new Error(`status ${res.status}`) });
    return await res.text();
  });
  const { ok, failed } = partitionSettled(settled);

  const generateOptions: StepGenerateOptions = {
    system: "Be terse.",
    temperature: 0.2,
    maxTokens: 300,
  };
  const prose = await mapConcurrent(ok, 2, async (one) =>
    stripJsonFence(await stepGenerate(`Summarize: ${one.value}`, generateOptions)),
  );

  const jsonOptions: StepGenerateJsonOptions<typeof verdict> = {
    ...generateOptions,
    schema: verdict,
  };
  const themed = await stepGenerateJson(`Theme these: ${prose.join("\n")}`, jsonOptions);

  const delegateOptions: DelegateOptions = { task: "Check the theme reads fairly.", maxSteps: 3 };
  const review: DelegateResult = await stepDelegate(reviewer, delegateOptions);

  await stepEmit("summaries", { theme: themed.theme, kept: themed.keep });
  return {
    theme: themed.theme,
    failures: failed.map((one) => one.error),
    review: review.text,
    // Where a third party is told to call back when it is done.
    callback: stepWebhookUrl("summaries-done"),
  };
}

// ── The rest of epoch 1's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch1Types = {
  multipartBody: MultipartBody;
  multipartPart: MultipartPart;
  pcmFormat: PcmFormat;
  settled: Settled<string, number>;
  speakOptions: SpeakOptions;
  spokenAudio: SpokenAudio;
  stepFetchInit: StepFetchInit;
  stepGenerateJsonOptions: StepGenerateJsonOptions<typeof verdict>;
  stepGenerateOptions: StepGenerateOptions;
  stepInfo: StepInfo;
  wavFormat: WavFormat;
};

export const epoch1Values = [
  blockAlign,
  bytesPerSecond,
  encodeWav,
  isTransientStatus,
  mapConcurrent,
  mapSettled,
  multipartBody,
  offsetToMs,
  parseWav,
  partitionSettled,
  pcmDurationMs,
  requireStepEnv,
  retryAfter,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  StepGenerateError,
  StepTransportError,
  stepDelegate,
  stepEmit,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stepInfo,
  stepReport,
  stepSpeak,
  stepWebhookUrl,
  stripJsonFence,
  UnsupportedRecordingError,
  WAV_HEADER_BYTES,
  wavHeader,
] as const;
