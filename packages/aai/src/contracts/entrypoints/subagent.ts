// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `subagent`.
 *
 * Delegating a bounded task to a second tool loop with its own context window:
 * the `subagent()` declaration, the options one run takes, and what it answers
 * — its final message plus the shape of the work, never the tool results that
 * stayed inside it. Plus the two ways to CHOOSE one: a call site naming a
 * definition, and a ROSTER the model picks from (`SubagentRoster`,
 * `DELEGATE_TOOL_NAME`).
 *
 * The roster's names are here rather than on `agent`, though `subagents` is an
 * `AgentDef` field — the same call `ctx.delegate` makes in the other direction.
 * A capability is a thing an author writes about, and `SubagentRoster` says
 * nothing without `SubagentDef`; the FIELD's signature is covered by `agent`,
 * whose report names `AgentDef`.
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
  DEFAULT_GUARDRAIL_MAX_RETRIES,
  DELEGATE_TOOL_NAME,
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  type GuardrailVerdict,
  type SubagentAnswer,
  type SubagentDef,
  type SubagentGuardrail,
  type SubagentRoster,
  type SubagentToolCall,
  subagent,
  // The typed half of the surface: a subagent declaring a `schema` answers with
  // a parsed `object`. Both are reached only through `subagent()` and
  // `ctx.delegate`, so they belong to this capability rather than to `tool`.
  type TypedDelegateResult,
  type TypedSubagentDef,
} from "../../index.ts";
