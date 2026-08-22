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
 * to build without it". For this one it is closer to a requirement: without
 * storage the run lives in the process, and a process does not survive a
 * multi-day sleep. Set `DATABASE_URL` under `aai dev`, or `aai storage enable`
 * once deployed. Build it with `intervalUnit: "minutes"` and you will see it
 * work either way; leave it on `days` without storage and the second digest
 * never arrives.
 *
 * ## Batch polling, which is this file's one genuinely new mechanism
 *
 * `spoken-summary` and `transcription-workflow` each wait for ONE transcript,
 * so their poll loop is `for (…) { if (done) return; await sleep(…) }`. Here N
 * episodes are in flight at once and they finish out of order, so the loop has
 * to carry a shrinking pending set and let the finished ones drop out — see
 * {@link waitForTranscripts}. It is the same idea one dimension up, and the
 * reason it stays in the template rather than moving to the SDK is that the SDK
 * owns what is INSIDE a step and never the body's control flow.
 *
 * @module digest
 */

import {
  mapConcurrent,
  report,
  stepGenerateJson,
  stepTranscribePoll,
  stepTranscribeSubmit,
  TRANSCRIBE_API,
  TranscribeError,
} from "@alexkroman1/aai/step";
import { throwStepError } from "@alexkroman1/aai/step-errors";
import { errorMessage } from "@alexkroman1/aai/utils";
import { sleep } from "workflow";
import { z } from "zod";
import { discoverEpisodes, type Episode } from "./feeds.ts";
import { sendDigestToSlack } from "./slack.ts";

/** Between polling rounds. Transcription is minutes, so this is not a busy wait. */
const POLL_DELAY = "20 seconds";

/** 180 rounds x 20s = an hour, which is far past any podcast episode. */
const MAX_POLL_ATTEMPTS = 180;

/**
 * How much transcript the model reads.
 *
 * A three-hour episode is far more than a summary needs and more than the
 * context window wants to pay for. Truncating is the right call for a DIGEST
 * specifically: the opening of an episode is where its subject is stated.
 */
const MAX_TRANSCRIPT_CHARS = 18_000;

/** Submissions in flight at once — polite to the provider, still parallel. */
const SUBMIT_CONCURRENCY = 2;

/** Status checks in flight at once. Cheaper calls, so a wider gate. */
const POLL_CONCURRENCY = 3;

export type DigestInput = {
  podcastChannels: string;
  slackWebhookUrl: string;
  slackWorkflowTextParam?: string;
  maxEpisodesPerDigest?: number;
  intervalEvery?: number;
  intervalUnit?: IntervalUnit;
  daysToRun?: number;
};

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

