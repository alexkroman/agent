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
