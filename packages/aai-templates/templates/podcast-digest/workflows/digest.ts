// Copyright 2026 the AAI authors. MIT license.
/**
 * The flow: watch some podcasts, transcribe what is new, summarize it, and post
 * a digest to Slack — then do it again on a schedule, for as long as asked.
 *
 * ```text
 *   discoverEpisodes    one step  — links in, episodes with audio out
 *   submitTranscript    N steps   — hand each episode to AssemblyAI
 *   waitForTranscripts  the BODY  — poll the whole batch, sleeping between rounds
 *   summarizeTranscript N steps   — one model call per finished transcript
 *   sendDigestToSlack   one step  — the message
 *   sleep(interval)     the BODY  — and around again
 * ```
 *
 * ## What this template is FOR
 *
 * The other workflow templates are one-shot: something arrives, a run processes
 * it, the run ends. This one is the shape nothing else here demonstrates — a
 * run that is **long-lived and periodic**. It sleeps for days at a time and
 * wakes up to do the same work again, which is only possible because a durable
 * sleep is suspension rather than waiting: nothing is resident, nothing is
 * billed, and the run survives the agent restarting, redeploying or going idle
 * underneath it.
 *
 * That single fact is why `daysToRun` exists as an input at all. A run that
 * repeats forever is a resource nobody can see and nobody remembers to cancel,
 * so this one is asked up front how many digests it owes and then finishes.
 *
 * ## Storage is not optional here, unlike everywhere else
 *
 * Every other template says "enable the database for durability, but it is fine
 * to build without it". Deployed, that is settled for you: the platform keeps
 * runs on its own database, so a multi-day sleep survives. Under `aai dev`
 * without a `DATABASE_URL` the run lives in the process, and a process does not
 * survive a multi-day sleep — build with `intervalUnit: "minutes"` and you will
 * see it work either way; leave it on `days` locally and the second digest never
 * arrives.
 *
 * ## Batch polling, which is this file's one genuinely new mechanism
 *
 * `spoken-summary` and `transcription-workflow` each wait for ONE transcript,
 * so their poll loop is `for (…) { if (done) return; await ctx.sleep(…) }`. Here N
 * episodes are in flight at once and they finish out of order, so the loop has
 * to carry a shrinking pending set and let the finished ones drop out — see
 * {@link waitForTranscripts}. It is the same idea one dimension up, and the
 * reason it stays in the template rather than moving to the SDK is that the SDK
 * owns what is INSIDE a step and never the body's control flow.
 *
 * @module digest
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { mapConcurrent, report, TRANSCRIBE_API } from "@alexkroman1/aai/step";
import {
  FatalError,
  stepGenerateJsonClassified,
  stepTranscribePollClassified,
  stepTranscribeSubmitClassified,
} from "@alexkroman1/aai/step-errors";
import { errorMessage } from "@alexkroman1/aai/utils";
import type { WorkflowInputOf } from "@alexkroman1/aai/workflow-api";
import { z } from "zod";
import type { dailyDigest } from "../agent.ts";
import { discoverEpisodes, type Episode } from "./feeds.ts";
import { sendDigestToSlack } from "./slack.ts";

/**
 * Between polling rounds. Transcription is minutes, so this is not a busy wait.
 *
 * Exported so `agent.eval.test.ts` can assert on the wait a run RECORDED without
 * restating the number — an eval skips the sleep, so the duration asked for is
 * the only observable there is.
 */
export const POLL_DELAY_MS = 20_000;

/**
 * 180 rounds x 20s = an hour, which is far past any podcast episode.
 *
 * Exported for the same reason as {@link POLL_DELAY}: the eval drives a job past
 * this budget and reads the degraded entry, and a restated 180 in two files is a
 * second place for the number to be wrong.
 */
export const MAX_POLL_ATTEMPTS = 180;

