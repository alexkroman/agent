// Copyright 2026 the AAI authors. MIT license.
/**
 * The FAST/SLOW two-tier declaration — a cheap model holds the call while an
 * expensive one does the work.
 *
 * The shape is Pine AI's TalkAct (19PINE-AI/TalkAct), whose problem statement
 * is the one a voice agent with tools always has: a frontier model driving a
 * task takes seconds per step (they measure p50 4.2s, p90 6.0s) and natural
 * conversation wants a reply inside one. One model cannot do both, so TalkAct
 * splits them and reports p50 **0.63s** against **10.89s** for the same model
 * doing both jobs, at 8/8 task success either way.
 *
 * ## The three couplings, and where each one lands here
 *
 * - **The STATE DIGEST.** TalkAct's slow tier attaches a mandatory
 *   `state_summary` argument to *every* action, which keeps the fast tier
 *   grounded "at zero extra model calls". Here it is the same mechanism — an
 *   argument on every slow-tier tool call — rendered into the fast tier's
 *   system prompt as a suffix, which is the seam `dialog()` already uses.
 * - **The CHANNEL.** `ask_user` / `tell_user`, which TalkAct carries on two
 *   asyncio queues because its fast agent is the only thing that hears or
 *   speaks. Neither is true in this runtime: slow→fast is `injectTurn` (the
 *   verb that already existed for "a durable run finished, tell the caller"),
 *   and fast→slow is the session's own transcript, relayed unconditionally. No
 *   second channel exists to drift from the first. Their ablation says this is
 *   the half that carries task success: with the fast→slow channel removed,
 *   **0/4**.
 * - **DIGEST-GATED COMPLETION** — see {@link TwoTierConfig.completionGate}.
 *
 * ## The fast tier gets NO tools, and that is the mutation gate
 *
 * Not "the fast tier is asked not to mutate" and not "its mutating calls are
 * reviewed": with `twoTier` declared, its request carries no tool list at all,
 * so the only tier that can change anything is the slow one — guaranteed by
 * the request rather than by a policy. That is also what makes a small
 * conversational model usable as the fast tier; several are tool-free by
 * capability, and this architecture wants exactly that.
 *
 * Which steps the slow tier must be most careful about is still the tool's own
 * declaration, never a heuristic over its name (`ToolDef.mutates`,
 * `ToolDef.completes`). That is SABER's decomposition (arXiv:2512.07850): each
 * additional deviation on a MUTATING step cuts the odds of success by up to 96%
 * on τ-bench Retail and up to 92% on Airline, while deviations on non-mutating
 * steps have little to no effect.
 *
 * ## It is OFF by default, and that is a measurement requirement
 *
 * Omit `twoTier` and every path behaves exactly as it did: one model, its own
 * tools, no digest, no second request, the same prompt bytes. That is not
 * caution — a feature that cannot be switched off inside one build cannot be
 * A/B'd against the single-tier path in the same session, and every published
 * number this design draws on is either single-trial or measured against a
 * different user simulator than ours.
 *
 * @see {@link TwoTierConfig}
 */

import type { LlmProvider } from "./providers.ts";

/**
 * How much thinking the slow tier is given.
 *
 * A FIRST-CLASS knob rather than a constant, because the one published
 * ablation on a second reasoning tier of this shape (Pickle's tool-mentor)
 * attributes its gain to the supervisor's reasoning BUDGET rather than to its
 * prompt wording — a full round of prompt iteration was worth net one task.
 * Their numbers are single-trial under their own churn caveat and are not
 * quoted here as an effect size; what survives is the design hint, which is
 * cheap to honour: make the budget settable, and do not expect prompt tuning
 * to carry the feature.
 *
 * Passed to the provider as its own reasoning option, spelled per family. A
 * provider with no such option ignores it, which is why this is a HINT. An
 * effort set on the descriptor itself — `assemblyAILlm({ reasoningEffort })` —
 * is applied when the model is built and is the precise form.
 *
 * @public
 */
export type SlowTierEffort = "minimal" | "low" | "medium" | "high";

/**
 * The FAST/SLOW two-tier configuration — see this module's header.
 *
 * The fast tier is `agent({ llm })`, unchanged and unnamed here: whatever the
 * agent already talks on is the tier that holds the call, minus its tools. Only
 * the second one needs declaring, which is what keeps this additive.
 *
 * @example A tool-free conversational model in front of a careful one
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { assemblyAILlm } from "@alexkroman1/aai/llm";
 *
 * export default agent({
 *   name: "orders-desk",
 *   llm: assemblyAILlm({ model: "qwen3.5-4b-32k-fast", reasoningEffort: "none" }),
 *   twoTier: {
 *     llm: assemblyAILlm({ model: "gpt-5.6-luna" }),
 *     effort: "high",
 *   },
 * });
 * ```
 *
 * @public
 */
