// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/channels` — where a run's output GOES.
 *
 * One vendor today, one shape: a factory returns a serializable DESCRIPTOR
 * (`{ kind, options }`) and {@link sendToChannel} posts a {@link ChannelMessage}
 * to it. Nothing here opens a socket at import time, and nothing reads a
 * credential out of the environment — see {@link SlackChannelOptions} for why
 * a channel's credential is passed in where a provider's is not.
 *
 * @example Post a run's result to Slack
 * ```ts
 * import { slackChannel } from "@alexkroman1/aai/channels";
 * import { sendToChannelClassified } from "@alexkroman1/aai/step-errors";
 *
 * export async function postSummary(webhookUrl: string, points: string[]): Promise<string> {
 *   return await sendToChannelClassified(slackChannel({ webhookUrl }), {
 *     text: `Weekly summary: ${points.length} items`,
 *     heading: "Weekly summary",
 *     sections: [{ title: "Highlights", bullets: points }],
 *   });
 * }
 * ```
 *
 * ## A channel is the OUTBOUND half, deliberately
 *
 * The word is used elsewhere for a bidirectional edge adapter — `vercel/eve`'s
 * `defineChannel` owns inbound routes, a session address, and delivery back —
 * and that is a different concept than this one. The narrow reading is the
 * useful one here because it is what a durable step has: no session to resume,
 * no route to serve, one message to place somewhere and a verdict to reach
 * about whether a failed attempt is worth repeating. eve's own docs decline to
 * abstract this case and send authors to the provider's API plus an
 * application-owned outbox; this SDK's steps already have the durability half,
 * so what was left to write is the render-and-classify half.
 *
 * ## What each piece is for
 *
 * - {@link slackChannel} — declare a destination. {@link isSlackWebhookUrl} guards
 *   the value where a PERSON supplies it, which is a security boundary and not
 *   only a typo check.
 * - {@link sendToChannel} — post, and throw a {@link ChannelDeliveryError}
 *   carrying the retry verdict. `sendToChannelClassified`
 *   (`@alexkroman1/aai/step-errors`) is the same call with the fatal/retryable
 *   mapping already applied.
 * - {@link renderChannelPayload} — the request that WOULD be sent, pure, so a
 *   spec can assert the body without a network.
 *
 * This subpath names neither `zod` nor `@alexkroman1/aai/step-errors`, which is
 * what lets an `agent.ts` import {@link isSlackWebhookUrl} for a schema
 * refinement without pulling either into its graph.
 *
 * @module channels
 */

// Listed rather than `export *`, the same choice `step-barrel.ts` makes and
// for the same reason: a wildcard needs a lint suppression, and this surface
// is checked by `pnpm check:api-report` and `check:api-contracts` anyway, so
// an export missing from this list fails a gate rather than silently leaving
// the subpath.
export {
  type Channel,
  ChannelDeliveryError,
  type ChannelDescriptor,
  type ChannelKind,
  type ChannelMessage,
  type ChannelPayload,
  type ChannelSection,
} from "./channels/channel-types.ts";
export {
  CHANNEL_POST_TIMEOUT_MS,
  channelAdvice,
  registerChannelKind,
  registeredChannelKinds,
  renderChannelPayload,
  sendToChannel,
} from "./channels/send.ts";
export {
  escapeSlackMrkdwn,
  isSlackWebhookUrl,
  isSlackWorkflowTriggerUrl,
  renderSlackChannelPayload,
  renderSlackPlainText,
  SLACK_CHANNEL,
  SLACK_CHANNEL_KIND,
  type SlackChannel,
  type SlackChannelOptions,
  slackChannel,
  slackChannelAdvice,
} from "./channels/slack.ts";
