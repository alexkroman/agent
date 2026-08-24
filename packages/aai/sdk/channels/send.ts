// Copyright 2026 the AAI authors. MIT license.
/**
 * Dispatch: turn a {@link Channel} into a request, post it, and classify what
 * came back.
 *
 * ## The dispatch table is a plain object, and stays one
 *
 * Every channel is render-plus-POST, so there is no host-side opener layer
 * here the way there is for a provider (`registerTtsKind` and the rest). A
 * `kind` a caller invented is a THROW rather than a silent no-op: a delivery
 * that quietly did not happen is the failure mode this whole module exists to
 * make loud.
 *
 * ## Why this is not a `"use step"` body
 *
 * The Workflow DevKit's builder rewrites `"use step"` bodies it finds in an
 * agent project's `workflows/` directory. A body written anywhere else — here,
 * in `node_modules` — is transformed by nothing: it would run inline, with no
 * journal and no retry, while LOOKING durable at every call site. So this is a
 * function a step body calls, exactly like `stepFetch` and `stepGenerate`, and
 * the `"use step"` stays in the agent project where the builder can see it.
 */

import { stepFetch } from "../step-fetch.ts";
import { isTransientStatus, retryAfter } from "../step-retry.ts";
import { responseErrorMessage } from "../utils.ts";
import type { Channel, ChannelMessage, ChannelPayload } from "./channel-types.ts";
import { ChannelDeliveryError } from "./channel-types.ts";
import {
  renderSlackChannelPayload,
  SLACK_CHANNEL_KIND,
  type SlackChannelOptions,
  slackChannelAdvice,
} from "./slack.ts";

/**
 * A platform is not slow. A post that has not answered in 30s is not going to,
 * and a step holding a socket open past that is a step nobody can cancel.
 */
export const CHANNEL_POST_TIMEOUT_MS = 30_000;

/** What every channel kind supplies: how to render, and what to say when refused. */
interface ChannelKindHandler {
  readonly render: (message: ChannelMessage, options: Record<string, unknown>) => ChannelPayload;
  readonly advice: (options: Record<string, unknown>, detail: string) => string;
}

const CHANNEL_KINDS: Readonly<Record<string, ChannelKindHandler>> = {
  [SLACK_CHANNEL_KIND]: {
    render: (message, options) => renderSlackChannelPayload(message, slackOptions(options)),
    advice: (options, detail) => slackChannelAdvice(slackOptions(options), detail),
  },
};

/**
 * A descriptor's options, NARROWED rather than cast.
 *
 * A cast would be the short way and it would be wrong twice over: a channel
 * descriptor round-trips through a durable run's journal and can arrive as
 * whatever was written there, and `sendToChannel` is reachable from a body
 * that built its descriptor from parsed input. So the field is checked, and a
 * descriptor missing it fails with the call that would have produced a valid
 * one rather than with `POST undefined`.
 */
function slackOptions(options: Record<string, unknown>): SlackChannelOptions {
  const { textParam, webhookUrl } = options;
  if (typeof webhookUrl !== "string") {
    throw new Error(
      "A Slack channel needs a string `webhookUrl`. Build one with `slack({ webhookUrl })`.",
    );
  }
  return typeof textParam === "string" ? { textParam, webhookUrl } : { webhookUrl };
}

function handlerFor(channel: Channel): ChannelKindHandler {
  const handler = CHANNEL_KINDS[channel.kind];
  if (handler === undefined) {
    throw new Error(
      `Unknown channel kind ${JSON.stringify(channel.kind)}. ` +
        `Known kinds: ${Object.keys(CHANNEL_KINDS).join(", ")}.`,
    );
  }
  return handler;
}

/**
 * The request a channel would send for this message — PURE, so the branch a
 * channel takes over its own options is testable without a network.
 *
 * That branch is not academic: on Slack it decides between Block Kit and flat
 * workflow variables, and the wrong one is a 400 on the whole payload.
 *
 * @throws {Error} when `channel.kind` names no known channel.
 * @public
 */
export function renderChannelPayload(channel: Channel, message: ChannelMessage): ChannelPayload {
  return handlerFor(channel).render(message, channel.options);
}

/**
 * The sentence a person can act on for a refusal this channel understands.
 *
 * @throws {Error} when `channel.kind` names no known channel.
 * @public
 */
export function channelAdvice(channel: Channel, detail: string): string {
  return handlerFor(channel).advice(channel.options, detail);
}

/**
 * Post one message, and classify the failure honestly.
 *
 * The 4xx/5xx split is the whole reason this is not a one-line `stepFetch`.
 * A revoked webhook, an unpublished Slack workflow and a wrong variable name
 * all answer 4xx and will answer 4xx identically on every retry — retrying
 * them burns a step's attempts and delays the real error by minutes. A 5xx is
 * the platform having a bad minute, which is precisely what retries are for,
 * and any `Retry-After` it named is carried on the error.
 *
 * The `ChannelDeliveryError` it throws is what `toStepError` reads, so a step
 * body hands it straight on and the DevKit gives up or waits the right amount
 * — see {@link ChannelDeliveryError}, or reach for `sendToChannelClassified`
 * (`@alexkroman1/aai/step-errors`) to skip the `.catch`.
 *
 * @returns whatever the platform answered with, or `"ok"` when it sent no body.
 * @throws {ChannelDeliveryError} on any non-2xx.
 *
 * @example
 * ```ts
 * import { sendToChannel, slack } from "@alexkroman1/aai/channels";
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function announce(webhookUrl: string): Promise<string> {
 *   "use step";
 *   return await sendToChannel(slack({ webhookUrl }), { text: "Run finished." }).catch(
 *     throwStepError,
 *   );
 * }
 * ```
 *
 * @public
 */
export async function sendToChannel(channel: Channel, message: ChannelMessage): Promise<string> {
  const payload = renderChannelPayload(channel, message);
  const response = await stepFetch(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...payload.headers },
    body: JSON.stringify(payload.body),
    signal: AbortSignal.timeout(CHANNEL_POST_TIMEOUT_MS),
  });
  if (response.ok) return (await response.text()) || "ok";

  // `responseErrorMessage` rather than `await response.text()` and a
  // hand-rolled truncation: it prefers a JSON `error` field when the body has
  // one — which Slack's does — and falls back to the status with a bounded
  // preview. That body is what decides which advice a person is given.
  const detail = await responseErrorMessage(response, `${channel.kind} channel post`);
  const retryable = isTransientStatus(response.status);
  throw new ChannelDeliveryError(
    retryable
      ? `${channel.kind} channel post failed: HTTP ${response.status}. ${detail}`
      : `${channelAdvice(channel, detail)} (HTTP ${response.status})`,
    {
      channelKind: channel.kind,
      status: response.status,
      retryable,
      retryAfter: retryAfter(response),
    },
  );
}
