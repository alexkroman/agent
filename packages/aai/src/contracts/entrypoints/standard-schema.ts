// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `standard-schema`.
 *
 * The [Standard Schema](https://standardschema.dev) spec types every
 * schema-taking signature in the SDK is written in terms of — `tool()`'s
 * `parameters`, `ctx.generate`'s `schema`, a step's and a workflow's `output`.
 *
 * Its own capability because it is reached by eight others (`generate`, `step`,
 * `step-errors`, `subagent`, `testing`, `tool`, `workflow`, `workflow-api`) and
 * belongs to none of them. Before it had an owner it was on no authoring subpath
 * at all, so each of the eight hashed its body in full and a change to the spec
 * would have been eight classifications; now it is one, and the eight record the
 * name only.
 *
 * `InferSchemaOutput` and `ToolInputSchema` are NOT here: they are the SDK's own
 * types over the spec, and `tool` owns them.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export type {
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from "../../index.ts";
