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

import { stepFetch } from "../../step-fetch.ts";
import { isTransientStatus, retryAfter } from "../../step-retry.ts";
import { responseErrorMessage } from "../../utils.ts";
import { SLACK_CHANNEL_HANDLER } from "../slack.ts";
import { TEXTBELT_CHANNEL_HANDLER, textbeltOptions, textbeltRefusal } from "../textbelt.ts";
import type { Channel, ChannelHandler, ChannelMessage, ChannelPayload } from "./channel-types.ts";
import { ChannelDeliveryError } from "./channel-types.ts";
import { channelOutboxEntry, publishedChannelOutbox, redactChannelCredentials } from "./outbox.ts";

/**
 * A platform is not slow. A post that has not answered in 30s is not going to,
 * and a step holding a socket open past that is a step nobody can cancel.
 */
export const CHANNEL_POST_TIMEOUT_MS: number = 30_000;

/**
 * What a registration carries BESIDE the handler: the two things only some
 * platforms need, declared by the platform that needs them.
 *
 * Kept off {@link ChannelHandler} rather than as fields on it: that interface
 * is the shared, contract-hashed shape every channel implements
 * (guard-invariants rule 25), and neither of these is something a new channel
 * would have to INVENT to render at all. They ride on the registration, and
 * the registry stores them with the handler for that kind.
 *
 * @public
 */
export interface ChannelRegistration {
  /**
   * Reads a REFUSAL out of a 2xx body, for a platform that answers one with a
   * 200 — Textbelt says `200 {"success": false, "error": …}`. Returns the
   * reason, or `undefined` when the body means delivered. Without it, every
   * 2xx is a delivery.
   */
  readonly refusal?: (body: string) => string | undefined;
  /**
   * Descriptor option and rendered-body fields that are CREDENTIALS: their
   * values are redacted from every refusal the send path turns into an error,
   * and a body field of that name never reaches a channel outbox
   * (`publishChannelOutbox`). Textbelt declares `key` (its API key rides in
   * the body); Slack declares `webhookUrl` (the URL is the credential, and an
   * outbox entry never carries a URL anyway). A kind that declares none has
   * only the secret-named query-parameter scrub, which applies to every kind.
   */
  readonly credentialFields?: readonly string[];
}

/** One registered kind: its handler, plus what its registration declared. */
type ChannelKindEntry = {
  readonly handler: ChannelHandler;
  readonly refusal: ((body: string) => string | undefined) | undefined;
  readonly credentialFields: readonly string[];
};

const CHANNEL_KINDS = new Map<string, ChannelKindEntry>();

/**
 * Register a channel kind, so `sendToChannel` can dispatch a descriptor
 * carrying its tag.
 *
 * The SDK registers what it ships (Slack and Textbelt). Call this for a destination
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
 * Re-registering a kind REPLACES it — handler and registration together —
 * which is what makes a shipped channel overridable, and is why the tag is the
 * identity rather than the value.
 *
 * **A channel that carries a secret declares it** in `registration`'s
 * `credentialFields`, so a refusal quoting it back is redacted and an outbox
 * never records it; see {@link ChannelRegistration}.
 *
 * **A handler typed on its own options (`ChannelHandler<MyOptions>`) is
 * registered WITH the function that narrows the raw record into them**, which
 * runs before each `render` and `advice` — so both are handed a checked value,
 * and a journaled descriptor with a bad field fails naming it. The overload
 * makes the narrowing required: nothing else checks that what a journal hands
 * back is a `MyOptions`.
 *
 * @public
 */
export function registerChannelHandler(
  handler: ChannelHandler,
  registration?: ChannelRegistration,
): void;
/**
 * Register a channel kind whose `render`/`advice` read their OWN options type,
 * narrowed from the descriptor's raw options by `options` (throwing a sentence
 * naming the field that is wrong).
 *
 * @public
 */
export function registerChannelHandler<O>(
  handler: ChannelHandler<O>,
  options: (raw: Record<string, unknown>) => O,
  registration?: ChannelRegistration,
): void;
export function registerChannelHandler<O>(
  handler: ChannelHandler<O>,
  optionsOrRegistration?: ((raw: Record<string, unknown>) => O) | ChannelRegistration,
  maybeRegistration?: ChannelRegistration,
): void {
  const options = typeof optionsOrRegistration === "function" ? optionsOrRegistration : undefined;
  const registration =
    typeof optionsOrRegistration === "function" ? maybeRegistration : optionsOrRegistration;
  // The first overload: `O` is the raw record, so the handler is stored as is.
  const raw: unknown = handler;
  const stored: ChannelHandler =
    options === undefined
      ? (raw as ChannelHandler)
      : {
          kind: handler.kind,
          render: (message, raw) => handler.render(message, options(raw)),
          advice: (raw, detail) => handler.advice(options(raw), detail),
        };
  CHANNEL_KINDS.set(handler.kind, {
    handler: stored,
    refusal: registration?.refusal,
    credentialFields: [...(registration?.credentialFields ?? [])],
  });
}

