// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createDialogKnobs, type DialogTurnKnobs } from "./pipeline-dialog-knobs.ts";

const BASE = { minBargeInWords: 2, interruptionMinDurationMs: 120 };

/** A step as `prepareStep` is handed one; nothing here reads more of it. */
const STEP = { stepNumber: 0, steps: [], messages: [] } as never;

describe("with no dialog declaring a knob", () => {
  test("every read is the agent's own setting, and there is no preparer", () => {
    const knobs = createDialogKnobs(undefined, BASE);

    expect(knobs.minBargeInWords()).toBe(2);
    expect(knobs.interruptionMinDurationMs()).toBe(120);
    // `undefined` rather than a no-op preparer: it is what the transport gates
    // preemptive generation on, so a pass-through function would turn the
    // feature off for every agent that merely declares a dialog.
    expect(knobs.dialogStep).toBeUndefined();
  });
});

describe("with a dialog source", () => {
  test("an absent field falls through to the agent's setting", () => {
    const knobs = createDialogKnobs(() => ({ toolChoice: "required" }), BASE);

    expect(knobs.minBargeInWords()).toBe(2);
    expect(knobs.interruptionMinDurationMs()).toBe(120);
  });

  test("the source is re-read on every access, so a phase change takes effect", () => {
    let now: DialogTurnKnobs | undefined;
    const knobs = createDialogKnobs(() => now, BASE);

    expect(knobs.minBargeInWords()).toBe(2);
    now = { minBargeInWords: Number.POSITIVE_INFINITY };
    expect(knobs.minBargeInWords()).toBe(Number.POSITIVE_INFINITY);
    now = { minBargeInWords: 1 };
    expect(knobs.minBargeInWords()).toBe(1);
  });

  test("the preparer carries only the LLM knobs the active state declared", async () => {
    const knobs = createDialogKnobs(
      () => ({ minBargeInWords: 9, toolChoice: "none", temperature: 0.4 }),
      BASE,
    );

    // The barge-in numbers are not step settings — they belong to the STT gates,
    // and a `minBargeInWords` on a `streamText` step would be silently ignored.
    expect(await knobs.dialogStep?.(STEP)).toEqual({ toolChoice: "none", temperature: 0.4 });
  });

  test("a step the active state has nothing to say about is prepared by nothing", async () => {
    const knobs = createDialogKnobs(() => ({ minBargeInWords: 9 }), BASE);

    expect(await knobs.dialogStep?.(STEP)).toBeUndefined();
  });
});
