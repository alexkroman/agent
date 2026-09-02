// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `workflow`.
 *
 * Serving the workflow HTTP API from a host: the DevKit adapter, the run
 * record it hands back, and the limits a request is held to.
 *
 * Re-exported from `@alexkroman1/aai-runtime`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  DEFAULT_WORKFLOW_FIND_LIMIT,
  ensureWorkflowJournalSchema,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_INPUT_BYTES,
  type WdkAdapter,
  type WdkRunRecord,
  type WdkStreamOptions,
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
  type WorkflowClientOptions,
} from "../../runtime-barrel.ts";
