// Copyright 2026 the AAI authors. MIT license.
/**
 * Delivering the digest — which is now almost entirely a question of what the
 * MESSAGE says, because where it goes is the SDK's job.
 *
 * This module used to carry the whole third-party contract: Slack's two
 * webhook shapes and the branch between them, Block Kit assembly, mrkdwn
 * escaping, the 4xx/5xx split and the advice each refusal deserves. All of it
 * is `@alexkroman1/aai/channels` now — `slackChannel()` names the destination,
 * `sendToChannelOrFail` posts and classifies — and what is left here is the
 * part that is actually about podcasts: turning episode digests into a
 * {@link ChannelMessage}.
 *
 * That split is the point of the channel concept. Every one of those rules is
 * about SLACK rather than about this template, and a template is the wrong
 * place to learn them: the trigger-vs-incoming-webhook distinction alone is
 * the most common way a run of this ends in a red 400 with nobody able to say
 * why.
 *
 * ## What a step still owns
 *
 * The step BOUNDARY is not here — only a body holds a `ctx`, and the call this
 * file is reached through is `ctx.step("postDigest", …)` in `digest.ts`. What
 * stays here is what a step DOES: the digest rendered as a `ChannelMessage` and
 * one `sendToChannelOrFail` call. Deciding which steps exist is the
 * template's job; what happens inside one is the SDK's.
 *
 * The one thing this file still ASKS Slack is which of its two webhook shapes
 * a run is posting to — {@link describeDestination}, over the SDK's own
 * `isSlackWorkflowTriggerUrl` — because the run's output says so and the page
 * prints it. That is a question about this run rather than a rule about Slack,
 * which is the line the rest of this module was moved across.
 */

import {
  type ChannelMessage,
  type ChannelSection,
  isSlackWorkflowTriggerUrl,
  type SlackChannelOptions,
  slackChannel,
} from "@alexkroman1/aai/channels";
import { stepReport } from "@alexkroman1/aai/step";
import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";
import { formatDuration, plural } from "@alexkroman1/aai/utils";
import type { EpisodeDigest } from "./digest.ts";

/**
 * Everything the message needs, so rendering can stay a pure function.
 *
 * The destination is `SlackChannelOptions` — the SDK's own pair — rather than
 * the two loose strings this used to carry. They were `webhookUrl` and
 * `textParam` under other names, restated so that `sendDigestToSlack` could
 * rename them BACK on the way into `slackChannel()`; the run now carries the
 * value the channel takes.
 */
export type SlackDigestInput = {
  destination: SlackChannelOptions;
  podcastChannels: string;
  episodes: EpisodeDigest[];
  digestNumber: number;
  totalDigests: number;
};

/**
 * The step: post one digest.
 *
 * It is three lines because the interesting decisions moved. `slackChannel()` builds
 * the descriptor, {@link renderDigestMessage} says what the message contains,
 * and `sendToChannelOrFail` does the render-post-classify round — throwing
 * a `FatalError` on a 4xx (a revoked webhook and a wrong variable name answer
 * identically on every retry, so retrying only delays the real error) and a
 * `RetryableError` carrying Slack's own `Retry-After` on a 5xx.
 */
export async function sendDigestToSlack(input: SlackDigestInput): Promise<string> {
  await stepReport("Posting the digest to Slack.");
  return await sendToChannelOrFail(slackChannel(input.destination), renderDigestMessage(input));
}

/**
 * Which of Slack's two webhook shapes this run posts to, as the run's output
 * reports it and the page prints it.
 *
 * It used to be the constant `"Slack webhook"`, which is the one thing about
 * this destination a reader cannot check for themselves — the two URLs take
 * DIFFERENT bodies (Block Kit against flat workflow variables), so which one a
 * run used decides whether `slackWorkflowTextParam` mattered at all and which
 * half of a refusal's advice applies. `isSlackWorkflowTriggerUrl` is the SDK's
 * own answer to that question, and it is the same predicate
 * `renderSlackChannelPayload` branches on, so the page cannot report one shape
 * while the post used the other.
 */
export function describeDestination(destination: SlackChannelOptions): string {
  return isSlackWorkflowTriggerUrl(destination.webhookUrl)
    ? "a Slack workflow trigger"
    : "a Slack incoming webhook";
}

/**
 * The digest as a channel message — PURE, so a spec asserts what a run would
 * post without a network, and without knowing Slack's payload shape.
 *
 * `text` is the notification line and, on a Slack workflow trigger, the whole
 * message: the SDK folds the rest into it when the destination has no rich
 * format. So it says how many episodes rather than repeating the headline —
 * through `plural`, because this line read "1 episode summaries" for every
 * single-episode digest, which is the exact mistake that helper exists for.
 */
export function renderDigestMessage(input: SlackDigestInput): ChannelMessage {
  const count = input.episodes.length;
  return {
    text: `${digestHeadline(input)}: ${count} episode ${plural(count, "summary", "summaries")}`,
    heading: digestHeadline(input),
    subtitle: `Feeds: ${input.podcastChannels}`,
    sections: input.episodes.map(episodeSection),
  };
}

/**
 * One episode as a section of the message.
 *
 * Annotated with the SDK's `ChannelSection` rather than left to inference: it
 * is what says a section may carry a `url`, a `subtitle` and `bullets` at all,
 * so an author adding a field to a digest entry gets a compile error instead of
 * a key Slack silently drops.
 */
export function episodeSection(episode: EpisodeDigest): ChannelSection {
  return {
    title: episode.title,
    url: episode.url,
    subtitle: episodeSubtitle(episode),
    body: episode.summary,
    bullets: episode.keyPoints,
  };
}

/**
 * The show, and how long the episode runs when the provider measured it.
 *
 * The duration is the PROVIDER's own — it decoded the file and nothing here
 * did — and it is the one fact a reader deciding whether to listen wants that a
 * summary cannot supply. `formatDuration` rather than a `m:ss` of our own: an
 * hour-long episode is exactly where every hand-written one prints `64:09`.
 */
function episodeSubtitle(episode: EpisodeDigest): string {
  return episode.durationMs === undefined
    ? episode.podcastTitle
    : `${episode.podcastTitle} · ${formatDuration(episode.durationMs)}`;
}

function digestHeadline(input: SlackDigestInput): string {
  return `Podcast digest ${input.digestNumber}/${input.totalDigests}`;
}
