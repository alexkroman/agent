// Copyright 2026 the AAI authors. MIT license.
// `classifyThrow`: the precedence that turns one walk's throw into a verdict,
// or into "no verdict — retry the delivery".

import { describe, expect, test } from "vitest";
import { classifyThrow } from "./outcome.ts";
import { createSuspendController, type SuspendController } from "./suspend.ts";

function walk(over: Partial<Parameters<typeof classifyThrow>[1]> = {}) {
  return {
    signal: undefined,
    refused: undefined,
    journalFailed: false,
    suspend: createSuspendController(),
    ...over,
  };
}

/** A controller that has really parked, and the value its interruption rejected with. */
async function parked(wakeAt: number): Promise<{ suspend: SuspendController; thrown: unknown }> {
  const suspend = createSuspendController();
  void suspend.enter().park(wakeAt);
  const thrown = await suspend.interruption.catch((err: unknown) => err);
  return { suspend, thrown };
}

describe("classifyThrow", () => {
  test("an ordinary throw fails the run with its message", () => {
    expect(classifyThrow(new Error("boom"), walk())).toEqual({
      kind: "failed",
      error: { message: "boom" },
    });
  });

  test("the cancel's own reason is no verdict: the run is already cancelled", () => {
    const ctl = new AbortController();
    ctl.abort(new Error("cancelled"));
    expect(classifyThrow(ctl.signal.reason, walk({ signal: ctl.signal }))).toBeUndefined();
    // Any OTHER throw on a cancelled walk is still classified.
    expect(classifyThrow(new Error("late"), walk({ signal: ctl.signal }))?.kind).toBe("failed");
  });

  test("a failed journal is no verdict, even over a refusal", () => {
    expect(
      classifyThrow(new Error("x"), walk({ journalFailed: true, refused: "diverged" })),
    ).toBeUndefined();
  });

  test("a refusal fails the run with the REFUSAL, not the throw it caused", () => {
    expect(classifyThrow(new Error("consequence"), walk({ refused: "diverged at s1" }))).toEqual({
      kind: "failed",
      error: { message: "diverged at s1" },
    });
  });

  test("the controller's own suspension parks the run at the earliest wake", async () => {
    const { suspend, thrown } = await parked(500);
    expect(classifyThrow(thrown, walk({ suspend }))).toEqual({ kind: "suspended", wakeAt: 500 });
  });

  test("a refusal wins over a suspension", async () => {
    const { suspend, thrown } = await parked(500);
    expect(classifyThrow(thrown, walk({ suspend, refused: "wait inside a step" }))?.kind).toBe(
      "failed",
    );
  });
});
