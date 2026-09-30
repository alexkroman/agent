// Copyright 2026 the AAI authors. MIT license.
/**
 * The `text_me` builtin — text the OWNER something too long to say, over the
 * Textbelt channel (`sdk/channels/textbelt.ts`), for an agent that brings its
 * own `TEXTBELT_KEY`.
 *
 * **The model never names the recipient.** It is chosen here by
 * `allowedSmsRecipient`: the number the session's client reported
 * (`sessionClientPhone`) only when the owner listed it (`SMS_TO_PHONE` or
 * `SMS_ALLOWED_PHONES`), else `SMS_TO_PHONE`. A client's `?phone=` is a claim
 * anyone who can open a session can make, so an unlisted one is ignored — a
 * misheard request, or a stranger on the LAN, cannot point the owner's key at
 * somebody else.
 *
 * A key Textbelt has not yet allowed to send links refuses any text holding
 * one; `TEXTBELT_LINKS=strip` in the agent env makes `text_me` take them out
 * instead ({@link TEXTBELT_LINKS_ENV}).
 *
 * Every failure is the tool's RESULT (`{ error }`), never a throw, like every
 * other builtin. The key handling — agent env on each call, not derived into
 * `requiredEnv` — is `_keyed-api.ts`'s rule.
 */

import { z } from "zod";
import { missingEnvMessage } from "../sdk/_missing-env.ts";
import { postToChannel } from "../sdk/channels/shared/send.ts";
import {
  stripLinks,
  TEXTBELT_MAX_MESSAGE_CHARS,
  textbeltChannel,
} from "../sdk/channels/textbelt.ts";
import { sessionClientPhone } from "../sdk/session-phone.ts";
import { allowedSmsRecipient } from "../sdk/sms-recipient.ts";
import type { ToolDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { builtinCover } from "./_builtin-cover.ts";
import { builtinFetch } from "./ssrf.ts";

/** The agent-env variable `text_me` reads its Textbelt key from. */
export const TEXTBELT_KEY_ENV = "TEXTBELT_KEY";
/** The owner's own number: the default recipient. */
export const SMS_TO_PHONE_ENV = "SMS_TO_PHONE";

/**
 * Set to `strip` for a Textbelt key not yet allowed to send links
 * (https://textbelt.com/whitelist): `text_me` then leaves every link out —
 * the `url` argument and any link in the message — and says so in its result,
 * rather than sending a text Textbelt will refuse. Read per call, like the key:
 * whether a key may send links is a property of the KEY.
 */
export const TEXTBELT_LINKS_ENV = "TEXTBELT_LINKS";

/** Longest link `text_me` takes; the message is cut to leave it room. */
const MAX_URL_CHARS = 500;

const textMeParams = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(TEXTBELT_MAX_MESSAGE_CHARS)
    .describe("The text to send: the full version, written to be read, not spoken"),
  url: z
    .string()
    .trim()
    .max(MAX_URL_CHARS)
    .describe("A link to include — the exact http(s) URL you visited or found; never invent one")
    .optional(),
});

/** An http(s) URL, or nothing: a text is no place for `javascript:` or a file path. */
function httpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** `message`, then the link on its own line, the message cut so the link survives the cap. */
function smsBody(message: string, url: string | undefined): string {
  if (url === undefined) return message;
  const room = TEXTBELT_MAX_MESSAGE_CHARS - url.length - 1;
  const cut = message.length <= room ? message : `${message.slice(0, room - 1)}…`;
  return `${cut}\n${url}`;
}

/** The text to send and whether links were left out of it — see {@link TEXTBELT_LINKS_ENV}. */
function outgoingText(
  args: { message: string; url?: string | undefined },
  links: string | undefined,
): { text: string; leftOut: boolean } {
  if (links?.trim().toLowerCase() !== "strip") {
    return { text: smsBody(args.message, args.url), leftOut: false };
  }
  const text = stripLinks(args.message);
  return { text, leftOut: text !== args.message || args.url !== undefined };
}

export function createTextMe(
  fetchFn: typeof globalThis.fetch = builtinFetch(),
): ToolDef<typeof textMeParams> & { guidance: string } {
  return {
    guidance:
      "Use text_me to text the owner the full version of anything too long to say well: " +
      "directions, a list, a recipe, several results, or anything with a link, address or " +
      "number. Usually offer first and send once they say yes. Never read a URL aloud: text it.",
    description:
      "Send a text message to the owner's own phone (the number is configured, never chosen " +
      "here). Use it for what is too long or too exact to say: directions, a list, a recipe, " +
      "several search results, or anything with a link, address or phone number. Offer first " +
      '("Want me to text you that?") and send when they agree, or when they ask to be texted. ' +
      "Put a link in `url`, never read it aloud. Returns whether it was sent.",
    inputSchema: textMeParams,
    messages: builtinCover("I'm sending the text."),
    async execute(args, ctx) {
      if (args.url !== undefined && !httpUrl(args.url)) {
        return { error: "Only an http(s) link can be texted." };
      }
      const key = ctx.env[TEXTBELT_KEY_ENV]?.trim();
      if (!key) return { error: missingEnvMessage(TEXTBELT_KEY_ENV) };
      const to = allowedSmsRecipient(sessionClientPhone(ctx), ctx.env);
      if (to === undefined) return { error: missingEnvMessage(SMS_TO_PHONE_ENV) };
      const { text, leftOut } = outgoingText(args, ctx.env[TEXTBELT_LINKS_ENV]);
      if (text === "") {
        return { error: "That text was only links, and this Textbelt key can't send links." };
      }
      try {
        await postToChannel(textbeltChannel({ key, to }), { text }, fetchFn);
        return leftOut
          ? { sent: true, note: "Links were left out: they can't be texted yet." }
          : { sent: true };
      } catch (err) {
        // A ChannelDeliveryError is already a sentence naming the fix; anything
        // else is the request never getting an answer. Neither names the number.
        return { error: `The text did not send: ${errorMessage(err)}` };
      }
    },
  };
}
