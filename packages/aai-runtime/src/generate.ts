// Copyright 2026 the AAI authors. MIT license.
/**
 * Host-side implementation of the `ctx.generate` capability
 * (see `sdk/generate.ts` for the contract).
 *
 * One implementation running wherever the runtime runs — in-process under
 * `aai dev` and inside the guest sandbox on the platform — so dev and prod
 * cannot drift on what a generation call accepts or resolves. Descriptors resolve through
 * the same `resolveLlm` registry as the pipeline's own model, with
 * credentials from the agent's env (never `process.env`).
 */

import type { GenerateOptions, GenerateResult } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import {
  isConvertibleSchema,
  normalizeLlm,
  toToolJsonSchema,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { createLlmModelCache, isLlmDescriptor } from "./_llm-model-cache.ts";

/**
 * The host-side `ctx.generate` implementation — takes `GenerateOptions` and
 * resolves a `GenerateResult`, with an extra per-call options bag: the tool
 * executor binds the issuing turn's abort signal so an in-flight generation
 * stops on barge-in / reset / session stop.
 *
 * @internal
 */
export type HostGenerateFn = (
  options: GenerateOptions,
  callOpts?: { signal?: AbortSignal | undefined },
) => Promise<GenerateResult>;

/**
 * Options for {@link createGenerateFn}.
 * @internal
 */
export type CreateGenerateFnOptions = {
  /**
   * Default LLM descriptor — the agent's own pipeline `llm`. Callers may
   * override per call via `GenerateOptions.llm`. When neither is present a
   * generation call fails with a descriptive error (S2S agents must name a
   * provider explicitly).
   */
  llm?: LlmProvider | undefined;
  /** Env the provider credential resolves from (agent env / providerEnv). */
  env: ProviderEnv;
};

/**
 * Resolve the `schema` option to plain JSON Schema. A Standard Schema (Zod,
 * ArkType, …) converts via {@link toToolJsonSchema}; a plain object passes
 * through. A pre-Standard-Schema Zod (v3) instance has `safeParse` but no
 * `~standard` — reject it by name rather than shipping a nonsense spec.
 */
function resolveJsonSchema(
  schema: NonNullable<GenerateOptions["schema"]>,
): Record<string, unknown> {
  if (isConvertibleSchema(schema)) {
    return toToolJsonSchema(schema) as Record<string, unknown>;
  }
  if (typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    throw new Error(
      "generate: `schema` looks like a pre-v4 Zod schema, which cannot be " +
        "converted. Upgrade to zod v4 (Standard Schema) or pass plain JSON Schema.",
    );
  }
  return schema as Record<string, unknown>;
}

/**
 * Build the host generate function for one agent.
 *
 * Models resolve lazily and are memoized per descriptor object, so repeated
 * workflow calls against the same provider reuse one client.
 *
 * @internal
 */
export function createGenerateFn(opts: CreateGenerateFnOptions): HostGenerateFn {
  const modelFor = createLlmModelCache(opts.env);

  const resolveModel = (descriptor: LlmProvider | undefined): LanguageModel => {
    if (!isLlmDescriptor(descriptor)) {
      throw new Error(
        "generate: no LLM configured. Pass an `llm` descriptor in the generate " +
          "options (from @alexkroman1/aai/llm), or run the agent in pipeline mode.",
      );
    }
    return modelFor(descriptor);
  };

  return async (options, callOpts): Promise<GenerateResult> => {
    const model = resolveModel(options.llm ? normalizeLlm(options.llm) : opts.llm);
    const common = {
      model,
      prompt: options.prompt,
      ...omitUndefined({
        system: options.system,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        abortSignal: callOpts?.signal,
      }),
    };
    if (options.schema !== undefined) {
      // `generateText` + `Output.object`, not `generateObject` — the latter is
      // deprecated as of ai 7.0.62 in favour of exactly this.
      const { output } = await generateText({
        ...common,
        output: Output.object({ schema: jsonSchema(resolveJsonSchema(options.schema)) }),
      });
      return { text: JSON.stringify(output), object: output };
    }
    const { text } = await generateText(common);
    return { text };
  };
}
