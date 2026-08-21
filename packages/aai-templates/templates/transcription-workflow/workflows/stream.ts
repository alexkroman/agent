// Copyright 2026 the AAI authors. MIT license.
/**
 * The streaming desk: transcribe the recording WHILE it uploads.
 *
 * Read `transcribe.ts` first. This does the same three jobs — plan, transcribe,
 * stitch — with the same two steps doing the middle and the end, and the only thing
 * it changes is WHEN. That one change is the reason it exists:
 *
 * | | `transcribe` | `transcribeStream` |
 * | --- | --- | --- |
 * | the run starts | after the last byte is stored | before the first one is |
 * | the client sends | `POST /workflows/uploads` | `PUT /workflows/uploads/<id>` |
 * | who names the upload | the store | the CLIENT |
 * | the body | plans once, fans out once | polls, fans out over what has arrived |
 *
 * ## The client names the upload, and that is the whole trick
 *
 * An ordinary upload cannot help here: `POST` answers with an id once the last byte
 * is stored, so there is nothing to put in a run input until the upload is over. A
 * STREAMED upload is named by its caller — `useWorkflowStream` mints an id, starts
 * the run on it, and PUTs the file in one request — so the record exists from the
 * first byte with `complete: false` and its `size` grows as bytes land.
 *
 * The reader needed almost nothing for this, which is why this flow is so close to
 * the other one: `readUpload` already clamped its window to what is stored (so a
 * plan computed from a header could end one byte past the file), and that clamp is
 * exactly "read what has arrived". So `transcribeSegment` below is `transcribe.ts`'s
 * OWN step, unchanged, called on windows this body has checked are present.
 *
 * ## `complete`, never a stalled `size`
 *
 * The exit is the upload's `complete` flag. A `size` that has stopped growing means
 * only that nothing arrived recently, which is what a slow link and a dead client
 * both look like — so a body that took a stalled size for the end would return a
 * transcript of most of a recording and report success. The stall is what
 * {@link MAX_IDLE_POLLS} is for, and it FAILS the run rather than finishing it.
 *
 * ## It really does overlap, and the granularity is a SEGMENT
 *
 * Watched directly — the same 10-minute recording at 2 MB/s, polling the upload's
 * `size` and counting `Transcribed …` lines in the run's own log:
 *
 * ```text
 *    1s    2 MB uploaded   0 segments transcribed
 *   14s   26 MB            1          <- first one, at 24% of the file
 *   23s   45 MB            2
 *   32s   63 MB            3
 *   41s   82 MB            4
 *   48s   94 MB            5
 *   54s  106 MB            6
 *   55s  ---- PUT returns ----
 *   60s  109 MB            7          <- run completed
 * ```
 *
 * **Six of seven segments were transcribed before the upload finished.** So the run
 * does not wait for the file — and it does not start on the first CHUNK either, which
 * is worth being exact about: a segment is the smallest thing the sync endpoint can
 * decode, so the floor is "one segment has landed", not "some bytes have". Three
 * granularities stack up to that:
 *
 * - a segment is `SEGMENT_SECONDS + SEGMENT_OVERLAP_SECONDS` of audio — ~17.6 MB at
 *   48 kHz stereo, which is ~9s of a 2 MB/s uplink;
 * - the store publishes `size` a `UPLOAD_CHUNK_BYTES` chunk at a time (1 MiB), so the
 *   view a poll reads is at most a megabyte stale;
 * - the body sleeps {@link POLL_INTERVAL} between polls when nothing is ready, cut
 *   short by the client's wake.
 *
 * 9s + one poll is the 14s above. Nothing here can go below a segment without a
 * different provider API — which is what the third flow (`batch.ts`) is.
 *
 * ## What it actually saves, measured
 *
 * Run against a real dev server on a 10-minute 48 kHz stereo recording (115 MB, 7
 * segments), with `curl --limit-rate` standing in for an uplink:
 *
 * | uplink | classic (upload + run) | streaming (upload + tail) | saved |
 * | --- | --- | --- | --- |
 * | loopback | 0.3 + 5.3 = 5.5s | 0.2 + 5.3 = 5.5s | 0s |
 * | 8 MB/s | 13.8 + 4.2 = 18.0s | 13.9 + 3.2 = 17.1s | 0.9s |
 * | 2 MB/s | 55.1 + 4.3 = 59.4s | 55.1 + 2.2 = 57.3s | 2.1s |
 *
 * Read the TAIL column, which is the whole mechanism: it shrinks as the uplink slows
 * (5.3s -> 3.2s -> 2.2s) because more of the transcription has already happened
 * behind the upload by the time the last byte lands. The floor is one segment.
 *
 * **So the saving is roughly ONE segment's latency, not a proportion of the file** —
 * and the reason is structural rather than a tuning problem. Every segment but the
 * last is transcribed during the upload, and the last one cannot start until its
 * bytes land, so both flows end at `upload + one segment`. The transcription is the
 * small term for any file this endpoint accepts: it runs 20-200x faster than
 * realtime, so a recording long enough for the difference to matter is a recording
 * whose upload dominates either way.
 *
 * Precisely: both flows are `upload + rounds x one segment`, streaming is always
 * ONE round (only the last segment is left when the bytes land), and the classic
 * flow is `ceil(segments / segmentConcurrency)`. So the saving is
 * `(rounds - 1) x segment latency` and **it is ZERO whenever the classic fan-out
 * fits in one round** — which is most files, because that width is 32:
 *
 * | recording | segments | classic rounds | saving |
 * | --- | --- | --- | --- |
 * | 12 min, 48 kHz stereo (130 MB) | 8 | 1 | none, by construction |
 * | 60 min, 48 kHz stereo (660 MB) | 41 | 2 | one segment |
 * | 6 h, 16 kHz mono (660 MB) | 241 | 8 | seven segments |
 *
 * It therefore grows with the SEGMENT COUNT, which is duration over bitrate — not
 * with file size. The two 660 MB rows are the point: same bytes, same width, and
 * the low-bitrate one has six times the segments and six times the benefit.
 *
 * This paragraph used to claim a 97-minute recording was "~65 segments in ~9
 * rounds, and eight of those rounds happen behind the upload". The segment count
 * was right and the rounds were not: at width 32 that is 3 rounds, so at most 2
 * are hidden. It described a width of ~7, which is what `mapInBatches` and a
 * smaller `BYTES_IN_FLIGHT` gave before either moved — and it overstated this
 * flow's benefit about fourfold, which is exactly the expectation a reader brings
 * to the mode picker and then finds unmet.
 *
 * What it always buys, at any length, is the thing a table cannot show: the page
 * shows real progress — segment timings, arriving — while the bytes are still
 * moving, instead of a bar and then a wait. The classic flow remains the simpler
 * shape and is never slower, which is why the page offers both rather than replacing
 * one with the other.
 *
 * ## A ROUND has to finish before the next poll
 *
 * Everything the body decides comes from a journaled poll, so the set of segments it
 * fans out over is fixed for the length of that fan-out: one that becomes readable
 * while a round is in flight waits for the round. That is a smaller wait than it was
 * — `mapConcurrent` is a window over a cursor rather than sequential batches, so a
 * round now ends when its LAST segment lands rather than at the sum of each batch's
 * slowest — but it is not zero, and it is why the two flows converge on a fast
 * uplink rather than the streaming one winning. On a slow uplink it costs nothing:
 * segments arrive slower than they transcribe.
 *
 * Feeding new segments into a running fan-out would remove it and is deliberately
 * not done: which items are in flight would then depend on when bytes arrived, and
 * the DevKit correlates a journal entry to a step call by ISSUE ORDER. A round is
 * what keeps that order a pure function of journaled values.
 */

