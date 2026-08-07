// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM tool-loop defaults: how many tool-calling steps a reply may spend,
 * and how the model chooses tools within them.
 *
 * Split out of `constants.ts` for file-length reasons, like
 * `endpointing-constants.ts` and `pipeline-tuning-constants.ts`; both names
 * are re-exported from `constants.ts`, so the import path is unchanged.
 * They live together because they are the two halves of one question and the
 * forced final step overrides the second to enforce the first.
 */

/**
 * Max TOOL-CALLING steps per reply — bounds runaway tool loops.
 *
 * Matches LiveKit's `max_tool_steps`. The cap bounds tool steps only: on
 * reaching it the pipeline spends ONE more step with `toolChoice: "none"`, so
 * the model must produce speech (`forceFinalAnswer` in
 * `host/transports/pipeline-stream.ts`).
 *
 * **That forced step is what makes a low cap safe, and the two must move
 * together.** The measured objection to lowering this was never the number —
 * it was that hitting the cap ended the turn wherever it landed, so the agent
 * stopped holding a half-answer and the caller heard nothing at all. With the
 * forced step, a truncated chain still answers ("I found your order but
 * couldn't reach the returns system — want me to try again?"), which beats
 * both silence and a tenth tool call.
 *
 * The tail given up is thin, and comes from the same measurement that once
 * justified 10: across 815 replies in two tau2-bench retail runs, 28-33% of
 * replies called a tool at all, and among those the count was p50 **1**, p90
 * 3, p99 5-6. So 3 covers p90 outright, and exactly one reply of 815 ever
 * reached 10 — that reply made 7 consecutive tool calls with no speech
 * between them, so what the caller experienced was dead air (see
 * `DEFAULT_DEAD_AIR_COVER_MS`), not a step limit. Raise it per agent
 * (`agent({ maxSteps })`) for a genuinely chain-heavy domain; the real
 * constraint on a long chain is caller patience, not step count.
 *
 * S2S enforces the same cap service-side by refusing tool calls past it
 * (`host/session-core.ts`), where no forced final step is possible.
 */
export const DEFAULT_MAX_STEPS = 3;

/** Default `toolChoice`: the LLM decides when to call tools vs respond directly. */
export const DEFAULT_TOOL_CHOICE = "auto" as const;
