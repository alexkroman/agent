// Copyright 2026 the AAI authors. MIT license.
/**
 * The `listen_for` builtin: bias the recognizer toward words the caller is
 * about to say.
 *
 * Its own module rather than a block in `builtin-tools.ts` — that file is at
 * the 500-line cap — and because the interesting part is not the tool but the
 * FILTER below, which needs somewhere to be argued and tested.
 */

import { z } from "zod";

import type { ToolDef } from "../sdk/tool-def.ts";

const listenForParams = z.object({
  terms: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe(
      "Words a PERSON WILL SAY OUT LOUD, spelled the way they should be " +
        "transcribed: a caller's name, an order number, a product. Never a " +
        "username, login, email or database id, and no leading '#'.",
    ),
});

/** What {@link spokenTerms} kept, and what it refused. */
export type SpokenTerms = { kept: string[]; dropped: string[] };

/**
 * Keep only the terms a caller could plausibly SAY.
 *
 * **This is a filter rather than a prompt rule because the prompt rule did not
 * hold.** Measured on a graded tau2-bench retail run with the tool live: of
 * ~25 terms the model passed, roughly six were sayable. The rest were the
 * fields a lookup result happens to contain — `yusuf_rossi_9620` and
 * `mei_kovacs_8020` (login ids), and `#W6390527` (an order number carrying the
 * written `#`). Both descriptions already said "the caller will say back";
 * the model reached for the field literally named `user_id` anyway, because
 * that is what the tool result handed it.
 *
 * Neither shape can ever match a transcript — a recognizer hears "Yusuf
 * Rossi", never "yusuf underscore rossi underscore nine six two zero" — so
 * each one spends a slot of a capped list to bias nothing.
 *
 * Two rules, and the asymmetry between them is deliberate:
 *
 * - A leading `#` is STRIPPED, not refused. "#W6390527" is the right value
 *   written the wrong way, and the agent's own prompt rules tell it to write
 *   an id with the "#" dropped — so repairing it keeps a good term.
 * - A token containing `_` or `@` is DROPPED. There is no repair: a login id
 *   is a different string from the name it was derived from, and guessing
 *   "Yusuf Rossi" out of `yusuf_rossi_9620` would bias toward a name the
 *   record may not even hold.
 *
 * What is deliberately NOT filtered is a bare digit run: a caller really does
 * read out an item number, a ZIP or the last four of a card, and the spelling
 * rules in the default prompt treat those as identifiers for that reason.
 */
export function spokenTerms(terms: readonly string[]): SpokenTerms {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of terms) {
    const term = raw.trim().replace(/^#+/, "").trim();
    if (term.length === 0 || /[_@]/.test(term)) dropped.push(raw);
    else kept.push(term);
  }
  return { kept, dropped };
}

/**
 * `listen_for` — the one builtin that changes what the agent HEARS rather
 * than what it does, and the only one whose moment the model is uniquely
 * placed to spot: a lookup has just returned a name, and the caller is about
 * to confirm or repeat it.
 */
export function createListenFor(): ToolDef<typeof listenForParams> & { guidance: string } {
  return {
    guidance:
      "The moment a tool result gives you a name, an order number or a product THE CALLER WILL " +
      "SAY ALOUD, call listen_for with those exact words. Pass what a person pronounces — never " +
      "a username, login, email or database id, even when that is the field the result gave " +
      "you, and never a value you are about to say rather than hear. It costs nothing and " +
      "makes the next thing you hear more likely to be right. Do not re-send terms you have " +
      "already sent.",
    description:
      "Tell the speech recognizer to expect specific words for the rest of the call — a " +
      "caller's name, an order number, a product — so they transcribe correctly when spoken. " +
      "Use it right after a lookup returns a value the caller will say or confirm. Pass only " +
      "what a person says out loud, never a username or database id. It does not speak, read, " +
      "or change anything.",
    inputSchema: listenForParams,
    execute(args, ctx) {
      // Filtered BEFORE the capability, so a model that hands over the wrong
      // field spends no session slot on it and is told which value was
      // refused — the one thing that can teach it the difference mid-call.
      const { kept, dropped } = spokenTerms(args.terms);
      if (kept.length === 0) {
        return {
          listening_for: [],
          detail:
            `Nothing here is a spoken value: ${dropped.join(", ")}. Pass the words the ` +
            "caller says — their name, the order number — not the ids a record stores them under.",
        };
      }
      // The capability reports whether the hint reached a recognizer at all
      // (S2S runs recognition service-side, and a stopped session has none),
      // and the model is told plainly rather than left to assume it worked.
      const applied = ctx.steerRecognizer(kept);
      if (!applied) {
        return {
          listening_for: [],
          detail: "This session's recognizer cannot be steered. Carry on without it.",
        };
      }
      return dropped.length === 0
        ? { listening_for: kept }
        : {
            listening_for: kept,
            detail: `Ignored, not spoken aloud: ${dropped.join(", ")}.`,
          };
    },
  };
}
