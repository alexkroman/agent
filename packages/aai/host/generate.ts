// Copyright 2026 the AAI authors. MIT license.
/**
 * Host-side implementation of the `ctx.generate` capability
 * (see `sdk/generate.ts` for the contract).
 *
 * One implementation, two call sites — the self-hosted tool executor calls
 * it in-process, and the platform's sandbox sidecar exposes it to the guest
 * as the `llm/generate` RPC — so the two execution modes cannot drift on
 * what a generation call accepts or resolves. Descriptors resolve through
 * the same `resolveLlm` registry as the pipeline's own model, with
 * credentials from the agent's env (never `process.env`).
 */

import { generateObject, generateText, jsonSchema, type LanguageModel } from "ai";
import type { GenerateOptions, GenerateResult } from "../sdk/generate.ts";
import type { LlmProvider } from "../sdk/providers.ts";
import { resolveLlm } from "./providers/resolve.ts";

/**
 * A {@link GenerateFn} with an extra per-call options bag: the tool executor
 * binds the issuing turn's abort signal so an in-flight generation stops on
 * barge-in / reset / session stop.
 */
export type HostGenerateFn = (
  options: GenerateOptions,
  callOpts?: { signal?: AbortSignal | undefined },
) => Promise<GenerateResult>;

export type CreateGenerateFnOptions = {
  /**
   * Default LLM descriptor — the agent's own pipeline `llm`. Callers may
   * override per call via `GenerateOptions.llm`. When neither is present a
   * generation call fails with a descriptive error (S2S agents must name a
   * provider explicitly).
   */
  llm?: LlmProvider | undefined;
  /** Env the provider credential resolves from (agent env / providerEnv). */
  env: Record<string, string>;
};

function isDescriptor(value: unknown): value is LlmProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Reject Zod schemas up front — they'd work here but not across the sandbox
 *  RPC boundary, which is exactly the works-in-dev/fails-in-prod drift the
 *  policy modules exist to prevent. */
function assertJsonSchema(schema: Record<string, unknown>): void {
  if (typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    throw new Error(
      "generate: `schema` must be a plain JSON Schema object, not a Zod schema — " +
        "convert with z.toJSONSchema(), or use the @alexkroman1/aai/workflow helpers.",
    );
  }
}

/**
 * Build the host generate function for one agent.
 *
 * Models resolve lazily and are memoized per descriptor object, so repeated
 * workflow calls against the same provider reuse one client.
 */
export function createGenerateFn(opts: CreateGenerateFnOptions): HostGenerateFn {
  const models = new WeakMap<LlmProvider, LanguageModel>();

  const resolveModel = (descriptor: LlmProvider | undefined): LanguageModel => {
    if (!(descriptor && isDescriptor(descriptor))) {
      throw new Error(
        "generate: no LLM configured. Pass an `llm` descriptor in the generate " +
          "options (from @alexkroman1/aai/llm), or run the agent in pipeline mode.",
      );
    }
    const cached = models.get(descriptor);
    if (cached) return cached;
    const model = resolveLlm(descriptor, opts.env);
    models.set(descriptor, model);
    return model;
  };

  return async (options, callOpts): Promise<GenerateResult> => {
    const model = resolveModel(options.llm ?? opts.llm);
    const common = {
      model,
      prompt: options.prompt,
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens !== undefined
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      ...(callOpts?.signal !== undefined ? { abortSignal: callOpts.signal } : {}),
    };
    if (options.schema !== undefined) {
      assertJsonSchema(options.schema);
      const { object } = await generateObject({ ...common, schema: jsonSchema(options.schema) });
      return { text: JSON.stringify(object), object };
    }
    const { text } = await generateText(common);
    return { text };
  };
}
