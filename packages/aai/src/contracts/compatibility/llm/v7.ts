// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:llm` epoch 7.
 *
 * Epoch 8 ADDED a vendor — `cerebrasLlm`, `CerebrasLlmOptions` and
 * `CEREBRAS_BASE_URL`. Nothing moved and nothing was removed, which is why
 * epoch 7 is RETAINED.
 *
 * ## What an additive vendor quietly depends on, and what no other fixture pins
 *
 * The four retained epochs before this one are all about the ASSEMBLYAI stage:
 * `v1.ts` argues why the default's identity was never a promise, `v3.ts` pins
 * that `model` still takes a plain string beside the generated union, `v4.ts`
 * pins the bare factory across the `TOOLS_REQUIRE_NO_REASONING` boundary,
 * `v5.ts` pins `"low"` as a first-class effort, and `v6.ts` pins that
 * `options.model` is POPULATED rather than left for the host.
 *
 * None of them says the thing epoch 8 rested on: that **every vendor factory
 * on this surface answers the same `LlmProvider`** — one `kind` discriminant
 * plus an `options` bag — so a new vendor is reachable by naming a factory and
 * changes nothing about how an existing one is written or read. That uniformity
 * is the whole reason adding Cerebras was additive rather than an epoch that
 * re-split `ModelOptions` across every call site, and it is what the barrel's
 * own doc means by "every vendor still gets a NAME for its own options".
 *
 * So this file pins the SHAPE across vendors rather than any one vendor's
 * behaviour: several factories, each assigned to the same `LlmProvider` type,
 * each read back the same two ways. It reddens if a vendor's factory stops
 * answering `LlmProvider`, if `kind` is renamed, or if `options` stops being a
 * plain bag — any of which is the signal to DROP epoch 7 rather than edit
 * around it.
 *
 * Note what it deliberately does NOT do: compare a `kind` against a `*_KIND`
 * constant. Those tags live on `/host-internal`, and a fixture for the
 * AUTHORING surface may not reach there — the same boundary `v6.ts` records.
 *
 * **Its specifiers are RELATIVE**, for the reason `v1.ts` gives.
 *
 * @module
 */

import {
  anthropicLlm,
  assemblyAILlm,
  groqLlm,
  type LlmProvider,
  openRouterLlm,
} from "../../../sdk/providers/llm-barrel.ts";

/**
 * One type for every vendor. The annotation is the assertion: if any factory
 * stopped answering `LlmProvider`, this array would not compile.
 */
export const everyVendor: readonly LlmProvider[] = [
  assemblyAILlm(),
  anthropicLlm({ model: "claude-sonnet-4-6" }),
  groqLlm({ model: "llama-3.3-70b-versatile" }),
  openRouterLlm({ model: "meta-llama/llama-3.3-70b-instruct" }),
];

/** And each is read back the same two ways, whoever serves it. */
export const kinds: readonly string[] = everyVendor.map((one) => one.kind);
export const models: readonly unknown[] = everyVendor.map(
  (one) => (one.options as { model?: unknown }).model,
);
