// Copyright 2026 the AAI authors. MIT license.
/**
 * The pipeline fuzz's generated world: the arbitraries stay inside the bounds
 * the harness assumes, a noise barge-in always gets its quiet gap, and the
 * script cycles its pattern into one step per LLM request.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  ACTION_KINDS,
  buildScript,
  OPENERS,
  SCRIPT_LENGTH,
  shortRunArb,
  stepPauseMs,
} from "./_pipeline-fuzz-input.ts";

describe("stepPauseMs", () => {
  test("passes an ordinary step's pause through, null included", () => {
    expect(stepPauseMs({ action: "sttFinal", opener: 0, pauseMs: 2 })).toBe(2);
    expect(stepPauseMs({ action: "ttsAudio", opener: 0, pauseMs: null })).toBeNull();
  });

  test("raises a noise barge-in's pause to the quiet gap it needs", () => {
    expect(stepPauseMs({ action: "noiseBargeIn", opener: 0, pauseMs: null })).toBe(3);
    expect(stepPauseMs({ action: "noiseBargeIn", opener: 0, pauseMs: 1 })).toBe(3);
    expect(stepPauseMs({ action: "noiseBargeIn", opener: 0, pauseMs: 4 })).toBe(4);
  });
});

describe("shortRunArb", () => {
  test("every generated run is one the harness can play", () => {
    fc.assert(
      fc.property(shortRunArb, (run) => {
        expect(run.steps.length).toBeGreaterThanOrEqual(6);
        for (const step of run.steps) {
          expect(ACTION_KINDS).toContain(step.action);
          expect(OPENERS[step.opener]).toBeDefined();
        }
        expect(run.script.length).toBeGreaterThanOrEqual(4);
        expect(run.tools.length).toBeGreaterThanOrEqual(1);
        expect(run.refusals.length).toBeGreaterThanOrEqual(4);
      }),
      { numRuns: 50 },
    );
  });
});

describe("buildScript", () => {
  test("cycles the pattern into SCRIPT_LENGTH steps, one shape per turn kind", () => {
    const { steps, stepText } = buildScript(["text", "tool", "fail"], "r1");
    expect(steps).toHaveLength(SCRIPT_LENGTH);
    expect(stepText).toHaveLength(SCRIPT_LENGTH);

    expect(steps[0]?.map((part) => part.type)).toEqual(["text", "text", "text", "text", "text"]);
    expect(stepText[0]).toBe("s0w0 s0w1 s0w2 s0w3 s0w4 ");

    expect(steps[1]).toEqual([
      { type: "tool-call", toolCallId: "cr1-1", toolName: "lookup", input: "{}" },
    ]);
    expect(stepText[1]).toBe("");

    expect(steps[2]?.[0]?.type).toBe("error");
    expect(stepText[2]).toBe("");
    // The pattern repeats: step 3 is a text turn again.
    expect(stepText[3]).toBe("s3w0 s3w1 s3w2 s3w3 s3w4 ");
  });

  test("tool-call ids carry the run id, so two runs never share one", () => {
    const a = buildScript(["tool"], "a").steps[0]?.[0];
    const b = buildScript(["tool"], "b").steps[0]?.[0];
    expect(a).not.toEqual(b);
  });
});
