// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 27.
 *
 * A template spec asserting that a `dialog()` gate HELD, as it was written at
 * epoch 27 — drive the tool through the agent's own table, check the answer
 * is a `ToolFailure` by hand, and pin the gate's sentence with a regex the
 * spec spelled itself. It must keep compiling for as long as epoch 27 is
 * advertised as supported.
 *
 * ## What moved, and why epoch 27 survives it
 *
 * Epoch 28 ADDED `expectDialogRefused` and `dialogRefusalPattern`. Additive: no
 * existing signature moved, and nothing a spec already called behaves
 * differently.
 *
 * What the addition replaces is the composition below, which is the whole
 * point of freezing it: seven templates asserted a refusal this way at epoch
 * 27 — an `isToolFailure` guard, a `toBe(true)`, and a hand-written pattern for
 * the sentence the gate writes, two of them re-deriving the JSON escaping an
 * eval reads a tool result through ({@link refusalAt}). Every one of those
 * sites has to keep compiling whether or not it is ever converted.
 *
 * Nothing here names `expectDialogRefused` or `dialogRefusalPattern`.
 *
 * ## Where a break lands
 *
 * {@link refusedAt} is frozen from the CALL side: `toolRunner` ceasing to accept
 * an omitted `args`, `runTool`'s answer narrowing away from `unknown`, or
 * `expectDialogOk` losing the `state` it hands back all redden below. The
 * hand-rolled half is deliberately untyped against this capability — it reads
 * `error` off a `ToolFailure`, which is `aai:utils`'s promise, not this one's.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 27 has to be dropped with a reason.
 */

import {
  createToolContext,
  expectDialogOk,
  type ToolBearingAgent,
  toolRunner,
} from "../../../sdk/testing-barrel.ts";
import { isToolFailure } from "../../../sdk/utils.ts";

/**
 * The gate's own sentence, as an epoch-27 eval spelled it. The character class
 * absorbs the JSON escaping a serialized tool result carries — the state name
 * arrives inside `\"identifying\"` rather than plain quotes.
 */
export const refusalAt = (state: string): RegExp =>
  new RegExp(`Not available yet: this conversation is at [\\\\"]*${state}`);

/**
 * Drive `name` before the dialog has reached its state and read the refusal
 * back — the shape every gated-tool spec had at epoch 27.
 */
export async function refusedAt(
  agentDef: ToolBearingAgent,
  name: string,
  state: string,
): Promise<string | undefined> {
  const run = toolRunner(agentDef);
  const ctx = createToolContext();
  const refused = await run(name, undefined, ctx);
  if (!isToolFailure(refused)) return undefined;
  return refusalAt(state).test(refused.error) ? refused.error : undefined;
}

/**
 * And the success half beside it, so the pair a spec wrote is frozen together:
 * `expectDialogOk` hands back WHERE the dialog landed.
 */
export async function landedAt(agentDef: ToolBearingAgent, name: string): Promise<string> {
  const run = toolRunner(agentDef);
  return expectDialogOk(await run(name, undefined, createToolContext())).state;
}
