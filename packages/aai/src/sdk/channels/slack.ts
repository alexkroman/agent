// Copyright 2026 the AAI authors. MIT license.
/**
 * The Slack channel — the first one, and the reason the concept is shaped the
 * way it is.
 *
 * Slack has two things people call "a webhook URL" and they take different
 * bodies. Getting this wrong is the single most common way a delivery ends in
 * a red 400 with nobody able to say why, so the distinction is modelled here
 * rather than left to whoever pastes the URL:
 *
 * | URL | What it wants |
 * | --- | --- |
 * | `hooks.slack.com/services/…` | A classic incoming webhook: Block Kit |
 * | `hooks.slack.com/triggers/…` | A workflow trigger: FLAT string variables |
 *
 * Send Block Kit to a trigger URL and Slack rejects the whole payload, because
 * a trigger's body is a flat map of the variables its workflow declared —
 * there is no `blocks` variable and there never will be.
 * {@link renderSlackChannelPayload} branches on the URL for exactly that
 * reason, and it is a pure function so the branch is testable without a
 * network.
 *
 * **That branch is also the argument for `ChannelMessage.text` being
 * required.** One of Slack's two webhooks cannot render structure at all, so a
 * message shape that made the flat string optional would be unrenderable half
 * the time on the very first channel.
 *
 * ## Why the trigger case needs a parameter NAME from the author
 *
 * A trigger's variables are named by whoever built the Slack workflow. The SDK
 * cannot know that name, so {@link SlackChannelOptions.textParam} is a field
 * defaulting to `text` — the name Slack's own example uses. That is an unusual
 * thing to ask for and it is the honest option: the alternative is guessing,
 * and a guess fails with `invalid_arguments` and no indication of which name
 * was wrong.
 */

import type {
  Channel,
  ChannelHandler,
  ChannelMessage,
  ChannelPayload,
  ChannelSection,
} from "./channel-types.ts";

/** The `kind` tag on a Slack channel descriptor. */
export const SLACK_CHANNEL_KIND = "slack";

/** Slack's own cap on a `header` block's `plain_text`. Longer is a 400. */
const SLACK_HEADER_MAX = 150;

/** The variable name Slack's own workflow-trigger example uses. */
const DEFAULT_TEXT_PARAM = "text";

/**
 * What {@link slackChannel} takes.
 *
 * **No credential is read from the environment**, and that is a deliberate
 * difference from a provider descriptor. A webhook URL IS the credential —
 * anyone holding it can post — and the destination is usually per-run rather
 * than per-deploy: one deployed agent posts to whichever workspace each run
 * names. So it is passed in, and the guard for it ({@link isSlackWebhookUrl})
 * is published so the check can happen at the form's edge.
 *
 * @public
 */
export interface SlackChannelOptions {
  /**
   * An incoming webhook (`hooks.slack.com/services/…`) or a workflow trigger
   * (`hooks.slack.com/triggers/…`). Validate it with
   * {@link isSlackWebhookUrl} wherever it is accepted from a person.
   */
  readonly webhookUrl: string;
  /**
   * The workflow variable the message text is sent as — WORKFLOW TRIGGER URLs
   * only, where it must match a variable that workflow declares. Ignored by an
   * incoming webhook, which takes Block Kit.
   *
   * @defaultValue `"text"`
   */
  readonly textParam?: string;
}

/** A Slack channel descriptor, as returned by {@link slackChannel}. */
export type SlackChannel = Channel & {
  readonly kind: typeof SLACK_CHANNEL_KIND;
  readonly options: SlackChannelOptions & Record<string, unknown>;
};

/**
 * Declare a Slack destination.
 *
 * @example Post a digest to Slack from a step
 * ```ts
 * import { slackChannel } from "@alexkroman1/aai/channels";
 * import { sendToChannelClassified } from "@alexkroman1/aai/step-errors";
 *
 * export async function postDigest(webhookUrl: string, summary: string): Promise<string> {
 *   return await sendToChannelClassified(slackChannel({ webhookUrl }), {
 *     text: `Daily digest: ${summary}`,
 *     heading: "Daily digest",
 *     sections: [{ body: summary }],
 *   });
 * }
 * ```
 *
 * @public
 */