import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
import { mapConcurrent, readUpload, report, uploadInfo } from "@alexkroman1/aai/utils";
import { sleep } from "workflow";
import {
  clock,
  fatalOnUnsupported,
  mergeTranscript,
  type SegmentTranscript,
  segmentConcurrency,
  startClock,
  transcribeSegment,
} from "./transcribe.ts";
import {
  HEADER_PROBE_BYTES,
  offsetToMs,
  parseWav,
  planSegments,
  type Segment,
  UnsupportedRecordingError,
  type WavFormat,
} from "./wav.ts";

/** How long the body waits between polls when nothing new has arrived. */
const POLL_INTERVAL = "5s";

/**
 * Consecutive polls with NO new bytes before the run gives up.
 *
 * An upload that died stays incomplete forever, so without a bound the run polls for
 * as long as the world will replay it. At {@link POLL_INTERVAL} this is five minutes
 * of silence — far longer than any stall a live uplink produces, and short enough
 * that the failure reaches whoever is watching.
 *
 * It resets on every byte, so a slow upload is bounded by its own quietest gap
 * rather than by its total length: a two-hour recording on a bad connection is fine
 * as long as something arrives every five minutes.
 */
const MAX_IDLE_POLLS = 60;

/** What one poll of the upload found. */
export type UploadProgressView = {
  /** Bytes stored so far. */
  size: number;
  /** Whether that is all of them. The ONLY field an exit may be decided on. */
  complete: boolean;
};

