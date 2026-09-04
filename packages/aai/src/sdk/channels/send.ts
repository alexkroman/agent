// Copyright 2026 the AAI authors. MIT license.
/**
 * Dispatch: turn a {@link Channel} into a request, post it, and classify what
 * came back.
 *
 * ## The dispatch is a REGISTRY, and this module knows no platform
 *
 * Every channel is render-plus-POST, so there is no host-side opener layer
 * here the way there is for a provider — but there is the same reason to keep
 * the vendors out of the shared path. This module used to hold Slack's
 * option-narrowing and four Slack imports beside the table, which made a
 * second channel an edit to a file that has nothing to do with it. A channel
 * is a {@link ChannelHandler} VALUE now, declared in the module that owns the
 * platform, and the ones the SDK ships are registered below.
 *
 * {@link registerChannelHandler} is the same door `registerSttKind` opens one
 * layer up: a host or an agent project can add a destination the SDK does not
 * ship without waiting for one.
 *
 * A `kind` nothing has registered is a THROW rather than a silent no-op: a
 * delivery that quietly did not happen is the failure mode this whole module
 * exists to make loud, and the message names what IS registered, because the
 * likeliest cause is a channel module that was never imported.
 *
 * ## Why this is not a step
 *
 * A step is `ctx.step(name, fn)`, and only a workflow BODY holds a `ctx`. A
 * "step" declared in a dependency is reached by no `ctx.step`, so it would run
 * inline with no journal and no retry while LOOKING durable at every call site.
 * So this is a function a step CALLS, exactly like `stepFetch` and
 * `stepGenerate`, and the step boundary stays in the agent project where the
 * author can see it.
 */

import { stepFetch } from "../step-fetch.ts";
import { isTransientStatus, retryAfter } from "../step-retry.ts";
import { responseErrorMessage } from "../utils.ts";
import type { Channel, ChannelHandler, ChannelMessage, ChannelPayload } from "./channel-types.ts";
import { ChannelDeliveryError } from "./channel-types.ts";
import { SLACK_CHANNEL_HANDLER } from "./slack.ts";

/**
 * A platform is not slow. A post that has not answered in 30s is not going to,
 * and a step holding a socket open past that is a step nobody can cancel.
 */
export const CHANNEL_POST_TIMEOUT_MS = 30_000;

const CHANNEL_KINDS = new Map<string, ChannelHandler>();

/**
 * Register a channel kind, so `sendToChannel` can dispatch a descriptor
 * carrying its tag.
 *
 * The SDK registers what it ships (Slack today). Call this for a destination
 * it does not — an internal notifier, a platform with no adapter here — and
 * the rest of the channel surface works unchanged: `slackChannel()` has no privileges
 * a hand-written descriptor factory lacks.
 *
 * **Register before the first send, and remember a descriptor outlives the
 * process.** A channel round-trips through a durable run's journal, so a run
 * resumed in a fresh worker dispatches on a tag whose module that worker may
 * never have imported. Register at module load in the agent's entry, not
 * lazily beside the first call.
 *
 * Re-registering a kind REPLACES it, which is what makes a shipped channel
 * overridable — and is why the tag is the identity rather than the value.
 *
 * @public
 */
export function registerChannelHandler(handler: ChannelHandler): void {
  CHANNEL_KINDS.set(handler.kind, handler);
}

/** The tags {@link sendToChannel} can dispatch, in registration order. */
export function registeredChannelKindNames(): readonly string[] {
  return [...CHANNEL_KINDS.keys()];
}

registerChannelHandler(SLACK_CHANNEL_HANDLER);

function handlerFor(channel: Channel): ChannelHandler {
  const handler = CHANNEL_KINDS.get(channel.kind);
  if (handler === undefined) {
    throw new Error(
      `Unknown channel kind ${JSON.stringify(channel.kind)}. ` +
        `Registered kinds: ${registeredChannelKindNames().join(", ") || "(none)"}. ` +
        "A kind is registered by importing the module that declares it, or by " +
        "calling `registerChannelHandler` — a run resumed in a fresh worker has " +
        "imported neither unless the agent's entry does it at module load.",
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
export function explainChannelFailure(channel: Channel, detail: string): string {
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
 * body hands it straight on and the engine gives up or waits the right amount
 * — see {@link ChannelDeliveryError}, or reach for `sendToChannelOrFail`
 * (`@alexkroman1/aai/step-errors`) to skip the `.catch`.
 *
 * @returns whatever the platform answered with, or `"ok"` when it sent no body.
 * @throws {ChannelDeliveryError} on any non-2xx.
 *
 * @example
 * ```ts
 * import { sendToChannel, slackChannel } from "@alexkroman1/aai/channels";
 * import { throwStepError } from "@alexkroman1/aai/step-errors";
 *
 * export async function announce(webhookUrl: string): Promise<string> {
 *   return await sendToChannel(slackChannel({ webhookUrl }), { text: "Run finished." }).catch(
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
      : `${explainChannelFailure(channel, detail)} (HTTP ${response.status})`,
    {
      channelKind: channel.kind,
      status: response.status,
      retryable,
      retryAfter: retryAfter(response),
    },
  );
}
