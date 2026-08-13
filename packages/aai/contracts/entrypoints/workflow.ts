// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `workflow`.
 *
 * Durable workflows: the `workflow()` helper, the client a tool reaches them
 * through, and the run snapshot a caller polls.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AnyWorkflowDef,
  clampWorkflowWait,
  type FindOptions,
  isTerminal,
  MAX_WORKFLOW_WAIT_MS,
  type StartOptions,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminalWorkflowRun,
  type WorkflowBody,
  type WorkflowClient,
  type WorkflowDef,
  type WorkflowOutputOf,
  type WorkflowRunBase,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
  type WorkflowSummary,
  workflow,
} from "../../index.ts";