/**
 * How much transcript the model reads.
 *
 * A three-hour episode is far more than a summary needs and more than the
 * context window wants to pay for. Truncating is the right call for a DIGEST
 * specifically: the opening of an episode is where its subject is stated.
 */
const MAX_TRANSCRIPT_CHARS = 18_000;

/**
 * Submissions in flight at once — polite to the provider, still parallel.
 *
 * Inside `DEFAULT_STEP_CONCURRENCY` (`aai-runtime`, 16), so this width is what
 * really runs — see "The WINDOW is not the concurrency" in `mapConcurrent`.
 */
const SUBMIT_CONCURRENCY = 2;

/**
 * Status checks in flight at once. Cheaper calls, so a wider gate.
 *
 * Well inside `DEFAULT_STEP_CONCURRENCY` (`aai-runtime`, 16), like
 * {@link SUBMIT_CONCURRENCY} above, so this width is what really runs.
 */
const POLL_CONCURRENCY = 3;

/**
 * What a run is started with — the schema's OUTPUT, so every `.default()` has
 * already run and nothing here is optional.
 *
 * Derived rather than restated. The hand-written version this replaces declared
 * six optional fields against a schema where all six carry a default, so the
 * body re-applied every one of them with `??` and a `.default(5)` beside a
 * `?? 3` could disagree with nothing reporting it.
 */
export type DigestInput = WorkflowInputOf<typeof dailyDigest>;

export type IntervalUnit = "minutes" | "hours" | "days";

/**
 * An episode on its way through transcription.
 *
 * A discriminated union rather than an optional `transcript` field, so the
 * "we could not transcribe this one" case is a STATE the compiler makes every
 * reader handle — not a `undefined` somebody forgets to check. One bad episode
 * must not sink a digest of five.
 */
type TranscriptJob = Episode &
  (
    | { transcriptStatus: "submitted"; transcriptId: string }
    | { transcriptStatus: "unavailable"; reason: string }
  );

type TranscriptState = Episode &
  (
    | { transcriptStatus: "done"; transcriptId: string; transcript: string; durationMs: number }
    | { transcriptStatus: "unavailable"; reason: string }
  );

/** One episode as it appears in the message and on the page. */
export type EpisodeDigest = Episode & {
  transcriptSource: "assemblyai" | "unavailable";
  summary: string;
  keyPoints: string[];
};

export type DailyDigestOutput = {
  podcastChannels: string;
  deliveryTarget: string;
  scheduleInterval: string;
  digestsScheduled: number;
  digestsSent: number;
  lastDigest: {
    sentAt: string;
    slackStatus: string;
    episodes: EpisodeDigest[];
  } | null;
};

/** What the model must answer with, and what `stepGenerateJsonClassified` enforces. */
const SummaryReply = z.object({
  summary: z.string().trim().min(1),
  keyPoints: z.array(z.string().trim().min(1)).min(1).max(5),
});

/**
 * The body.
 *
 * Everything it does is a step call or a `sleep`, which is what makes it legal
 * to replay: the DevKit re-runs this function from the top after any crash, and
 * each step it reaches is either replayed from the journal or executed for the
 * first time. Nothing here reads a clock, generates an id, or touches anything
 * that would answer differently on the second pass — {@link timestamp} is a step
 * for exactly that reason.
 */
