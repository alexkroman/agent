// Copyright 2026 the AAI authors. MIT license.
/**
 * What a CANCEL does to a walk: it stops before the next step, and it ends a
 * retry's backoff rather than waiting it out.
 *
 * Out of `workflow/replay.test.ts`, which sits at the test-file line cap; the
 * walk's signal is one concern and reads as one.
 */

import { publishStepReporter } from "@alexkroman1/aai/host-internal";
import { RetryableError } from "@alexkroman1/aai/step-errors";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createMemoryJournal } from "../journal/backends/memory.ts";
import type { JournalStore } from "../journal/types.ts";
import { replayRun } from "../replay.ts";

/** A journal holding the one run these specs walk. */
async function seed(): Promise<{ journal: JournalStore }> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return { journal };
}

/** Swallow the engine's retry narration, which an unpublished slot prints. */
function quietReporter(): void {
  publishStepReporter(async () => undefined);
  onTestFinished(() => publishStepReporter(undefined));
}

describe("cancellation", () => {
  test("stops before the next step and propagates the abort", async () => {
    const { journal } = await seed();
    const controller = new AbortController();
    const second = vi.fn(() => "should not run");
    await expect(
      replayRun({
        runId: "wrun_1",
        workflow: "digest",
        input: {},
        journal,
        signal: controller.signal,
        run: async (_input, ctx) => {
          await ctx.step("first", () => "ran");
          controller.abort();
          await ctx.step("second", second);
        },
      }),
    ).rejects.toThrow();
    expect(second).not.toHaveBeenCalled();
  });

  test("a cancel during a retry's BACKOFF ends the walk without waiting it out", async () => {
    quietReporter();
    const { journal } = await seed();
    const controller = new AbortController();
    const reason = new Error("cancelled mid-backoff");
    let calls = 0;
    // No clock read: the backoff is 60s against the unit tier's 5s budget, so a
    // walk that waited it out fails this spec by timing out.
    const walk = replayRun({
      runId: "wrun_1",
      workflow: "digest",
      input: {},
      journal,
      signal: controller.signal,
      run: (_input, ctx) =>
        ctx.step("flaky", () => {
          calls++;
          // Aborted a tick after the throw, so the cancel lands inside the wait.
          setTimeout(() => controller.abort(reason), 0);
          throw new RetryableError("later", { retryAfter: 60_000 });
        }),
    });
    await expect(walk).rejects.toBe(reason);
    expect(calls).toBe(1);
  });
});
