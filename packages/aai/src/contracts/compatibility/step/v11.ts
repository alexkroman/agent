// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 11.
 *
 * A `workflows/` module: a step that fetches, a step that asks the model for a
 * SHAPE, and a fan-out bounded by {@link mapConcurrent}. Written the way it was
 * authored at epoch 11, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 11 survives it
 *
 * The export list is unchanged. What moved is {@link stepGenerateJson}'s
 * BEHAVIOUR: it now renders the caller's schema as JSON Schema and appends it
 * to `system`, so the request is constrained by the same schema that validates
 * the reply. At epoch 11 it only validated, so every caller wrote the shape out
 * in the prompt as well — which is exactly what {@link summarize} below does.
 *
 * That older prompt still compiles and still works: the derived section is
 * APPENDED after the caller's own wording, so a prompt that restates the fields
 * says them twice rather than disagreeing with itself. Saying them twice is
 * harmless; saying them differently was the bug, and it is now unreachable
 * because one of the two is generated.
 *
 * The signature did not move, so nothing here needed to change — which is the
 * claim this file makes.
 */

import { z } from "zod";
import {
  encodeWav,
  isTransientStatus,
  type MultipartBody,
  type MultipartPart,
  mapConcurrent,
  mapSettled,
  multipartBody,
  type PcmFormat,
  partitionSettled,
  pcmDurationMs,
  requireStepEnv,
  retryAfter,
  type Settled,
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  type StepFetchInit,
  StepGenerateError,
  type StepGenerateJsonOptions,
  type StepGenerateOptions,
  type StepInfo,
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
  WAV_HEADER_BYTES,
  wavHeader,
} from "../../../sdk/step-barrel.ts";

/** What one page yields once the model has read it. */
const Digest = z.object({
  headline: z.string(),
  points: z.array(z.string()),
});

export type Digest = z.infer<typeof Digest>;

/** Read a page. `stepFetch` rather than `fetch`: it pins HTTP/1.1 for fan-out. */
export async function readPage(url: string): Promise<string> {
  const response = await stepFetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.text();
}

/**
 * Summarize one page — the epoch-11 call, with the shape written in `system`.
 *
 * The options are named through {@link StepGenerateJsonOptions} so the type is
 * frozen here too, not merely the call.
 */
export async function summarize(article: string): Promise<Digest> {
  const options: StepGenerateJsonOptions<typeof Digest> = {
    schema: Digest,
    system: 'Reply with JSON only: {"headline": string, "points": string[]}.',
    maxTokens: 400,
  };
  return await stepGenerateJson(article, options);
}

