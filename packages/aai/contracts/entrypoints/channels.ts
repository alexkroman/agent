// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `channels`.
 *
 * Where a run's output GOES — the channel descriptor, the message shape every
 * channel renders, the post and its verdict, and the Slack destination.
 *
 * One capability rather than one per vendor, matching the four provider
 * STAGES: delivery is a single stage, so a second channel joins this contract
 * rather than opening another. What that costs is a bump when any vendor's
 * options move; what it buys is that the shape all channels share cannot drift
 * per vendor without being classified.
 *
 * Re-exported from `@alexkroman1/aai/channels`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  CHANNEL_POST_TIMEOUT_MS,
  type Channel,
  ChannelDeliveryError,
  type ChannelDescriptor,
  type ChannelMessage,
  type ChannelPayload,
  type ChannelSection,
  channelAdvice,
  escapeSlackMrkdwn,
  isSlackWebhookUrl,
  isSlackWorkflowTriggerUrl,
  renderChannelPayload,
  renderSlackChannelPayload,
  renderSlackPlainText,
  SLACK_CHANNEL_KIND,
  type SlackChannel,
  type SlackChannelOptions,
  sendToChannel,
  slack,
  slackChannelAdvice,
} from "../../sdk/channels-barrel.ts";
