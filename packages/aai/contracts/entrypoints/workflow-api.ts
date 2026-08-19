// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `workflow-api`.
 *
 * The workflow HTTP API's client half: the factory, the call set it returns, the
 * options it takes, and the path prefix both ends resolve.
 *
 * Its own capability rather than part of `workflow`, because the two answer to
 * different audiences and would otherwise bump each other. `workflow` is what an
 * `agent.ts` names — `workflow()`, `WorkflowClient`, the run snapshot a tool
 * reads — while this is what something OUTSIDE the agent is written against: a
 * page, a shell script, a cron job. A route added to the API moves this contract
 * and says nothing about how a workflow is declared.
 *
 * Re-exported from `@alexkroman1/aai/workflow-api`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createWorkflowApiClient,
  type UploadBody,
  type UploadOptions,
  type UploadParallel,
  type UploadPartsSettings,
  type UploadProgress,
  type UploadRef,
  WORKFLOW_API_PREFIX,
  type WorkflowApi,
  type WorkflowApiClientOptions,
} from "../../sdk/workflow-api-client.ts";
