// Copyright 2026 the AAI authors. MIT license.
/**
 * `streamText` takes ONE `prepareStep`, and this package has more than one
 * thing to say per step.
 *
 * The AI SDK's per-step hook is a single slot: a second caller does not add a
 * layer, it REPLACES the first. Two things want it in the voice pipeline —
 * `forceFinalAnswer`, which spends the reserved step on an answer with no
 * tools, and the context budget, which decides which messages this step may
 * send — and a third, a caller's own `prepareStep`, on the text agent's door.
 * Composing them is therefore not a convenience: writing either one directly
 * into the slot silently deletes the other, and both failures are invisible
 * (a turn that stops mid-chain with an empty transcript; a request that
 * overflows the model's window).
 *
 * The combinator used to be a private function in `text-agent.ts` composing
 * exactly two. It is shared and variadic now, so the pipeline's pair and the
 * text agent's pair are the same code, and the one test that a composition
 * keeps BOTH results covers both call sites.
 *
 * {@link forceFinalAnswer} sits beside it — the preparer every one of those
 * call sites ends with. It came out of `pipeline-llm-stream.ts`, which three
 * modules imported it from and which the context budget took past the file-line
 * cap; a preparer belongs with the seam that composes preparers rather than
 * inside the one turn assembler that happens to have declared it first.
 */

import type { ToolChoice } from "@alexkroman1/aai";
import type { PrepareStepFunction, PrepareStepResult, ToolSet } from "ai";
import type { Logger } from "./runtime-config.ts";

/**
 * Run each preparer in order and layer their results, LAST writer winning per
 * key.
 *
 * The order is the point, and it is the caller's to choose. A preparer that
 * owns the step's MESSAGES — compaction, a context budget, an injected wrap-up
 * notice — must run early and keep what it returned; nothing legitimately owns
 * `toolChoice` on the step the budget reserved for answering, because that step
 * exists precisely so the model has no move left but to speak. So
 * `forceFinalAnswer` goes LAST at every call site and wins on the one key it
 * sets, while every other key passes through untouched.
 *
 * An `undefined` preparer is skipped (the text agent's caller hook is
 * optional), and a preparer answering `undefined` — "nothing to say about this
 * step" — contributes no keys rather than erasing the ones before it. That
 * second rule is the one a hand-rolled merge gets wrong: `a ?? b` would drop
 * everything `a` said the moment `b` had an opinion.
 */
export function composePrepareStep(
  ...preparers: readonly (PrepareStepFunction<ToolSet> | undefined)[]
): PrepareStepFunction<ToolSet> {
  return async (options) => {
    let merged: NonNullable<PrepareStepResult<ToolSet>> = {};
    for (const preparer of preparers) {
      const result = await preparer?.(options);
      if (result) merged = { ...merged, ...result };
    }
    return merged;
  };
}

/**
 * Put a DEMANDING `toolChoice` back to `"auto"` after the first step.
 *
 * `streamText` applies the request's `toolChoice` to every step, so
 * `toolChoice: "required"` re-obliges the model to call a tool after it already
 * has — and again, and again, until the whole `maxSteps` budget is gone and
 * {@link forceFinalAnswer} spends the reserved step on an answer. Bounded, not
 * a loop; but the caller waits through every round trip, and what the setting
 * almost always means is "start by calling something".
 *
 * Returns `undefined` — contributing no keys at all — when there is nothing to
 * reset: `"auto"` and `"none"` are not demands, and an agent that set no
 * `toolChoice` has the default `"auto"`. That is what makes this safe to
 * compose in unconditionally and safe to default ON.
 *
 * Composed BEFORE {@link forceFinalAnswer}, which owns the same key on the one
 * step it fires for: the reserved step must have no tools at all, and `"auto"`
 * there would let the model spend it on another call.
 *
 * @internal
 */
export function resetToolChoiceAfterFirstStep(
  toolChoice: ToolChoice,
  enabled: boolean,
): ((opts: { stepNumber: number }) => { toolChoice: "auto" } | undefined) | undefined {
  const demands = toolChoice !== "auto" && toolChoice !== "none";
  if (!(enabled && demands)) return undefined;
  return ({ stepNumber }) => (stepNumber === 0 ? undefined : { toolChoice: "auto" });
}

/**
 * Spend the step after the tool budget on an answer the caller can hear.
 *
 * `stopWhen: stepCountIs(n)` alone stops the turn the moment the budget runs
 * out — including mid-chain, right after a tool result, with no text emitted.
 * Nothing downstream can repair that: the reply completes "successfully" with
 * an empty transcript, so `errorPhrase` does not fire either, and the caller
 * hears the agent simply stop. The lower the cap, the more often that happens,
 * which is why it and this function are one change (see DEFAULT_MAX_STEPS).
 *
 * So the budget passed to `stopWhen` is `maxSteps + 1`, and this forces
 * `toolChoice: "none"` on that extra step: the model still has every tool
 * result in context, but its only remaining move is to speak. Same shape as
 * LiveKit's behaviour on `max_tool_steps` since 1.4.5.
 *
 * It costs nothing in the ordinary case — p50 is one step, so a turn that
 * never approaches the cap never reaches this callback. The override also
 * wins over an agent-level `toolChoice: "required"`, which would otherwise
 * demand a tool call on the one step where tools are unavailable.
 */
export function forceFinalAnswer(
  maxSteps: number,
  log: Logger,
  sid: string,
): (opts: { stepNumber: number }) => { toolChoice: "none" } | undefined {
  return ({ stepNumber }) => {
    if (stepNumber < maxSteps) return;
    log.info("maxSteps reached; forcing a final answer with no tools", { maxSteps, sid });
    return { toolChoice: "none" };
  };
}
