// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step` epoch 5.
 *
 * A `workflows/*.ts` BODY that MAKES something and hands it to somebody else:
 * speak a briefing, frame the samples as a `.wav`, post it as a form, and give
 * the far side a URL to call back on when it has finished reading. That is the
 * half of this capability epoch 5 had that epoch 3 did not — `stepInfo` and
 * `stepWebhookUrl`, one reading the engine and one leaving the system — so the
 * example beside `v3.ts` is written around those rather than repeating its
 * fan-out. Written the way it was authored at epoch 5, and it must keep
 * compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 5 survives it
 *
 * Epoch 6 did two things, and neither is visible from here.
 *
 * It ADDED `wavHeader` — `encodeWav` without the join, for a caller handing the
 * header and the samples to something that takes a LIST rather than holding a
 * second copy of the audio to put them in one buffer first. A name nobody
 * referenced cannot break anyone: {@link frame} below joins, because joining was
 * the only thing available to it, and a joined buffer is still a `.wav`.
 *
 * And it WIDENED `MultipartPart.bytes`, from `Uint8Array` to
 * `Uint8Array | readonly Uint8Array[]`, which is what makes the new name worth
 * anything. **A widened PARAMETER is safe here precisely because this file is a
 * CALLER**: it accepts everything it used to accept, so the single buffer
 * {@link publishBriefing} hands {@link deliver} is as legal at epoch 6 as it was
 * at epoch 5. The direction that is not
 * safe is the same change made to a RETURN — a caller that reads `part.bytes`
 * off something this capability handed it would now be reading a union — and
 * this capability returns no `MultipartPart`, which is why the widening is a
 * retain rather than a drop.
 *
 * **The direction that WOULD break this file is a SIGNATURE**, because a step
 * body is a pure CALLER: every name below is invoked, none is implemented. A
 * narrowed parameter on `stepFetch`, a second required argument on
 * `stepWebhookUrl`, a `StepInfo` that stops carrying `isLastAttempt` — each
 * reddens here, and each is a real break for every `workflows/*.ts` module in
 * every user project.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 5 has to be dropped with a reason.
 */

import {
  encodeWav,
  type MultipartBody,
  type MultipartPart,
  multipartBody,
  type PcmFormat,
  pcmDurationMs,
  report,
  requireStepEnv,
  type SpeakOptions,
  type SpokenAudio,
  STEP_SPEAK_SAMPLE_RATE,
  type StepFetchInit,
  type StepInfo,
  stepFetch,
  stepInfo,
  stepSpeak,
  stepWebhookUrl,
  WAV_HEADER_BYTES,
} from "../../../sdk/step-barrel.ts";

/** The audio this briefing is assembled at, in one place. */
const FORMAT: PcmFormat = { sampleRate: STEP_SPEAK_SAMPLE_RATE, channels: 1, bitsPerSample: 16 };

/**
 * ── EDIT: the lines the briefing is read from. ───────────────────────────
 *
 * One `stepSpeak` per line rather than one for the whole script, because the
 * pieces are what the caller edits: a section that changed is re-spoken and its
 * neighbours are not. `sampleRate` is pinned to the constant instead of left to
 * the default so the sections cannot be synthesized at rates that disagree —
 * {@link frame} joins them, and a join across rates is a file that plays at the
 * wrong speed rather than a file that fails.
 */
export async function speakLines(lines: readonly string[]): Promise<SpokenAudio[]> {
  const opts: SpeakOptions = { voice: "matilda", sampleRate: STEP_SPEAK_SAMPLE_RATE };
  const spoken: SpokenAudio[] = [];
  for (const line of lines) {
    spoken.push(await stepSpeak(line, opts));
  }
  return spoken;
}

/**
 * Frame the sections as ONE `.wav`, and say how long it runs.
 *
 * `SpokenAudio` carries both a finished file and the bare `pcm`, and this is the
 * case the second one exists for: concatenating the FILES would put a
 * `WAV_HEADER_BYTES` header in the middle of the audio, and a `.wav` has exactly
 * one — it declares the byte count that follows it, so a second one is data as
 * far as any reader is concerned. The samples are joined and framed once
 * instead.
 *
 * `encodeWav` takes the sections as a list, so nothing here builds an
 * intermediate copy of the audio to hand it one buffer.
 *
 * The duration is computed off the SAMPLES rather than off the file:
 * `WAV_HEADER_BYTES` of what comes back is header, and counting them as audio
 * overstates a short briefing by enough to matter.
 */
