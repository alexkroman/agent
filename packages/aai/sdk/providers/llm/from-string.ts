// Copyright 2026 the AAI authors. MIT license.
/**
 * Model-string shorthand for the `llm` field — `agent({ llm: "..." })` and
 * `ctx.generate({ llm: "..." })` accept a plain model id and desugar it to a
 * gateway descriptor here, at definition time. The descriptor stays the
 * canonical serializable form; a string never reaches the wire.
 *
 * - `"creator/model"` (a slash) routes through the Vercel AI Gateway —
 *   the id shape the AI Gateway and eve use (`"anthropic/claude-sonnet-4-5"`).
 *   Requires `AI_GATEWAY_API_KEY`.
 * - A bare id (`"gpt-5.5"`) routes through the AssemblyAI LLM Gateway on
 *   `ASSEMBLYAI_API_KEY` — the key every published agent already has.
 */

import type { LlmProvider } from "../../providers.ts";
import { assemblyAILlm } from "./assemblyai.ts";
import { gatewayLlm } from "./gateway.ts";

/**
 * One descriptor per model id, so repeated desugaring of the same string
 * yields the same object — `createGenerateFn` memoizes resolved
 * `LanguageModel`s by descriptor identity, which fresh literals would defeat
 * on every `ctx.generate({ llm: "..." })` call.
 */
const byModelId = new Map<string, LlmProvider>();

/** Normalize an `llm` field that may be a model-id string shorthand. */
export function normalizeLlm(llm: LlmProvider | string | undefined): LlmProvider | undefined {
  if (typeof llm !== "string") return llm;
  let descriptor = byModelId.get(llm);
  if (!descriptor) {
    descriptor = llm.includes("/") ? gatewayLlm({ model: llm }) : assemblyAILlm({ model: llm });
    byModelId.set(llm, descriptor);
  }
  return descriptor;
}
