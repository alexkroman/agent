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
 *
 * A `schema` call CHECKS what came back — see {@link checkGenerated}. The
 * schema constrains the request and validates the reply, which are two
 * different guarantees and were one for as long as only the first was wired.
 */

import type { GenerateOptions, GenerateResult } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import {
  isConvertibleSchema,
  normalizeLlm,
  toToolJsonSchema,
} from "@alexkroman1/aai/host-internal";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { generateText, jsonSchema, type LanguageModel, Output } from "ai";
import { createLlmModelCache, isLlmDescriptor } from "./_llm-model-cache.ts";

/**
 * The host-side `ctx.generate` implementation — takes `GenerateOptions` and
 * resolves a `GenerateResult`, with an extra per-call options bag: the tool
 * executor binds the issuing turn's abort signal so an in-flight generation
 * stops on barge-in / reset / session stop.
 *
 * Public because `EvalSessionOptions.generate` takes one: substituting the
 * in-tool LLM call is how a case asserts on what a tool DID without paying for
 * a second live model, and an option whose type has no name is an option a
 * spec can pass and not hold in a variable. It was `@internal` while nothing
 * published a field of this type.
 */
export type HostGenerateFn = (
  options: GenerateOptions,
  callOptions?: { signal?: AbortSignal | undefined },
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
 * Check what the model produced against the call's own `schema` and answer the
 * PARSED value.
 *
 * **`jsonSchema()` DESCRIBES; it does not validate.** The AI SDK's
 * `Output.object` runs whatever validator its `Schema` carries, and a schema
 * built from a bare JSON Schema document carries none — so `safeValidateTypes`
 * waves the reply through and `output` is whatever the model emitted, returned
 * as `GenerateObjectResult<T>.object`, which declares `T`. A tool reading
 * `object.issues.map(…)` off a `z.array(z.string())` field therefore threw a
 * `TypeError` inside a live turn, at a line the compiler had signed off, for a
 * reply nothing had checked. Constraining the request is not the same as
 * checking the answer: structured-output support is per provider and per model,
 * a gateway may silently drop the format, and a model can satisfy the grammar
 * and still miss the shape.
 *
 * So the reply is validated HERE, through the caller's own Standard Schema —
 * the same half of schema handling every other reader in this repo uses
 * (`stepGenerateJson`, `settleRunOutcome`, `executeToolCall`), and the same one
 * the eval harness already put in front of `stubGenerate`'s scripted answers.
 *
 * The value returned is the validated one rather than the caller's raw reply,
 * for `settleRunOutcome`'s reason: a schema PARSES — a `.default()` fills in, a
 * zod object drops an unknown key — and what a caller reads has to be what its
 * own declaration describes.
 *
 * A vendor validator that THROWS is left to propagate. It reaches the same
 * `catch` a rejection would, and unlike a workflow run there is nothing here to
 * mark failed or redeliver.
 */
/**
 * The model answered with something the call's own schema rejects.
 *
 * A CLASS rather than a bare `Error` because one caller has to tell this apart
 * from every other way a generation can fail, and it is the caller for whom the
 * word "model" is wrong: an EVAL's model is a script its author wrote, so
 * `eval/describe.ts` catches this and re-throws blaming the script and naming
 * it. Matching on the message would have made that a string comparison across
 * two packages.
 */
export class GenerateSchemaMismatchError extends Error {
  override readonly name = "GenerateSchemaMismatchError";
}

async function checkGenerated(
  schema: NonNullable<GenerateOptions["schema"]>,
  output: unknown,
): Promise<unknown> {
  if (!isConvertibleSchema(schema)) {
    checkJsonShape(schema as Record<string, unknown>, output);
    return output;
  }
  const result = await schema["~standard"].validate(output);
  if (result.issues) {
    // Throws, and does not re-ask the model. A tool's own `catch` is the
    // recourse `repairToolCall` does not have — that hook repairs arguments the
    // AI SDK is about to discard with nothing else to try, whereas a caller here
    // can degrade, ask differently, or answer without the model. A silent second
    // round trip is the wrong default in a live turn: it doubles the worst-case
    // latency on exactly the path where the model is already misbehaving, and it
    // spends the caller's tokens on a policy it never asked for.
    throw new GenerateSchemaMismatchError(
      `generate: the model's reply does not match the call's schema: ${formatSchemaIssues(result.issues)}`,
    );
  }
  return result.value;
}

/**
 * The only claim a PLAIN JSON Schema call can check: the shape of the top-level
 * value.
 *
 * A JSON Schema document is not a validator and this package ships no
 * evaluator for one, so the deep check the Standard Schema path gets is
 * unavailable — which is also why that call's `object` is `unknown` and the
 * caller must narrow. What is still worth refusing is the reply that is not the
 * KIND of thing the schema describes at all: a bare `"sorry, I can't"` string,
 * or `null`, against a document declaring an object. `type` may name several
 * kinds, and a document that declares none is held to the line
 * `stepGenerateJson` draws — a record or an array, since a caller asking for
 * structured output and receiving a scalar has a defect in every case.
 */
function checkJsonShape(schema: Record<string, unknown>, value: unknown): void {
  const declared = declaredTypes(schema);
  if (declared === undefined) {
    if (isRecord(value) || Array.isArray(value)) return;
    throw new Error(
      `generate: the model's reply is not a JSON object or array, which the call's JSON Schema asked for. It returned ${jsonTypeOf(value)}.`,
    );
  }
  if (declared.some((type) => matchesJsonType(type, value))) return;
  throw new Error(
    `generate: the model's reply is a JSON ${jsonTypeOf(value)}, where the call's JSON Schema declares ${declared.join(" or ")}.`,
  );
}

/** The top-level `type` a JSON Schema declares, as a list, or `undefined`. */
function declaredTypes(schema: Record<string, unknown>): string[] | undefined {
  const type = schema.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) {
    const names = type.filter((entry): entry is string => typeof entry === "string");
    return names.length > 0 ? names : undefined;
  }
  return undefined;
}

/** JSON's own type of a parsed value — the vocabulary a schema's `type` uses. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

/** Does `value` inhabit the JSON Schema type named `type`? */
function matchesJsonType(type: string, value: unknown): boolean {
  // `integer` is the one name with no JSON counterpart: it is a number that
  // happens to be whole, so it cannot come out of `jsonTypeOf`.
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return jsonTypeOf(value) === type;
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

  return async (options, callOptions): Promise<GenerateResult> => {
    const model = resolveModel(options.llm ? normalizeLlm(options.llm) : opts.llm);
    const common = {
      model,
      prompt: options.prompt,
      ...omitUndefined({
        system: options.system,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
        abortSignal: callOptions?.signal,
      }),
    };
    if (options.schema !== undefined) {
      // `generateText` + `Output.object`, not `generateObject` — the latter is
      // deprecated as of ai 7.0.62 in favour of exactly this.
      const { output } = await generateText({
        ...common,
        output: Output.object({ schema: jsonSchema(resolveJsonSchema(options.schema)) }),
      });
      // `text` is the stringified OBJECT by contract, so it is stringified from
      // the checked value: a `.default()` the schema filled in belongs in both
      // halves of the result or the two disagree about the same call.
      const object = await checkGenerated(options.schema, output);
      return { text: JSON.stringify(object), object };
    }
    const { text } = await generateText(common);
    return { text };
  };
}
