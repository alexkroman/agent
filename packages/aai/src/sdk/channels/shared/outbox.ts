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
 * Descriptor option and body fields that are CREDENTIALS: dropped before an
 * entry reaches a sink, and their VALUES redacted from every refusal
 * `postToChannel` turns into an error ({@link redactChannelCredentials}).
 *
 * The one place this list lives, because a sink's whole purpose is to be read
 * — appended to a file in a project directory, printed, diffed — and a key in
 * it is a key on disk; and because an error message is read too, and further
 * afield: it is a durable run's stored error (a Postgres row), a log line and
 * a UI string. Textbelt carries its API key in the body as `key`. Slack
 * carries its secret in the URL rather than the body (a webhook URL IS the
 * credential), which is why an entry never carries the URL at all and why
 * `webhookUrl` is listed: it never names a body field, but it is an OPTION
 * whose value must not come back in a refusal. A channel that puts a secret
 * anywhere else adds the field here.
 */
export const CHANNEL_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set(["key", "webhookUrl"]);

/** What a redacted credential reads as in an error message. @internal */
export const REDACTED = "[redacted]";

/**
 * A `key=`/`token=`/`secret=`-style query parameter, value included, in any
 * URL a platform wrote into its answer. Matched on the NAME rather than the
 * value, because the value may be a credential this process never held — a
 * platform's own signed link, a key derived from ours.
 */
const SECRET_QUERY_PARAM =
  /([?&](?:api[_-]?key|access[_-]?token|auth|client[_-]?secret|key|password|secret|sig|signature|token)=)[^&#\s"'<>)]+/gi;

/**
 * `text` with every credential in `channel`'s options replaced by
 * {@link REDACTED}, and every secret-named query parameter's value too.
 *
 * **A platform's refusal can quote the credential back.** Textbelt answered a
 * text with a link, on a key not yet allowed links, `200 {"success": false,
 * "error": "… Please go to https://textbelt.com/whitelist?key=<THE KEY> …"}`
 * — and that `error` became a `ChannelDeliveryError`'s message, which is
 * stored with the run, logged, and shown. So the send path redacts every
 * detail it did not write itself before it reaches advice or a message, and
 * does it HERE, centrally, rather than in each handler's advice: a handler
 * that forgets is the same leak.
 *
 * Each value is matched raw and URL-encoded (a key in a query string is
 * encoded), longest first so a key inside a webhook URL cannot leave half of
 * either behind. The query-parameter pass then catches what no option names.
 *
 * @internal
 */
export function redactChannelCredentials(channel: Channel, text: string): string {
  return redactCredentials(
    [...CHANNEL_CREDENTIAL_FIELDS].map((field) => channel.options[field]),
    text,
  );
}

/**
 * `text` with each of `values` (the strings among them) replaced by
 * {@link REDACTED}, raw and URL-encoded, longest first — and every secret-named
 * query parameter's value too.
 *
 * The mechanism under {@link redactChannelCredentials}, taking the VALUES rather
 * than a descriptor, because a channel is not the only thing that holds a
 * credential and gets an answer back from the far side: `stepPlaceCall`
 * (`sdk/step-place-call.ts`) holds a Twilio auth token and turns Twilio's
 * refusals into an error a run stores, logs and shows — the same leak, with
 * the same fix, and two copies of it would be two lists to keep in step.
 *
 * @internal
 */
export function redactCredentials(values: readonly unknown[], text: string): string {
  const secrets = values
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .flatMap((value) => [value, value.trim(), encodeURIComponent(value.trim())])
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join(REDACTED);
  return redacted.replace(SECRET_QUERY_PARAM, `$1${REDACTED}`);
}

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
