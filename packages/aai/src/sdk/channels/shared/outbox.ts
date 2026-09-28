// Copyright 2026 the AAI authors. MIT license.
/**
 * The channel OUTBOX — where a text goes instead of the network when a host
 * says so.
 *
 * Every channel send ends in `postToChannel`: the `text_me` host builtin calls
 * it directly with its screened fetch, and a workflow step reaches it through
 * `sendToChannel` / `sendToChannelOrFail`. So one sink checked THERE is the
 * whole of "try the agent without texting anyone": a developer running
 * `aai dev` against a real Textbelt key, or a Slack webhook that posts to a
 * real channel, can watch what WOULD have gone out without a byte of it
 * leaving the process — and without a code path of the agent's own that only
 * exists in a test.
 *
 * A published sink is taken as the ANSWER: the post it replaces is reported
 * as delivered (`"ok"`), because the agent's side of the contract — build a
 * message, hand it to a channel, carry on — is what is being exercised. What
 * the platform would have said back (a refusal, a 5xx) is not simulated.
 *
 * ## Why a global slot
 *
 * The same reason as `publishClientNotifier`: the host that decides where
 * texts go (`aai-runtime`, reading `AAI_CHANNEL_OUTBOX`) and the step that
 * sends one (the agent bundle's own copy of this SDK) are two module instances
 * in one realm, so a module-level variable would be published into one copy
 * and read from the other.
 *
 * @module
 */

import type { Channel, ChannelPayload } from "./channel-types.ts";

const CHANNEL_OUTBOX_SLOT = Symbol.for("@alexkroman1/aai.channelOutbox");

/**
 * One captured send: the channel's kind, the recipient when the descriptor
 * names one, and the JSON body the platform WOULD have been posted — with
 * every credential removed (see {@link CHANNEL_CREDENTIAL_FIELDS}).
 *
 * @internal
 */
export type ChannelOutboxEntry = {
  /** The channel's `kind` tag — `"textbelt"`, `"slack"`, or a registered one. */
  kind: string;
  /** The descriptor's `options.to`, when it is a string (Textbelt's number). */
  to?: string;
  /** The rendered body, credentials removed. */
  body: Record<string, unknown>;
};

/**
 * What a host publishes: take one captured send. A rejection fails the send
 * the way a failed post would, so a sink that cannot write says so.
 *
 * @internal
 */
export type ChannelOutbox = (entry: ChannelOutboxEntry) => void | Promise<void>;

type OutboxSlot = { [CHANNEL_OUTBOX_SLOT]?: ChannelOutbox };

/**
 * Body fields that are CREDENTIALS, dropped before an entry reaches a sink.
 *
 * The one place this list lives, because a sink's whole purpose is to be read
 * — appended to a file in a project directory, printed, diffed — and a key in
 * it is a key on disk. Textbelt carries its API key in the body as `key`.
 * Slack carries its secret in the URL rather than the body (a webhook URL IS
 * the credential), which is why an entry never carries the URL at all. A
 * channel that puts a secret anywhere else in its body adds the field here.
 */
const CHANNEL_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(["key"]);

/**
 * Publish where this process's channel sends go instead of the network.
 * `undefined` unpublishes, and posts go out again.
 *
 * @internal — a host concern. An agent sends with `sendToChannel` unchanged.
 */
export function publishChannelOutbox(sink: ChannelOutbox | undefined): void {
  if (sink === undefined) delete (globalThis as OutboxSlot)[CHANNEL_OUTBOX_SLOT];
  else (globalThis as OutboxSlot)[CHANNEL_OUTBOX_SLOT] = sink;
}

/** The published sink, if any. @internal */
export function publishedChannelOutbox(): ChannelOutbox | undefined {
  return (globalThis as OutboxSlot)[CHANNEL_OUTBOX_SLOT];
}

/**
 * The entry a sink is handed for `payload` rendered from `channel`: never the
 * URL, never a {@link CHANNEL_CREDENTIAL_FIELDS} field.
 *
 * @internal
 */
export function channelOutboxEntry(channel: Channel, payload: ChannelPayload): ChannelOutboxEntry {
  const body = Object.fromEntries(
    Object.entries(payload.body).filter(([field]) => !CHANNEL_CREDENTIAL_FIELDS.has(field)),
  );
  const to = channel.options.to;
  return { kind: channel.kind, ...(typeof to === "string" ? { to } : {}), body };
}
