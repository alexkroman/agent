// Copyright 2026 the AAI authors. MIT license.
/**
 * The SLOW TIER: one detached tool loop, per session.
 *
 * It is a `ToolLoopAgent` over the agent's own tools, run OUTSIDE any turn.
 * That last word is the architecture:
 *
 * **Nothing the caller waits for is downstream of this.** The fast tier's
 * request carries no tools at all, so it answers at its own first-token
 * latency whatever this loop is doing — and "fail open on slow-tier timeout"
 * is therefore a property of the shape rather than a policy someone
 * remembered to write. There is no branch in which a hung slow tier makes the
 * caller wait, because the caller's turn never awaited it. That matters here
 * specifically: this repo has a measured failure in which an agent went silent
 * for 63 seconds across four caller utterances, and a second model inside the
 * turn is the most direct way to reproduce it.
 *
 * What a timeout still costs is a STALE DIGEST — the fast tier keeps talking
 * from the last summary it was given — and `timeoutMs` bounds a run so a wedged
 * provider does not hold the coalescing runner forever.
 *
 * ## Why it lives here and not somewhere the repo already has
 *
 * - **Not a WORKFLOW.** A run outlives the session, is journaled, and may be
 *   replayed in another process. This work is meaningless once the call is
 *   over and has no durability requirement at all.
 * - **Not a separate OPENER.** An opener exists for a provider session holding
 *   a socket for the length of a call. This is request/response.
 * - **Not `ctx.delegate`.** A subagent is invoked FROM a tool body by the
 *   author, and its whole design is that it sees no conversation
 *   (`messages: () => []`). This tier's entire job is to act on the
 *   conversation, and nothing invokes it — the runtime does, off a session
 *   event.
 *
 * What it DOES reuse is everything below the model: `createLlmModelCache`,
 * `toVercelTools`, `executeToolCall` through the caller's own option bag, the
 * session's usage meter, and `forceFinalAnswer`.
 */

import { DEFAULT_SLOW_TIER_EFFORT, type SlowTierEffort } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import { normalizeLlm } from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { JSONValue } from "ai";
import { type LanguageModel, stepCountIs, ToolLoopAgent } from "ai";
import pTimeout, { TimeoutError } from "p-timeout";
import { createLlmModelCache, isLlmDescriptor } from "../_llm-model-cache.ts";
import { forceFinalAnswer } from "../_prepare-step.ts";
import type { Logger } from "../runtime-config.ts";
import { toVercelTools } from "../to-vercel-tools.ts";
import type { StepUsage, UsageMeter } from "../usage-meter.ts";
import { renderSlowTierBrief, SLOW_TIER_SYSTEM_PROMPT } from "./prompt.ts";
import type { SlowTierView } from "./view.ts";

/**
 * Anthropic's and Google's thinking budget, per effort level.
 *
 * `budgetTokens` must sit strictly below the request's own output cap, which is
 * why {@link OUTPUT_TOKENS} exists beside this rather than being left to the
 * provider's default: a budget above the cap is a request the provider refuses
 * outright, and a refused slow-tier run is a silent un-gating. The numbers are
 * the vendors' own documented tiers, not a measurement of ours.
 */
const THINKING_BUDGET: Record<SlowTierEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
};

/** Output cap per effort — strictly above {@link THINKING_BUDGET}; see there. */
const OUTPUT_TOKENS: Record<SlowTierEffort, number> = {
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16_384,
};

/**
 * The effort hint, spelled for each family that has one.
 *
 * Namespaced by provider id, and the AI SDK hands a namespace only to the
 * provider it names — so passing all three is not a leak into the wrong
 * request, it is how one option reaches whichever provider the author chose.
 * A family with no reasoning knob receives no namespace and is unaffected,
 * which is why `TwoTierConfig.effort` is documented as a HINT.
 *
 * An effort on the DESCRIPTOR still wins: `assemblyAILlm({ reasoningEffort })`
 * sets `providerOptions.openai.reasoningEffort` inside the LLM registry, which
 * is applied when the model is built rather than per request.
 *
 * Exported because it is the one part of the model wiring a unit test can drive
 * without a provider, and because the budget/cap relationship above is the kind
 * of arithmetic that is wrong silently.
 */
export function effortProviderOptions(
  effort: SlowTierEffort,
): Record<string, Record<string, JSONValue>> {
  return {
    openai: { reasoningEffort: effort },
    anthropic: { thinking: { type: "enabled", budgetTokens: THINKING_BUDGET[effort] } },
    google: { thinkingConfig: { thinkingBudget: THINKING_BUDGET[effort] } },
  };
}

