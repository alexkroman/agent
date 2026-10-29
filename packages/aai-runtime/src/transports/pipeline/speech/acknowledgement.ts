// Copyright 2026 the AAI authors. MIT license.
/**
 * Is this utterance only the caller ACKNOWLEDGING — "mm-hmm", "yeah, right",
 * "exactly" — rather than taking the floor?
 *
 * Content, where the rest of the barge-in rules are deliberately content-blind,
 * because the content-blind signal for it does not survive the default STT.
 * `dropsBriefFinal` separates a backchannel from an answer by its words' span
 * (`SttTurnMeta.spokenMs`), but on `universal-3-5-pro` that span starts at the
 * turn window, not at speech: "Mm-hmm, yeah." spoken over ~1s reported 2462ms.
 * So every backchannel read as long speech. On Full-Duplex-Bench v1.5
 * (run `v15-silence400`) all 92 backchannels spoken over a reply cut it ~0.3s
 * in, were committed as a turn, and the answer restarted or went vague
 * (C_UNKNOWN 27%).
 *
 * Over those runs, 88 of 98 committed backchannels were acknowledgement-only by
 * this list, and 0 of 200 committed interruptions were. Two shapes are
 * deliberately NOT acknowledgements: a question ("really?" is still listed —
 * it is rhetorical far more often than not, and the agent finishing its
 * sentence answers it), and anything carrying content ("yeah, but…"), which
 * is a turn by the time a non-listed word arrives.
 *
 * The cost is the one `dropsBriefFinal` already accepts: a genuine "yes" spoken
 * over a question the agent is STILL asking is not a turn. The agent finishes
 * the question, and the caller answers it again. A "yes" whose final lands once
 * the agent has stopped — spoken over the question's last word, committed by
 * endpointing after it — is the answer, and commits (`dropsAcknowledgementFinal`
 * in `stt-handlers.ts`).
 */

/** Lowercased tokens that, alone or together, are only acknowledgement. */
const ACKNOWLEDGEMENT_TOKENS: ReadonlySet<string> = new Set([
  "mm-hmm",
  "mhm",
  "mm",
  "hmm",
  "uh-huh",
  "uh",
  "um",
  "ah",
  "aha",
  "oh",
  "ooh",
  "yeah",
  "yes",
  "yep",
  "yup",
  "right",
  "sure",
  "okay",
  "ok",
  "alright",
  "all",
  "exactly",
  "totally",
  "absolutely",
  "definitely",
  "indeed",
  "true",
  "agreed",
  "got",
  "gotcha",
  "it",
  "i",
  "see",
  "cool",
  "nice",
  "great",
  "wow",
  "really",
  "interesting",
  "haha",
  "ha",
]);

/** More words than this is a sentence, whatever they are. */
const MAX_ACKNOWLEDGEMENT_WORDS = 4;

/** True when `text` holds 1-4 words and every one is an acknowledgement token. */
export function isAcknowledgementOnly(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z'-]+/)
    .map((t) => t.replace(/^[-']+|[-']+$/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_ACKNOWLEDGEMENT_WORDS) return false;
  return tokens.every((t) => ACKNOWLEDGEMENT_TOKENS.has(t));
}