export async function dailyDigestFlow(
  input: DigestInput,
  ctx: WorkflowCtx,
): Promise<DailyDigestOutput> {
  // No `??` fallbacks: {@link DigestInput} is the schema's OUTPUT, so every
  // `.default()` has already run by the time a run reaches this line. The
  // chain this replaces restated all four of them, which is a second place for
  // the number to be wrong.
  const { daysToRun: totalDigests, maxEpisodesPerDigest: maxEpisodes } = input;
  const { intervalEvery, intervalUnit } = input;
  const intervalMs = scheduleIntervalMs(intervalEvery, intervalUnit);

  let lastDigest: DailyDigestOutput["lastDigest"] = null;
  let digestsSent = 0;

  for (let digestNumber = 1; digestNumber <= totalDigests; digestNumber += 1) {
    const episodes = await ctx.step("discoverEpisodes", () =>
      discoverEpisodes(input.podcastChannels, maxEpisodes),
    );
    // `maxAttempts` was a `maxRetries` property on each function (4, 4, 5 —
    // retries AFTER the first attempt, so 5, 5, 6 in all). It is an argument to
    // the CALL now, which is where a policy belongs: the same function called
    // from two places may deserve different patience.
    const jobs = await mapConcurrent(episodes, SUBMIT_CONCURRENCY, (episode) =>
      ctx.step("submitTranscript", () => submitTranscript(episode), { maxAttempts: 5 }),
    );
    const transcripts = await waitForTranscripts(jobs, ctx);
    const digests = await mapConcurrent(transcripts, SUBMIT_CONCURRENCY, (transcript) =>
      ctx.step("summarizeTranscript", () => summarizeTranscript(transcript), { maxAttempts: 6 }),
    );

    const slackStatus = await ctx.step("postDigest", () =>
      sendDigestToSlack({
        slackWebhookUrl: input.slackWebhookUrl,
        slackWorkflowTextParam: input.slackWorkflowTextParam,
        podcastChannels: input.podcastChannels,
        episodes: digests,
        digestNumber,
        totalDigests,
      }),
    );

    lastDigest = {
      sentAt: await ctx.step("timestamp", () => timestamp()),
      slackStatus,
      episodes: digests,
    };
    digestsSent += 1;

    // Not after the last one: a run that has delivered everything it owes
    // should end, not sleep for a day and then end.
    if (digestNumber < totalDigests) await ctx.sleep("nextDigest", intervalMs);
  }

  return {
    podcastChannels: input.podcastChannels,
    deliveryTarget: "Slack webhook",
    scheduleInterval: formatScheduleInterval(intervalEvery, intervalUnit),
    digestsScheduled: totalDigests,
    digestsSent,
    lastDigest,
  };
}

/**
 * Wait for a whole BATCH of transcripts, letting them finish out of order.
 *
 * Part of the BODY rather than a step, and not because it is small: it CALLS
 * steps and it sleeps, neither of which may happen inside one. So it is replayed
 * with the body — legal for the ordinary reason, that every line is either a
 * `ctx.step` or a `ctx.sleep` — and it takes the `ctx` for that reason.
 *
 * The shape to notice is that `pending` SHRINKS. A loop that waited for all N
 * on every round would hold the whole batch hostage to its slowest member, and
 * with `maxEpisodesPerDigest` up to 20 that is the difference between a digest
 * arriving and a digest timing out. Finished episodes move to `completed` and
 * are never polled again.
 *
 * Running out of rounds is NOT an error. An episode nobody could transcribe in
 * an hour becomes `unavailable` with a reason, and the digest goes out with the
 * other four — a partial digest being obviously better than none, and the
 * reason being printed where a reader will see it.
 *
 * **What comes back is in the order it went in**, which is not what a first
 * draft does. Appending each episode as it finishes — and concatenating the
 * ones that never did on the end — makes the digest's running order a report of
 * TRANSCRIPTION LATENCY: `discoverEpisodes` sorted the feed newest first, and a
 * reader then sees whichever episode the provider happened to finish first at
 * the top. Found by `agent.eval.test.ts`, which is the only tier that can see
 * it, a per-step spec having no batch to order.
 */
