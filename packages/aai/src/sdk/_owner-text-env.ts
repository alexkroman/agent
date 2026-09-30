// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent-env contract a "text the owner" reads — shared by the `text_me`
 * builtin (`host/text-me.ts`, reading `ctx.env`) and `stepTextOwner`
 * (`step-text-owner.ts`, reading the step env), so a tool and a step that
 * both text the owner cannot disagree about which variable means what.
 */

/** The agent-env variable the Textbelt key is read from. */
export const TEXTBELT_KEY_ENV = "TEXTBELT_KEY";
/** The owner's own number: the default recipient. */
export const SMS_TO_PHONE_ENV = "SMS_TO_PHONE";
/** More numbers a client may claim; see `allowedSmsRecipient`. */
export const SMS_ALLOWED_PHONES_ENV = "SMS_ALLOWED_PHONES";

/**
 * Set to `strip` for a Textbelt key not yet allowed to send links
 * (https://textbelt.com/whitelist): every link is then left out rather than
 * sending a text Textbelt will refuse. Read per call, like the key: whether a
 * key may send links is a property of the KEY.
 */
export const TEXTBELT_LINKS_ENV = "TEXTBELT_LINKS";

/** `TEXTBELT_LINKS` as a channel's `links` option: `"strip"` (any case, trimmed) or `"keep"`. */
export function textbeltLinksFromEnv(raw: string | undefined): "keep" | "strip" {
  return raw?.trim().toLowerCase() === "strip" ? "strip" : "keep";
}
