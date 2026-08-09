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

import { generateObject, generateText, jsonSchema, type LanguageModel } from "ai";
import type { ProviderEnv } from "../sdk/env-types.ts";
import type { GenerateOptions, GenerateResult } from "../sdk/generate.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { normalizeLlm } from "../sdk/providers/llm/from-string.ts";
import type { LlmProvider } from "../sdk/providers.ts";
import { isConvertibleSchema, toToolJsonSchema } from "../sdk/schema.ts";
import { resolveLlm } from "./providers/resolve.ts";

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

function isDescriptor(value: unknown): value is LlmProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

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
      const { object } = await generateObject({
        ...common,
        schema: jsonSchema(resolveJsonSchema(options.schema)),
      });
      return { text: JSON.stringify(object), object };
    }
    const { text } = await generateText(common);
    return { text };
  };
}
