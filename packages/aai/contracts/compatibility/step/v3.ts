// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 3.
 *
 * A `workflows/*.ts` BODY, written against the whole step vocabulary — read
 * the environment, fan out over HTTP, narrate, ask the model, speak the
 * answer, frame the bytes. That is what this capability is for and it is the
 * one surface here with no `ToolContext` behind it, so a snippet is the
 * artifact: an author reads this to learn what a step body may name. Written
 * the way it was authored at epoch 3, and it must keep compiling for as long
 * as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 ADDED `stepWebhookUrl` — the public callback URL a step hands a
 * third party so the delivery resolves the body's `ctx.waitFor` instead of the
 * run polling for an answer. It is the one member of this capability whose
 * value LEAVES the system, which is why it got its own entry rather than
 * riding in on `/utils`.
 *
 * Adding a name breaks nothing that did not name it, which is what makes this
 * a retain rather than a drop: an epoch-3 body polls for its answer, and a
 * body that polls still compiles and still runs. What it does not get is the
 * latency back, so the upgrade is worth taking — it is just not owed.
 *
 * **The direction that WOULD break this file is a SIGNATURE**, because a step
 * body is a pure CALLER: every name below is invoked, none is implemented, so
 * nothing here is insulated by a member being optional the way an interface's
 * consumer is. A narrowed parameter on `stepFetch`, a widened return on
 * `stepSpeak`, a third required argument on `mapConcurrent` — each reddens
 * here and each is a real break for every `workflows/*.ts` module in every
 * user project. That is the claim this file exists to keep testable.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  emit,
  encodeWav,
  isTransientStatus,
  type MultipartBody,
  type MultipartPart,
  mapConcurrent,
  multipartBody,
  type PcmFormat,
  pcmDurationMs,
  report,
  requireStepEnv,
  retryAfter,
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  STEP_SPEAK_TIMEOUT_MS,
  type StepFetchInit,
  StepGenerateError,
  type StepGenerateJsonOptions,
  type StepGenerateOptions,
  StepTransportError,
  stepEnv,
  stepFetch,
  stepGenerate,
  stepGenerateJson,
  stepSpeak,
  stripJsonFence,
  WAV_HEADER_BYTES,
} from "../../../sdk/step-barrel.ts";

/**
 * ── EDIT: the keys this workflow declares. ───────────────────────────────
 *
 * A step body has no `ToolContext`, so this is the whole of how it reads
 * `agent({ requiredEnv })`. The two spellings are a decision, not a
 * preference: `requireStepEnv` throws at the moment the value is missing —
 * which is what you want for a credential the step cannot proceed without —
 * and `stepEnv` hands back `undefined` for a knob that has a default.
 */
export function readConfig(): { key: string; region: string } {
  return {
    key: requireStepEnv("PARTNER_API_KEY"),
    region: stepEnv("PARTNER_REGION") ?? "us",
  };
}

/**
 * ── EDIT: the upstream this workflow fans out over. ──────────────────────
 *
 * `stepFetch` rather than `fetch`, and that is the single most load-bearing
 * line in a step body: global `fetch` speaks HTTP/2, so a fan-out multiplexes
 * onto ONE connection and a server-side capacity limit arrives as a stream
 * reset rather than as a 429 a retry policy can read. This one is pinned to
 * HTTP/1.1, so the limit stays a status.
 */
async function fetchOne(id: string, key: string): Promise<Response> {
  const init: StepFetchInit = {
    method: "GET",
    headers: { authorization: `Bearer ${key}` },
  };
  return await stepFetch(`https://partner.example.com/records/${id}`, init);
}

/** What a failed attempt tells the body to do next. */
type Verdict = { retry: boolean; notBefore?: Date | undefined };

/**
 * Classify a failure without deciding the policy.
 *
 * `isTransientStatus` answers "is another attempt worth anything", and
 * `retryAfter` reads the server's own opinion about WHEN off the headers. A
 * body that guesses the second half hammers an upstream that already said how
 * long to wait.
 *
 * `StepTransportError` is the third case and the reason it is exported: the
 * request never got a status at all — a reset, a refused connection, a DNS
 * failure — which is transient in a way no status code can express.
 */
export function classify(failure: unknown, response?: Response): Verdict {
  if (failure instanceof StepTransportError) return { retry: true };
  if (!response) return { retry: false };
  return response.ok
    ? { retry: false }
    : { retry: isTransientStatus(response.status), notBefore: retryAfter(response) };
}

/**
 * The fan-out itself: a WINDOW over the ids, never a `Promise.all`.
 *
 * The width is the whole argument for this helper existing. `Promise.all` over
 * a thousand ids opens a thousand requests, and a step that does that to a
 * partner is a step that gets rate-limited into failing as a unit. A window of
 * eight costs a slow item only itself.
 *
 * `report` is what a page's progress stream renders — narration for a human
 * watching a run that will take minutes.
 */
