// Copyright 2026 the AAI authors. MIT license.
/**
 * One run context per PROCESS.
 *
 * The bug this pins reached a deployed transcription workflow and read as
 * cosmetic: a narration line logged with an empty context object.
 *
 * ```text
 * Workflow: Transcribing 45:00–46:32. {}
 * ```
 *
 * The empty `{}` is `stepMetadata()` finding no step, and the same lookup
 * decides whether the line is STREAMED to a watching page — so a fifty-minute
 * transcription reported no progress at all. It happened because a deployed guest
 * held two copies of this package, each with its own store. It holds one now (the
 * worker IMPORTS the runtime — `worker-bundler.test.ts` and the guest's
 * `harness/externals.test.ts` are the gates), so what is left to pin is the
 * store's own contract: a context entered is the context read, a step narrows it
 * without leaking back, and outside a run there is none.
 */

import { describe, expect, test } from "vitest";
import { currentRun, type RunContext, withRunContext, withStepContext } from "./run-context.ts";

/** A run context with the two fields these cases care about. */
const runOf = (runId: string): RunContext => ({
  runId,
  workflow: "transcribe",
  // Never called here: what is under test is which STORE the context lands in.
  write: () => Promise.resolve(0),
});

const STEP = { name: "transcribeSegment", key: "transcribeSegment#12", attempt: 2, maxAttempts: 3 };

describe("the run context", () => {
  test("a context entered is the one read, across awaits", async () => {
    const seen = await withRunContext(runOf("wrun_1"), async () => {
      await Promise.resolve();
      return currentRun();
    });
    expect(seen?.runId).toBe("wrun_1");
  });

  test("a step narrows the context, and the body reads as the body again after it", async () => {
    // `stepReport()` reads `currentRun()?.step`; an empty context is what made the
    // narration log-only.
    const { inside, after } = await withRunContext(runOf("wrun_2"), async () => {
      const inside = await withStepContext(STEP, async () => currentRun()?.step);
      return { inside, after: currentRun()?.step };
    });
    expect(inside).toEqual(STEP);
    expect(after).toBeUndefined();
  });

  test("outside a run there is no context, and a step is a pass-through", async () => {
    expect(currentRun()).toBeUndefined();
    await expect(withStepContext(STEP, async () => currentRun())).resolves.toBeUndefined();
  });
});
