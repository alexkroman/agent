// Copyright 2026 the AAI authors. MIT license.
/**
 * The Textbelt channel — an SMS to ONE fixed number, through
 * https://textbelt.com (one POST, no sender number to rent or register).
 *
 * ## The recipient is fixed when the channel is built
 *
 * `to` is an option of the descriptor, not a field of the message, so nothing
 * a message carries — nothing a model wrote into it — can redirect the text.
 * Choosing `to` is the caller's job; `allowedSmsRecipient` is the rule
 * the `text_me` builtin uses for it.
 *
 * ## A refusal arrives as a 200
 *
 * Textbelt answers `200 {"success": false, "error": "Out of quota"}` rather
 * than a 4xx, so `send.ts` registers `textbeltRefusal` for this kind: without
 * it a spent quota would read as delivered. A refusal is not retryable (quota,
 * a bad number, a link on a key not yet allowed links all answer the same next
 * time); a 5xx or 429 is, as on every channel.
 *
 * ## Length: one text, capped at {@link TEXTBELT_MAX_MESSAGE_CHARS}
 *
 * Textbelt splits a long text into carrier segments itself and bills one
 * credit per segment (usually ~120 characters each); its docs promise that
 * segmentation "up to a certain length (as of writing, 256 bytes)" and say
 * nothing past it. This channel sends ONE request per message and cuts the
 * rendered text at 1,000 characters with an ellipsis rather than splitting it
 * into several texts, which could arrive out of order and would be sent twice
 * over by a retried step. Keep messages short: a full-length one costs ~8
 * credits, and one past what Textbelt accepts comes back as a refusal.
 *
 * ## Links need a Textbelt allowance
 *
 * Textbelt refuses a text containing a URL until the key is allowed to send
 * them (https://textbelt.com/whitelist). The advice for that refusal says so.
 */

import { isRecord } from "../is-record.ts";
import { omitUndefined } from "../omit-undefined.ts";
import type {
  Channel,
  ChannelHandler,
  ChannelMessage,
  ChannelPayload,
} from "./shared/channel-types.ts";

/** The `kind` tag on a Textbelt channel descriptor. */
export const TEXTBELT_CHANNEL_KIND = "textbelt";

/** Where every Textbelt text is POSTed. @internal */
export const TEXTBELT_ENDPOINT = "https://textbelt.com/text";

/**
 * The longest text a Textbelt channel sends, in characters; a longer render is
 * cut with an ellipsis. See the module doc for why a cap and not a split.
 */
export const TEXTBELT_MAX_MESSAGE_CHARS = 1000;

/**
 * What {@link textbeltChannel} takes.
 *
 * Like a Slack webhook URL, both are passed in rather than read from the env
 * here. The key is a credential and a descriptor is JOURNALED when it is a
 * step's argument, so build the channel inside the step from `stepEnv()` (or in
 * a tool from `ctx.env`) rather than passing it through a run's input.
 *
 * @public
 */
export interface TextbeltChannelOptions {
  /** A Textbelt API key. Append `_test` to check a request without sending. */
  readonly key: string;
  /**
   * The one number this channel texts: E.164 (`+15555550123`) anywhere, or a
   * 10-digit number in the US, as Textbelt accepts. Personal data.
   */
  readonly to: string;
  /**
   * `"strip"` takes every link out of the text before it is sent — for a key
   * Textbelt has not yet allowed to send links (https://textbelt.com/whitelist),
   * which refuses any text containing one. The words still arrive; `"keep"`
   * (the default) sends the text as written.
   */
  readonly links?: "keep" | "strip";
}

/** A Textbelt channel descriptor, as returned by {@link textbeltChannel}. */
export type TextbeltChannel = Channel & {
  readonly kind: typeof TEXTBELT_CHANNEL_KIND;
  readonly options: TextbeltChannelOptions & Record<string, unknown>;
};

/**
 * Declare an SMS destination: one number, texted through Textbelt.
 *
 * @example Text the owner from a step
 * ```ts
 * import { sendToChannel, textbeltChannel } from "@alexkroman1/aai/channels";
 * import { requireStepEnv } from "@alexkroman1/aai/step";
 * import { orFail } from "@alexkroman1/aai/step-errors";
 *
 * export async function textOwner(summary: string): Promise<string> {
 *   const channel = textbeltChannel({
 *     key: requireStepEnv("TEXTBELT_KEY"),
 *     to: requireStepEnv("SMS_TO_PHONE"),
 *   });
 *   return await orFail(sendToChannel)(channel, { text: summary });
 * }
 * ```
 *
 * @public
 */
export function textbeltChannel(options: TextbeltChannelOptions): TextbeltChannel {
  return { kind: TEXTBELT_CHANNEL_KIND, options: { ...options } };
}

/**
 * A message as one SMS body: `heading` (else `text`), `subtitle`, then each
 * section's title, link, prose and bullets, cut at
 * {@link TEXTBELT_MAX_MESSAGE_CHARS}.
 *
 * @public
 */
export function renderTextbeltText(message: ChannelMessage): string {
  return capText(joinedText(message));
}

/** `text` cut at {@link TEXTBELT_MAX_MESSAGE_CHARS}, marked. */
function capText(text: string): string {
  return text.length <= TEXTBELT_MAX_MESSAGE_CHARS
    ? text
    : `${text.slice(0, TEXTBELT_MAX_MESSAGE_CHARS - 1)}…`;
}