/** A fan-out with a declared width — the journal's name+occurrence rule. */
export async function digestAll(urls: readonly string[]): Promise<Settled<string, Digest>[]> {
  await stepReport(`Reading ${urls.length} page(s).`);
  return await mapConcurrent(urls, 3, async (url): Promise<Settled<string, Digest>> => {
    try {
      return { ok: true, item: url, value: await summarize(await readPage(url)) };
    } catch (err: unknown) {
      return { ok: false, item: url, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** The fence a model adds however firmly it is told not to. */
export function unfence(reply: string): string {
  return stripJsonFence(reply);
}

// ── The rest of the step surface, as one workflow module uses it ─────────────
//
// An epoch freezes every name it PROMISED, so a fixture that imported a
// convenient subset would freeze a subset — the others would keep compiling
// because nothing mentions them. What follows exercises the remainder: the
// env reads, the emit, the webhook, the multipart upload, the WAV helpers, the
// speech step, the settle helpers, and the two error classes a step classifies.

/** The credential, and an optional knob beside it. */
export function credentials(): { key: string; region: string | undefined } {
  return { key: requireStepEnv("ASSEMBLYAI_API_KEY"), region: stepEnv("MEDIA_REGION") };
}

/** Where this run is, for a log line that has to name the attempt. */
export function whereAmI(): StepInfo | undefined {
  // `undefined` outside a step, which is the honest answer and the reason the
  // return type says so rather than asserting.
  const info: StepInfo | undefined = stepInfo();
  return info;
}

/** Upload one clip as multipart — the body built by the SDK, not by hand. */
export async function uploadClip(bytes: Uint8Array, filename: string): Promise<string> {
  const part: MultipartPart = { name: "audio", filename, bytes, type: "audio/wav" };
  const body: MultipartBody = multipartBody(part);
  const init: StepFetchInit = {
    method: "POST",
    body: body.body,
    headers: { ...body.headers, authorization: credentials().key },
  };
  const response = await stepFetch("https://api.example/upload", init);
  if (!response.ok) {
    // The two questions a step asks about a failed response, both the SDK's.
    const transient = isTransientStatus(response.status);
    const after = retryAfter(response.headers);
    throw new Error(`HTTP ${response.status} (transient=${transient}, retryAfter=${after ?? "-"})`);
  }
  return ((await response.json()) as { id: string }).id;
}

/** Give raw PCM a header back, for the one request that needs a real file. */
export function asWav(pcm: Uint8Array): { wav: Uint8Array; ms: number; headerBytes: number } {
  const format: PcmFormat = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 };
  return {
    wav: encodeWav(pcm, format),
    ms: pcmDurationMs(pcm.byteLength, format),
    headerBytes: WAV_HEADER_BYTES,
  };
}

/** The header alone, for a caller streaming the body separately. */
export function headerFor(byteLength: number): Uint8Array {
  return wavHeader({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 }, byteLength);
}

/** Speak a summary from inside a step, and say how long it came back. */
export async function speakSummary(script: string): Promise<{ ms: number; rate: number }> {
  // The deadline is the SDK's own; naming the constant is what freezes it.
  const options: SpeakOptions = { voice: "jane" };
  const audio: SpokenAudio = await stepSpeak(script, options);
  await stepEmit("spoken", { bytes: audio.audio.byteLength, budgetMs: STEP_SPEAK_TIMEOUT_MS });
  // `durationMs` is derived from the byte count rather than claimed by the
  // service; recomputing it off the header-less samples must agree.
  const ms = pcmDurationMs(audio.pcm.byteLength, {
    sampleRate: audio.sampleRate,
    channels: 1,
    bitsPerSample: 16,
  });
  return { ms: ms === audio.durationMs ? ms : audio.durationMs, rate: STEP_SPEAK_SAMPLE_RATE };
}

/** The URL a third party calls back on — minted for THEM, not for the caller. */
export async function callbackUrl(token: string): Promise<string> {
  return await stepWebhookUrl(token);
}

/** A plain model call, and the options type named so the signature is frozen. */
export async function askPlainly(prompt: string): Promise<string> {
  const options: StepGenerateOptions = { system: "Answer in one sentence.", maxTokens: 120 };
  return await stepGenerate(prompt, options);
}

/** Hand one angle to a subagent from inside a step. */
export async function investigate(angle: string): Promise<string> {
  const answer = await stepDelegate(
    { name: "researcher", systemPrompt: "Research the angle.", expectedOutput: "A paragraph." },
    { task: angle },
  );
  return answer.text;
}

/** Settle a fan-out and split it, rather than racing to the first rejection. */
export async function digestSettled(
  urls: readonly string[],
): Promise<{ ok: readonly Digest[]; bad: readonly string[] }> {
  const settled: Settled<string, Digest>[] = await mapSettled(urls, 3, async (url) =>
    summarize(await readPage(url)),
  );
  const { ok, failed } = partitionSettled(settled);
  return { ok: ok.map((entry) => entry.value), bad: failed.map((entry) => entry.item) };
}

/** The two error classes a step body classifies a failure with. */
export function classify(err: unknown): "gateway" | "transport" | "other" {
  if (err instanceof StepGenerateError) return "gateway";
  if (err instanceof StepTransportError) return "transport";
  return "other";
}