/** The tags {@link sendToChannel} can dispatch, in registration order. */
export function registeredChannelKindNames(): readonly string[] {
  return [...CHANNEL_KINDS.keys()];
}

registerChannelHandler(SLACK_CHANNEL_HANDLER, { credentialFields: ["webhookUrl"] });
registerChannelHandler(TEXTBELT_CHANNEL_HANDLER, textbeltOptions, {
  refusal: textbeltRefusal,
  credentialFields: ["key"],
});

function entryFor(channel: Channel): ChannelKindEntry {
  const entry = CHANNEL_KINDS.get(channel.kind);
  if (entry === undefined) {
    throw new Error(
      `Unknown channel kind ${JSON.stringify(channel.kind)}. ` +
        `Registered kinds: ${registeredChannelKindNames().join(", ") || "(none)"}. ` +
        "A kind is registered by importing the module that declares it, or by " +
        "calling `registerChannelHandler` — a run resumed in a fresh worker has " +
        "imported neither unless the agent's entry does it at module load.",
    );
  }
  return entry;
}

function handlerFor(channel: Channel): ChannelHandler {
  return entryFor(channel).handler;
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
 * — see {@link ChannelDeliveryError}, or reach for `orFail(sendToChannel)`
 * (`orFail` is on `@alexkroman1/aai/step-errors`) to skip the `.catch`.
 *
 * @returns whatever the platform answered with, or `"ok"` when it sent no body.
 * @throws {ChannelDeliveryError} on any non-2xx, and on a 2xx the channel reads
 *   as a refusal (a registration's `refusal` — Textbelt's `{"success": false}`),
 *   which is never retryable.
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
  return await postToChannel(channel, message, stepFetch);
}

/** The `fetch` a post goes through: `stepFetch`, or a host's screened one. @internal */
export type ChannelFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

/**
 * {@link sendToChannel} over a caller's `fetch` — how a HOST builtin posts
 * through its own screened egress (`text_me`) with the verdicts unchanged.
 *
 * Every send, host or step, ends here — which is why a published channel
 * outbox (`publishChannelOutbox`) is checked here and nowhere else.
 *
 * @internal
 */
export async function postToChannel(
  channel: Channel,
  message: ChannelMessage,
  fetchFn: ChannelFetch,
): Promise<string> {
  const { handler, refusal, credentialFields } = entryFor(channel);
  const payload = handler.render(message, channel.options);
  // A published OUTBOX takes the send instead of the network (`outbox.ts`):
  // checked AFTER rendering, so a descriptor with a bad field still fails the
  // way it would for real, and BEFORE `fetchFn`, so nothing leaves the process.
  // The entry carries no URL and none of the kind's declared credential
  // fields — see `channelOutboxEntry`.
  const outbox = publishedChannelOutbox();
  if (outbox !== undefined) {
    await outbox(channelOutboxEntry(channel, payload, credentialFields));
    return "ok";
  }
  // Every string below that the PLATFORM wrote — a 2xx refusal, a non-2xx
  // body or its preview, even a fetch failure's message — goes through
  // `redactChannelCredentials` before it reaches advice or an error, and the
  // finished message goes through it again in case a handler's advice quotes
  // its options. Textbelt has answered with our key in a link, and the message
  // is stored with the run, logged and shown (see `redactChannelCredentials`).
  const redact = (text: string) => redactChannelCredentials(channel, credentialFields, text);
  const response = await fetchFn(payload.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...payload.headers },
    body: JSON.stringify(payload.body),
    signal: AbortSignal.timeout(CHANNEL_POST_TIMEOUT_MS),
  }).catch((err: unknown) => {
    // A fetch that never got an answer can name the URL it was dialling, and
    // a Slack webhook URL is the credential. Rethrown as is when it does not,
    // so a timeout keeps its type for whoever classifies it.
    if (!(err instanceof Error) || redact(err.message) === err.message) throw err;
    throw new Error(redact(err.message));
  });
  if (response.ok) {
    const body = await response.text();
    const refused = refusal?.(body);
    if (refused === undefined) return body || "ok";
    throw new ChannelDeliveryError(
      redact(`${handler.advice(channel.options, redact(refused))} (HTTP ${response.status})`),
      { channelKind: channel.kind, status: response.status, retryable: false },
    );
  }

  // `responseErrorMessage` rather than `await response.text()` and a
  // hand-rolled truncation: it prefers a JSON `error` field when the body has
  // one — which Slack's does — and falls back to the status with a bounded
  // preview. That body is what decides which advice a person is given.
  const detail = redact(await responseErrorMessage(response, `${channel.kind} channel post`));
  const retryable = isTransientStatus(response.status);
  throw new ChannelDeliveryError(
    redact(
      retryable
        ? `${channel.kind} channel post failed: HTTP ${response.status}. ${detail}`
        : `${handler.advice(channel.options, detail)} (HTTP ${response.status})`,
    ),
    {
      channelKind: channel.kind,
      status: response.status,
      retryable,
      retryAfter: retryAfter(response),
    },
  );
}
