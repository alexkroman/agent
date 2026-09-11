// Copyright 2026 the AAI authors. MIT license.
/**
 * What to do with a committed transcript the recognizer is not sure of — the
 * BAND between "good enough to act on" and "not worth hearing".
 *
 * A pipeline agent had two outcomes for a final transcript: run the turn, or
 * (for an empty string only) drop it. Everything else went to the model at face
 * value, which is how a mis-heard order id or email becomes a tool-call
 * argument and then poisons every later step of the call — the transcript reads
 * fluently, the tool call is well-formed, and nothing anywhere reports a
 * problem. The recognizer's own confidence is the one signal available BEFORE
 * the model sees the words, and acting on it is strictly cheaper than
 * unwinding a wrong order lookup three turns later.
 *
 * Three bands, two numbers:
 *
 * | Confidence | Verdict |
 * | --- | --- |
 * | below {@link LowConfidencePolicy.discardBelow} | `discard` — the words never reach the model |
 * | below {@link LowConfidencePolicy.actionBelow} | `clarify` or `note`, per {@link LowConfidencePolicy.action} |
 * | at or above it | `accept` — today's behaviour, unchanged |
 *
 * **It is OFF unless an agent declares it**, and the reason is the one this
 * repo applies to every other voice default: the band's numbers are Vapi's
 * published defaults (`confidenceThreshold` 0.4, a 0.2-wide action band under
 * it), measured on their stack and not on ours, and the statistic they are
 * measured against is not the one AssemblyAI streaming reports. Turning it on
 * for every agent on that footing would trade a silent wrong answer for a
 * silent extra question. `lowConfidence: {}` opts in at those defaults; every
 * number is then an author knob.
 *
 * **`undefined` confidence is ACCEPT, never zero.** A provider that reports
 * nothing has no opinion — `deepgramStt`, `sonioxStt` and `elevenLabsStt`
 * report no per-word confidence through this seam at all — and reading silence
 * as "bad" would make the policy discard every turn on three of four
 * providers.
 */

/** The clarification an agent speaks when a turn lands in the action band. */
export const DEFAULT_LOW_CONFIDENCE_PHRASE =
  "I'm sorry, I didn't quite catch that. Could you please repeat?";

/**
 * The note appended to the MODEL's copy of a low-confidence turn under
 * `action: "note"`.
 *
 * Written as an observation rather than an instruction to re-ask: the model is
 * mid-conversation and knows whether the turn carried an identifier worth
 * confirming, which this note does not. It names the failure it is warning
 * about — mis-heard identifiers — because "low confidence" alone reads as
 * "the caller was vague".
 */
export const DEFAULT_LOW_CONFIDENCE_NOTE =
  "low-confidence transcript: some words may be mis-heard — confirm any names, numbers or identifiers with the caller before acting on them";

/** Below this the transcript is dropped outright. Vapi's implied floor. */
export const DEFAULT_LOW_CONFIDENCE_DISCARD_BELOW = 0.2;

/** Below this (and at or above the floor) the policy's action fires. */
export const DEFAULT_LOW_CONFIDENCE_ACTION_BELOW = 0.4;

/**
 * What the agent does with a transcript in the action band.
 *
 * - `clarify` — SPEAK {@link LowConfidencePolicy.phrase} and run no turn. The
 *   words reach neither the model nor history, exactly like the failure phrases
 *   (see `AgentTranscriptRecovery`): a garbage transcript in the record is a
 *   garbage transcript the model can still act on two turns later.
 * - `note` — run the turn, with {@link LowConfidencePolicy.note} appended to
 *   the MODEL's copy of the transcript only. The caller's caption and the
 *   session record stay verbatim, the rule `assembleSpelledRuns` already
 *   follows: what the caller said is not ours to rewrite.
 */
export type LowConfidenceAction = "clarify" | "note";

/**
 * Which number the bands are compared against.
 *
 * - `mean` — the mean of the turn's per-word confidences. The transcript-level
 *   reading Vapi's published thresholds were chosen against, and the
 *   conservative one: a single soft word in a long sentence does not fire it.
 * - `minWord` — the LOWEST per-word confidence in the turn. The
 *   entity-sensitive reading, and the one that matches the failure this policy
 *   exists for — one mis-heard digit in an otherwise clean sentence. It fires
 *   far more often at the same thresholds, so an agent choosing it should
 *   expect to lower them.
 *
 * Which is right here is an open MEASUREMENT, not a preference; `mean` is the
 * default because it is the one the published numbers belong to.
 */
