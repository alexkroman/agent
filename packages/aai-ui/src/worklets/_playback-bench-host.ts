// Copyright 2026 the AAI authors. MIT license.
/**
 * The bench's HOST-side half: what the server believes about the caller's
 * playback, against what the caller actually heard.
 *
 * Split from `_playback-bench-harness.ts` at the seam it already had — that file
 * models the wire and drives the worklet, and this one models
 * `aai/host/transports/pipeline-heard.ts`'s arithmetic over the result. It went
 * out when the file hit the 500-line cap, which is the right time rather than a
 * line later.
 *
 * Everything here is a TRANSCRIPTION of host code this package may not import
 * (`aai`'s `host/` is Node-only and internal), so it carries the same warning the
 * pacer model does: a change to `createPlaybackClock` will not fail this file.
 * Re-read it against these functions if that clock moves.
 */

import type { Delivery, RenderResult } from "./_playback-bench-harness.ts";

/**
 * What the HOST believes about playback, and what actually happened.
 *
 * The barge-in floor is `pending()` in `aai/host/transports/pipeline-heard.ts`:
 * `now() < endsAtMs + PIPELINE_PLAYBACK_GRACE_MS`, where `endsAtMs` accumulates
 * each forwarded chunk's duration from `max(endsAtMs, now())` — an OPEN-LOOP
 * model that assumes playback starts the instant a chunk is forwarded and runs at
 * exactly 1.0x. No real client beats that, so the model is a lower bound and the
 * grace is what covers the difference.
 *
 * This measures the difference. `requiredGraceMs` is how long after the host's
 * estimate the caller was still hearing audio — i.e. the smallest grace that
 * keeps barge-in working to the end of a reply. It is a REQUIREMENT, so a grace
 * at or above it is correct and one below it means a barge-in in the reply's tail
 * is not recognised as arriving during playback.
 *
 * Two clients are modelled because the host serves both: one that wires
 * `onPlaybackProgress` (the browser does) and one that does not (a telephony
 * bridge, a harness). The reports clamp `endsAtMs` UPWARD only, so a reporting
 * client shrinks the requirement and a silent one leaves the host on the
 * open-loop estimate — which is the case the constant has to be safe for.
 */
export type PlayoutVsHost = {
  /** When the host's open-loop model thinks forwarded audio finishes playing. */
  openLoopEndMs: number;
  /** The same, with the client's `playback_progress` reports clamped in. */
  reportedEndMs: number;
  /** When the caller actually stopped hearing audio. */
  realEndMs: number;
  /** Smallest grace that keeps `pending()` true to `realEndMs`, unreported. */
  requiredGraceMs: number;
  /** The same for a client that DOES report its backlog. */
  requiredGraceReportingMs: number;
};

/**
 * Replay a render against the host's own playback-clock arithmetic.
 *
 * `deliveries` is what the host FORWARDED (the pacer's output, before the link),
 * because that is what `onChunk` sees — the host has no view of the wire.
 */
export function playoutVsHost(opts: {
  forwarded: Delivery[];
  render: RenderResult;
  sampleRate: number;
  /** Interval of the client's backlog reports; production is 500 ms. */
  reportIntervalMs: number;
}): PlayoutVsHost {
  const { forwarded, render, sampleRate } = opts;
  // The host's model, transcribed from `createPlaybackClock`.
  let endsAtMs = 0;
  for (const d of forwarded) {
    const chunkMs = (d.bytes.byteLength / 2 / sampleRate) * 1000;
    endsAtMs = Math.max(endsAtMs, d.atMs) + chunkMs;
  }
  const openLoopEndMs = endsAtMs;

  // The same, plus the upward clamp each backlog report applies. The reports the
  // worklet posted are in order at a fixed interval, so their wall times are the
  // interval times their index.
  let reported = 0;
  for (const [i, bufferedMs] of render.progressMs.entries()) {
    const atMs = render.timeToFirstAudioMs + i * opts.reportIntervalMs;
    reported = Math.max(reported, atMs + bufferedMs);
  }
  const reportedEndMs = Math.max(openLoopEndMs, reported);

  // Ground truth: the last quantum the ear received audio in.
  const realEndMs = render.timeToFirstAudioMs + render.playedMs;

  return {
    openLoopEndMs,
    reportedEndMs,
    realEndMs,
    requiredGraceMs: Math.max(0, realEndMs - openLoopEndMs),
    requiredGraceReportingMs: Math.max(0, realEndMs - reportedEndMs),
  };
}
