// Copyright 2026 the AAI authors. MIT license.
/**
 * The `ctx.generate` capability contract — one-shot LLM text/object
 * generation available to tool `execute` functions.
 *
 * Like `ctx.db`, generation always executes wherever the runtime runs —
 * in-process under `aai dev`, inside the guest sandbox on the platform —
 * through one implementation (`host/generate.ts`), so dev and prod cannot
 * drift. This module holds only the shared, Node-free contract.
 *
 * `GenerateOptions.schema` accepts a Zod schema (or any Standard Schema
 * that converts to JSON Schema — see `toToolJsonSchema`) as well as a plain
 * JSON Schema object. Schemas are converted before the call, so the typed
 * `generateObject`-style spelling just works:
 *
 * ```ts
 * import { z } from "zod";
 * import { tool } from "@alexkroman1/aai";
 *
 * const summarize = tool({
 *   description: "Summarize the conversation so far",
 *   execute: async (_args, ctx) => {
 *     const { object } = await ctx.generate({
 *       prompt: ctx.messages.map((m) => `${m.role}: ${m.content}`).join("\n"),
 *       schema: z.object({ summary: z.string(), sentiment: z.string() }),
 *     });
 *     return object; // typed { summary: string; sentiment: string }
 *   },
 * });
 * ```
 */

import type { LlmProvider } from "./providers.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./schema.ts";

/** Options for one LLM generation call. */
export type GenerateOptions = {
  /** The user prompt for this call. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /**
   * LLM provider for this call: a descriptor from `@alexkroman1/aai/llm`,
   * or a model-id string (`"creator/model"` routes through the Vercel AI
   * Gateway; a bare id through the AssemblyAI LLM Gateway — same shorthand
   * as `agent({ llm })`). Defaults to the agent's own pipeline `llm`.
   * Credentials resolve from the agent's env — an S2S agent can use
   * `generate` by naming a provider whose API key it holds as a secret.
   */
  llm?: LlmProvider | string;
  /**
   * Schema for structured output. When set, the model is constrained to the
   * schema and the result's `object` carries the parsed value. Accepts a
   * Zod schema (or any Standard Schema convertible to JSON Schema) — the
   * typed result follows from it — or a plain JSON Schema object, in which
   * case `object` is `unknown`.
   */
  schema?: StandardSchemaV1 | Record<string, unknown>;
  /** Sampling temperature passed through to the provider. */
  temperature?: number;
  /** Cap on generated tokens passed through to the provider. */
  maxOutputTokens?: number;
};

/** Result of one LLM generation call. */
export type GenerateResult<T = unknown> = {
  /** The generated text. For schema calls, the JSON-stringified object. */
  text: string;
  /** The schema-validated object when `schema` was set; absent otherwise. */
  object?: T;
};

/**
 * One-shot LLM generation — the signature of `ctx.generate`. A call with a
 * Standard Schema `schema` returns a result whose `object` is typed by that
 * schema; a plain-JSON-Schema or schemaless call returns `unknown`.
 */
export type GenerateFn = {
  <S extends StandardSchemaV1>(
    options: GenerateOptions & { schema: S },
  ): Promise<GenerateResult<InferSchemaOutput<S>>>;
  (options: GenerateOptions): Promise<GenerateResult>;
};
