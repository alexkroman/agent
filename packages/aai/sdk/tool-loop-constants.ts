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
 * `host/transports/pipeline-llm-stream.ts`).
 *
 * **The forced step is what makes ANY cap safe, and the two must move
 * together.** Without it, hitting the cap ends the turn wherever it lands, so
 * the agent stops holding a half-answer and the caller hears nothing at all.
 * With it, a truncated chain still answers ("I found your order but couldn't
 * reach the returns system — want me to try again?"). Keep the forced step
 * whatever this number becomes.
 *
 * **10, and the measurement says it costs almost nothing.** Across 815 replies
 * in two tau2-bench retail runs, 28-33% of replies called a tool at all, and
 * among those the count was p50 **1**, p90 3, p99 5-6 — so the cap is not what
 * shapes ordinary turns either way, and exactly one reply of 815 ever reached
 * 10. A lower cap was tried (3) on the reasoning that it covers p90 outright;
 * the tail it truncates is the chain-heavy domain, where a step limit turns a
 * completable task into a half-answer, and the forced final step makes that
 * degradation quiet rather than absent. What the one 10-step reply shows is
 * the real failure mode: it made 7 consecutive tool calls with no speech
 * between them, so what the caller experienced was DEAD AIR (see
 * `DEFAULT_DEAD_AIR_COVER_MS`), not a step limit. Tune the silence, not the
 * cap; the real constraint on a long chain is caller patience.
 *
 * S2S enforces the same cap service-side by refusing tool calls past it, where
 * no forced final step is possible.
 */
export const DEFAULT_MAX_STEPS = 10;

/** Default `toolChoice`: the LLM decides when to call tools vs respond directly. */
export const DEFAULT_TOOL_CHOICE = "auto" as const;