/** What the model must answer with, and what `stepGenerateJson` enforces. */
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
export async function dailyDigestFlow(input: DigestInput): Promise<DailyDigestOutput> {
  "use workflow";

  const totalDigests = input.daysToRun ?? 7;
  const maxEpisodes = input.maxEpisodesPerDigest ?? 5;
  const intervalEvery = input.intervalEvery ?? 1;
  const intervalUnit = input.intervalUnit ?? "days";
  const intervalMs = scheduleIntervalMs(intervalEvery, intervalUnit);

  let lastDigest: DailyDigestOutput["lastDigest"] = null;
  let digestsSent = 0;

  for (let digestNumber = 1; digestNumber <= totalDigests; digestNumber += 1) {
    const episodes = await discoverEpisodes(input.podcastChannels, maxEpisodes);
    const jobs = await mapConcurrent(episodes, SUBMIT_CONCURRENCY, submitTranscript);
    const transcripts = await waitForTranscripts(jobs);
    const digests = await mapConcurrent(transcripts, SUBMIT_CONCURRENCY, summarizeTranscript);

    const slackStatus = await sendDigestToSlack({
      slackWebhookUrl: input.slackWebhookUrl,
      slackWorkflowTextParam: input.slackWorkflowTextParam ?? "text",
      podcastChannels: input.podcastChannels,
      episodes: digests,
      digestNumber,
      totalDigests,
    });

    lastDigest = { sentAt: await timestamp(), slackStatus, episodes: digests };
    digestsSent += 1;

    // Not after the last one: a run that has delivered everything it owes
    // should end, not sleep for a day and then end.
    if (digestNumber < totalDigests) await sleep(intervalMs);
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
 * A plain async function rather than a step, and not because it is small: it
 * calls steps and it `sleep`s, neither of which a step may do. So it runs as
 * part of the body and is replayed with it — legal for the ordinary reason,
 * that every line is either a step call or a `sleep`.
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
 */
async function waitForTranscripts(jobs: TranscriptJob[]): Promise<TranscriptState[]> {
  let pending = jobs;
  const completed: TranscriptState[] = [];

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS && pending.length > 0; attempt += 1) {
    const polled = await mapConcurrent(pending, POLL_CONCURRENCY, pollTranscript);
    for (const state of polled) {
      if (state.transcriptStatus !== "submitted") completed.push(state);
    }
    pending = polled.filter((state) => state.transcriptStatus === "submitted");
    if (pending.length > 0) await sleep(POLL_DELAY);
  }

  return completed.concat(
    pending.map((job) => ({
      ...job,
      transcriptStatus: "unavailable" as const,
      reason:
        job.transcriptStatus === "submitted"
          ? // The transcript is not lost — it is still on the provider, and the
            // message says where, the same way the other transcription templates do.
            `Transcript ${job.transcriptId} was still unfinished after ${MAX_POLL_ATTEMPTS} ` +
            `checks. It is not lost — read it with GET ${TRANSCRIBE_API}/v2/transcript/${job.transcriptId}.`
          : job.reason,
    })),
  );
}

/**
 * Hand one episode's audio to AssemblyAI.
 *
 * The `catch` is the interesting line. `TranscribeError` has already decided
 * whether a failure is worth retrying, so a retryable one is re-thrown for the
 * DevKit to schedule, and a terminal one — a 404 on the media URL, a file that
 * is not audio — becomes an `unavailable` VALUE rather than a throw. That is
 * the whole partial-failure policy in one place: transport problems retry,
 * this-episode-is-broken problems degrade.
 */
export async function submitTranscript(episode: Episode): Promise<TranscriptJob> {
  "use step";

  await report(`Submitting ${episode.title} for transcription.`);
  try {
    const { id } = await stepTranscribeSubmit(episode.audioUrl, {
      // A digest quotes nobody, so who spoke costs time for nothing.
      params: { speaker_labels: false },
    });
    return { ...episode, transcriptStatus: "submitted", transcriptId: id };
  } catch (err) {
    if (err instanceof TranscribeError && err.retryable) throwStepError(err);
    return { ...episode, transcriptStatus: "unavailable", reason: errorMessage(err) };
  }
}

submitTranscript.maxRetries = 4;

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
  "use step";

  if (job.transcriptStatus === "unavailable") return job;

  try {
    const progress = await stepTranscribePoll(job.transcriptId);
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
    if (err instanceof TranscribeError && err.retryable) throwStepError(err);
    return { ...job, transcriptStatus: "unavailable", reason: errorMessage(err) };
  }
}

pollTranscript.maxRetries = 4;

/** Reduce one transcript to the summary and points the digest carries. */
export async function summarizeTranscript(state: TranscriptState): Promise<EpisodeDigest> {
  "use step";

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
  const parsed = await stepGenerateJson(
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
  ).catch(throwStepError);

  return {
    ...episodeOf(state),
    transcriptSource: "assemblyai",
    summary: parsed.summary,
    keyPoints: parsed.keyPoints,
  };
}

summarizeTranscript.maxRetries = 5;

/**
 * The clock, as a step.
 *
 * A step's result is journaled and therefore stable across replays, where
 * `new Date()` in the body would answer differently on every one — and a body
 * that is not deterministic is a body the DevKit cannot replay.
 */
export async function timestamp(): Promise<string> {
  "use step";
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