/** How one slow-tier run ended. */
export type SlowRunOutcome = "completed" | "timed-out" | "failed";

/** Runs the slow tier once against the session's current state. @internal */
export type SlowLoop = (view: SlowTierView, signal: AbortSignal) => Promise<SlowRunOutcome>;

/** What {@link createSlowLoop} needs. @internal */
export type CreateSlowLoopOptions = {
  /** `twoTier.llm` when set. */
  llm: LlmProvider | string | undefined;
  /** The FAST tier's descriptor, which is the fallback. */
  fallbackLlm: LlmProvider | undefined;
  env: ProviderEnv;
  effort: SlowTierEffort;
  maxSteps: number;
  timeoutMs: number;
  sessionId: string;
  logger: Logger;
  /** The slow tier's tools, schemas already carrying `state_summary`. */
  schemas: readonly ToolSchema[];
  /** The gated executor — see `session.ts`. */
  executeTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) => Promise<string>;
  /** The session's meter: a slow-tier step is a model request and is billed like one. */
  usage?: UsageMeter | undefined;
};

/**
 * Build the slow tier.
 *
 * Throws at CONSTRUCTION if no descriptor resolves. Deliberate: an agent that
 * declared `twoTier` and cannot reach a model has a configuration error, and
 * discovering it at the first caller utterance — as a run that fails silently
 * while the fast tier keeps promising work is underway — is the worst available
 * moment.
 *
 * @internal
 */
export function createSlowLoop(options: CreateSlowLoopOptions): SlowLoop {
  const modelFor = createLlmModelCache(options.env);
  const descriptor = options.llm ? normalizeLlm(options.llm) : options.fallbackLlm;
  if (!isLlmDescriptor(descriptor)) {
    throw new Error(
      "twoTier: no model for the slow tier. Set `twoTier.llm` (from " +
        "@alexkroman1/aai/llm), or give the agent an `llm` for it to fall back to.",
    );
  }
  const model: LanguageModel = modelFor(descriptor);
  const effort = options.effort ?? DEFAULT_SLOW_TIER_EFFORT;
  const { logger, sessionId, maxSteps, timeoutMs, usage } = options;

  return async (view: SlowTierView, signal: AbortSignal): Promise<SlowRunOutcome> => {
    const agent = new ToolLoopAgent({
      id: "slow-tier",
      model,
      instructions: SLOW_TIER_SYSTEM_PROMPT,
      tools: toVercelTools(options.schemas, {
        executeTool: (name, args, _sid, _messages, callOptions) =>
          options.executeTool(name, args, callOptions?.signal ?? signal),
        sessionId,
        // The slow tier's tools read an EMPTY `ctx.messages`. The conversation
        // is in the BRIEF, rebuilt per run from the session's own state — so a
        // tool here sees no growing side-history that could drift from what the
        // fast tier has, which is the information boundary stated as a default.
        messages: () => [],
        signal,
      }),
      stopWhen: stepCountIs(maxSteps + 1),
      prepareStep: forceFinalAnswer(maxSteps, logger, sessionId),
      maxOutputTokens: OUTPUT_TOKENS[effort],
      providerOptions: effortProviderOptions(effort),
    });

    const run = async (): Promise<SlowRunOutcome> => {
      const exhausted = usage?.exhausted();
      if (exhausted !== undefined) {
        // Checked BEFORE the request, like every other model call in this
        // runtime: a slow-tier run is several requests and a budget that
        // bounded only the conversation would leave the expensive half
        // unbounded.
        logger.warn("Slow tier skipped: session budget exhausted", { sid: sessionId, exhausted });
        return "failed";
      }
      const result = await agent.generate({
        prompt: renderSlowTierBrief(view),
        abortSignal: signal,
        onStepFinish: (step: { usage: StepUsage }) => usage?.record(step.usage),
      });
      // The final TEXT is deliberately discarded. Nothing reads it: everything
      // the caller hears went through the channel tools, and everything the
      // fast tier knows went through the digest. A slow tier whose closing
      // paragraph mattered would be a third channel to keep in sync.
      void result;
      return "completed";
    };

    try {
      return await pTimeout(run(), { milliseconds: timeoutMs });
    } catch (err) {
      if (signal.aborted) return "failed";
      if (err instanceof TimeoutError) {
        logger.warn("Slow tier timed out", { sid: sessionId, timeoutMs });
        return "timed-out";
      }
      logger.error("Slow tier failed", {
        sid: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    }
  };
}
