// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `flow`.
 *
 * The dialog statechart: what an agent may do NEXT, declared rather than asked
 * for in prose. A gated tool refuses at EXECUTION when the conversation is
 * somewhere else, and every flow tool's result carries the position it landed
 * in — see `sdk/flow.ts` for why the enforcement point is execution and not the
 * advertised tool list.
 *
 * Its own capability rather than part of `state` even though it is BACKED by a
 * session slot: a slot is where a value lives and this is what may happen next,
 * so an author reaches for them for different reasons and a signature change in
 * one says nothing about the other.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type Flow,
  type FlowOptions,
  type FlowPosition,
  type FlowToolDef,
  type FlowToolResult,
  flow,
} from "../../index.ts";