async function waitForTranscripts(
  jobs: TranscriptJob[],
  ctx: WorkflowCtx,
): Promise<TranscriptState[]> {
  let pending = jobs;
  // Keyed by episode id rather than appended, and that is what keeps the digest
  // in PUBLICATION order — see this function's doc.
  const settled = new Map<string, TranscriptState>();

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && pending.length > 0; attempt += 1) {
    const polled = await mapConcurrent(pending, POLL_CONCURRENCY, (job) =>
      ctx.step("pollTranscript", () => pollTranscript(job), { maxAttempts: 5 }),
    );
    for (const state of polled) {
      if (state.transcriptStatus !== "submitted") settled.set(state.id, state);
    }
    pending = polled.filter((state) => state.transcriptStatus === "submitted");
    if (pending.length > 0) await ctx.sleep("poll", POLL_DELAY_MS);
  }

  // The list `jobs` arrived in, which `discoverEpisodes` sorted newest first.
  // A job still pending is absent from `settled`, so the `??` IS the
  // give-up path — `pollTranscript` returns the job unchanged while it is
  // submitted, so the value given up on is the one that went in.
  return jobs.map((job) => settled.get(job.id) ?? gaveUpOn(job));
}

/**
 * One episode the run is done waiting for.
 *
 * Its own function because {@link waitForTranscripts} reaches it from the
 * ordered rebuild, for every job whose budget ran out while it was still
 * submitted and which is therefore absent from `settled`.
 */
function gaveUpOn(job: TranscriptJob): TranscriptState {
  return {
    ...job,
    transcriptStatus: "unavailable" as const,
    reason:
      job.transcriptStatus === "submitted"
        ? // The transcript is not lost — it is still on the provider, and the
          // message says where, the same way the other transcription templates do.
          `Transcript ${job.transcriptId} was still unfinished after ${MAX_POLL_ATTEMPTS} ` +
          `checks. It is not lost — read it with GET ${TRANSCRIBE_API}/v2/transcript/${job.transcriptId}.`
        : job.reason,
  };
}

/**
 * Hand one episode's audio to AssemblyAI.
 *
 * The `catch` is the interesting line, and the whole partial-failure policy is
 * in it: transport problems retry, this-episode-is-broken problems degrade. A
 * terminal failure — a 404 on the media URL, a file that is not audio — becomes
 * an `unavailable` VALUE rather than a throw, because one bad episode must not
 * sink a digest of five.
 *
 * The verdict itself is the SDK's: `stepTranscribeSubmitClassified` reads
 * `TranscribeError`'s own `retryable` AND its `retryAfter`, and throws a
 * `FatalError` or a `RetryableError` accordingly. The hand-written
 * `err instanceof TranscribeError && err.retryable` this replaces read only the
 * first of those, so a provider that named a delay was retried on the DevKit's
 * one-second default instead.
 */
export async function submitTranscript(episode: Episode): Promise<TranscriptJob> {
  await report(`Submitting ${episode.title} for transcription.`);
  try {
    const { id } = await stepTranscribeSubmitClassified(episode.audioUrl, {
      // A digest quotes nobody, so who spoke costs time for nothing.
      params: { speaker_labels: false },
    });
    return { ...episode, transcriptStatus: "submitted", transcriptId: id };
  } catch (err) {
    if (!FatalError.is(err)) throw err;
    return { ...episode, transcriptStatus: "unavailable", reason: errorMessage(err) };
  }
}

/**
 * Ask once whether one job has finished.
 *
 * One poll is one step, so each round is journaled on its own: a run that dies
 * mid-wait resumes knowing the last answer instead of re-transcribing. It
 * returns the job UNCHANGED when the answer is "not yet", which is what lets
 * {@link waitForTranscripts} keep it in `pending` without a second vocabulary
 * for "still going".
 */
