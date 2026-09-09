// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `coding`.
 *
 * The workspace tool set an agent that edits CODE is given: read, search,
 * write, edit, delete, run a command, keep a plan. `createCodingTools` is the
 * whole of it — a host names a directory and gets a registry keyed by the names
 * the model calls.
 *
 * It is contracted because the SHAPE is the promise, in two directions at once.
 * A template's `tools/read_file.ts` default-exports one entry of the record, so
 * a name changing here is a tool disappearing from somebody's agent; and the
 * three seams a host fills in — `validate`, `afterWrite`, `env` — are called
 * with arguments an author's own code has to declare, so a signature change
 * there breaks a workspace nobody rebuilt.
 *
 * The prose and the numbers ride along deliberately.
 * `CODING_TOOL_DESCRIPTIONS` is what a host MERGES its own overrides over, and
 * the four limits are what such an override has to quote — a description
 * naming a different number than the code enforces is worse than one naming
 * none, and a host cannot keep them in step with a constant it cannot import.
 *
 * What is NOT here is the machinery underneath — the edit matcher, the grep,
 * the capped child-process runner. Those are on
 * `@alexkroman1/aai/host-internal`, outside every contract, because their
 * reader is the framework rather than an author.
 *
 * Re-exported from `@alexkroman1/aai/coding-tools`. This file is not shipped
 * and nothing imports it — it exists so `pnpm check:api-contracts` can extract
 * a report for this capability alone, hash it, and hold it to a committed
 * epoch. See `scripts/api-contracts.mjs`.
 */

export {
  BASH_TIMEOUT_MAX_MS,
  BASH_TIMEOUT_MS,
  CODING_TOOL_DESCRIPTIONS,
  type CodingToolName,
  type CodingToolsOptions,
  createCodingTools,
  GLOB_LIMIT,
  READ_LIMIT,
} from "../../host/coding-tools-barrel.ts";
