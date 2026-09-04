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
 */

import { type ChannelMessage, slackChannel } from "@alexkroman1/aai/channels";
import { stepReport } from "@alexkroman1/aai/step";
import { sendToChannelOrFail } from "@alexkroman1/aai/step-errors";
import type { EpisodeDigest } from "./digest.ts";

/** Everything the message needs, so rendering can stay a pure function. */
export type SlackDigestInput = {
  slackWebhookUrl: string;
  slackWorkflowTextParam: string;
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
  return await sendToChannelOrFail(
    slackChannel({ webhookUrl: input.slackWebhookUrl, textParam: input.slackWorkflowTextParam }),
    renderDigestMessage(input),
  );
}

/**
 * The digest as a channel message — PURE, so a spec asserts what a run would
 * post without a network, and without knowing Slack's payload shape.
 *
 * `text` is the notification line and, on a Slack workflow trigger, the whole
 * message: the SDK folds the rest into it when the destination has no rich
 * format. So it says how many episodes rather than repeating the headline.
 */
export function renderDigestMessage(input: SlackDigestInput): ChannelMessage {
  return {
    text: `${digestHeadline(input)}: ${input.episodes.length} episode summaries`,
    heading: digestHeadline(input),
    subtitle: `Feeds: ${input.podcastChannels}`,
    sections: input.episodes.map((episode) => ({
      title: episode.title,
      url: episode.url,
      subtitle: episode.podcastTitle,
      body: episode.summary,
      bullets: episode.keyPoints,
    })),
  };
}

function digestHeadline(input: SlackDigestInput): string {
  return `Podcast digest ${input.digestNumber}/${input.totalDigests}`;
}
