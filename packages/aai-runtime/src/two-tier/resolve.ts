// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving `twoTier` into the numbers the runtime uses, in one place.
 *
 * Separate from the wiring for the reason `pipeline-transport-options.ts` is
 * separate from its transport: every default here is a number somebody will
 * want to argue with, and a `??` at a call site is where a default goes to hide.
 */

import {
  DEFAULT_SLOW_TIER_CONTEXT_MESSAGES,
  DEFAULT_SLOW_TIER_EFFORT,
  DEFAULT_SLOW_TIER_TIMEOUT_MS,
  type SlowTierEffort,
} from "@alexkroman1/aai";
import type { LlmProvider } from "@alexkroman1/aai/llm";

/**
 * The `twoTier` declaration as a CONFIG carries it.
 *
 * Structurally `TwoTierConfig`, but every member widened with `| undefined`,
 * because that is what `z.infer` produces for an `.optional()` key under
 * `exactOptionalPropertyTypes` — and this reads a parsed `AgentConfig` rather
 * than the authoring type. The alternative is a cast at the one call site,
 * which is where a widening stops being checked.
 */
export type TwoTierConfigInput = {
  readonly llm?: LlmProvider | string | undefined;
  readonly effort?: SlowTierEffort | undefined;
  readonly timeoutMs?: number | undefined;
  readonly completionGate?: boolean | undefined;
  readonly contextMessages?: number | undefined;
};

/**
 * How many tool-calling steps one slow-tier run may take.
 *
 * Its own number rather than the agent's `maxSteps`, which is a VOICE budget —
 * it bounds how long a caller waits inside one reply, and the default is small
 * for exactly that reason. A slow-tier run is not in anybody's reply: the fast
 * tier is talking while it works, so the thing to bound is the bill and a
 * runaway loop, not the wait. TalkAct's own slow agent runs to 60.
 */
export const DEFAULT_SLOW_TIER_MAX_STEPS = 24;

/** Every `twoTier` field, resolved. @internal */
export type ResolvedTwoTier = {
  readonly llm: LlmProvider | string | undefined;
  readonly effort: SlowTierEffort;
  readonly timeoutMs: number;
  readonly completionGate: boolean;
  readonly contextMessages: number;
  readonly maxSteps: number;
};

/**
 * Resolve the declaration, or `undefined` when the agent made none.
 *
 * `undefined` in and `undefined` out is the whole off-switch: every caller
 * gates on it, so an agent that declares no `twoTier` allocates nothing, wraps
 * nothing, and sends the bytes it sent before this feature existed.
 *
 * @internal
 */
export function resolveTwoTier(
  config: TwoTierConfigInput | undefined,
): ResolvedTwoTier | undefined {
  if (config === undefined) return undefined;
  return {
    llm: config.llm,
    effort: config.effort ?? DEFAULT_SLOW_TIER_EFFORT,
    timeoutMs: config.timeoutMs ?? DEFAULT_SLOW_TIER_TIMEOUT_MS,
    completionGate: config.completionGate ?? true,
    contextMessages: config.contextMessages ?? DEFAULT_SLOW_TIER_CONTEXT_MESSAGES,
    maxSteps: DEFAULT_SLOW_TIER_MAX_STEPS,
  };
}
