// Copyright 2026 the AAI authors. MIT license.
/**
 * Delivering the digest — the half of this template that is about a THIRD
 * PARTY's contract rather than about podcasts.
 *
 * Slack has two things people call "a webhook URL" and they take different
 * bodies. Getting this wrong is the single most common way a run of this
 * template ends in a red 400 with nobody able to say why, so the distinction is
 * modelled here rather than left to whoever pastes the URL:
 *
 * | URL | What it wants |
 * | --- | --- |
 * | `hooks.slack.com/services/…` | A classic incoming webhook: Block Kit |
 * | `hooks.slack.com/triggers/…` | A workflow trigger: FLAT string variables |
 *
 * Send Block Kit to a trigger URL and Slack rejects the whole payload, because
 * a trigger's body is a flat map of the variables its workflow declared — there
 * is no `blocks` variable and there never will be. {@link renderSlackPayload}
 * branches on the URL for exactly that reason, and it is a pure function so the
 * branch is testable without a network.
 *
 * ## Why the trigger case needs a parameter NAME from the user
 *
 * A trigger's variables are named by whoever built the Slack workflow. This
 * template cannot know that name, so it is an input field defaulting to `text`
 * — the name Slack's own example uses. That is an unusual thing to put in a
 * form and it is the honest option: the alternative is guessing, and a guess
 * fails with `invalid_arguments` and no indication of which name was wrong.
 */

import { report, stepFetch } from "@alexkroman1/aai/step";
import { toStepError } from "@alexkroman1/aai/step-errors";
import { responseErrorMessage } from "@alexkroman1/aai/utils";
import { FatalError } from "workflow";
import type { EpisodeDigest } from "./digest.ts";

/** Slack is not slow; a post that has not answered in 30s is not going to. */
const POST_TIMEOUT_MS = 30_000;

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
 * The step: post one digest, and classify the failure honestly.
 *
 * The 4xx/5xx split is the whole reason this is not a one-line `stepFetch`. A
 * revoked webhook, an unpublished workflow and a wrong variable name all answer
 * 4xx and will answer 4xx identically on every retry — retrying them burns the
 * DevKit's attempts and delays the real error by minutes. A 5xx is Slack having
 * a bad minute, which is precisely what retries are for, and `toStepError`
 * carries any `Retry-After` Slack named into the schedule.
 */
export async function sendDigestToSlack(input: SlackDigestInput): Promise<string> {
  "use step";

  await report("Posting the digest to Slack.");
  const response = await stepFetch(input.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(renderSlackPayload(input)),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (response.ok) return (await response.text()) || "ok";

  // `responseErrorMessage` rather than `await response.text()` and a hand-rolled
  // truncation: it prefers a JSON `error` field when the body has one — which
  // Slack's does — and falls back to the status with a bounded preview.
  const detail = await responseErrorMessage(response, "Slack webhook post");
  if (response.status >= 400 && response.status < 500) {
    throw new FatalError(`${slackAdvice(input.slackWebhookUrl, detail)} (HTTP ${response.status})`);
  }
  throw toStepError(response, `Slack webhook post failed: HTTP ${response.status}. ${detail}`);
}

/**
 * The sentence a person can act on, chosen from what the URL and body say.
 *
 * `workflow_not_published` is called out by name because it is the one 4xx with
 * a fix that is not "check your URL" — the URL is fine and the workflow behind
 * it was never published — and nothing in Slack's generic message says so.
 */
export function slackAdvice(webhookUrl: string, detail: string): string {
  if (isSlackWorkflowTriggerUrl(webhookUrl)) {
    if (detail.includes("workflow_not_published")) {
      return "That Slack workflow trigger exists but its workflow is not published. Publish it in Slack, then start a new run.";
    }
    return `Slack rejected the workflow trigger: ${detail}. Check that the text parameter matches a variable the workflow declares.`;
  }
  return `Slack rejected the incoming webhook: ${detail}. Check that the webhook is still active and has not been revoked.`;
}

/** A workflow trigger, which takes flat variables and not Block Kit. */
export function isSlackWorkflowTriggerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === "hooks.slack.com" &&
      parsed.pathname.startsWith("/triggers/")
    );
  } catch {
    return false;
  }
}

/**
 * Accepted at the form's edge: an incoming webhook or a workflow trigger, on
 * one of Slack's two webhook hosts.
 *
 * A host check rather than "is it a URL", and this is a security boundary as
 * much as a usability one: this value becomes the target of a POST carrying
 * summarized content, so anything that is not Slack is an exfiltration target
 * somebody typed into a form. Refusing at `start()` is a 400 at the call site;
 * refusing later would be a failed run after transcription had already been paid for.
 */
export function isSlackWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === "https:" &&
      (host === "hooks.slack.com" || host === "hooks.slack-gov.com") &&
      parsed.pathname.length > 1
    );
  } catch {
    return false;
  }
}

/** Block Kit, or flat variables — see the module doc. */
export function renderSlackPayload(input: SlackDigestInput): Record<string, unknown> {
  if (isSlackWorkflowTriggerUrl(input.slackWebhookUrl)) {
    return { [input.slackWorkflowTextParam || "text"]: renderPlainTextDigest(input) };
  }
  return renderSlackMessage(input);
}

/** The trigger body: one string, because that is all a variable can hold. */
export function renderPlainTextDigest(input: SlackDigestInput): string {
  return [
    digestHeadline(input),
    `Feeds: ${input.podcastChannels}`,
    "",
    ...input.episodes.flatMap((episode) => [
      `${episode.title} — ${episode.podcastTitle}`,
      episode.url,
      episode.summary,
      ...episode.keyPoints.map((point) => `- ${point}`),
      "",
    ]),
  ]
    .join("\n")
    .trim();
}

/** The incoming-webhook body: Block Kit, with `text` as the notification line. */
function renderSlackMessage(input: SlackDigestInput): Record<string, unknown> {
  return {
    // Not decoration — this is what a push notification and a screen reader
    // read. A Block Kit payload with no `text` notifies as "[no preview]".
    text: `${digestHeadline(input)}: ${input.episodes.length} episode summaries`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: digestHeadline(input) } },
      {
        type: "section",
        text: { type: "mrkdwn", text: `Feeds: ${escapeSlack(input.podcastChannels)}` },
      },
      { type: "divider" },
      ...input.episodes.flatMap((episode) => [
        {
          type: "section",
          text: { type: "mrkdwn", text: renderEpisodeBlock(episode) },
        },
        { type: "divider" },
      ]),
    ],
  };
}

function renderEpisodeBlock(episode: EpisodeDigest): string {
  return [
    `*<${escapeSlack(episode.url)}|${escapeSlack(episode.title)}>*`,
    `_${escapeSlack(episode.podcastTitle)}_`,
    escapeSlack(episode.summary),
    ...episode.keyPoints.map((point) => `• ${escapeSlack(point)}`),
  ].join("\n");
}

function digestHeadline(input: SlackDigestInput): string {
  return `Podcast digest ${input.digestNumber}/${input.totalDigests}`;
}

/**
 * The three characters Slack's mrkdwn reserves.
 *
 * Only three, and only these: Slack's own escaping rules say `&`, `<` and `>`
 * and nothing else, so escaping more would put backslashes in front of
 * apostrophes in every summary. `&` first, or the ampersands introduced by the
 * other two get double-escaped.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
