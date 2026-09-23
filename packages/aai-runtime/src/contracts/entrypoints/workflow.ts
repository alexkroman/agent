// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `workflow`.
 *
 * Serving the workflow HTTP API from a host: its prefix, the token that closes
 * it, the journal schema a self-hosted operator applies, and the limits a
 * request is held to.
 *
 * The engine adapter (`WdkAdapter`, its run record and stream options) and the
 * client's options bag are no longer here: `createWorkflowClient`, the one
 * thing that takes them, is unexported, so a host could assemble the bag and
 * hand it to nothing. They are relative-import internals now.
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
  WORKFLOW_API_PREFIX,
  WORKFLOW_API_TOKEN_ENV,
} from "../../runtime-barrel.ts";