export interface TwoTierConfig {
  /**
   * The slow tier's model.
   *
   * @defaultValue the agent's own `llm` — which makes the declaration a pure
   * ARCHITECTURE change rather than also a model change, and is the arm to run
   * when you want to know which of the two a difference came from.
   */
  llm?: LlmProvider | string;
  /**
   * The slow tier's reasoning budget — see {@link SlowTierEffort}.
   *
   * @defaultValue `"high"` (`DEFAULT_SLOW_TIER_EFFORT`)
   */
  effort?: SlowTierEffort;
  /**
   * How long one slow-tier RUN may take before it is abandoned.
   *
   * @defaultValue `15000` (`DEFAULT_SLOW_TIER_TIMEOUT_MS`)
   *
   * **Nobody waits for this, and that is the point.** The slow tier runs
   * detached from every turn, so a run that overruns costs a STALE DIGEST —
   * the fast tier keeps talking from the last summary it was given — and never
   * a silent caller. There is deliberately no fail-open/fail-closed policy
   * beside it: failing open is what the architecture DOES, structurally,
   * because the caller's turn never awaited the slow tier in the first place.
   * A knob for it would be a setting with nothing to set.
   *
   * What the bound buys is that a wedged provider does not hold the run slot
   * forever, so the next caller utterance still gets a fresh run. An abandoned
   * run's in-flight work is settled as failed on its way out, which is what
   * keeps {@link TwoTierConfig.completionGate} from wedging behind it.
   */
  timeoutMs?: number;
  /**
   * Refuse a `completes` tool while the digest still holds work that has not
   * settled — DIGEST-GATED COMPLETION.
   *
   * @defaultValue `true`
   *
   * This is the half of TalkAct's contract that was a prompt rule there
   * ("never claim the task is done unless the computer agent state explicitly
   * says so", written after early versions "hallucinated 'it's submitted!' and
   * hung up") and is a refusal here. It is aimed at a failure mode this repo
   * has measured by name on tau2: the agent says "I've updated your address"
   * with no tool call behind it.
   *
   * **What it reaches.** Every tool declared `completes` — the author's
   * hand-off or termination tool, and the slow tier's own "work finished"
   * tool, which is not exempt. The refusal names what is still outstanding and
   * arrives as an ordinary recoverable tool failure, so the run finishes the
   * work and reports again rather than the turn ending. It is the same
   * interception Pickle describes, where a blocked hand-off continues the
   * conversation instead of silently terminating it.
   *
   * **What it does not reach**, stated because the difference matters: the
   * fast tier SAYING a false completion. Speech is not a tool call. The levers
   * there are the rendered statement of outstanding work on every fast-tier
   * request (which this feature installs unconditionally) and, for an agent
   * that wants a hard stop, an `outputGuardrails` entry the author writes.
   */
  completionGate?: boolean;
  /**
   * How many trailing messages of the conversation the slow tier may see.
   *
   * @defaultValue `24` (`DEFAULT_SLOW_TIER_CONTEXT_MESSAGES`)
   *
   * A bound on COST and on the information boundary at once, which is SABER's
   * third component (block-based context cleaning) read the way its motivation
   * reads: errors grow with context length as an agent drifts from its role and
   * acts on stale constraints. The window is the session's own conversation,
   * trimmed — never a richer history assembled beside it.
   */
  contextMessages?: number;
}

/** Default {@link TwoTierConfig.effort}. @public */
export const DEFAULT_SLOW_TIER_EFFORT: SlowTierEffort = "high";

/** Default {@link TwoTierConfig.timeoutMs}. @public */
export const DEFAULT_SLOW_TIER_TIMEOUT_MS = 15_000;

/** Default {@link TwoTierConfig.contextMessages}. @public */
export const DEFAULT_SLOW_TIER_CONTEXT_MESSAGES = 24;

/**
 * The longest a rendered digest section may be, in characters.
 *
 * It rides on EVERY request the fast tier makes, so an unbounded one is a
 * prompt that grows for the length of the call — and the cost lands on the
 * number this repo measures time-to-first-token on. The cap trims the oldest
 * SETTLED entries first: what is outstanding is the half the section exists to
 * state.
 *
 * @public
 */
export const MAX_STATE_DIGEST_CHARS = 2000;
