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
 * ## A poll reads THREE numbers, and each answers a different question
 *
 * `size` is the CONTIGUOUS PREFIX, `stored` is every byte that has landed, and
 * `ranges` is where those bytes are. They are one number only for a whole-file
 * upload; under the browser's default fan-out they diverge completely, and reading
 * the wrong one is two separate bugs:
 *
 * - **Readiness on the prefix alone made this flow a no-op.** The client sends
 *   `UPLOAD_PART_CONCURRENCY` windows of `UPLOAD_PART_BYTES` at once, so every part
 *   of any recording that fits in one round shares the uplink and they all finish
 *   together. The prefix cannot move until the FIRST part completes, which is
 *   within a second of the last. Measured on a deployed agent, a 27 MB recording at
 *   0.9 MB/s: `size` was 0 at every poll for 45 seconds and then the whole file, so
 *   the run planned nothing, transcribed nothing, and did its entire fan-out after
 *   the upload — the classic flow, with extra steps. `segmentStored` reads `ranges`
 *   instead, and `readUpload` clamps to the run a read starts in rather than to the
 *   prefix, so a window that has landed is a window this flow can work on.
 * - **The stall test on the prefix would then FAIL a healthy upload.** A parts
 *   upload moving at full speed reports the same prefix at every poll, which is
 *   indistinguishable from a dead client — so past {@link MAX_IDLE_POLLS} the run
 *   abandons an upload that is still arriving. It reads `stored`, which grows with
 *   every window whatever order they land in.
 *
 * `size` keeps the two jobs only it can do: the header probe (which reads from byte
 * zero) and the finished recording's duration.
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
 * - the store publishes bytes an `UPLOAD_PART_BYTES` window at a time (8 MiB), so the
 *   view a poll reads is up to a window stale. This paragraph said 1 MiB, naming
 *   `UPLOAD_CHUNK_BYTES`, which is the chunk a range READ is served in and not the
 *   unit a write publishes: `putWindows` cuts a body into `UPLOAD_PART_BYTES`
 *   windows so one byte layout serves every route an upload can arrive by;
 * - the body sleeps {@link POLL_INTERVAL_MS} between polls when nothing is ready, cut
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

