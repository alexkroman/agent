// Copyright 2026 the AAI authors. MIT license.
/**
 * Who a "text me" is allowed to reach — the rule `text_me` applies, published
 * so a workflow step (reading `stepEnv`) applies the identical one.
 *
 * A client-reported number (`sessionClientPhone(ctx)`) is a CLAIM: anyone who
 * can open a session can send `?phone=<anyone>`. So it is used only when it is
 * one the owner listed; otherwise the owner's own number is. Never a number
 * nobody listed.
 */

import { normalizeE164 } from "./session-phone.ts";

/** `SMS_ALLOWED_PHONES` set to this allows any valid claimed number (testing only). */
const SMS_ALLOW_ANY = "*";

/**
 * The env this rule reads. Both optional so a `ctx.env` or a `stepEnv()` record
 * can be passed as is.
 *
 * @public
 */
export interface SmsRecipientEnv {
  /** The owner's own number: the default recipient, and implicitly allowed. */
  readonly SMS_TO_PHONE?: string | undefined;
  /**
   * More numbers a client may claim, comma-separated — or `*` for ANY valid number,
   * which makes the claim the whole check: for testing, never for a device on a
   * network strangers can reach.
   */
  readonly SMS_ALLOWED_PHONES?: string | undefined;
}

/**
 * The number an SMS may go to: `claimed` (normally `sessionClientPhone(ctx)`)
 * when its E.164 form equals `SMS_TO_PHONE` or one of the comma-separated
 * `SMS_ALLOWED_PHONES`, each normalized the same way (spaces, dashes, dots and
 * parentheses stripped; a `+` and 8–15 digits); otherwise `SMS_TO_PHONE` as
 * configured; `undefined` when neither applies.
 *
 * An unlisted claim is not an error, it is IGNORED: the text goes to the owner
 * instead, which is what a caller asking to be texted on a home device means.
 *
 * `SMS_ALLOWED_PHONES=*` turns the list off: any claim that is a valid E.164
 * number is used as is. That is the trust model `sessionClientPhone` warns
 * against, opted into by name — for trying a UI with several people's phones
 * before there is a way to verify one.
 *
 * @example
 * ```ts
 * import { allowedSmsRecipient } from "@alexkroman1/aai/channels";
 *
 * const env = { SMS_TO_PHONE: "+15555550100", SMS_ALLOWED_PHONES: "+1 (555) 555-0123" };
 * allowedSmsRecipient("+15555550123", env); // "+15555550123", listed
 * allowedSmsRecipient("+15555550199", env); // "+15555550100", the owner
 * ```
 *
 * @public
 */
export function allowedSmsRecipient(
  claimed: string | undefined,
  env: SmsRecipientEnv,
): string | undefined {
  const owner = env.SMS_TO_PHONE?.trim() || undefined;
  const claim = claimed === undefined ? undefined : normalizeE164(claimed);
  if (claim !== undefined) {
    if (env.SMS_ALLOWED_PHONES?.trim() === SMS_ALLOW_ANY) return claim;
    const listed = [owner, ...(env.SMS_ALLOWED_PHONES ?? "").split(",")];
    if (listed.some((n) => n !== undefined && normalizeE164(n.trim()) === claim)) return claim;
  }
  return owner;
}