export function slackChannel(options: SlackChannelOptions): SlackChannel {
  return { kind: SLACK_CHANNEL_KIND, options: { ...options } };
}

/**
 * A workflow trigger, which takes flat variables and not Block Kit.
 *
 * @public
 */
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
 * Whether a string is a Slack webhook URL at all — an incoming webhook or a
 * workflow trigger, on one of Slack's two webhook hosts.
 *
 * **A HOST check rather than "is it a URL", and this is a security boundary as
 * much as a usability one.** The value becomes the target of a POST carrying
 * whatever the run summarized, so anything that is not Slack is an
 * exfiltration endpoint somebody typed into a form. Refuse it where the value
 * is accepted — a 400 at the call site — rather than at delivery, which is a
 * failed run after the expensive work has already been paid for.
 *
 * @example Refuse a non-Slack destination at the form's edge
 * ```ts
 * import { isSlackWebhookUrl } from "@alexkroman1/aai/channels";
 * import { z } from "zod";
 *
 * export const input = z.object({
 *   webhookUrl: z
 *     .string()
 *     .trim()
 *     .url()
 *     .refine(isSlackWebhookUrl, "Enter a Slack webhook URL from hooks.slack.com"),
 * });
 * ```
 *
 * @public
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

/**
 * The three characters Slack's mrkdwn reserves.
 *
 * Only three, and only these: Slack's own escaping rules say `&`, `<` and `>`
 * and nothing else, so escaping more would put backslashes in front of the
 * apostrophes in every summary. `&` first, or the ampersands introduced by the
 * other two get double-escaped.
 *
 * @public
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Block Kit, or flat variables — see the module doc. */
export function renderSlackChannelPayload(
  message: ChannelMessage,
  options: SlackChannelOptions,
): ChannelPayload {
  const body = isSlackWorkflowTriggerUrl(options.webhookUrl)
    ? { [textParamOf(options)]: renderSlackPlainText(message) }
    : renderSlackBlocks(message);
  return { url: options.webhookUrl, body };
}

/**
 * The variable name, with an empty one treated as absent.
 *
 * `??` alone would not do it: an empty `textParam` is a plausible thing for a
 * form field to hand a caller, and it would post under the key `""` — which
 * Slack rejects with `invalid_arguments`, naming nothing.
 */
function textParamOf(options: SlackChannelOptions): string {
  const named = options.textParam?.trim();
  return named === undefined || named === "" ? DEFAULT_TEXT_PARAM : named;
}

/**
 * The trigger body: one string, because that is all a variable can hold.
 *
 * `text` leads rather than being dropped — on this arm it is the notification
 * line AND the only place the caller's own summary of the message survives.
 */
export function renderSlackPlainText(message: ChannelMessage): string {
  return [
    message.heading ?? message.text,
    ...(message.subtitle === undefined ? [] : [message.subtitle]),
    "",
    ...(message.sections ?? []).flatMap(plainTextSection),
  ]
    .join("\n")
    .trim();
}

function plainTextSection(section: ChannelSection): string[] {
  return [
    ...(section.title === undefined
      ? []
      : [
          section.subtitle === undefined ? section.title : `${section.title} — ${section.subtitle}`,
        ]),
    ...(section.url === undefined ? [] : [section.url]),
    ...(section.body === undefined ? [] : [section.body]),
    ...(section.bullets ?? []).map((bullet) => `- ${bullet}`),
    "",
  ];
}