/** The cut, derived once from the header. */
export type StreamPlan = {
  format: WavFormat;
  segments: Segment[];
};

/**
 * Transcribe a recording that is still uploading.
 *
 * The input is what `POST /workflows/runs` carries — see `agent.ts`. `recording` is
 * an upload id exactly as in the classic flow; what differs is that the client chose
 * it and the bytes are still on their way.
 */
export async function transcribeStreamFlow(input: { recording: string }) {
  "use workflow";

  const startedAt = await startClock();
  let plan: StreamPlan | undefined;
  // Body state, and legal because every value in it came out of a journaled step
  // result — a replay rebuilds the identical sets in the identical order.
  const done = new Set<number>();
  const parts: SegmentTranscript[] = [];
  let idlePolls = 0;
  let lastSize = -1;

  for (;;) {
    const at = await probeUpload(input.recording);

    // The header has to be present before anything can be planned, and it is the
    // first thing to arrive. `complete` also qualifies, for a recording shorter
    // than the probe window.
    if (!plan && (at.size >= HEADER_PROBE_BYTES || at.complete)) {
      plan = await planStreamed(input.recording);
    }

    if (plan) {
      // A segment is READY when its whole window is stored — except once the upload
      // is complete, where `at.size` is the true total and the plan came from the
      // header's DECLARED length: a recording that came up short leaves a final
      // segment ending past the file, and `readUpload` clamping is what makes that
      // the right answer rather than an error.
      const ready = plan.segments.filter(
        (segment) =>
          !done.has(segment.index) &&
          (segment.end <= at.size || (at.complete && segment.start < at.size)),
      );
      if (ready.length > 0) {
        idlePolls = 0;
        lastSize = at.size;
        for (const segment of ready) done.add(segment.index);
        // One step per segment, bounded, in an order a replay reproduces exactly —
        // `ready` is derived from a journaled poll, and `mapConcurrent` issues its
        // calls in list order. THE SAME STEP the classic flow uses, so a segment
        // transcribed here reaches the page's live transcript identically.
        parts.push(
          ...(await mapConcurrent(
            ready,
            segmentConcurrency((plan as StreamPlan).format),
            (segment) => transcribeSegment(input.recording, (plan as StreamPlan).format, segment),
          )),
        );
        // Straight back to the top WITHOUT sleeping, and this line was measured
        // rather than reasoned about. A batch takes seconds, so by the time it
        // finishes the upload has moved on and the view above is stale — deciding
        // anything on it means sleeping through news that has already arrived.
        // Measured by deleting this one statement, 10-minute recording at 8 MB/s:
        // the tail goes 3.2s -> 9.5s and the run 17.1s -> 23.4s. A poll is one cheap
        // step; sleeping is only right when there was nothing to do.
        continue;
      }
    }

    // Nothing to work on, so this view is current and the exit can be trusted.
    if (at.complete && plan && done.size >= expectedSegments(plan, at.size)) break;
    // A stall, not an ending — see MAX_IDLE_POLLS.
    if (at.size === lastSize) idlePolls += 1;
    else {
      idlePolls = 0;
      lastSize = at.size;
    }
    if (idlePolls > MAX_IDLE_POLLS) abandon(input.recording, at);
    await sleep(POLL_INTERVAL);
  }

  const finished = plan;
  if (!finished) abandon(input.recording, { size: 0, complete: false });
  return await mergeTranscript(
    input.recording,
    offsetToMs(finished.format, Math.min(finished.format.dataEnd, lastSize)),
    parts,
    startedAt,
  );
}

