// Copyright 2026 the AAI authors. MIT license.
// `streamText` has ONE `prepareStep` slot and this package has more than one
// thing to say per step, so a combinator that silently drops one of its
// preparers is the failure mode with no symptom — see _prepare-step.ts.

import type { ModelMessage, PrepareStepFunction, ToolSet } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  composePrepareStep,
  forceFinalAnswer,
  resetToolChoiceAfterFirstStep,
} from "./_prepare-step.ts";
import { silentLogger } from "./runtime-config.ts";

/** The `prepareStep` options object, with only the fields a case varies set. */
function step(
  overrides: { stepNumber?: number; messages?: ModelMessage[] } = {},
): Parameters<PrepareStepFunction<ToolSet>>[0] {
  const options = {
    stepNumber: overrides.stepNumber ?? 0,
    messages: overrides.messages ?? [{ role: "user" as const, content: "hi" }],
    steps: [],
    initialMessages: [],
    responseMessages: [],
    instructions: undefined,
    initialInstructions: undefined,
    model: "test-model",
    toolsContext: {},
    runtimeContext: {},
  };
  return options;
}

describe("composePrepareStep", () => {
  const trimmed: ModelMessage[] = [{ role: "user", content: "trimmed" }];
  /** Stands in for the context budget: owns `messages`, says nothing else. */
  const budget = (): { messages: ModelMessage[] } => ({ messages: trimmed });
  /** Stands in for `forceFinalAnswer`: owns `toolChoice`, says nothing else. */
  const forceFinal = (): { toolChoice: "none" } => ({ toolChoice: "none" });

  test("keeps BOTH results — the trim and the forced tool choice", async () => {
    // The whole reason this exists: writing either preparer straight into the
    // single slot deletes the other, with no error and no symptom until a turn
    // stops mid-chain or a request overflows the window.
    const result = await composePrepareStep(budget, forceFinal)(step());
    expect(result).toEqual({ messages: trimmed, toolChoice: "none" });
  });

  test("a preparer answering undefined contributes nothing and erases nothing", async () => {
    // "Nothing to say about this step" — the common case for both real
    // preparers. A `a ?? b` merge would drop everything the first one said.
    const silent = (): undefined => undefined;
    expect(await composePrepareStep(budget, silent)(step())).toEqual({ messages: trimmed });
    expect(await composePrepareStep(silent, forceFinal)(step())).toEqual({ toolChoice: "none" });
  });

  test("an undefined preparer is skipped, not called", async () => {
    // The text agent's caller hook is optional.
    const later = vi.fn(forceFinal);
    expect(await composePrepareStep(undefined, later)(step())).toEqual({ toolChoice: "none" });
    expect(later).toHaveBeenCalledTimes(1);
  });

  test("the LAST writer wins per key, which is why forceFinalAnswer goes last", async () => {
    const caller = (): { toolChoice: "required"; messages: ModelMessage[] } => ({
      toolChoice: "required",
      messages: trimmed,
    });
    const result = await composePrepareStep(caller, forceFinal)(step());
    // The caller asked for `required`; the reserved answering step overrides
    // that one key and leaves its messages alone.
    expect(result).toEqual({ messages: trimmed, toolChoice: "none" });
  });

  test("every preparer sees the SAME options, in order", async () => {
    const seen: number[] = [];
    // Returns an empty result rather than nothing: `void` is not a
    // `PrepareStepResult`, and this is about ORDER, not about the merge.
    const record = (n: number) => (): Record<string, never> => {
      seen.push(n);
      return {};
    };
    await composePrepareStep(record(1), record(2), record(3))(step({ stepNumber: 7 }));
    expect(seen).toEqual([1, 2, 3]);
  });

  test("awaits an async preparer rather than merging its promise", async () => {
    const asyncBudget = async (): Promise<{ messages: ModelMessage[] }> => ({ messages: trimmed });
    expect(await composePrepareStep(asyncBudget, forceFinal)(step())).toEqual({
      messages: trimmed,
      toolChoice: "none",
    });
  });

  test("composing nothing is a no-op result, never undefined", async () => {
    // `streamText` accepts an empty result; returning `undefined` from the
    // composed function would be fine too, but the empty object is what every
    // other branch returns and one shape is easier to reason about.
    expect(await composePrepareStep()(step())).toEqual({});
  });
});

describe("resetToolChoiceAfterFirstStep", () => {
  test("a demanding toolChoice is reset from step 1 on", () => {
    // The sharp edge it removes: `"required"` is applied to EVERY step, so the
    // model is re-obliged to call a tool after it already has, burning the
    // whole `maxSteps` budget before `forceFinalAnswer` rescues the turn.
    const preparer = resetToolChoiceAfterFirstStep("required", true);
    expect(preparer?.({ stepNumber: 0 })).toBeUndefined();
    expect(preparer?.({ stepNumber: 1 })).toEqual({ toolChoice: "auto" });
    expect(preparer?.({ stepNumber: 7 })).toEqual({ toolChoice: "auto" });
  });

  test("a NAMED tool is a demand too", () => {
    const preparer = resetToolChoiceAfterFirstStep({ type: "tool", toolName: "lookup" }, true);
    expect(preparer?.({ stepNumber: 1 })).toEqual({ toolChoice: "auto" });
  });

  test("it does not exist at all for an agent that set no toolChoice", () => {
    // The opt-out default is only safe because this contributes NO preparer —
    // not a preparer that returns nothing — when there is no demand to reset.
    expect(resetToolChoiceAfterFirstStep("auto", true)).toBeUndefined();
    expect(resetToolChoiceAfterFirstStep("none", true)).toBeUndefined();
  });

  test("disabled, it does not exist either", () => {
    expect(resetToolChoiceAfterFirstStep("required", false)).toBeUndefined();
  });

  test("forceFinalAnswer still WINS on the reserved step", async () => {
    // Composed before it deliberately: the reserved step exists so the model
    // has no move left but to speak, and `"auto"` there would let it spend the
    // step on another call.
    const composed = composePrepareStep(
      resetToolChoiceAfterFirstStep("required", true),
      forceFinalAnswer(2, silentLogger, "sid"),
    );
    // `step()` is the real `prepareStep` options shape, which is what the
    // composed function takes — the two preparers under it read only
    // `stepNumber`, but the seam between them is typed and stays typed.
    expect(await composed(step({ stepNumber: 1 }))).toEqual({ toolChoice: "auto" });
    expect(await composed(step({ stepNumber: 2 }))).toEqual({ toolChoice: "none" });
  });
});
