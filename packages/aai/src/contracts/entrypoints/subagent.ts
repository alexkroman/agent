// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `subagent`.
 *
 * The `speaker()` definition — one for every second voice, on the line or off
 * it — and the off-line run `ctx.delegate` makes of one: the options it takes
 * and what it answers (its final message plus the shape of the work, never the
 * tool results that stayed inside it). The ROSTER that routes between speakers
 * is `persona`'s.
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
  DEFAULT_GUARDRAIL_MAX_REVISIONS,
  DELEGATE_TOOL_NAME,
  type DelegateAnswer,
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  type DelegateToolCall,
  type GuardrailVerdict,
  type SpeakerDef,
  type SpeakerGuardrail,
  speaker,
  // The typed half of the surface: a speaker declaring a `schema` answers with
  // a parsed `object`. Both are reached only through `speaker()` and
  // `ctx.delegate`, so they belong to this capability rather than to `tool`.
  type TypedDelegateResult,
  type TypedSpeakerDef,
} from "../../index.ts";