export function frame(spoken: readonly SpokenAudio[]): { wav: Uint8Array; durationMs: number } {
  const wav = encodeWav(
    spoken.map((section) => section.pcm),
    FORMAT,
  );
  return { wav, durationMs: pcmDurationMs(wav.byteLength - WAV_HEADER_BYTES, FORMAT) };
}

/**
 * Post the briefing to the partner, with a URL for them to answer on.
 *
 * `multipartBody` returns the body AND the `Content-Type` carrying the boundary
 * it chose, which is the pairing a hand-written version gets wrong — a boundary
 * in the header that does not match the one in the payload is a 400 from a
 * server that cannot tell you why.
 *
 * The payload arrives as ONE part, already whole: {@link frame} joined the
 * sections to make a legal `.wav`, so there is nothing left to hand over in
 * pieces, and the degraded path below has a single string to send.
 *
 * `stepWebhookUrl(token)` is the field that makes this a handoff rather than a
 * fire-and-forget. It is the only value here that LEAVES the system, and it
 * outlives the sandbox that minted it — which is the whole reason a body waiting
 * on a third party can wait on `ctx.waitFor(token)` instead of polling for an
 * answer that may take a human's working day to arrive.
 */
export async function deliver(
  payload: MultipartPart,
  token: string,
  durationMs: number,
): Promise<Response> {
  const encoder = new TextEncoder();
  const form: MultipartBody = multipartBody(
    payload,
    { name: "callback", bytes: encoder.encode(stepWebhookUrl(token)) },
    { name: "duration_ms", bytes: encoder.encode(String(durationMs)) },
  );
  const init: StepFetchInit = {
    method: "POST",
    headers: { ...form.headers, authorization: `Bearer ${requireStepEnv("PARTNER_API_KEY")}` },
    body: form.body,
  };
  // `stepFetch` rather than `fetch`, and that is the single most load-bearing
  // line in a step body: global `fetch` speaks HTTP/2, so a capacity limit
  // arrives as a stream reset rather than as a status a retry policy can read.
  return await stepFetch("https://partner.example.com/briefings", init);
}

/**
 * The whole step, and the one decision it makes for itself.
 *
 * `stepInfo()` is how a body reads the ENGINE: which try this is, and whether a
 * throw from here fails the step for good. The branch is the point — synthesis
 * is the expensive half and the partner would rather have the script than
 * nothing, so the LAST attempt degrades to text instead of spending its budget
 * on the leg that has already failed.
 *
 * `isLastAttempt` rather than `attempt === maxAttempts`: the subtraction is
 * where the mistake is, and a body that hard-codes the ceiling degrades early
 * and silently the day the call site's `maxAttempts` changes.
 *
 * `undefined` means this ran outside a step at all — under a test, or from a
 * tool — and the honest reading of that is "no attempt budget is being spent",
 * so it takes the full path.
 */
export async function publishBriefing(
  lines: readonly string[],
  token: string,
): Promise<{ durationMs: number; degraded: boolean }> {
  const info: StepInfo | undefined = stepInfo();
  await report(`briefing: attempt ${info?.attempt ?? 1} of ${info?.maxAttempts ?? 1}`);

  if (info?.isLastAttempt === true) {
    await report("last attempt: sending the script rather than the audio");
    const script: MultipartPart = {
      name: "script",
      bytes: new TextEncoder().encode(lines.join("\n")),
      filename: "briefing.txt",
      type: "text/plain",
    };
    await deliver(script, token, 0);
    return { durationMs: 0, degraded: true };
  }

  const { wav, durationMs } = frame(await speakLines(lines));
  const audio: MultipartPart = {
    name: "audio",
    bytes: wav,
    filename: "briefing.wav",
    type: "audio/wav",
  };
  await deliver(audio, token, durationMs);
  return { durationMs, degraded: false };
}