/**
 * How much of the upload is stored, and whether that is all of it.
 *
 * A step because it is I/O, which a body may not do — and because what the body does
 * next is derived from its RESULT, so journaling it is what makes the run take the
 * same branches on a replay. It narrates nothing: sixty "still uploading" lines
 * would bury the ones that matter, and `transcribeSegment` is where the log comes
 * from.
 */
export async function probeUpload(id: string): Promise<UploadProgressView> {
  "use step";

  const info = await uploadInfo(id);
  return { size: info.size, complete: info.complete };
}

/**
 * Read the header and decide where to cut — from the DECLARED length.
 *
 * The one real difference from `splitRecording` next door, and it is a one-argument
 * difference: that step passes the upload's own size, which for a file still
 * arriving is only what has landed so far and would plan a fraction of the
 * recording. `Number.POSITIVE_INFINITY` makes `parseWav` return the length the
 * header DECLARES, which is known from the first 64 KB — so the whole plan exists
 * before most of the audio does.
 *
 * A WAV declaring no length at all cannot be planned this way and is refused by
 * name: there is nothing to compute a segment list from until the file has finished,
 * which is what the classic flow is for.
 */
export async function planStreamed(id: string): Promise<StreamPlan> {
  "use step";

  const head = await readUpload(id, { end: HEADER_PROBE_BYTES });
  const format = fatalOnUnsupported(() => parseWav(head.bytes, Number.POSITIVE_INFINITY));
  if (!Number.isFinite(format.dataEnd)) {
    return throwFatalStepError(
      new UnsupportedRecordingError(
        "That WAV declares no data length, so its segments cannot be planned before it has " +
          "finished uploading. Use the `transcribe` workflow, which stores the file first.",
      ),
    );
  }
  const segments = fatalOnUnsupported(() => planSegments(format));
  await report(
    `Planned ${clock(segments.at(-1)?.endMs ?? 0)} of audio as ${segments.length} segment${
      segments.length === 1 ? "" : "s"
    } while it uploads.`,
  );
  return { format, segments };
}

/**
 * How many segments a finished upload of `size` bytes really has.
 *
 * Not `plan.segments.length`: the plan came from the header's declared length, and a
 * recording that came up short has segments that start past the end of the file.
 * Counting those would leave the run waiting for audio nobody is going to send.
 */
function expectedSegments(plan: StreamPlan, size: number): number {
  return plan.segments.filter((segment) => segment.start < size).length;
}

/**
 * Give up on an upload that stopped arriving.
 *
 * A PLAIN throw, not `throwFatalStepError`: this is the BODY, and the
 * fatal/retryable distinction belongs to a step — it is what tells the DevKit
 * whether to run that step again. A body that throws fails the run, which is what
 * should happen here, and dressing it up as a step error would suggest a retry
 * policy with nothing to apply to.
 */
function abandon(id: string, at: UploadProgressView): never {
  throw new Error(
    `Gave up waiting for ${id}: ${at.size} byte(s) stored and still incomplete. ` +
      `Nothing new arrived for ${MAX_IDLE_POLLS} polls — the uploader stopped.`,
  );
}
