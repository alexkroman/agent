// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/testing` — driving a DURABLE workflow run from a
 * spec.
 *
 * The one thing an agent author could not test. A workflow's steps are ordinary
 * exported functions and its declaration is a value, so both have always been
 * reachable from a vitest file; the BODY takes a `ctx` only an engine
 * constructs. `@alexkroman1/aai/testing`'s `createWorkflowContext` gives it one that
 * records — which is the right tool for asserting what a body ASKED FOR, and
 * says outright that it is not a durability test — and this gives it the real
 * engine, over the memory journal, so a spec can assert that a run slept,
 * resumed, retried, was answered, and survived a dead worker.
 *
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 *
 * const approve = workflow({
 *   description: "Hold a draft until a reviewer answers.",
 *   run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval:1"),
 * });
 *
 * const run = await runWorkflow(approve, { draft: "…" }, { name: "approve" });
 * console.log(run.status); // "running" — parked on the reviewer
 *
 * await run.signal("approval:1", { approved: true });
 * console.log(run.status); // "completed"
 * ```
 *
 * ## Why it is on the RUNTIME rather than beside `createWorkflowContext`
 *
 * `@alexkroman1/aai` is the shared core and imports no sibling package — a hard
 * boundary this repo checks with `konsistent`, and one the engine sits on the
 * far side of. The engine, the journal and `createInProcessWorkflowEngine` are
 * `@alexkroman1/aai-runtime`'s, so a helper that runs a real one has to live
 * here. The split a template sees is therefore: `@alexkroman1/aai/testing` for
 * the CONTEXT (no journal, one walk, everything recorded), this for the ENGINE
 * (a journal, real replays, real suspensions).
 *
 * ## Runner-agnostic, deliberately
 *
 * Nothing here installs a global or owns a lifetime a runner has to unwind —
 * the driver injects its own dispatcher, so no timer is ever armed — which is
 * this repo's rule for what may stay off a `/vitest` subpath. It works from any
 * harness.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module testing
 */

export {
  DEFAULT_MAX_DELIVERIES,
  runWorkflow,
} from "./testing/run-workflow.ts";
export type {
  RunWorkflowOptions,
  WorkflowTestHandle,
  WorkflowTestRead,
  WorkflowTestRun,
  WorkflowTestStep,
} from "./testing/run-workflow-types.ts";