export async function fetchAll(ids: readonly string[], key: string): Promise<string[]> {
  await report(`fetching ${ids.length} record(s)`);
  return await mapConcurrent(ids, 8, async (id, index) => {
    const response = await fetchOne(id, key);
    // A structured chunk, unlike `report`'s line: a page subscribes to the
    // namespace and renders per-item progress from it.
    await emit("records", { index, id, status: response.status });
    return await response.text();
  });
}

/**
 * Send bytes up as a form, without hand-rolling a boundary.
 *
 * `multipartBody` returns the body AND the `Content-Type` carrying the
 * boundary it chose, which is the pairing a hand-written version gets wrong —
 * a boundary in the header that does not match the one in the payload is a
 * 400 from a server that cannot tell you why.
 */
export async function uploadReport(pdf: Uint8Array, key: string): Promise<Response> {
  const part: MultipartPart = {
    name: "file",
    bytes: pdf,
    filename: "audit.pdf",
    type: "application/pdf",
  };
  const form: MultipartBody = multipartBody(part, {
    name: "kind",
    bytes: new TextEncoder().encode("audit"),
  });
  return await stepFetch("https://partner.example.com/reports", {
    method: "POST",
    headers: { ...form.headers, authorization: `Bearer ${key}` },
    body: form.body,
  });
}

/** The shape the model must answer in, as something that CHECKS. */
const Summary = z.object({
  headline: z.string().trim().min(1),
  risks: z.array(z.string().trim().min(1)),
  spoken: z.string().trim().min(1),
});

/**
 * Ask the model, two ways, and the difference is who validates.
 *
 * `stepGenerate` is one `fetch` to the LLM gateway on the agent's own key —
 * deliberately not the AI SDK, which would be megabytes inside an artifact
 * measured in kilobytes. `stepGenerateJson` is that plus a schema, and it
 * throws when the reply misses, which is exactly what a retry is for: a model
 * that answered in prose may well obey on the next attempt.
 *
 * `stripJsonFence` is the escape hatch for the free-text path — a model that
 * wraps its JSON in a ``` fence is answering correctly in a format
 * `JSON.parse` refuses.
 */
export async function summarize(transcript: string): Promise<{
  headline: string;
  risks: string[];
  spoken: string;
}> {
  const shared: StepGenerateOptions = {
    system: "You audit support calls. Be specific and never invent a risk.",
    temperature: 0,
  };
  const opts: StepGenerateJsonOptions<typeof Summary> = { ...shared, schema: Summary };
  try {
    return await stepGenerateJson(`Summarize this call:\n\n${transcript}`, opts);
  } catch (failure) {
    // The typed failure, and the reason it is a class rather than a status: it
    // carries the gateway's own `retryable` verdict and its `retryAfter`, so a
    // body re-raises rather than re-deriving a policy from an HTTP code it
    // never saw.
    if (failure instanceof StepGenerateError && !failure.retryable) throw failure;
    const raw = await stepGenerate(`Summarize this call as JSON:\n\n${transcript}`, shared);
    return Summary.parse(JSON.parse(stripJsonFence(raw)));
  }
}

/**
 * Say the summary out loud, and frame it so something can play it.
 *
 * `stepSpeak` is a SLOT the way `stepFetch` is: the synthesizer needs a
 * WebSocket client this zero-dependency subpath may not carry, so the host
 * fills it and the body just calls it. What comes back is PCM plus a WAV
 * already framed — `encodeWav` and the two constants are here for the body
 * that has raw samples from somewhere else.
 *
 * `pcmDurationMs` off the PCM rather than off the WAV: `WAV_HEADER_BYTES` of
 * that buffer are header, and counting them as audio overstates a short clip
 * by enough to matter.
 */
export async function narrate(text: string): Promise<{ wav: Uint8Array; durationMs: number }> {
  const opts: SpeakOptions = {
    voice: "matilda",
    sampleRate: STEP_SPEAK_SAMPLE_RATE,
    signal: AbortSignal.timeout(STEP_SPEAK_TIMEOUT_MS),
  };
  const spoken: SpokenAudio = await stepSpeak(text, opts);
  const format: PcmFormat = { sampleRate: spoken.sampleRate, channels: 1, bitsPerSample: 16 };
  const wav = encodeWav(spoken.pcm, format);
  return {
    wav,
    // Equal to `spoken.durationMs`, computed the long way to show the pair a
    // body needs when the samples did NOT come from `stepSpeak`.
    durationMs: pcmDurationMs(wav.byteLength - WAV_HEADER_BYTES, format),
  };
}
