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
 * script or a tool annotating a result reads a run. Those seventeen names were
 * on the root barrel, whose membership test is "would an `agent.ts`, a tool
 * module, or a `workflow()` NAME it", and none of them passes it.
 *
 * `WorkflowClient` stays because `ToolContext.workflows` is typed as one, so a
 * tool body annotating its context names it without reaching for a subpath.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { type WorkflowClient, type WorkflowDef, workflow } from "../../index.ts";
