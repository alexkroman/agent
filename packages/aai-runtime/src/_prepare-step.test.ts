// Copyright 2026 the AAI authors. MIT license.
// `streamText` has ONE `prepareStep` slot and this package has more than one
// thing to say per step, so a combinator that silently drops one of its
// preparers is the failure mode with no symptom — see _prepare-step.ts.

import type { ModelMessage, PrepareStepFunction, ToolSet } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  composePrepareStep,
  forceFinalAnswer,
  isFailedToolResult,
  resetToolChoiceAfterFirstStep,
  TOOL_ERROR_BUDGET,
  toolErrorBudget,
} from "./_prepare-step.ts";
import { type Logger, silentLogger } from "./runtime-config.ts";

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

// A tool round trip is silence on a phone call. The cases below are the shapes
// seen in recorded voice runs: repeated identity lookups that each failed while
// the caller asked whether anyone was there, and one call retried with
// identical arguments after each `Error: ...` result.
describe("toolErrorBudget", () => {
  type Part = Record<string, unknown>;
  const call = (toolName: string, input: unknown): Part => ({
    type: "tool-call",
    toolCallId: "c",
    toolName,
    input,
  });
  const result = (toolName: string, input: unknown, output: unknown): Part => ({
    type: "tool-result",
    toolCallId: "c",
    toolName,
    input,
    output,
  });
  /** One finished step: a call and its result. */
  const round = (toolName: string, input: unknown, output: unknown): { content: Part[] } => ({
    content: [call(toolName, input), result(toolName, input, output)],
  });
  const failure = '{"error":"No record matches those details."}';

  test("distinct calls with fewer than the budget's failures say nothing", () => {
    const budget = toolErrorBudget(silentLogger, "sid");
    expect(budget({ steps: [] })).toBeUndefined();
    const steps = [
      round("find_user", { name: "Ada" }, failure),
      round("find_user", { email: "ada@example.com" }, "Error: not found"),
      round("find_user", { zip: "12345" }, '{"id":"u1"}'),
    ];
    expect(budget({ steps })).toBeUndefined();
  });

  test("an identical retry of a failed call forces an answer", () => {
    const budget = toolErrorBudget(silentLogger, "sid");
    const steps = [
      round("find_user", { name: "Ada", zip: "1" }, "Error: not found"),
      // Same call, keys in another order: canonical JSON makes it identical.
      { content: [call("find_user", { zip: "1", name: "Ada" })] },
    ];
    expect(budget({ steps })).toEqual({ toolChoice: "none" });
  });

  test("retrying a call that SUCCEEDED is not a repeat", () => {
    const budget = toolErrorBudget(silentLogger, "sid");
    const steps = [
      round("get_order", { id: 1 }, '{"ok":true}'),
      round("get_order", { id: 1 }, "{}"),
    ];
    expect(budget({ steps })).toBeUndefined();
  });

  test("the budget's worth of failures forces an answer", () => {
    expect(TOOL_ERROR_BUDGET).toBe(3);
    const budget = toolErrorBudget(silentLogger, "sid");
    const steps = [
      round("find_user", { name: "Ada" }, failure),
      { content: [{ type: "tool-error", toolName: "find_user", input: { a: 1 }, error: "boom" }] },
      round("find_user", { email: "x" }, { type: "error-text", value: "denied" }),
    ];
    expect(budget({ steps: steps.slice(0, 2) })).toBeUndefined();
    expect(budget({ steps })).toEqual({ toolChoice: "none" });
  });

  test("failures in earlier turns never count — steps are one turn's", () => {
    // Each turn is its own `streamText` call and gets its own preparer and
    // its own `steps`, so a fresh turn after three failed ones starts clean.
    for (let turn = 0; turn < 3; turn++) {
      const budget = toolErrorBudget(silentLogger, "sid");
      expect(budget({ steps: [round("find_user", { name: "Ada" }, failure)] })).toBeUndefined();
    }
  });

  test("logs once per turn when it fires", () => {
    const info = vi.fn();
    const log: Logger = { ...silentLogger, info };
    const budget = toolErrorBudget(log, "sid-1");
    const steps = [round("t", { q: 1 }, failure), { content: [call("t", { q: 1 })] }];
    budget({ steps });
    budget({ steps });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("tool-error budget spent; forcing an answer", {
      sid: "sid-1",
      errors: 1,
      identicalRepeat: true,
    });
  });

  test("composes before forceFinalAnswer and overrides a dialog pin", async () => {
    const dialogPin = (): { toolChoice: "required" } => ({ toolChoice: "required" });
    const composed = composePrepareStep(
      dialogPin,
      toolErrorBudget(silentLogger, "sid"),
      forceFinalAnswer(5, silentLogger, "sid"),
    );
    const failed = round("t", { q: 1 }, failure);
    const options = step({ stepNumber: 1 });
    expect(await composed({ ...options, steps: [] })).toEqual({ toolChoice: "required" });
    const repeat = { ...options, stepNumber: 2, steps: [failed, failed] as typeof options.steps };
    expect(await composed(repeat)).toEqual({ toolChoice: "none" });
  });
});

describe("isFailedToolResult", () => {
  test.each([
    ['{"error":"x"}', true],
    ["  Error: user not found", true],
    [{ error: "x" }, true],
    [{ type: "error-json", value: { code: 1 } }, true],
    [{ type: "text", value: "Error: nope" }, true],
    ["error: lower case is not the convention", false],
    ['{"id":"u1"}', false],
    [{ type: "text", value: "found it" }, false],
    [undefined, false],
    [42, false],
  ])("%j → %s", (output, expected) => {
    expect(isFailedToolResult(output)).toBe(expected);
  });
});
