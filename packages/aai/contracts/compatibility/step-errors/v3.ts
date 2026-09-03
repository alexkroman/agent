// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:step-errors` epoch 3.
 *
 * One workflow's failure vocabulary, leg by leg: fetch a manifest, cut and
 * transcribe the audio, ask the model for a summary, post it. Every call below
 * can fail, and what this capability is for is that a step's failure is a
 * DECISION — retry this, stop on that — rather than a stack trace. Written the
 * way it was authored at epoch 3, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * The ffmpeg run is a PARAMETER. `@alexkroman1/aai/ffmpeg` is what a real body
 * would call there, and it is a different capability with its own epochs —
 * naming it here would let a break in that surface redden this file and
 * misattribute the finding to `step-errors`. Same for the channel: its two
 * argument types are read off `sendToChannelClassified` itself rather than
 * imported from `@alexkroman1/aai/channels`, so this example stays evidence
 * about ONE promise.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * Epoch 4 WIDENED `stepTranscribeSyncClassified`'s first parameter, from
 * `Uint8Array` to `Uint8Array | readonly Uint8Array[]`, so a caller holding a
 * header and its samples separately need not join them into a second full copy
 * of the audio before handing them over.
 *
 * **A widened PARAMETER cannot break a CALLER, which is all this file is.** It
 * accepts everything it used to accept, so {@link clipText} below passes one
 * `Uint8Array` and is as legal at epoch 4 as it was at epoch 3 — the same
 * bytes, the same request on the wire. That is what makes this a retain rather
 * than a drop. The mirror image is not safe and is worth naming: the same change
 * to a RETURN would hand every existing caller a union where it had a buffer,
 * and this capability returns no bytes at all.
 *
 * **The direction that WOULD break this file is a narrowing, or a VERDICT.**
 * Every name below is invoked, so a narrowed parameter or a second required
 * argument reddens here. So would something quieter and worse: `toStepError`
 * ceasing to answer a `FatalError` for a terminal status would leave
 * {@link deliverReceipt}'s fallback unreachable, with nothing failing to
 * compile and a run merely retrying a destination that will refuse it every
 * time. That is the claim this file exists to keep testable, and the reason a
 * fixture should USE what it names rather than only import it.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 3 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  DEFAULT_RETRY_DELAY_MS,
  FatalError,
  RetryableError,
  type RetryableErrorOptions,
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

/** The two arguments `sendToChannelClassified` takes, read off the function itself. */
type Destination = Parameters<typeof sendToChannelClassified>[0];
type Announcement = Parameters<typeof sendToChannelClassified>[1];

/** ── EDIT: the shape this step reads out of a partner's manifest. ───────── */
const Manifest = z.object({
  recording: z.string().trim().min(1),
  segments: z.array(z.string().trim().min(1)),
});

/**
 * Fetch the manifest, and let the two failures it has mean different things.
 *
 * `stepFetchOk` is `stepFetch` with the non-2xx branch every caller was writing
 * by hand — and the half that is easy to leave out is not the `if`, it is that
 * the BODY reaches the error and that the verdict comes from `toStepError`. A
 * hand-written version throws the number `400` and whoever reads the run has to
 * reproduce the call to find out what was wrong with it.
 *
 * What `stepFetchOk` does not cover is a 2xx body that is not the JSON it
 * claimed to be — a truncated response, a proxy's error page. That reaches
 * `toStepError`'s unclassifiable arm and comes back RETRYABLE, which is the safe
 * direction: a parse that failed once may well succeed next attempt, and the
 * alternative is silently disabling retries for a failure nobody classified.
 */
export async function readManifest(url: string): Promise<z.infer<typeof Manifest>> {
  const response = await stepFetchOk(url, { signal: AbortSignal.timeout(30_000) });
  const raw: unknown = await response.json().catch(throwStepError);
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    // Terminal on grounds no status code carries: the far side answered 200 with
    // a document this step cannot read, and it will answer with the same one on
    // every attempt. `throwFatalStepError` rather than `throw new FatalError`
    // because there IS a cause here, and a journaled failure that dropped it
    // reports one sentence with the issue list thrown away.
    return throwFatalStepError(parsed.error, `${url}: manifest is not the shape this step reads`);
  }
  if (parsed.data.segments.length === 0) {
    // And this one has no cause to carry — the body decided, so it says so
    // directly rather than routing through a classifier that would have to
    // guess.
    throw new FatalError(`${url}: manifest names no segments`);
  }
  return parsed.data;
}

/**
 * Cut a segment out, and classify what ffmpeg says about it.
 *
 * The inverted default is the whole reason this arm has a name of its own: a run
 * that TIMED OUT or was aborted is worth another attempt, and everything else
 * ffmpeg refuses — a container it will not read, a stream that is not there — is
 * terminal however many times it is replayed. `throwStepError`'s default runs
 * the other way, passing an unclassified cause through as retryable, and a
 * separate name is what keeps that polarity visible at the call site.
 */
export async function cutSegment(run: () => Promise<Uint8Array>): Promise<Uint8Array> {
  return await run().catch(throwFfmpegStepError);
}