export async function pollTranscript(job: TranscriptJob): Promise<TranscriptState | TranscriptJob> {
  if (job.transcriptStatus === "unavailable") return job;

  try {
    const progress = await stepTranscribePollClassified(job.transcriptId);
    // Branch on `done`, never on a status string: a vocabulary this body does
    // not own would otherwise read as "not finished yet" forever.
    if (!progress.done) return job;

    await report(`Transcribed ${job.title}.`);
    return {
      ...job,
      transcriptStatus: "done",
      transcriptId: job.transcriptId,
      transcript: progress.transcript.text,
      durationMs: progress.transcript.durationMs,
    };
  } catch (err) {
    // Same policy as {@link submitTranscript}: the SDK classified it, a
    // retryable verdict goes back to the DevKit, a terminal one degrades.
    if (!FatalError.is(err)) throw err;
    return { ...job, transcriptStatus: "unavailable", reason: errorMessage(err) };
  }
}

/** Reduce one transcript to the summary and points the digest carries. */
export async function summarizeTranscript(state: TranscriptState): Promise<EpisodeDigest> {
  if (state.transcriptStatus === "unavailable") {
    // Still an entry in the digest. A reader who sees four summaries and one
    // stated reason knows what happened; four summaries and silence looks like
    // the feed simply had four episodes.
    return {
      ...episodeOf(state),
      transcriptSource: "unavailable",
      summary: `This episode could not be transcribed: ${state.reason}`,
      keyPoints: ["No transcript was available to summarize."],
    };
  }

  await report(`Summarizing ${state.title}.`);
  const parsed = await stepGenerateJsonClassified(
    [
      `Podcast: ${state.podcastTitle}`,
      `Episode: ${state.title}`,
      `Published: ${state.published}`,
      "",
      "Transcript:",
      state.transcript.slice(0, MAX_TRANSCRIPT_CHARS),
    ].join("\n"),
    {
      schema: SummaryReply,
      system:
        "You summarize podcast transcripts for a daily digest. Reply with JSON only: " +
        '{"summary": string, "keyPoints": string[]}. Keep the summary to a few sentences ' +
        "and give 3 to 5 concrete key points — decisions, numbers, names, claims — never " +
        '"the hosts discussed several topics".',
    },
  );

  return {
    ...episodeOf(state),
    transcriptSource: "assemblyai",
    summary: parsed.summary,
    keyPoints: parsed.keyPoints,
  };
}

/**
 * The clock, as a step.
 *
 * A step's result is journaled and therefore stable across replays, where
 * `new Date()` in the body would answer differently on every one — and a body
 * that is not deterministic is a body the engine cannot replay.
 *
 * The read below is therefore a BASELINED occurrence of `guard-invariants`
 * rule 30, and that is the reason: it is inside a step, not inside a body. The
 * rule bans the call anywhere in a shipped `workflows/` file because the
 * `ctx.step` callback boundary is not decidable from a line; `dailyDigestFlow`
 * is what reaches this one, as `ctx.step("timestamp", () => timestamp())`.
 * Anything at BODY level is the bug, not an exception.
 */
export async function timestamp(): Promise<string> {
  return new Date().toISOString();
}

// ---- Pure helpers -----------------------------------------------------------

/** The `Episode` half of a state, without its transcript fields. */
function episodeOf(state: Episode): Episode {
  return {
    id: state.id,
    feedUrl: state.feedUrl,
    podcastTitle: state.podcastTitle,
    title: state.title,
    url: state.url,
    audioUrl: state.audioUrl,
    published: state.published,
  };
}

/** "1 hour", "15 minutes" — the schedule as the page prints it. */
export function formatScheduleInterval(every: number, unit: IntervalUnit): string {
  return `${every} ${every === 1 ? unit.slice(0, -1) : unit}`;
}

/**
 * The interval in milliseconds, which is one of the three things `sleep` takes.
 *
 * `sleep` also accepts a duration STRING (`"20 seconds"`, as `POLL_DELAY`
 * above), and building one here would look tidier — but that overload is typed
 * as a template-literal union, so a value assembled from two variables does not
 * satisfy it without a cast. A number needs no cast and no trust.
 */
export function scheduleIntervalMs(every: number, unit: IntervalUnit): number {
  const multiplier = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
  return every * multiplier;
}
