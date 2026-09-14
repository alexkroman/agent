// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 6.
 *
 * Epoch 7 changed the VALUE, and so the literal type, of
 * `ASSEMBLYAI_LLM_DEFAULT_MODEL` — `"qwen3-next-80b-a3b"` became
 * `"gpt-5.6-luna"`, returning it to the only id measured on answer quality
 * (that constant's doc carries the numbers). No export moved and no signature
 * changed, which is why epoch 6 is RETAINED.
 *
 * ## Four epochs moved this one default, so what is left to pin
 *
 * `v1.ts` argues why depending on WHICH id the default is was never a
 * supported promise. `v3.ts` pins that `model` still takes a plain string as
 * well as the generated union. `v4.ts` pins that the bare factory is usable
 * for a tool-calling agent across the `TOOLS_REQUIRE_NO_REASONING` boundary.
 * `v5.ts` pins that `"low"` remains a first-class effort after the preset
 * stopped using it.
 *
 * What is left, and what every one of those moves quietly relied on, is the
 * DESCRIPTOR's shape: `assemblyAILlm()` answers an `LlmProvider` whose `kind`
 * identifies the resolver and whose `options.model` is always POPULATED — the
 * factory resolves the default eagerly rather than leaving the field absent
 * for the host to fill. That is what lets `describeResolvedProviders` print
 * the effective model in the boot line, and what lets a caller read back the
 * id it is about to run without knowing whether it named one. It held across
 * all four moves and no other fixture states it.
 *
 * If a later epoch makes `options.model` optional on the resolved descriptor,
 * renames `kind`, or defers the default to the host, this file reddens — the
 * signal to DROP epoch 6 rather than to edit around it.
 *
 * **Its specifiers are RELATIVE**, for the reason `v1.ts` gives.
 *
 * @module
 */

import { assemblyAILlm, type LlmProvider } from "../../../sdk/providers/llm-barrel.ts";

/** The bare call resolves a model rather than leaving the field absent. */
const resolved: LlmProvider = assemblyAILlm();

/** Both halves of the descriptor, read the way a boot line reads them. */
export const kind: string = resolved.kind;
export const model: unknown = (resolved.options as { model?: unknown }).model;

/**
 * The kind is READ but not compared against a constant: the `*_KIND` tags are
 * on `/host-internal`, and a fixture for the AUTHORING surface may not reach
 * there — which is itself part of what this file pins.
 */

/** And an explicitly-named model resolves to itself, not to the default. */
export const named: LlmProvider = assemblyAILlm({ model: "claude-sonnet-4-6" });
