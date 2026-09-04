// Copyright 2026 the AAI authors. MIT license.
/**
 * The channel contract: a serializable DESTINATION, and the message shape
 * every channel renders.
 *
 * A channel is where a run's output GOES — the Slack workspace a digest is
 * posted to, the endpoint a summary is pushed at. It is deliberately the
 * narrow half of what other frameworks call a channel: `vercel/eve`'s is an
 * edge adapter that also normalizes inbound platform events into a session and
 * owns delivery back, and its own docs are explicit that it does NOT abstract
 * the outbound-only case ("to post a notification without a model call, use
 * the destination platform's API instead"). That case is what a workflow step
 * has, it is what every template here had hand-rolled, and it is what this is.
 *
 * ## Two layers, the same boundary the providers draw
 *
 * A {@link Channel} is DATA — `{ kind, options }`, JSON-serializable, no
 * functions — exactly like `SttProvider` and its siblings, and for the same
 * reason: it crosses the CLI → server → guest boundary, and a durable step's
 * arguments are journaled, so a descriptor round-trips where an object with
 * methods cannot. {@link sendToChannel} is the other layer: it takes the
 * descriptor and does the POST.
 *
 * ## What a channel is NOT allowed to be
 *
 * A channel never carries an interactive surface, a session, or an inbound
 * route. There is no `receive`, and adding one would be a different concept
 * wearing this name — see the module doc on `sdk/channels/slack.ts` for the
 * one place that distinction has already cost somebody a red 400.
 *
 * ## A PLATFORM feature is a kind's options, never a field here
 *
 * {@link ChannelMessage} and {@link ChannelSection} are the platform-neutral
 * half, and they are the half a contract hash watches. Every field added to
 * them is a signature change to `aai:channels` — for every channel, including
 * the ones that cannot render it — so a Slack-only affordance added here
 * charges a version bump to Discord and to whatever comes next. That is the
 * shape that produced this repo's largest single source of contract churn one
 * layer down: `ToolContext` grew a field per runtime capability and `aai:tool`
 * ran nine consecutive signature-only epochs for it (`guard-invariants` rule
 * 24 caps it; rule 25 caps these).
 *
 * So the rule is: a knob only one platform has goes in that kind's OWN options
 * type, which nothing else reads and which is free to grow. `textParam` is the
 * worked example — a Slack workflow-trigger detail, on `SlackChannelOptions`,
 * invisible to every other channel and to this file. Add here only what a new
 * channel would have to INVENT to render at all, and expect to defend it.
 */

/**
 * Base shape for a channel descriptor: a `kind` tag plus an opaque `options`
 * payload, so the dispatch table picks the renderer and passes the author's
 * options through verbatim.
 *
 * @public
 */
export interface ChannelDescriptor<Kind extends string, Options> {
  readonly kind: Kind;
  readonly options: Options;
}

/**
 * Any channel descriptor — what {@link sendToChannel} takes.
 *
 * The `__surface` property is a compile-time tag, so a PROVIDER descriptor
 * cannot be handed to a channel operation and vice versa. It is optional and
 * never present at runtime, so a plain `{ kind, options }` object parsed off
 * the wire stays assignable — the same trick `ProviderDescriptor`'s `__stage`
 * plays for the four pipeline stages.
 *
 * @public
 */
export type Channel = ChannelDescriptor<string, Record<string, unknown>> & {
  /** Compile-time surface tag; never present at runtime. */
  readonly __surface?: "channel";
};

/**
 * Everything one channel kind supplies: how to turn a {@link ChannelMessage}
 * into the request body that platform takes, and what to say when the platform
 * refuses one.
 *
 * A channel is defined as a VALUE of this shape, in the module that owns the
 * platform, and `sendToChannel` reaches it through the registry. The generic
 * send path therefore imports nothing vendor-specific and adding a channel
 * touches no shared file — which is the whole reason this interface is public
 * rather than an internal shape inside `send.ts`, where it started with Slack's
 * option-narrowing spelled out beside the dispatch table.
 *
 * `render` and `advice` are handed the descriptor's RAW options, because a
 * descriptor round-trips through a durable run's journal and arrives as
 * whatever was written there. Narrowing them is the kind's own job and the
 * reason it owns this function: a cast here would fail as `POST undefined`
 * rather than naming the field that is missing.
 *
 * @public
 */
