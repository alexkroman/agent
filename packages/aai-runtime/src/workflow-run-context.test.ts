// Copyright 2026 the AAI authors. MIT license.
/**
 * One run context per PROCESS, across every copy of this package.
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
 * transcription reported no progress at all, and the attempt suffix that tells a
 * reader a fan-out is retrying could never appear. Only the log line survived,
 * which is why every other signal said healthy.
 *
 * A deployed guest has two copies of this package by design: the harness bundles
 * its own and calls `createRuntimeServer` from it, while the agent's runtime comes from
 * the BUNDLE's `__aaiCreateRuntime` so a deployed agent runs the SDK version it
 * was tested against. `vi.resetModules()` is that, exactly — a second module
 * instance is a second copy — which is what makes this testable in one process.
 */

import { describe, expect, test, vi } from "vitest";
import type { RunContext } from "./workflow-run-context.ts";

/** A run context with the two fields these cases care about. */
const runOf = (runId: string): RunContext => ({
  runId,
  workflow: "transcribe",
  // Never called here: what is under test is which STORE the context lands in.
  write: () => Promise.resolve(0),
});

/**
 * A fresh copy of the module, the way a second bundle gets one.
 *
 * The reset is here rather than in a `beforeEach` because every case's first
 * statement is a `loadCopy()` — and the slot OUTLIVES the reset (it is on
 * `globalThis`), so a copy loaded by an earlier test is exactly what a later one
 * must adopt.
 */
async function loadCopy() {
  vi.resetModules();
  return await import("./workflow-run-context.ts");
}

describe("the run context crosses copies of this package", () => {
  test("a context set by ONE copy is visible to ANOTHER", async () => {
    // The deployed shape: the bundle's copy runs the engine and enters the
    // context, the harness's copy holds the reporter that reads it.
    const engine = await loadCopy();
    const reporter = await loadCopy();
    expect(reporter).not.toBe(engine);

    const seen = await engine.withRunContext(runOf("wrun_1"), async () => reporter.currentRun());
    expect(seen?.runId).toBe("wrun_1");
  });

  test("a STEP set by one copy is visible to another, which is what `{}` was", async () => {
    // `stepReport()` reads `currentRun()?.step`, and an empty context is what made
    // the narration log-only. Two copies, so this fails against a module-level
    // `new AsyncLocalStorage()`.
    const engine = await loadCopy();
    const reporter = await loadCopy();

    const seen = await engine.withRunContext(runOf("wrun_2"), () =>
      engine.withStepContext(
        { name: "transcribeSegment", key: "transcribeSegment#12", attempt: 2, maxAttempts: 3 },
        async () => reporter.currentRun()?.step,
      ),
    );
    expect(seen).toEqual({
      name: "transcribeSegment",
      key: "transcribeSegment#12",
      attempt: 2,
      maxAttempts: 3,
    });
  });

  test("outside a run BOTH copies agree there is no context", async () => {
    // The other half: a shared store must not invent one either, or a `stepReport()`
    // from a spec would claim a step it is not in.
    const engine = await loadCopy();
    const reporter = await loadCopy();
    expect(engine.currentRun()).toBeUndefined();
    expect(reporter.currentRun()).toBeUndefined();
  });
});
