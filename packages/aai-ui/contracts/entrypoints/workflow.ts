// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `workflow`.
 *
 * The browser half of durable workflows: the HTTP client over the workflow API,
 * the hooks that start a run and watch it, and the types that narrow a
 * completed run's output.
 *
 * Distinct from `aai:workflow`, which is the same concept from the other side
 * of the wire — `workflow()` declares one, this reaches it. The two share three
 * names (`isTerminal`, `WorkflowSummary`, `WorkflowOutputOf`, re-exported here
 * from the SDK) and are separately versioned, because a change can break an
 * author on one side and not the other.
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createWorkflowApi,
  DEFAULT_WORKFLOW_POLL_MS,
  isTerminal,
  MAX_MISSING_READS,
  type UseWorkflowRunResult,
  type UseWorkflowSubmitOptions,
  type UseWorkflowsOptions,
  type UseWorkflowsResult,
  useWorkflowRun,
  useWorkflowSubmit,
  useWorkflows,
  type WorkflowApi,
  type WorkflowApiOptions,
  type WorkflowOutputOf,
  type WorkflowRun,
  type WorkflowSubmission,
  type WorkflowSummary,
} from "../../index.ts";
