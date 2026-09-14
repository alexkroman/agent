// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 5.
 *
 * Epoch 6 changed the VALUE, and so the literal type, of
 * `ASSEMBLYAI_LLM_DEFAULT_MODEL` — `"gemini-3.7-flash"` became
 * `"qwen3-next-80b-a3b"`. No export moved and no signature changed, which is
 * why epoch 5 is RETAINED. `v1.ts` argues in full why depending on WHICH id
 * the default is was never a supported promise.
 *
 * ## What is distinct about epoch 5, so this is not `v3.ts`/`v4.ts` again
 *
 * Three consecutive epochs moved this one default, and a fixture per epoch is
 * only worth its bytes if each pins a different promise. `v3.ts` pins that
 * `model` still takes a plain string as well as the generated union; `v4.ts`
 * pins that the bare factory is usable for a TOOL-CALLING agent across the
 * `TOOLS_REQUIRE_NO_REASONING` boundary.
 *
 * Epoch 5's default was a GEMINI id — the one family that refuses
 * `reasoningEffort: "none"` — so `assemblyAIPipeline()` passed `"low"` while
 * it stood. What an epoch-5 author could therefore have written, and what this
 * file pins, is that **`"low"` is a first-class `AssemblyAIReasoningEffort`**
 * and a descriptor carrying it still compiles. Epoch 6 stops USING that value
 * in the preset; it must not stop ACCEPTING it, because the authors who copied
 * the preset while epoch 5 was current wrote it into their own agents.
 *
 * If a later epoch narrows `AssemblyAIReasoningEffort`, drops
 * `reasoningEffort`, or makes the options argument required, this file reddens
 * — the signal to DROP epoch 5 rather than to edit around it.
 *
 * **Its specifiers are RELATIVE**, for the reason `v1.ts` gives.
 *
 * @module
 */

import {
  type AssemblyAIReasoningEffort,
  assemblyAILlm,
  type LlmProvider,
} from "../../../sdk/providers/llm-barrel.ts";

/** Every level the type admits, named — the union is the promise. */
const levels: readonly AssemblyAIReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

/** The value the preset itself carried at epoch 5. */
const asEpoch5Shipped: AssemblyAIReasoningEffort = "low";

/**
 * A stage built the way an author who copied the epoch-5 preset would have
 * built it. Still legal; whether the id it names WANTS that value is a
 * property of the id, which is exactly what the constant's doc is for.
 */
export const tunedLikeEpoch5: LlmProvider = assemblyAILlm({
  model: "gemini-3.7-flash",
  reasoningEffort: asEpoch5Shipped,
});

/** And each level remains expressible on its own. */
export const everyLevel: readonly LlmProvider[] = levels.map((reasoningEffort) =>
  assemblyAILlm({ reasoningEffort }),
);