import type { WorkflowCtx } from "@alexkroman1/aai";
import {
  mapConcurrent,
  readUpload,
  report,
  type UploadRange,
  uploadInfo,
} from "@alexkroman1/aai/step";
import { throwFatalStepError } from "@alexkroman1/aai/step-errors";
import { formatDuration, omitUndefined, plural } from "@alexkroman1/aai/utils";
import {
  fatalOnUnsupported,
  mergeTranscript,
  type SegmentTranscript,
  segmentConcurrency,
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

/**
 * The LONGEST the body waits between polls, and its fallback when it cannot do
 * better.
 *
 * It used to be the only interval, and on a slow uplink that is most of what this
 * flow was still leaving on the table. A poll answers "has the next segment
 * landed"; a flat interval answers it on average half an interval late, once per
 * segment, for the whole upload — 20 segments of a 30-minute recording is ~50s of
 * pure waiting added to a run whose entire point is to finish as the bytes arrive.
 *
 * So it is a CEILING now: {@link nextPollDelay} sleeps until the next segment
 * should have landed, and falls back here when there is nothing to predict from.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * The shortest the body will sleep.
 *
 * A poll is one cheap step (the body's own note above the `continue` says so), but
 * it is not free — it is a journal write and, on the platform, a step execution —
 * so a rate estimate that comes out near zero must not turn the loop into a spin.
 * 250ms is under the latency of any single segment's transcription, so nothing is
 * waiting on this.
 */
const MIN_POLL_INTERVAL_MS = 250;

/**
 * Consecutive polls with NO new bytes before the run gives up.
 *
 * An upload that died stays incomplete forever, so without a bound the run polls for
 * as long as the world will replay it. At {@link POLL_INTERVAL_MS} this is five minutes
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
  /**
   * The CONTIGUOUS PREFIX — how far the file can be read from byte zero.
   *
   * Not how much has arrived: see {@link UploadProgressView.stored}. It is what
   * the header probe and the final duration are measured against, because both
   * want a length rather than a coverage map.
   */
  size: number;
  /** Whether that is all of them. The ONLY field an exit may be decided on. */
  complete: boolean;
  /**
   * Total bytes landed, prefix and windows ahead of it alike.
   *
   * The one number a STALL may be judged on. `size` cannot be: a fan-out lands
   * its windows out of order, so the prefix stays at zero through an upload that
   * is moving at full speed and {@link MAX_IDLE_POLLS} would call it dead.
   */
  stored: number;
  /**
   * The windows that have landed, when the upload arrived as parts.
   *
   * Absent for a whole-file write, whose bytes are the prefix and nothing else.
   * This is what makes a segment readable before the windows in front of it
   * arrive — see the readiness test in the body.
   */
  ranges?: readonly UploadRange[];
  /**
   * When this view was taken, as the step that took it saw the clock.
   *
   * Journaled, which is the only reason the body may read a clock at all: the
   * sleep below is derived from the RATE between two of these, and a value the
   * body sampled itself would make that derivation diverge on a replay. Same rule
   * as every other field here — see the body's own note on why its state is legal.
   */
  observedAt: number;
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
export async function transcribeStreamFlow(input: { recording: string }, ctx: WorkflowCtx) {
  // `ctx.now()`, not a step: the engine journals the read under its own key, so
  // every walk of this line sees the instant the first one did.
  const startedAt = await ctx.now();
  let plan: StreamPlan | undefined;
  // Body state, and legal because every value in it came out of a journaled step
  // result — a replay rebuilds the identical sets in the identical order.
  const done = new Set<number>();
  const parts: SegmentTranscript[] = [];
  let idlePolls = 0;
  // The prefix at the last poll, which is what the final duration is measured
  // from — and deliberately NOT what the stall test reads; see `lastStored`.
  let lastSize = 0;
  // Total bytes landed at the last poll. A fan-out lands its windows out of
  // order, so this is the only number that distinguishes an upload that has
  // stopped from one whose prefix has not caught up yet.
  let lastStored = -1;
  /**
   * The previous poll, so {@link nextPollDelay} has two journaled samples to take
   * a rate from. Body state for the same reason the rest is: it came out of a step.
   */
  let previous: UploadProgressView | undefined;

  for (;;) {
    const at = await ctx.step("probeUpload", () => probeUpload(input.recording));
    // Every poll, because this is only ever read at the END — the run breaks out
    // on a `complete` view, whose prefix is the whole file. Updating it inside a
    // branch is how it used to end up describing whichever poll last had work.
    lastSize = at.size;

    // The header has to be present before anything can be planned, and it is the
    // first thing to arrive. `complete` also qualifies, for a recording shorter
    // than the probe window.
    if (!plan && (at.size >= HEADER_PROBE_BYTES || at.complete)) {
      plan = await ctx.step("planStreamed", () => planStreamed(input.recording));
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
          (segmentStored(segment, at) || (at.complete && segment.start < at.size)),
      );
      if (ready.length > 0) {
        idlePolls = 0;
        lastStored = at.stored;
        for (const segment of ready) done.add(segment.index);
        // One step per segment, bounded, in an order a replay reproduces exactly —
        // `ready` is derived from a journaled poll, and `mapConcurrent` issues its
        // calls in list order. THE SAME STEP the classic flow uses, so a segment
        // transcribed here reaches the page's live transcript identically.
        parts.push(
          ...(await mapConcurrent(
            ready,
            segmentConcurrency((plan as StreamPlan).format),
            (segment) =>
              // `maxAttempts: 6` was `transcribeSegment.maxRetries = 5`.
              ctx.step(
                "transcribeSegment",
                () => transcribeSegment(input.recording, (plan as StreamPlan).format, segment),
                { maxAttempts: 6 },
              ),
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
    // A stall, not an ending — see MAX_IDLE_POLLS. Judged on `stored` rather than
    // on the prefix: under the browser's default fan-out the prefix does not move
    // at all until the first window lands, so a run reading it would call a
    // healthy upload abandoned five minutes in and fail.
    if (at.stored === lastStored) idlePolls += 1;
    else {
      idlePolls = 0;
      lastStored = at.stored;
    }
    if (idlePolls > MAX_IDLE_POLLS) abandon(input.recording, at);
    // Sleep until the next segment should HAVE landed, rather than for a fixed
    // interval — see `nextPollDelay`. Both arguments are journaled step results,
    // so a replay computes the same delay from the same two samples.
    await ctx.sleep("poll", nextPollDelay(at, previous, plan, done));
    previous = at;
  }

  const finished = plan;
  if (!finished) abandon(input.recording, { size: 0, stored: 0 });
  return await ctx.step("mergeTranscript", () =>
    mergeTranscript(
      input.recording,
      offsetToMs(finished.format, Math.min(finished.format.dataEnd, lastSize)),
      parts,
      startedAt,
    ),
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
  const info = await uploadInfo(id);
  return {
    size: info.size,
    complete: info.complete,
    stored: storedBytes(info.size, info.ranges),
    // Legal HERE and nowhere else in this flow: a step's internals are not
    // replayed, only its result — which is what makes a step the place a clock
    // belongs. See `sync-api.ts`'s `timed` for the same rule.
    observedAt: Date.now(),
    // `omitUndefined` rather than a spread, because a journaled step result is
    // compared on replay and `{ ranges: undefined }` is not `{}` once it has been
    // through JSON.
    ...omitUndefined({ ranges: info.ranges }),
  };
}

/**
 * How long to wait before asking again — the time the NEXT segment still needs.
 *
 * The flat {@link POLL_INTERVAL_MS} this replaced is wrong in both directions on a
 * slow uplink: too long when a segment is seconds away, and equally too long when
 * it is a minute away, so the run discovers work late and then asks again pointlessly.
 * Two consecutive polls give a byte RATE, the plan gives the byte offset the next
 * un-transcribed segment needs, and the difference is a wait with a reason.
 *
 * Every input is a journaled step result — both views, and a plan derived from one —
 * so a replay computes the identical delay. That is the whole reason
 * {@link UploadProgressView.observedAt} exists rather than the body reading a clock.
 *
 * It is deliberately an ESTIMATE with a floor and a ceiling rather than a promise.
 * Undershooting costs one extra cheap poll; overshooting is bounded by
 * {@link POLL_INTERVAL_MS}, so a rate that collapses mid-upload degrades to exactly
 * the old behaviour instead of stalling. Note the estimate is only ever used to
 * SLEEP: readiness is still decided by {@link segmentStored} against a real view, so
 * a wrong guess here can waste a poll and can never transcribe a partial segment.
 */
export function nextPollDelay(
  at: UploadProgressView,
  previous: UploadProgressView | undefined,
  plan: StreamPlan | undefined,
  done: ReadonlySet<number>,
): number {
  // No previous sample, or a clock that did not advance: nothing to derive a rate
  // from. The first sleep of every run takes this arm.
  const elapsedMs = previous ? at.observedAt - previous.observedAt : 0;
  if (!previous || elapsedMs <= 0) return POLL_INTERVAL_MS;
  const bytesPerMs = (at.stored - previous.stored) / elapsedMs;
  // A stalled or shrinking upload has no arrival to predict. `MAX_IDLE_POLLS` is
  // what ends that run; this only declines to guess about it.
  if (bytesPerMs <= 0) return POLL_INTERVAL_MS;
  // Before the header is read there is no plan, so what is being waited for is the
  // probe window itself — small, and usually one part away. It is measured against
  // the PREFIX because that is what the probe reads: from byte zero. Never against
  // `stored`, which counts every window that has landed wherever it landed — the
  // module doc's third section is about exactly that divergence, and under the
  // browser's default fan-out `HEADER_PROBE_BYTES - stored` goes NEGATIVE before
  // the header this arm is waiting for has arrived at all, collapsing the sleep to
  // its floor. The RATE above is still `stored`'s, which is right: that one is a
  // throughput, and throughput is what every window contributes to.
  //
  // The plan arm asks {@link segmentStored}'s own question instead of subtracting
  // an offset, because that test does not read the prefix either. Measuring a
  // segment against `size` saturates for the whole upload — 45 seconds of `size: 0`
  // on the measured 27 MB recording — so every segment's sleep came back as the
  // flat POLL_INTERVAL_MS this function exists to replace.
  const remaining = plan ? bytesUntilNextSegment(plan, done, at) : HEADER_PROBE_BYTES - at.size;
  // Every segment is already stored: the loop is waiting on `complete`, which is a
  // flag the uploader sets rather than bytes to extrapolate.
  if (remaining === undefined) return POLL_INTERVAL_MS;
  if (remaining <= 0) return MIN_POLL_INTERVAL_MS;
  return Math.min(
    POLL_INTERVAL_MS,
    Math.max(MIN_POLL_INTERVAL_MS, Math.ceil(remaining / bytesPerMs)),
  );
}

/**
 * How many bytes away the NEAREST un-transcribed segment is from being readable.
 *
 * The nearest rather than the earliest, and that is the `ranges` arm's doing: a
 * fan-out lands its windows out of order, so the next segment the loop can act on
 * is whichever one is closest to covered — not the first one in the file. They are
 * the same segment for a whole-file upload, where coverage is a prefix and the
 * least distance belongs to the lowest `end`.
 *
 * `undefined` when there is nothing left to wait for.
 */
function bytesUntilNextSegment(
  plan: StreamPlan,
  done: ReadonlySet<number>,
  at: UploadProgressView,
): number | undefined {
  let nearest: number | undefined;
  for (const segment of plan.segments) {
    if (done.has(segment.index)) continue;
    const missing = bytesUntilStored(segment, at);
    if (nearest === undefined || missing < nearest) nearest = missing;
  }
  return nearest;
}

/**
 * The bytes {@link segmentStored} still wants before it answers `true`.
 *
 * Derived from the same two readings that test uses, which is the whole point: a
 * remainder taken from anything else predicts an arrival the readiness test will
 * not agree with. Two ways for the window to be covered, so two candidates and the
 * smaller wins — the PREFIX growing to `segment.end`, or the run that already
 * holds `segment.start` growing to the same place. A run starting AFTER the
 * segment does can never cover it alone (`rangesOf` merges the adjacent ones), so
 * it is not a candidate at all and such a segment is left waiting on the prefix.
 */
function bytesUntilStored(segment: Segment, at: UploadProgressView): number {
  if (segmentStored(segment, at)) return 0;
  let missing = segment.end - at.size;
  for (const range of at.ranges ?? []) {
    if (range.start > segment.start) continue;
    missing = Math.min(missing, segment.end - range.end);
  }
  return missing;
}

/**
 * How many bytes have landed in total, prefix and detached windows alike.
 *
 * `ranges` COVERS the prefix when it is present (it is every window the record
 * holds, merged), so this is the larger of the two rather than their sum — adding
 * them would double-count the prefix and make a stalled upload look like it was
 * still growing, which is the one thing {@link MAX_IDLE_POLLS} must not be lied
 * to about.
 */
export function storedBytes(size: number, ranges: readonly UploadRange[] | undefined): number {
  if (!ranges) return size;
  return Math.max(
    size,
    ranges.reduce((total, range) => total + (range.end - range.start), 0),
  );
}

/**
 * Whether every byte of `segment` is stored, wherever in the file it landed.
 *
 * The prefix answers most of this — a whole-file upload has no windows and a
 * finished one is covered end to end — and the `ranges` arm is what makes the
 * streaming flow work against the browser's DEFAULT upload. That fan-out puts
 * `UPLOAD_PART_CONCURRENCY` windows on the link at once, so they finish together
 * and the prefix is zero until the last moment; measured on a deployed agent, a
 * 27 MB recording at 0.9 MB/s reported `size: 0` for 45 of its 45 seconds. Read
 * only the prefix and the run has nothing to do until the upload is over, which
 * is the entire wait this flow exists to remove.
 *
 * A window has to be covered WHOLE by one run: `readUpload` clamps to the run a
 * read starts in, so a segment straddling a hole would come back short and be
 * transcribed as a fragment. `rangesOf` merges adjacent windows, so a run really
 * is a contiguous stretch and one containment test is the whole check.
 */
export function segmentStored(segment: Segment, at: UploadProgressView): boolean {
  if (segment.end <= at.size) return true;
  return (at.ranges ?? []).some(
    (range) => range.start <= segment.start && segment.end <= range.end,
  );
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
    `Planned ${formatDuration(segments.at(-1)?.endMs ?? 0)} of audio as ` +
      `${segments.length} ${plural(segments.length, "segment")} while it uploads.`,
  );
  return { format, segments };
}

/**
 * How many segments a finished upload of `size` bytes really has.
 *
 * Not `plan.segments.length`: the plan came from the header's declared length, and a
 * recording that came up short has segments that start past the end of the file.
 * Counting those would leave the run waiting for audio nobody is going to send.
 *
 * Exported for its spec. It is the one piece of this flow's exit condition that is
 * a pure function of journaled values, so it is the one a test can pin — and the
 * failure it guards is a run that never ends rather than one that fails.
 */
export function expectedSegments(plan: StreamPlan, size: number): number {
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
function abandon(id: string, at: Pick<UploadProgressView, "size" | "stored">): never {
  throw new Error(
    `Gave up waiting for ${id}: ${at.stored} byte(s) stored, ${at.size} readable from the ` +
      `start, and still incomplete. Nothing new arrived for ${MAX_IDLE_POLLS} polls — the ` +
      "uploader stopped.",
  );
}
