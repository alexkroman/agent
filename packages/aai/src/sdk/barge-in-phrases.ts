// Copyright 2026 the AAI authors. MIT license.
/**
 * The two phrase lists that sit ON TOP of the barge-in thresholds, and the one
 * classifier both are read through.
 *
 * `DEFAULT_MIN_BARGE_IN_WORDS` (1) and `DEFAULT_INTERRUPTION_MIN_DURATION_MS`
 * (500) answer "is this enough speech to be an interruption" with a word count
 * and a stopwatch. Neither can see WHAT was said, and that is the whole gap
 * these lists close — at a threshold of 1 word, "mm-hmm" and "stop" are the
 * same event to both gates, and they are opposite events to the caller.
 *
 * Two lists, deliberately not one scale (Vapi ships exactly this pair):
 *
 * - {@link DEFAULT_ACKNOWLEDGEMENT_PHRASES} NEVER interrupts, even when both
 *   thresholds are met. A backchannel is the caller telling the agent to KEEP
 *   GOING; aborting the reply is the one response that cannot be right.
 * - {@link DEFAULT_INTERRUPTION_PHRASES} ALWAYS interrupts, regardless of
 *   either threshold. "Stop" is one word and can be under 500ms, so both gates
 *   decline it, and it is the single utterance most certain to mean "yield".
 *
 * **The asymmetry between "yes" and "no" is deliberate and must be kept.**
 * "Yes" is in the acknowledgement list and "no" is in the interruption list,
 * so one never interrupts and the other always does. That reads like an
 * oversight and is not: a caller saying "yes" over the agent is agreeing with
 * a sentence still being spoken, and a caller saying "no" over it is
 * correcting one. The cost of getting each wrong is asymmetric too — a missed
 * "yes" costs nothing, a missed "no" lets the agent finish acting on something
 * the caller has just refused.
 *
 * ## Matching is NOT the same on the two lists
 *
 * - **Acknowledgement matches the WHOLE utterance.** "Okay" is a backchannel;
 *   "okay so I need to change my order" is a turn, and a substring rule would
 *   have swallowed it. So the normalized transcript must EQUAL a listed
 *   phrase.
 * - **Interruption matches ANYWHERE, as whole words.** "No, stop" and "yeah
 *   actually no" both have to fire, and neither equals a listed phrase.
 *
 * Both sides normalize first ({@link normalizeBargeInText}): lowercased,
 * apostrophes dropped so "I'm listening" reaches `im listening`, and every
 * other non-alphanumeric run — the hyphens in "uh-huh" and "mm-hmm" included —
 * becomes a single space. So a transcript is compared word by word and the
 * ASR's punctuation choices do not decide whether the agent yields.
 *
 * ## Precedence, and what is unmeasured
 *
 * Interruption is checked FIRST. "Okay stop" contains an acknowledgement token
 * and is not an acknowledgement.
 *
 * **Both lists ship ON and neither is measured on this corpus.** They are
 * Vapi's published production defaults, and the case for them here is the
 * measured gap above rather than a run of our own. The instrument that would
 * settle them is the tau-voice S_BC backchannel-selectivity metric together
 * with the give-up-probe rate per call (`DEFAULT_MIN_BARGE_IN_WORDS` carries
 * both and why S_BC has been too sparse to read). The revert condition is
 * explicit: **give-up probes rising** means the acknowledgement list is
 * swallowing real turns, and **aborted-turn count rising** means the
 * interruption list is firing on ASR noise. Pass `acknowledgementPhrases: []`
 * or `interruptionPhrases: []` to switch either off.
 *
 * @module
 */

/**
 * Phrases that NEVER interrupt the agent, even when the barge-in thresholds
 * are met. Matched against the WHOLE normalized utterance — see the module
 * doc.
 *
 * Vapi's published production list, verbatim.
 *
 * @internal
 */
export const DEFAULT_ACKNOWLEDGEMENT_PHRASES: readonly string[] = [
  "i understand",
  "i see",
  "i got it",
  "i hear you",
  "im listening",
  "im with you",
  "right",
  "okay",
  "ok",
  "sure",
  "alright",
  "got it",
  "understood",
  "yeah",
  "yes",
  "uh-huh",
  "mm-hmm",
  "gotcha",
  "mhmm",
  "ah",
  "yeah okay",
  "yeah sure",
];

/**
 * Phrases that ALWAYS interrupt the agent, regardless of `minBargeInWords` and
 * `interruptionMinDurationMs`. Matched as a whole-word run ANYWHERE in the
 * utterance — see the module doc.
 *
 * Vapi's published production list, verbatim. Two things about it are worth
 * knowing before editing it:
 *
 * - **"shut" and "up" are separate entries**, which is how the source list has
 *   them. So "hang up" fires this rule. That is a false positive on paper and
 *   close to harmless in practice — the caller saying "hang up" wants the
 *   floor — but it is the shape to check before adding a short word.
 * - **This list BYPASSES the sustained-speech gate**, which is the only thing
 *   standing between the agent and a one-word ASR artefact
 *   (`DEFAULT_INTERRUPTION_MIN_DURATION_MS` carries that measurement). What
 *   makes that survivable is `resumeFalseInterruption`, which resumes a reply
 *   aborted by a partial that never commits a final.
 *
 * @internal
 */
export const DEFAULT_INTERRUPTION_PHRASES: readonly string[] = [
  "stop",
  "shut",
  "up",
  "enough",
  "quiet",
  "silence",
  "but",
  "dont",
  "not",
  "no",
  "hold",
  "wait",
  "cut",
  "pause",
  "nope",
  "nah",
  "nevermind",
  "never",
  "bad",
  "actually",
];

/**
 * Lowercase, drop apostrophes, and reduce every other non-alphanumeric run to
 * one space.
 *
 * Apostrophes are DROPPED rather than spaced so "I'm listening" reaches
 * `im listening` — which is the spelling the phrase list carries, because an
 * ASR's apostrophes are its own choice. Hyphens become spaces so "uh-huh" and
 * "uh huh" are one phrase.
 *
 * @internal
 */
export function normalizeBargeInText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalized tokens of `text`; `[]` for an utterance with no words. @internal */
function tokens(text: string): readonly string[] {
  const normalized = normalizeBargeInText(text);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Does `haystack` contain `needle` as a contiguous run of whole words? */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * What a phrase list says about one utterance.
 *
 * `"none"` is the ordinary answer and means "the thresholds decide", which is
 * what makes an empty pair of lists byte-identical to the behaviour before
 * they existed.
 *
 * @internal
 */
export type BargeInPhraseVerdict = "interrupt" | "acknowledge" | "none";

/**
 * Classify an utterance against the two lists.
 *
 * Interruption is checked first (see the module doc). An empty list is
 * skipped, so `{ acknowledgement: [], interruption: [] }` always answers
 * `"none"`.
 *
 * @internal
 */
export function classifyBargeInPhrase(
  text: string,
  lists: {
    acknowledgement: readonly string[];
    interruption: readonly string[];
  },
): BargeInPhraseVerdict {
  const words = tokens(text);
  if (words.length === 0) return "none";
  for (const phrase of lists.interruption) {
    if (containsRun(words, tokens(phrase))) return "interrupt";
  }
  const whole = words.join(" ");
  for (const phrase of lists.acknowledgement) {
    if (normalizeBargeInText(phrase) === whole) return "acknowledge";
  }
  return "none";
}
