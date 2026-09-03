// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:testing` epoch 4.
 *
 * `runWorkflow` is how a durable workflow is TESTED without a platform, a queue
 * or a sandbox: it starts the declared body against an in-memory journal, walks
 * it to quiescence, and hands back what the run did — its status, its output,
 * every step it journaled, and where it suspended. This is the shape a project
 * copies into `agent.test.ts`. Written the way it was authored at epoch 4, and
 * it must keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 4 survives it
 *
 * An attempt CHARGE became a lease: the two `JournalStore` methods that take one
 * grew a `holder` — the walk that holds the charge — and `claimAttempt` grew a
 * `leaseMs`. This capability's report carries `JournalStore` because
 * `RunWorkflowOptions.journal` takes one and `WorkflowTestHandle.journal` hands
 * one back, so the change reaches a TESTING contract.
 *
 * It breaks nothing a test author writes. Nobody calls `claimAttempt` from a
 * spec — the engine does, while walking the run — and a caller who supplies
 * their own store IMPLEMENTS the interface, where extra parameters are
 * satisfied by a narrower function. What a test reads off `handle.journal` is
 * `readSteps` and `getRun`, neither of which moved. That is what makes this a
 * retain rather than a drop.
 *
 * ## What a `runWorkflow` test is NOT
 *
 * The engine here is real — a real replay against a real journal — but the
 * SUSPENSIONS are driven by the handle rather than by a clock: `advanceSleep`
 * wakes a durable sleep without waiting for it, and `signal` delivers a hook.
 * That is the point (a spec must not wait out a day-long schedule) and it is
 * also the limit: nothing here exercises the platform's queue, its delivery
 * ceiling, or two concurrent walks of one run.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 4 has to be dropped with a reason.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { runWorkflow, type WorkflowTestHandle } from "../../../testing-barrel.ts";

/** ── EDIT: the workflow under test. ────────────────────────────────────── */
const digest = workflow({
  description: "Gather notes on a topic, settle overnight, then write the report",
  input: z.object({ topic: z.string().min(3).describe("What to digest") }),
  // `(input, ctx)` — the INPUT first, which is the order a body is called with.
  run: async (input, ctx) => {
    const found = await ctx.step("gather", async () => `notes about ${input.topic}`);
    // A durable wait, so the run SUSPENDS here rather than blocking. Nothing is
    // holding a sandbox open across it, which is the whole reason a caller can
    // hang up — and `advanceSleep` below is how a spec crosses it.
    await ctx.sleep("settle", 60 * 60 * 1000);
    return await ctx.step("write", async () => `report: ${found}`);
  },
});

/** ── EDIT: the app that declares it. ───────────────────────────────────── */
export const app = workflowApp({
  name: "digest-desk",
  workflows: { digest },
});

/**
 * ── EDIT: what "the run got as far as the wait" means for you. ──────────
 *
 * The suspended shape is worth asserting on its own: every step before the wait
 * is already journaled, so a resume must not run them again. `wakeAt` is what
 * says the run is waiting rather than finished.
 */
export async function untilWait(topic: string): Promise<WorkflowTestHandle<string>> {
  const run = await runWorkflow(digest, { topic }, { name: "digest" });
  if (run.status !== "running" || run.wakeAt === undefined) {
    throw new Error(`expected a suspended run, got ${run.status}`);
  }
  return run;
}

/**
 * ── EDIT: the resume, and the claim that matters about it. ──────────────
 *
 * `advanceSleep` is `ctx.workflows.wakeUp`'s own mechanism, so this is the
 * production wake path rather than a test-only shortcut. What the assertion is
 * for is that the resumed walk ANSWERS `gather` from the journal instead of
 * running it a second time — the whole promise of durable execution.
 */
export async function keysAfterResume(topic: string): Promise<readonly string[]> {
  const run = await untilWait(topic);
  await run.advanceSleep();
  try {
    if (run.status !== "completed") throw new Error(`expected completed, got ${run.status}`);
    // Straight off the handle, and off `run.journal` for anything the handle
    // does not summarize.
    return run.steps.map((step) => step.key);
  } finally {
    // The journal and its timers are the handle's; a spec that leaks one leaks
    // it into the next file.
    await run.close();
  }
}
