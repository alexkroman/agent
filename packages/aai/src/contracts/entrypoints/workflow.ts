// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `workflow`.
 *
 * DECLARING a durable workflow: the `workflow()` helper, the shape it takes, and
 * the client a tool reaches its runs through.
 *
 * What a RUN is — the option bags, the status union, the snapshot a caller polls
 * and its guard, `WorkflowOutputOf` — is the `workflow-api` capability now.
 * The line is who READS it: an `agent.ts` declares a workflow, and a page, a
 * script or a tool annotating a result reads a run. Those names were on the
 * root barrel, whose membership test is "would an `agent.ts`, a tool module, or
 * a `workflow()` NAME it", and none of them passes it.
 *
 * `WorkflowClient` stays because `ToolContext.workflows` is typed as one, so a
 * tool body annotating its context names it without reaching for a subpath.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  DEFAULT_STEP_MAX_ATTEMPTS,
  // `WorkflowCtx.sleep`'s options. Durable sleep is what makes a replay engine
  // worth having, so its option bag is part of the declaring surface.
  type SleepOptions,
  type StepOptions,
  // The schema-bearing halves of both bags. A step's output and a hook's
  // payload are the two values a body handles that it did not compute, so the
  // option that CHECKS each belongs to the declaring surface beside the bag it
  // extends.
  type StepSchemaOptions,
  // `ctx.waitFor`'s options. A hook's DEADLINE is a parameter rather than a race
  // against `ctx.sleep` — the engine journals one call as one decision, where a
  // race restarts the window on every replay — so it belongs to the declaring
  // surface too.
  type WaitForOptions,
  type WaitForSchemaOptions,
  type WorkflowClient,
  // What a BODY is handed, and the per-step overrides it may pass. They join
  // this capability rather than `workflow-api` by that same test: `ctx.step` is
  // what an author WRITES inside a `workflows/*.ts` module, where a run snapshot
  // is what a page READS. They arrived with the engine that replaced the
  // Workflow DevKit's `"use step"` directive — the durability an author reaches
  // for is a method call now, so it is part of the declaring surface.
  type WorkflowCtx,
  type WorkflowDef,
  workflow,
} from "../../index.ts";
