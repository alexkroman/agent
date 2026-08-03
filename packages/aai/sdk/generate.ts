// Copyright 2026 the AAI authors. MIT license.
/**
 * The `ctx.generate` capability contract — one-shot LLM text/object
 * generation available to tool `execute` functions.
 *
 * Like `ctx.db`, generation always executes on the host:
 * the self-hosted runtime calls the provider SDK in-process, while the
 * platform sandbox proxies the call over the guest's NDJSON RPC channel
 * (`llm/generate`). This module holds only the shared, Node-free contract;
 * the host implementation lives in `host/generate.ts`.
 *
 * `GenerateOptions.schema` is a plain JSON Schema object — never a Zod
 * schema — because the options must survive the guest→host RPC boundary as
 * JSON. Convert a Zod schema with `z.toJSONSchema()` before passing it.
 */

import type { LlmProvider } from "./providers.ts";

/** Options for one LLM generation call. JSON-serializable by design. */
export type GenerateOptions = {
  /** The user prompt for this call. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /**
   * LLM provider descriptor (from `@alexkroman1/aai/llm`) for this call.
   * Defaults to the agent's own pipeline `llm`. Credentials resolve from the
   * agent's env — an S2S agent can use `generate` by naming a provider whose
   * API key it holds as a secret.
   */
  llm?: LlmProvider;
  /**
   * JSON Schema for structured output. When set, the model is constrained
   * to the schema and the result's `object` carries the parsed value.
   * Pass a plain JSON Schema object (e.g. via Zod v4's `z.toJSONSchema`),
   * not a Zod schema — the options must serialize across the sandbox RPC
   * boundary.
   */
  schema?: Record<string, unknown>;
  /** Sampling temperature passed through to the provider. */
  temperature?: number;
  /** Cap on generated tokens passed through to the provider. */
  maxOutputTokens?: number;
};

/** Result of one LLM generation call. */
export type GenerateResult = {
  /** The generated text. For schema calls, the JSON-stringified object. */
  text: string;
  /** The schema-validated object when `schema` was set; absent otherwise. */
  object?: unknown;
};

/** One-shot LLM generation. The signature of `ctx.generate`. */
export type GenerateFn = (options: GenerateOptions) => Promise<GenerateResult>;
