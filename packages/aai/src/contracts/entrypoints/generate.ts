// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `generate`.
 *
 * `ctx.generate` — one-shot LLM generation from inside a tool body, and the
 * option and result shapes around it. Split out of the `tool` capability for
 * the reason `db` was; that file carries the argument, including why the split
 * does not stop `aai:tool`'s hash from moving with these types.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export type {
  GenerateFn,
  GenerateObjectResult,
  GenerateOptions,
  GenerateResult,
} from "../../index.ts";
