// Copyright 2026 the AAI authors. MIT license.
import type { PrepareStepFunction, ToolSet } from "ai";
import { describe, expect, test } from "vitest";
import { createPersonaStep, type PersonaTurnKnobs } from "./pipeline-persona-knobs.ts";

/** A step as `prepareStep` is handed one — see `pipeline-dialog-knobs.test.ts`. */
const STEP: Parameters<PrepareStepFunction<ToolSet>>[0] = {
  steps: [],
  stepNumber: 0,
  model: "stub-model",
  instructions: undefined,
  initialInstructions: undefined,
  messages: [],
  initialMessages: [],
  responseMessages: [],
  toolsContext: {},
  runtimeContext: {},
};

describe("with no roster", () => {
  test("there is no preparer at all", () => {
    expect(createPersonaStep(undefined)).toBeUndefined();
  });
});

describe("with a persona source", () => {
  test("carries the active persona's two knobs, and only the ones it declares", async () => {
    const step = createPersonaStep(() => ({ toolChoice: "required", temperature: 0.2 }));
    expect(await step?.(STEP)).toEqual({ toolChoice: "required", temperature: 0.2 });
    expect(await createPersonaStep(() => ({ temperature: 0.9 }))?.(STEP)).toEqual({
      temperature: 0.9,
    });
  });

  test("a persona that asks nothing of the step contributes no keys", async () => {
    expect(await createPersonaStep(() => ({}))?.(STEP)).toBeUndefined();
    expect(await createPersonaStep(() => undefined)?.(STEP)).toBeUndefined();
  });

  test("never narrows the tool set — the gate is the enforcement point", async () => {
    const result = await createPersonaStep(() => ({ toolChoice: "auto" }))?.(STEP);
    expect(result).not.toHaveProperty("activeTools");
  });

  test("the source is re-read on every step, so a handoff mid-turn takes effect", async () => {
    let now: PersonaTurnKnobs | undefined = { temperature: 0.1 };
    const step = createPersonaStep(() => now);
    expect(await step?.(STEP)).toEqual({ temperature: 0.1 });
    now = { toolChoice: "none" };
    expect(await step?.(STEP)).toEqual({ toolChoice: "none" });
    now = undefined;
    expect(await step?.(STEP)).toBeUndefined();
  });
});
