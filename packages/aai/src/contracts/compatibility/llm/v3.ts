// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 3.
 *
 * Epoch 4 changed exactly one thing an author can observe, and it is the same
 * one epoch 2 changed: the VALUE, and so the literal type, of
 * `ASSEMBLYAI_LLM_DEFAULT_MODEL` — `"gpt-5.6-luna"` became `"gpt-5.6-sol"`.
 * The export list is unchanged and no signature moved, which is why epoch 3 is
 * RETAINED rather than dropped — the same call epoch 1 got, for the same
 * reason, and `v1.ts` states the argument in full.
 *
 * The promise is therefore the narrow one `v1.ts` already holds, and this file
 * holds it at the next epoch: an author who selected a model, tuned it,
 * pointed a stage at another account, or read the default still compiles.
 * Depending on WHICH id the default is was never safe and is what this file
 * must not do.
 *
 * ## What differs from `v1.ts`, so the two are not one file twice
 *
 * Epoch 3 is where the generated union CHANGED rather than grew: `kimi-k2.5`
 * was retired by the gateway and `qwen3.5-4b-32k-experimental` was renamed
 * `-fast` upstream, which is why epoch 2 was dropped rather than retained. So
 * what this file pins is the property that made that survivable — **`model`
 * accepts a plain string as well as the union**, so an id leaving the snapshot
 * is a stale value rather than a broken build. `v1.ts` pins the union arm;
 * this one pins that the two arms still coexist, and that the reasoning knob
 * the `gpt-5.6` family needs is still expressible.
 *
 * If a later epoch narrows `model` back to the union alone, drops
 * `reasoningEffort`, or removes the gateway URL constants, this file reddens —
 * the signal to DROP epoch 3 rather than to edit around it.
 *
 * **Its specifiers are RELATIVE.** Importing the package by name would resolve
 * through its own `exports` map to whatever the current build publishes, so the
 * fixture would prove the CURRENT surface compiles rather than that epoch 3's
 * does.
 *
 * @module
 */

import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  type AssemblyAIGatewayModel,
  type AssemblyAILlmOptions,
  type AssemblyAIReasoningEffort,
  assemblyAILlm,
  type LlmProvider,
} from "../../../sdk/providers/llm-barrel.ts";

/**
 * The default is READ, never asserted. Typed `string` deliberately: an epoch-3
 * binding annotated `"gpt-5.6-luna"` would have reddened on epoch 4, and that
 * was never a promise the SDK made.
 */
export const followsTheDefault: string = ASSEMBLYAI_LLM_DEFAULT_MODEL;

/** An id off the generated union, which is the autocomplete arm. */
const listed: AssemblyAIGatewayModel = "claude-sonnet-4-6";

/**
 * And an id that is NOT on it — the arm that made epoch 3's union churn
 * survivable. A model the gateway retires leaves an author with a stale value,
 * not a build error.
 */
const unlisted = "some-future-model";

export const both: readonly LlmProvider[] = [
  assemblyAILlm({ model: listed }),
  assemblyAILlm({ model: unlisted }),
];

/**
 * The reasoning knob, named through its published type. On the `gpt-5.6`
 * family `"none"` is a tool-calling REQUIREMENT rather than a tuning choice
 * (the factory fills it for those ids), and an author who wrote it out
 * explicitly at epoch 3 still compiles.
 */
const off: AssemblyAIReasoningEffort = "none";

/** A fully-specified stage, built as a typed options value and passed in. */
const opts: AssemblyAILlmOptions = {
  model: "gpt-5.6-terra",
  reasoningEffort: off,
  gatewayUrl: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  apiKeyEnv: "SECOND_ACCOUNT_KEY",
};

export const tuned: LlmProvider = assemblyAILlm(opts);
