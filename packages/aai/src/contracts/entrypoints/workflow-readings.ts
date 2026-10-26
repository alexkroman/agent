// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `workflow-readings`.
 *
 * A workflow read back off a DECLARATION: the `…Of<typeof def>` types a body
 * (`WorkflowInputOf`), a page (`WorkflowOutputOf`, `WorkflowRunOf`) and a
 * status tool annotate with, and the four readings through the AGENT def that
 * a page's hooks (`useWorkflowSubmit<typeof agentDef>("digest")`) and a spec's
 * `runWorkflow` are parameterized by (`WorkflowAppLike`, `WorkflowsOf`,
 * `WorkflowNameOf`, `WorkflowDefOf`), plus `workflowNameOf(def)`, the declared
 * name read back at runtime.
 *
 * Its own capability rather than part of `workflow-api` for two reasons: that
 * capability is at its export budget, and these move with the DECLARATION
 * (`aai:workflow`, `aai:agent`) rather than with the client — none of them is
 * reached by a client call, so `check:api-shape` lists each as an orphan by
 * design. `@alexkroman1/aai-ui` re-exports the four agent-def readings for its
 * hooks and `<WorkflowFields>`.
 *
 * Re-exported from `@alexkroman1/aai/workflow-api` (the three `…Of<typeof def>`
 * helpers also from the root). This file is not shipped and nothing imports it
 * — it exists so `pnpm check:api-contracts` can extract a report for this
 * capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type WorkflowAppLike,
  type WorkflowDefOf,
  type WorkflowInputOf,
  type WorkflowNameOf,
  type WorkflowOutputOf,
  type WorkflowRunOf,
  type WorkflowsOf,
  workflowNameOf,
} from "../../sdk/workflow-api-barrel.ts";
