// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 4.
 *
 * Epoch 5 changed the VALUE, and so the literal type, of
 * `ASSEMBLYAI_LLM_DEFAULT_MODEL` — `"gpt-5.6-sol"` became
 * `"gemini-3.7-flash"`. No export moved and no signature changed, which is why
 * epoch 4 is RETAINED; `v1.ts` states in full why depending on WHICH id the
 * default is was never a supported promise, and `v3.ts` holds the same line one
 * epoch earlier.
 *
 * ## What THIS epoch promised, which the other two do not pin
 *
 * Epoch 4's default sat INSIDE `TOOLS_REQUIRE_NO_REASONING`, where
 * `reasoning_effort: "none"` is a tool-calling requirement the factory fills in
 * on the author's behalf. Epoch 5's default sits OUTSIDE it, because a Gemini
 * model has no `"none"` level at all and would answer 400 — a bare 500 on the
 * streaming path.
 *
 * So the id moved across the boundary that decides whether the factory fills
 * anything, and the promise worth freezing is the one an author actually
 * relied on either side of it: **`assemblyAILlm()` with no arguments is usable
 * for a TOOL-CALLING agent.** That held at epoch 4 because the fill supplied
 * the required value, and it holds at epoch 5 because the model needs no value
 * — two different mechanisms, one unchanged guarantee. A fixture that pinned
 * the mechanism instead (asserting the descriptor carries `reasoningEffort`)
 * would have reddened on a change that broke nothing.
 *
 * If a later epoch makes the options argument required, removes
 * `reasoningEffort`, or narrows `model` back to the generated union alone, this
 * file reddens — the signal to DROP epoch 4 rather than to edit around it.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 4's
 * does.
 *
 * @module
 */

import { z } from "zod";
import { tool } from "../../../index.ts";
import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  assemblyAILlm,
  type LlmProvider,
} from "../../../sdk/providers/llm-barrel.ts";

/** The bare call, which is the shape the docs lead with. */
export const bare: LlmProvider = assemblyAILlm();

/**
 * A tool beside it, because "usable for a tool-calling agent" is the promise
 * this file exists for and a descriptor alone does not express it.
 */
export const lookup = tool({
  description: "Look up an order.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: ({ orderId }) => ({ orderId, status: "shipped" as const }),
});

/**
 * The default READ as a string — never annotated with the literal, which is
 * the mistake `v1.ts` warns about and the one epoch 5 would have punished.
 */
export const followsTheDefault: string = ASSEMBLYAI_LLM_DEFAULT_MODEL;
