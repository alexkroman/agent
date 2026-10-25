// Copyright 2026 the AAI authors. MIT license.
/**
 * The third desk: hand the whole recording to AssemblyAI's ASYNC API and wait.
 *
 * The other two flows exist because of one provider limit: the SYNC endpoint answers
 * inside the request and pays for it with a hard 120-second, 40 MB cap, so a long
 * recording has to be cut up and fanned out — and this template's whole subject is
 * the two ways to arrange that. The async API has no such cap. You submit a job, it
 * answers with an id in milliseconds, and the transcript is ready minutes later.
 *
 * So this flow is one call and no arithmetic: `transcribeUploadDurably`
 * (`@alexkroman1/aai/step`) journals the upload, the submit and the poll as three
 * steps of this body's own `ctx`, sleeping DURABLY between polls — which is the one
 * thing that makes this a workflow rather than a request. A job takes minutes, and
 * nothing about an HTTP request survives minutes.
 *
 * **It is here to be compared against the other two, and it usually wins.** No
 * segment planning, no seam stitching, no concurrency to tune, no WAV-only
 * restriction — the provider accepts compressed audio, so an m4a straight off a
 * phone works where both sync flows refuse it. What you give up is control of the
 * inside: the latency is the provider's queue rather than your fan-out, and there is
 * nothing to report between "submitted" and "done" except the job's own status.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { transcribeUploadDurably } from "@alexkroman1/aai/step";
import { countWords } from "@alexkroman1/aai/utils";
import type { Transcript } from "./transcribe.ts";

/** Transcribe a recording through the async API. */
export async function transcribeBatchFlow(
  input: { recording: string },
  ctx: WorkflowContext,
): Promise<Transcript> {
  // The clock at both ends, journaled under its own key, so a resumed run
  // reports the WHOLE run's elapsed rather than the delivery it finished on.
  // For this flow it is mostly the provider's queue, which is exactly the
  // thing a reader comparing the three wants to see.
  const startedAt = await ctx.now();
  const transcript = await transcribeUploadDurably(ctx, input.recording);
  const finishedAt = await ctx.now();
  await ctx.report("transcribed", `Transcribed ${transcript.source} in one piece.`);
  return {
    // The FILENAME, read off the journaled upload step — `upl_9f3…` tells a
    // reader nothing about which recording they are looking at.
    source: transcript.source,
    // ONE, and it is not a fudge: the async API transcribed the recording in one
    // piece, which is the difference this flow is here to show. A reader comparing
    // the three sees 7 segments, 7 segments, and 1.
    segments: 1,
    // The provider's own measurement — the only one of the three flows that does
    // not have to derive this from byte offsets.
    durationMs: transcript.durationMs,
    elapsedMs: finishedAt - startedAt,
    words: countWords(transcript.text),
    transcript: transcript.text,
  };
}
