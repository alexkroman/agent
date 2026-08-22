// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 2.
 *
 * Epoch 2 added `createStubWorkflows` — a complete `ctx.workflows` for a test
 * that drives one or two of its methods. Everything epoch 1 could express still
 * compiles (see `./v1.ts`, retained for that reason); this file covers only what
 * epoch 2 added.
 *
 * The point of the helper is that a hand-written stub of this client is a type
 * assertion, and an assertion keeps compiling when the client gains a method —
 * so this example is also the thing that would break if `createStubWorkflows`
 * stopped covering the whole client.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { createStubWorkflows, createToolContext } from "../../../sdk/testing.ts";
import type { WorkflowRunSnapshot } from "../../../sdk/workflow-run.ts";

/** A completed run, annotated so the literal narrows to the union's arm. */
const completedRun: WorkflowRunSnapshot = {
  runId: "wrun_1",
  workflow: "digest",
  createdAt: 0,
  status: "completed",
  output: { ok: true },
};

/** The bare stub: every method present, and rejecting until it is driven. */
export async function unstubbedMethodRejects(): Promise<string> {
  const workflows = createStubWorkflows();
  try {
    await workflows.start("digest", {});
    return "unexpectedly resolved";
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Driving the methods a tool under test reads, and passing it as `ctx`. */
export async function exerciseOverrides(): Promise<string | undefined> {
  const workflows = createStubWorkflows({
    start: async () => "wrun_1",
    get: async () => completedRun,
  });
  const ctx = createToolContext({ workflows });
  const runId: string = await ctx.workflows.start("digest", {});
  const run = await ctx.workflows.get(runId);
  return run?.status;
}

/** `listing` answers rather than rejecting — it is synchronous. */
export function listingIsEmpty(): number {
  return createStubWorkflows().listing().length;
}
