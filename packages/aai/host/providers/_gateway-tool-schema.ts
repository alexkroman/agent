// Copyright 2026 the AAI authors. MIT license.
/**
 * Strips JSON Schema keywords the AssemblyAI LLM Gateway's Gemini path cannot
 * accept, from the `tools` of an outgoing chat-completions request.
 *
 * The sibling repair in `_openai-stream-repair.ts` fixes the gateway's
 * *responses*; this fixes a *request* it will not accept. Without it, every
 * Gemini model on the gateway is unusable for any agent that has tools —
 * which is every agent this SDK builds.
 *
 * **How it presents, which is the reason this was expensive to find.** The
 * gateway answers `500 "something went wrong"`. A 500 is retryable, so the AI
 * SDK tries three times and surfaces `AI_APICallError: Internal Server Error`.
 * Measured against the studio's starter suite, all eleven runs failed
 * identically at twelve seconds having called no tools — which reads as a
 * lazy or broken model, not as a rejected request. Nothing in the response
 * names a schema, a keyword, or a tool.
 *
 * Two keywords were isolated by bisecting a captured request body against the
 * live gateway, one tool and one field at a time:
 *
 * - **`$schema`** — emitted at the root of every zod-derived tool schema by
 *   the AI SDK's conversion. Present on 9 of 10 studio tools; the only one
 *   that worked was the single hand-written schema that lacks it.
 * - **`propertyNames`** — how `z.record(z.string(), …)` serializes.
 *
 * Both are ordinary JSON Schema that OpenAI, Claude and Qwen all accept
 * (verified), so this rewrites unconditionally rather than sniffing the model
 * name: neither keyword carries information a model uses, the cost is one
 * pass over a small object, and model-sniffing would silently miss whichever
 * Gemini id someone configures next.
 *
 * Not exhaustive — Gemini's function-calling subset rejects more than these
 * two, and `gemini-3.5-flash-lite` still fails with both removed. This
 * handles what the SDK actually emits. Remove it once the gateway either
 * accepts standard JSON Schema or reports what it rejected.
 */

import { safeJsonParse } from "../../sdk/utils.ts";

/** Keywords the gateway's Gemini path rejects outright, with a 500. */
const UNSUPPORTED = new Set(["$schema", "propertyNames"]);

/** Recursive: `propertyNames` shows up on nested properties, not just the root. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key] = prune(child);
  }
  return out;
}

/**
 * Rewrite a chat-completions request body, or return it unchanged.
 *
 * Takes and returns the raw string: the caller has a `BodyInit`, and anything
 * that is not a tool-carrying JSON object must pass through untouched — this
 * sits under every request the provider makes.
 */
export function stripUnsupportedToolSchemaKeywords(body: string): string {
  // Cheap reject before parsing: most requests in a long agent loop are large,
  // and only ones declaring tools can carry the offending keywords.
  if (!body.includes('"tools"')) return body;
  const parsed = safeJsonParse(body);
  if (typeof parsed !== "object" || parsed === null) return body;
  const request = parsed as { tools?: unknown };
  if (!Array.isArray(request.tools)) return body;
  return JSON.stringify({ ...request, tools: prune(request.tools) });
}
