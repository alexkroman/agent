// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `subagent`.
 *
 * Delegating a bounded task to a second tool loop with its own context window:
 * the `subagent()` declaration, the options one run takes, and what it answers
 * — its final message plus the shape of the work, never the tool results that
 * stayed inside it.
 *
 * Its own capability rather than part of `tool`, and the reason is the one the
 * root guide gives for naming capabilities at all: `tool` is what an author
 * writes to be CALLED, this is what an author writes to CALL a model, and the
 * two move for different reasons. `ctx.delegate` itself belongs to `tool` —
 * it is a field of `ToolContext`, and a signature change there is a change to
 * the tool contract whatever it is a field of.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  type SubagentDef,
  type SubagentToolCall,
  subagent,
} from "../../index.ts";
