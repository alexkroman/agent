// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `channels`.
 *
 * `ChannelHandler` and `registerChannelHandler` are the EXTENSION POINT, and
 * they are why this capability should stay stable as channels are added: a new
 * destination is a value of that shape declared in its own module, not a field
 * on the shared message and not an entry in a table inside `send.ts`. What a
 * platform alone can do lives in that kind's own options type, which no
 * contract here watches — `guard-invariants` rule 25 is what keeps it there.
 *
 * Where a run's output GOES — the channel descriptor, the message shape every
 * channel renders, the post and its verdict, and the Slack and Textbelt
 * destinations.
 *
 * One capability rather than one per vendor, matching the four provider
 * STAGES: delivery is a single stage, so a second channel joins this contract
 * rather than opening another. What that costs is a bump when any vendor's
 * options move; what it buys is that the shape all channels share cannot drift
 * per vendor without being classified.
 *
 * `sessionClientPhone` (on `@alexkroman1/aai`) is here too: it is the number a
 * client CLAIMED, and it only means anything as the input to
 * `allowedSmsRecipient`, so the claim and the rule that screens it change
 * together — the same argument `inbox` makes for its two subpaths.
 *
 * Re-exported from `@alexkroman1/aai/channels`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export { sessionClientPhone } from "../../index.ts";
export {
  allowedSmsRecipient,
  CHANNEL_POST_TIMEOUT_MS,
  type Channel,
  ChannelDeliveryError,
  type ChannelDescriptor,
  type ChannelHandler,
  type ChannelMessage,
  type ChannelPayload,
  type ChannelRegistration,
  type ChannelSection,
  escapeSlackMrkdwn,
  explainChannelFailure,
  explainSlackChannelFailure,
  explainTextbeltChannelFailure,
  isSlackWebhookUrl,
  isSlackWorkflowTriggerUrl,
  registerChannelHandler,
  registeredChannelKindNames,
  renderChannelPayload,
  renderSlackChannelPayload,
  renderSlackPlainText,
  renderTextbeltText,
  SLACK_CHANNEL_HANDLER,
  SLACK_CHANNEL_KIND,
  type SlackChannel,
  type SlackChannelOptions,
  type SmsRecipientEnv,
  sendToChannel,
  slackChannel,
  TEXTBELT_CHANNEL_HANDLER,
  TEXTBELT_CHANNEL_KIND,
  TEXTBELT_MAX_MESSAGE_CHARS,
  type TextbeltChannel,
  type TextbeltChannelOptions,
  textbeltChannel,
} from "../../sdk/channels-barrel.ts";
// `text_me`'s rule from a step, on `@alexkroman1/aai/step`: it is
// `allowedSmsRecipient` plus a Textbelt send, so it changes with them.
export {
  type StepTextOwnerOptions,
  type StepTextOwnerResult,
  stepTextOwner,
} from "../../sdk/step-barrel.ts";
