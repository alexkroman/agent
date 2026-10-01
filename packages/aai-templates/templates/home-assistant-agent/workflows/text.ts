import type { StepOptions } from "@alexkroman1/aai";
import { stepTextOwner } from "@alexkroman1/aai/step";

// A run's result by text, for a run that texts it only when asked (research.ts). The
// speaker still says the answer either way.
//
// The SDK's stepTextOwner is the text_me builtin's rule from a step: the client's number
// is only a CLAIM (anyone who can open a session could name any number), used only when
// it is SMS_TO_PHONE or listed in SMS_ALLOWED_PHONES, else the owner gets it; a refusal that will refuse again is an
// answer, a transient one is thrown for the step to retry, and a recipient with no
// TEXTBELT_KEY is thrown FATAL (a retry can't set it).

/** A retried text is a second text: few attempts, unlike the announcement's. */
export const TEXT_STEP = { maxAttempts: 3 } satisfies StepOptions;

/**
 * How the result went by text. Not sent is not a failed run: the answer is written and
 * the speaker still says it, with the reason the text didn't go.
 */
export type Texted = { sent: true } | { sent: false; why?: string };

/**
 * Text `report` to the owner (or the claimed `phone`, when listed). Links out: Textbelt
 * refuses a text with one until the key is verified for links. The number it went to is
 * dropped: this is journaled and in the run's output, which the page shows.
 */
export async function textOwner(phone: string | undefined, report: string): Promise<Texted> {
  const texted = await stepTextOwner(report, { phone, links: "strip" });
  return texted.sent ? { sent: true } : texted;
}