/**
 * Transcribe one cut segment in a single request.
 *
 * This is the arm where classifying earns the most. A refusal the PROVIDER
 * decided — a segment with no speech in it, a container it will not read —
 * arrives carrying `retryable: false`, and unclassified a step re-uploads the
 * same bytes until its attempts run out on a file that will not transcribe on
 * any attempt.
 *
 * One buffer, because a cut segment IS one buffer.
 */
export async function clipText(bytes: Uint8Array, label: string): Promise<string> {
  const { text } = await stepTranscribeSyncClassified(bytes, { label, filename: `${label}.wav` });
  return text;
}

/**
 * Hand the whole recording to the async job API — upload, then submit.
 *
 * Two calls and two steps, which is why both are classified rather than one:
 * they have separate attempt budgets, so classifying the upload and not the
 * submit means the run gives up in one place and never in the other.
 */
export async function submitRecording(uploadId: string): Promise<string> {
  const { audioUrl } = await stepTranscribeUploadClassified(uploadId);
  const { id } = await stepTranscribeSubmitClassified(audioUrl);
  return id;
}

/**
 * How long to wait before asking the job again.
 *
 * {@link DEFAULT_RETRY_DELAY_MS} is what omitting the delay MEANS — one second —
 * and its own doc says it is not a considered number. It is the wrong one here
 * twice over: a job that is still queued will not be finished a second from now,
 * and a fan-out's segments all meet the queue together, so a second later every
 * one of them asks again. Naming a delay is how a body says what it actually
 * knows about the far side.
 */
const POLL_AGAIN: RetryableErrorOptions = { retryAfter: DEFAULT_RETRY_DELAY_MS * 30 };

/**
 * Ask the job whether it is finished, and let "not yet" be a retry.
 *
 * A poll that ANSWERS is not a poll that succeeded: an unfinished job comes back
 * as progress and only a transport or API failure rejects, so the classified
 * call says nothing about the job's own status. Turning "still running" into a
 * `RetryableError` is what makes the wait the ENGINE's rather than this body's —
 * a step that slept in a loop instead would hold its attempt open across the
 * whole job and lose the lot to one redeploy.
 */
export async function awaitTranscript(id: string): Promise<string> {
  const progress = await stepTranscribePollClassified(id);
  if (!progress.done)
    throw new RetryableError(`Transcript ${id} is ${progress.status}.`, POLL_AGAIN);
  return progress.transcript.text;
}

/** What the model must answer with, as something that CHECKS. */
const Summary = z.object({
  headline: z.string().trim().min(1),
  risks: z.array(z.string().trim().min(1)),
});

/**
 * Ask the model, two ways, and the difference is who validates.
 *
 * Both wrappers add exactly one thing — the classification — and it is worth
 * having because `StepGenerateError` carries the gateway's own verdict AND its
 * `Retry-After`, so a rate-limited call waits the delay the gateway named
 * instead of the one-second default. What neither flattens is the difference
 * between a gateway refusal and a reply that missed the schema: the second is a
 * plain error, passed through retryable, which is correct — a model that
 * answered in prose may obey on the next attempt.
 */
export async function summarize(transcript: string): Promise<{ headline: string; note: string }> {
  const shape = await stepGenerateJsonClassified(`Summarize this call:\n\n${transcript}`, {
    system: "You audit support calls. Be specific and never invent a risk.",
    schema: Summary,
    temperature: 0,
  });
  const note = await stepGenerateClassified(
    `Write one sentence a reviewer can act on, given these risks:\n${shape.risks.join("\n")}`,
    { system: "Be terse.", temperature: 0 },
  );
  return { headline: shape.headline, note };
}

/**
 * Post the summary, and FALL BACK rather than fail when the destination is the
 * problem.
 *
 * `toStepError` rather than `throwStepError`, because this body has a decision
 * to make before it fails and the verdict is the input to it. A terminal refusal
 * — a revoked webhook, an unpublished workflow, a variable name that matches
 * nothing — is a fact about the destination and answers identically on every
 * attempt, so retrying is the one thing that cannot help and a second route is
 * the only thing that can. Anything retryable is left alone: the engine is
 * better placed to wait than this body is.
 *
 * `FatalError.is` rather than `instanceof`, and that is not style. Membership is
 * a BRAND, so the check survives a second copy of this module in the graph —
 * which is the arrangement a bundled step artifact routinely produces, and where
 * `instanceof` silently answers `false` and sends every terminal refusal back
 * round the retry loop.
 */
export async function deliverReceipt(
  response: Response,
  label: string,
  fallback: () => Promise<void>,
): Promise<void> {
  if (response.ok) return;
  const verdict = toStepError(response, `${label}: receipt refused with HTTP ${response.status}`);
  if (!FatalError.is(verdict)) throw verdict;
  await fallback();
}

/**
 * Announce the finished audit.
 *
 * `sendToChannelClassified` for the reason every other wrapper here is used: a
 * 4xx from a webhook is terminal by construction, and stopping on it with the
 * sentence a person can act on beats burning three more attempts on an answer
 * that will not change. Reach for the raw `sendToChannel` where an unreachable
 * channel is a warning rather than an outcome.
 */
export async function announce(to: Destination, message: Announcement): Promise<string> {
  return await sendToChannelClassified(to, message);
}