/** A URL or anything that reads as one: a scheme, `www.`, or a bare domain with a common TLD. */
// A link ends before trailing punctuation: "(see https://x.com)," keeps its ")" and ",".
const LINK_RE =
  /\b(?:https?:\/\/|www\.)\S+?(?=[)\]>.,;:!?"']*(?:\s|$))|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|us|uk|ca|au|de|fr|dev|ai|app|info|biz|me|tv|news|blog)\b(?:\/\S*?(?=[)\]>.,;:!?"']*(?:\s|$)))?/gi;

/**
 * `text` with every link removed, and what removing them leaves behind tidied
 * away: empty brackets, bare `[n]` source markers, a trailing empty
 * "Sources:", doubled spaces and blank lines.
 *
 * @internal — `textbeltChannel({ links: "strip" })` and the `text_me` builtin.
 */
export function stripLinks(text: string): string {
  return text
    .replace(LINK_RE, "")
    .replace(/\(\s*\)|<\s*>|\[\s*\]\(\s*\)/g, "")
    .split("\n")
    .filter((line) => !/^\s*\[\d+\]\s*[-:]?\s*$/.test(line))
    .join("\n")
    .replace(/\n\n?Sources:\s*$/, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every part of a message as one text, uncut. */
function joinedText(message: ChannelMessage): string {
  const lines = [
    message.heading ?? message.text,
    ...(message.subtitle === undefined ? [] : [message.subtitle]),
    ...(message.sections ?? []).flatMap((section) => [
      "",
      ...(section.title === undefined ? [] : [section.title]),
      ...(section.url === undefined ? [] : [section.url]),
      ...(section.body === undefined ? [] : [section.body]),
      ...(section.bullets ?? []).map((bullet) => `- ${bullet}`),
    ]),
  ];
  return lines.join("\n").trim();
}

/** The SMS body a channel sends: links out first when it strips them, then the cap. */
function textbeltBody(message: ChannelMessage, options: TextbeltChannelOptions): string {
  const text = joinedText(message);
  return capText(options.links === "strip" ? stripLinks(text) : text);
}

/** Textbelt's JSON: `phone`, `message`, `key`. @internal */
export function renderTextbeltChannelPayload(
  message: ChannelMessage,
  options: TextbeltChannelOptions,
): ChannelPayload {
  return {
    url: TEXTBELT_ENDPOINT,
    body: { phone: options.to, message: textbeltBody(message, options), key: options.key },
  };
}

/**
 * The reason in a 2xx Textbelt body, or `undefined` for `"success": true`. A
 * body that is not JSON at all is a refusal too: nothing confirmed a send.
 *
 * @internal
 */
export function textbeltRefusal(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "Textbelt's answer was not JSON";
  }
  if (!isRecord(parsed)) return "Textbelt's answer was not an object";
  const { success, error } = parsed;
  if (success === true) return;
  return typeof error === "string" && error !== "" ? error : "Textbelt did not confirm the send";
}

/**
 * The sentence a person can act on. Never names the number or the key: the
 * first is personal data and the second a credential.
 *
 * @public
 */
export function explainTextbeltChannelFailure(detail: string): string {
  if (/quota/i.test(detail)) {
    return `Textbelt refused the text: ${detail}. The key has no credit left — top it up at textbelt.com.`;
  }
  if (/url|link|whitelist/i.test(detail)) {
    return `Textbelt refused the text: ${detail}. A text with a link needs the key allowed to send links: https://textbelt.com/whitelist`;
  }
  if (/phone|number/i.test(detail)) {
    return `Textbelt refused the text: ${detail}. Check the recipient: E.164 (+ and country code), or 10 digits in the US.`;
  }
  return `Textbelt refused the text: ${detail}. Check that the key is valid.`;
}

/**
 * A descriptor's options, NARROWED rather than cast — the reason
 * `slack.ts`'s `slackOptions` gives, since a descriptor can arrive from a
 * journal as whatever was written there.
 *
 * @internal
 */
export function textbeltOptions(options: Record<string, unknown>): TextbeltChannelOptions {
  const { key, to } = options;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(
      "A Textbelt channel needs a string `key`. Build one with `textbeltChannel({ key, to })`.",
    );
  }
  if (typeof to !== "string" || to.trim() === "") {
    throw new Error(
      "A Textbelt channel needs a string `to`. Build one with `textbeltChannel({ key, to })`.",
    );
  }
  const { links } = options;
  if (links !== undefined && links !== "keep" && links !== "strip") {
    throw new Error('A Textbelt channel\'s `links` is "keep" or "strip".');
  }
  return { key: key.trim(), to: to.trim(), ...omitUndefined({ links }) };
}

/**
 * Textbelt as a {@link ChannelHandler}, typed on its own options — registered
 * WITH its options narrowing, so `render` and `advice` are handed a
 * checked value.
 *
 * @public
 */
export const TEXTBELT_CHANNEL_HANDLER: ChannelHandler<TextbeltChannelOptions> = {
  kind: TEXTBELT_CHANNEL_KIND,
  render: renderTextbeltChannelPayload,
  advice: (_options, detail) => explainTextbeltChannelFailure(detail),
};