export interface ChannelHandler {
  /** The `kind` tag its descriptors carry, e.g. `"slack"`. */
  readonly kind: string;
  /** Turn a message into this platform's request. */
  readonly render: (message: ChannelMessage, options: Record<string, unknown>) => ChannelPayload;
  /** What to tell an author when the platform refuses a post. */
  readonly advice: (options: Record<string, unknown>, detail: string) => string;
}

/**
 * One block of a message: a titled chunk, optionally linked, with prose and
 * bullets under it.
 *
 * Everything is optional because a channel renders what it was given rather
 * than demanding a shape — a section with only `body` is a paragraph, one with
 * only `title` and `url` is a link.
 *
 * @public
 */
export interface ChannelSection {
  /** The section's headline. Rendered as a link when `url` is set. */
  readonly title?: string;
  /** Where `title` points. */
  readonly url?: string;
  /** A line under the title — a source, a byline, a timestamp. */
  readonly subtitle?: string;
  /** The prose. */
  readonly body?: string;
  /** Bullet points under the prose. */
  readonly bullets?: readonly string[];
}

/**
 * What gets posted, in terms no single platform owns.
 *
 * **`text` is not decoration and it is not optional.** It is what a push
 * notification and a screen reader read, and it is the WHOLE message on a
 * channel that has no rich format — a Slack workflow trigger takes flat string
 * variables and there is no `blocks` variable to send. A channel with a rich
 * format renders `heading`/`sections` and uses `text` as the notification
 * line; a channel without one renders `text` and folds the rest into it. Leave
 * it off and Slack notifies as "[no preview]"; that is the failure this field
 * exists to prevent.
 *
 * @public
 */
export interface ChannelMessage {
  /** The notification line, and the fallback body. Always sent. */
  readonly text: string;
  /** The title above the sections. */
  readonly heading?: string;
  /** A line under the heading — context for the whole message. */
  readonly subtitle?: string;
  /** The body, in blocks. */
  readonly sections?: readonly ChannelSection[];
}

/**
 * A rendered request: where to POST and what to send.
 *
 * Returned by {@link renderChannelPayload}, which is PURE — the branch a
 * channel takes over its own options is testable without a network, and on
 * Slack that branch is the difference between a delivered message and a 400.
 *
 * @public
 */
export interface ChannelPayload {
  /** Absolute URL to POST to. */
  readonly url: string;
  /** The JSON body. */
  readonly body: Record<string, unknown>;
  /** Headers beyond `Content-Type: application/json`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A post the channel refused, carrying the verdict the caller needs.
 *
 * `retryable` is the whole point, and it is why this is a class rather than a
 * thrown `Response`. A revoked webhook, an unpublished Slack workflow and a
 * wrong variable name all answer 4xx and will answer 4xx identically on every
 * attempt — retrying them burns a step's attempts and delays the real error by
 * minutes. A 5xx is the platform having a bad minute, which is precisely what
 * retries are for.
 *
 * `toStepError` (`@alexkroman1/aai/step-errors`) reads both fields, exactly as
 * it already does for `StepGenerateError` and `TranscribeError` — so a step
 * body hands this straight to it and the DevKit gives up or waits out the
 * platform's own `Retry-After` without the body deciding anything.
 *
 * @public
 */
export class ChannelDeliveryError extends Error {
  override readonly name = "ChannelDeliveryError";
  /** The channel that refused it — `"slack"`, and so on. */
  readonly channelKind: string;
  /** The HTTP status, or `undefined` when the request never got an answer. */
  readonly status: number | undefined;
  /** Whether another attempt could plausibly succeed. */
  readonly retryable: boolean;
  /** When the platform named a `Retry-After`, the moment it asked for. */
  readonly retryAfter: Date | undefined;

  constructor(
    message: string,
    init: {
      readonly channelKind: string;
      readonly status?: number | undefined;
      readonly retryable: boolean;
      readonly retryAfter?: Date | undefined;
      readonly cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.channelKind = init.channelKind;
    this.status = init.status;
    this.retryable = init.retryable;
    this.retryAfter = init.retryAfter;
  }
}
