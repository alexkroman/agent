// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepTextOwner` — the `text_me` builtin's rule, from a workflow step: text the
 * OWNER something, over Textbelt, on the agent's own `TEXTBELT_KEY`.
 *
 * A run that reports by text (a research report, an app job's answer) wrote the
 * same fifteen lines the builtin already holds: pick the recipient with
 * `allowedSmsRecipient` from the step env, build a `textbeltChannel`, send, and
 * turn a refusal that will refuse again into an answer while a transient one
 * is thrown for the step to retry. A copy that forgets the recipient rule
 * points the owner's key at whatever number a client claimed.
 *
 * **Not sent is not a failed run.** The step's result says whether the text
 * went and, when it did not, a reason a person can hear — so the body still
 * says its answer on the speaker, with why the text didn't follow. Only what a
 * retry could fix is thrown.
 *
 * It must still run INSIDE a step (`ctx.step(name, () => stepTextOwner(…))`),
 * and with few attempts: a retried text after a lost answer is a second text.
 */

import { missingEnvMessage } from "./_missing-env.ts";
import {
  SMS_ALLOWED_PHONES_ENV,
  SMS_TO_PHONE_ENV,
  TEXTBELT_KEY_ENV,
  TEXTBELT_LINKS_ENV,
  textbeltLinksFromEnv,
} from "./_owner-text-env.ts";
import { throwFatalStepError, throwStepError } from "./_step-verdict.ts";
import { ChannelDeliveryError } from "./channels/shared/channel-types.ts";
import { sendToChannel } from "./channels/shared/send.ts";
import { stripLinks, textbeltChannel } from "./channels/textbelt.ts";
import { allowedSmsRecipient } from "./sms-recipient.ts";
import { spokenErrorReason } from "./spoken-error-reason.ts";
import { stepEnv } from "./step-env.ts";

/**
 * Options for {@link stepTextOwner}.
 *
 * @public
 */
export type StepTextOwnerOptions = {
  /**
   * The number the client CLAIMED (`sessionClientPhone(ctx)`, carried in the
   * run's input). Used only when the owner listed it (`SMS_TO_PHONE` or
   * `SMS_ALLOWED_PHONES`); otherwise the text goes to `SMS_TO_PHONE`.
   */
  phone?: string | undefined;
  /**
   * `"strip"` leaves every link out, for a key Textbelt has not yet allowed
   * links. Defaults to the agent env's `TEXTBELT_LINKS`, as `text_me` reads it.
   */
  links?: "keep" | "strip" | undefined;
};

/**
 * What {@link stepTextOwner} resolves: sent, to whom — or not, and when there is
 * one, a reason a person can hear. `why` is absent when texting is simply not
 * set up (no `SMS_TO_PHONE`).
 *
 * `to` is personal data, and a step's result is JOURNALED: return what the
 * body needs from it rather than the whole result when the run's output is
 * shown to anyone but the owner.
 *
 * @public
 */
export type StepTextOwnerResult = { sent: true; to: string } | { sent: false; why?: string };

/**
 * Text the owner `text`, choosing the number exactly as the `text_me` builtin
 * does, from the step env (`TEXTBELT_KEY`, `SMS_TO_PHONE`,
 * `SMS_ALLOWED_PHONES`, `TEXTBELT_LINKS`).
 *
 * - No recipient (no `SMS_TO_PHONE`, no listed claim): `{ sent: false }`.
 * - A refusal that will refuse again (a bad number, no credit, a link on a key
 *   not allowed links), or a text that was only links on such a key:
 *   `{ sent: false, why }`.
 * - A transient failure (a 5xx, a 429, no answer): thrown, classified for the
 *   step's retry as `throwStepError` classifies it.
 * - A recipient but no `TEXTBELT_KEY`: thrown FATAL, naming the key — the
 *   owner asked for texts and a retry cannot set it.
 *
 * @example
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai";
 * import { stepTextOwner } from "@alexkroman1/aai/step";
 *
 * export async function reportFlow(input: { phone?: string; report: string }, ctx: WorkflowContext) {
 *   const texted = await ctx.step(
 *     "text",
 *     () => stepTextOwner(input.report, { phone: input.phone }),
 *     { maxAttempts: 3 },
 *   );
 *   return { texted: texted.sent };
 * }
 * ```
 *
 * @public
 */
export async function stepTextOwner(
  text: string,
  options: StepTextOwnerOptions = {},
): Promise<StepTextOwnerResult> {
  const to = allowedSmsRecipient(options.phone, {
    SMS_TO_PHONE: stepEnv(SMS_TO_PHONE_ENV),
    SMS_ALLOWED_PHONES: stepEnv(SMS_ALLOWED_PHONES_ENV),
  });
  if (to === undefined) return { sent: false };
  const key = stepEnv(TEXTBELT_KEY_ENV)?.trim();
  if (!key) return throwFatalStepError(new Error(missingEnvMessage(TEXTBELT_KEY_ENV)));
  const links = options.links ?? textbeltLinksFromEnv(stepEnv(TEXTBELT_LINKS_ENV));
  if ((links === "strip" ? stripLinks(text) : text.trim()) === "") {
    return {
      sent: false,
      why:
        links === "strip"
          ? "the text was only links, and this Textbelt key can't send links yet"
          : "there was nothing to text",
    };
  }
  try {
    await sendToChannel(textbeltChannel({ key, to, links }), { text });
    return { sent: true, to };
  } catch (err: unknown) {
    if (err instanceof ChannelDeliveryError && !err.retryable) {
      return { sent: false, why: spokenErrorReason(err) };
    }
    return throwStepError(err);
  }
}
