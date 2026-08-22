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
 * ## It is MIDDLEWARE, and the difference is the size of what it touches
 *
 * This began as a `fetch` wrapper (`repairOpenAiStream`'s request half), which
 * meant the only thing it had to work with was the serialized body: any request
 * whose text contained `"tools"` was `JSON.parse`d, walked, and re-stringified.
 * That body is the WHOLE CONVERSATION — every message, every tool result, every
 * tsc diagnostic dump the studio's build loop accumulated — parsed and
 * re-serialized on every step of every turn, to delete two keywords from a small
 * object near the end of it. The `body.includes('"tools"')` guard was there to
 * limit the damage and cannot: a tool-using agent declares tools on every
 * request it ever makes.
 *
 * `transformParams` is handed `params.tools` as structured objects, BEFORE the
 * provider serializes anything, so the prune touches the tool schemas and
 * nothing else. Same rewrite, same unconditional application, and the
 * conversation is never re-encoded.
 *
 * The response-side repairs stay in the `fetch` wrapper, and that split is not
 * arbitrary — see `_openai-stream-repair.ts`: those defects break the SDK's own
 * SSE parser, so there is no parsed stream part for a `wrapStream` to fix.
 * Bytes are genuinely the only place to catch them. A REQUEST defect has a
 * typed representation, so it belongs where the types are.
 *
 * Not exhaustive — Gemini's function-calling subset rejects more than these
 * two, and `gemini-3.5-flash-lite` still fails with both removed. This
 * handles what the SDK actually emits. Remove it once the gateway either
 * accepts standard JSON Schema or reports what it rejected.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { LanguageModelMiddleware } from "ai";
import type { JSONSchema7 } from "json-schema";

/** Keywords the gateway's Gemini path rejects outright, with a 500. */
const UNSUPPORTED = new Set(["$schema", "propertyNames"]);

/**
 * Recursive: `propertyNames` shows up on nested properties, not just the root.
 *
 * Returns the input by IDENTITY when nothing was removed, so a request whose
 * schemas are already clean — every non-zod-derived tool, and every tool at all
 * once the gateway is fixed — allocates nothing and leaves `params` untouched.
 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune);
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED.has(key)) {
      changed = true;
      continue;
    }
    const pruned = prune(child);
    if (pruned !== child) changed = true;
    out[key] = pruned;
  }
  return changed ? out : value;
}

/**
 * Prune the unsupported keywords from a single tool input schema.
 *
 * Exported for the spec, which is about which keywords survive rather than
 * about how a call's parameters are assembled.
 */
export function pruneToolSchema(schema: JSONSchema7): JSONSchema7 {
  return prune(schema) as JSONSchema7;
}

/**
 * Middleware that prunes the unsupported keywords from every function tool's
 * input schema.
 *
 * Only `type: "function"` tools are rewritten. A provider-defined tool carries
 * vendor arguments rather than a converted zod schema, so it is neither a source
 * of these keywords nor something to walk blindly — and the gateway serves
 * chat-completions, where provider tools do not arise at all.
 */
export function gatewayToolSchemaMiddleware(): LanguageModelMiddleware {
  return {
    transformParams: ({ params }) => {
      const { tools } = params;
      if (!tools || tools.length === 0) return Promise.resolve(params);
      const pruned = tools.map((tool) => {
        if (tool.type !== "function") return tool;
        const inputSchema = pruneToolSchema(tool.inputSchema);
        return inputSchema === tool.inputSchema ? tool : { ...tool, inputSchema };
      });
      // Identity when every schema was already clean — see `prune`.
      return Promise.resolve(
        pruned.some((tool, i) => tool !== tools[i]) ? { ...params, tools: pruned } : params,
      );
    },
  };
}
