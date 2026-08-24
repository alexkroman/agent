// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:channels` epoch 1.
 *
 * Epoch 1 is the concept's first shape: a serializable {@link Channel}
 * descriptor, a platform-neutral {@link ChannelMessage}, one dispatching post
 * that classifies its own failure, and Slack as the first destination.
 *
 * Four things this example is here to hold still, each of which a later change
 * would break silently:
 *
 * - **`ChannelMessage.text` is REQUIRED.** One of Slack's two webhooks — the
 *   workflow trigger — takes flat string variables and cannot render structure
 *   at all, so a message shape with an optional fallback line is unrenderable
 *   on half of the very first channel. Making it optional is a break.
 * - **`slack()` returns DATA.** `{ kind, options }` with no functions, because
 *   a descriptor crosses the CLI → server → guest boundary and a durable step's
 *   arguments are journaled. An object with methods would round-trip to
 *   nothing.
 * - **`isSlackWebhookUrl` is reachable without the DevKit or zod**, which is
 *   what lets an `agent.ts` schema refine on it. Moving it behind either graph
 *   would be a break with no signature change to show for it.
 * - **`renderChannelPayload` is PURE.** The branch between Block Kit and flat
 *   variables is the difference between a delivered message and a 400, and a
 *   spec has to be able to assert it without a network.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import {
  type Channel,
  ChannelDeliveryError,
  type ChannelMessage,
  isSlackWebhookUrl,
  renderChannelPayload,
  sendToChannel,
  slack,
} from "../../../sdk/channels-barrel.ts";
import { sendToChannelClassified } from "../../../sdk/step-errors.ts";

/**
 * The guard at the form's edge — a security boundary, since this value becomes
 * the target of a POST carrying whatever the run summarized.
 */
export const digestInput = z.object({
  webhookUrl: z
    .string()
    .trim()
    .url()
    .refine(isSlackWebhookUrl, "Enter a Slack webhook URL from hooks.slack.com"),
});

/** A destination is declared, not opened: pure data, safe to journal. */
export function destination(webhookUrl: string): Channel {
  return slack({ webhookUrl, textParam: "digest_body" });
}

/** The message, in terms no single platform owns. */
export function message(headline: string, points: string[]): ChannelMessage {
  return {
    text: `${headline}: ${points.length} items`,
    heading: headline,
    subtitle: "Feeds: example.test",
    sections: [
      {
        title: "Example Episode",
        url: "https://example.test/ep",
        subtitle: "Example Podcast",
        body: "A concise summary.",
        bullets: points,
      },
    ],
  };
}

/** The step: post, and let the DevKit mapping decide whether to retry. */
export async function post(webhookUrl: string, headline: string): Promise<string> {
  "use step";

  return await sendToChannelClassified(destination(webhookUrl), message(headline, ["One", "Two"]));
}

/**
 * The raw call, for a body that wants the verdict rather than the DevKit
 * error — a run treating an unreachable channel as a warning, or falling back
 * to a second destination.
 */
export async function postOrWarn(webhookUrl: string, headline: string): Promise<string> {
  "use step";

  try {
    return await sendToChannel(destination(webhookUrl), message(headline, ["One"]));
  } catch (err: unknown) {
    if (err instanceof ChannelDeliveryError && !err.retryable) return `gave up: ${err.message}`;
    throw err;
  }
}

/** Pure: what WOULD be sent, asserted without a network. */
export function previewBody(webhookUrl: string): Record<string, unknown> {
  return renderChannelPayload(destination(webhookUrl), message("Digest", ["One"])).body;
}
