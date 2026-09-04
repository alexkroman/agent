// Copyright 2026 the AAI authors. MIT license.
/**
 * Rewrites the `tools` of an outgoing chat-completions request into the JSON
 * Schema subset the AssemblyAI LLM Gateway's Gemini path can accept.
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
 * (verified), so those two are removed unconditionally rather than by sniffing
 * the model name: neither keyword carries information a model uses, the cost is
 * one pass over a small object, and model-sniffing would silently miss
 * whichever Gemini id someone configures next. The Gemini layer added since
 * DOES select by model id, and that is not a reversal of this argument — it
 * holds for a rewrite that costs nothing, and every rule in that layer costs
 * something. `_tool-schema-compat.ts` carries the trade.
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
 * provider serializes anything, so the rewrite touches the tool schemas and
 * nothing else. Same rewrite, same application, and the conversation is never
 * re-encoded.
 *
 * The response-side repairs stay in the `fetch` wrapper, and that split is not
 * arbitrary — see `_openai-stream-repair.ts`: those defects break the SDK's own
 * SSE parser, so there is no parsed stream part for a `wrapStream` to fix.
 * Bytes are genuinely the only place to catch them. A REQUEST defect has a
 * typed representation, so it belongs where the types are.
 *
 * Those two are where this started and they are no longer all of it. Gemini's
 * function-calling subset rejects more than them — `gemini-3.5-flash-lite`
 * still failed with both removed — so the rewrite is now a two-layer
 * PROVIDER-COMPAT table in `_tool-schema-compat.ts`: the unconditional pair
 * above, plus a Gemini layer selected by model id, whose rules fold a
 * constraint into the schema's `description` rather than deleting it outright.
 * That module's doc carries which keyword each rule exists for, what is
 * measured versus taken from Mastra's Google layer, and the three gaps that
 * remain. Remove all of it once the gateway either accepts standard JSON
 * Schema or reports what it rejected.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { LanguageModelMiddleware } from "ai";
import type { JSONSchema7 } from "json-schema";
import { toolSchemaRules } from "./_tool-schema-compat.ts";
import { rewriteToolSchema, type SchemaRule } from "./_tool-schema-walk.ts";

/**
 * Answers already given, keyed by the rule set and then by the schema OBJECT.
 *
 * `toVercelTools` builds a session's tool set once and the AI SDK hands the same
 * `inputSchema` object to every request, so without this the whole schema is
 * deep-walked per LLM request — several times a turn, on the time-to-first-token
 * path, for every agent on the default gateway provider. `rewriteToolSchema`
 * allocates per nested object before deciding to return its input, so even the
 * already-clean fast path pays the walk plus its garbage.
 *
 * **Two levels, because the answer depends on the RULES as well as the schema.**
 * The rewrite is selected by model id, so one schema has a different answer
 * under the Gemini layer than under the unconditional one — a cache keyed on the
 * schema alone would serve a Gemini-folded schema to an OpenAI call the moment
 * an agent used two models. That is safe to key on by identity because
 * `toolSchemaRules` returns one of exactly two module-level constants, never a
 * per-call array.
 *
 * `WeakMap` rather than a cache with a policy, at both levels: the entry dies
 * with the schema, which dies with the session. Result IDENTITY is preserved,
 * which is what `gatewayToolSchemaMiddleware`'s `tool !== tools[i]` check rests
 * on — a memo that returned an equal-but-fresh object would make every request
 * look rewritten.
 */
const rewritten = new WeakMap<object, WeakMap<object, JSONSchema7>>();

/** {@link rewriteToolSchema}, walked once per (rule set, schema object). */
function rewriteOnce(schema: JSONSchema7, rules: readonly SchemaRule[]): JSONSchema7 {
  // A boolean schema is legal JSON Schema and cannot be a `WeakMap` key.
  if (!isRecord(schema)) return rewriteToolSchema(schema, rules);
  let bySchema = rewritten.get(rules);
  if (bySchema === undefined) {
    bySchema = new WeakMap<object, JSONSchema7>();
    rewritten.set(rules, bySchema);
  }
  const memo = bySchema.get(schema);
  if (memo !== undefined) return memo;
  const answer = rewriteToolSchema(schema, rules);
  bySchema.set(schema, answer);
  return answer;
}

/**
 * Middleware that rewrites every function tool's input schema for the model the
 * call is going to.
 *
 * Only `type: "function"` tools are rewritten. A provider-defined tool carries
 * vendor arguments rather than a converted zod schema, so it is neither a source
 * of these keywords nor something to walk blindly — and the gateway serves
 * chat-completions, where provider tools do not arise at all.
 *
 * The model id comes from the call rather than from the descriptor that built
 * the provider, because that is the id the request is actually for; a wrapped
 * model reports its own. An id the vendor's type promises and the runtime does
 * not supply resolves to the unconditional layer, which is the safe half.
 */
export function gatewayToolSchemaMiddleware(): LanguageModelMiddleware {
  return {
    transformParams: ({ params, model }) => {
      const { tools } = params;
      if (!tools || tools.length === 0) return Promise.resolve(params);
      const rules = toolSchemaRules(model.modelId);
      const pruned = tools.map((tool) => {
        if (tool.type !== "function") return tool;
        const inputSchema = rewriteOnce(tool.inputSchema, rules);
        return inputSchema === tool.inputSchema ? tool : { ...tool, inputSchema };
      });
      // Identity when every schema was already clean — see `rewriteToolSchema`.
      return Promise.resolve(
        pruned.some((tool, i) => tool !== tools[i]) ? { ...params, tools: pruned } : params,
      );
    },
  };
}