export type LowConfidenceStatistic = "mean" | "minWord";

/**
 * Act on the recognizer's confidence in a committed turn. Pipeline mode only.
 *
 * @public
 */
export interface LowConfidencePolicy {
  /**
   * Confidence below which the transcript is DROPPED — no turn, no caption
   * commit, no clarification. Treated as noise the caller did not mean.
   *
   * @defaultValue `0.2` (`DEFAULT_LOW_CONFIDENCE_DISCARD_BELOW`)
   */
  discardBelow?: number | undefined;
  /**
   * Confidence below which {@link action} fires (and at or above
   * {@link discardBelow}). At or above this the turn runs exactly as it does
   * today.
   *
   * @defaultValue `0.4` (`DEFAULT_LOW_CONFIDENCE_ACTION_BELOW`)
   */
  actionBelow?: number | undefined;
  /**
   * What to do in that band.
   *
   * @defaultValue `"clarify"`
   */
  action?: LowConfidenceAction | undefined;
  /**
   * Spoken under `action: "clarify"`. Set `""` to speak nothing — the turn is
   * still dropped, which is `discardBelow` widened rather than a third mode.
   *
   * @defaultValue `DEFAULT_LOW_CONFIDENCE_PHRASE`
   */
  phrase?: string | undefined;
  /**
   * Appended to the model's copy under `action: "note"`.
   *
   * @defaultValue `DEFAULT_LOW_CONFIDENCE_NOTE`
   */
  note?: string | undefined;
  /**
   * Which per-turn statistic the bands read.
   *
   * @defaultValue `"mean"`
   */
  statistic?: LowConfidenceStatistic | undefined;
}

/** A {@link LowConfidencePolicy} with every default applied. @internal */
export interface ResolvedLowConfidence {
  discardBelow: number;
  actionBelow: number;
  action: LowConfidenceAction;
  phrase: string;
  note: string;
  statistic: LowConfidenceStatistic;
}

/** Apply the documented default for every field. @internal */
export function resolveLowConfidence(policy: LowConfidencePolicy): ResolvedLowConfidence {
  return {
    discardBelow: policy.discardBelow ?? DEFAULT_LOW_CONFIDENCE_DISCARD_BELOW,
    actionBelow: policy.actionBelow ?? DEFAULT_LOW_CONFIDENCE_ACTION_BELOW,
    action: policy.action ?? "clarify",
    phrase: policy.phrase ?? DEFAULT_LOW_CONFIDENCE_PHRASE,
    note: policy.note ?? DEFAULT_LOW_CONFIDENCE_NOTE,
    statistic: policy.statistic ?? "mean",
  };
}

/** What a classified transcript may become. @internal */
export type LowConfidenceVerdict =
  | { kind: "accept" }
  | { kind: "discard"; confidence: number }
  | { kind: "clarify"; confidence: number; phrase: string }
  | { kind: "note"; confidence: number; note: string };

/**
 * Classify one committed transcript against a resolved policy.
 *
 * `confidence` is the statistic the policy names, already selected by the
 * caller — `undefined` when the provider reported none, which is ACCEPT.
 *
 * The floor is checked first and the comparisons are strict `<`, so a policy
 * whose two numbers are equal has no action band at all (everything under the
 * floor is discarded) rather than an inverted one.
 *
 * @internal
 */
export function classifyConfidence(
  confidence: number | undefined,
  policy: ResolvedLowConfidence,
): LowConfidenceVerdict {
  if (confidence === undefined || !Number.isFinite(confidence)) return { kind: "accept" };
  if (confidence < policy.discardBelow) return { kind: "discard", confidence };
  if (confidence >= policy.actionBelow) return { kind: "accept" };
  return policy.action === "note"
    ? { kind: "note", confidence, note: policy.note }
    : { kind: "clarify", confidence, phrase: policy.phrase };
}