/** The incoming-webhook body: Block Kit, with `text` as the notification line. */
function renderSlackBlocks(message: ChannelMessage): Record<string, unknown> {
  const heading = message.heading ?? message.text;
  return {
    // Not decoration — this is what a push notification and a screen reader
    // read. A Block Kit payload with no `text` notifies as "[no preview]".
    text: message.text,
    blocks: [
      {
        type: "header",
        // `plain_text` is not mrkdwn, so it is NOT escaped — Slack renders the
        // three reserved characters literally here, and escaping would print
        // "&amp;" to the reader. It is truncated instead: over 150 characters
        // is a 400 on the whole payload.
        text: { type: "plain_text", text: truncate(heading, SLACK_HEADER_MAX) },
      },
      ...(message.subtitle === undefined
        ? []
        : [
            {
              type: "section",
              text: { type: "mrkdwn", text: escapeSlackMrkdwn(message.subtitle) },
            },
          ]),
      { type: "divider" },
      ...(message.sections ?? []).flatMap((section) => [
        { type: "section", text: { type: "mrkdwn", text: mrkdwnSection(section) } },
        { type: "divider" },
      ]),
    ],
  };
}

/** Bold, and a link when the section named one. */
function mrkdwnTitle(section: ChannelSection): string[] {
  if (section.title === undefined) return [];
  const label = escapeSlackMrkdwn(section.title);
  if (section.url === undefined) return [`*${label}*`];
  return [`*<${escapeSlackMrkdwn(section.url)}|${label}>*`];
}

function mrkdwnSection(section: ChannelSection): string {
  return [
    ...mrkdwnTitle(section),
    ...(section.subtitle === undefined ? [] : [`_${escapeSlackMrkdwn(section.subtitle)}_`]),
    ...(section.body === undefined ? [] : [escapeSlackMrkdwn(section.body)]),
    ...(section.bullets ?? []).map((bullet) => `• ${escapeSlackMrkdwn(bullet)}`),
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The sentence a person can act on, chosen from what the URL and the body say.
 *
 * `workflow_not_published` is called out by name because it is the one 4xx
 * with a fix that is not "check your URL" — the URL is fine and the workflow
 * behind it was never published — and nothing in Slack's generic message says
 * so.
 */
export function explainSlackChannelFailure(options: SlackChannelOptions, detail: string): string {
  if (isSlackWorkflowTriggerUrl(options.webhookUrl)) {
    if (detail.includes("workflow_not_published")) {
      return "That Slack workflow trigger exists but its workflow is not published. Publish it in Slack, then start a new run.";
    }
    return `Slack rejected the workflow trigger: ${detail}. Check that the text parameter matches a variable the workflow declares.`;
  }
  return `Slack rejected the incoming webhook: ${detail}. Check that the webhook is still active and has not been revoked.`;
}

/**
 * A descriptor's options, NARROWED rather than cast.
 *
 * A cast would be the short way and it would be wrong twice over: a channel
 * descriptor round-trips through a durable run's journal and can arrive as
 * whatever was written there, and `sendToChannel` is reachable from a body that
 * built its descriptor from parsed input. So the field is checked, and a
 * descriptor missing it fails with the call that would have produced a valid
 * one rather than with `POST undefined`.
 *
 * It lives HERE, beside the options type it narrows to, rather than in the
 * generic send path where it started: the shared module knowing one platform's
 * option shape is what makes a second channel an edit to a shared file.
 */
function slackOptions(options: Record<string, unknown>): SlackChannelOptions {
  const { textParam, webhookUrl } = options;
  if (typeof webhookUrl !== "string") {
    throw new Error(
      "A Slack channel needs a string `webhookUrl`. Build one with `slackChannel({ webhookUrl })`.",
    );
  }
  return typeof textParam === "string" ? { textParam, webhookUrl } : { webhookUrl };
}

/**
 * Slack as a {@link ChannelHandler} — what `sendToChannel` dispatches to for a
 * `"slack"` descriptor.
 *
 * Exported so a host that assembles its own channel set can name it, and so
 * this module is a complete unit: everything the send path needs to handle
 * Slack is here, and `send.ts` imports this one value rather than four
 * functions and an options type.
 *
 * @public
 */
export const SLACK_CHANNEL_HANDLER: ChannelHandler = {
  kind: SLACK_CHANNEL_KIND,
  render: (message, options) => renderSlackChannelPayload(message, slackOptions(options)),
  advice: (options, detail) => explainSlackChannelFailure(slackOptions(options), detail),
};
