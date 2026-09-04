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
 * structured-output spelling just works:
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
 *     // `object` is typed { summary: string; sentiment: string } and is not
 *     // optional — reading a field directly is the point of passing a schema.
 *     return `${object.sentiment}: ${object.summary}`;
 *   },
 * });
 * ```
 *
 * ## There is no `signal` here, and that is not the omission it looks like
 *
 * The authoring guide says to pass `ctx.signal` to anything slow, and a model
 * call is the slowest thing in a tool body — so the absent option reads as the
 * mandate being unfollowable. It is already followed: the runtime binds this
 * call to the tool's own signal for you. `buildToolContext` forwards the
 * per-call controller it always builds (`ToolContext.signal` is non-optional
 * for the same reason), and `createGenerateFn` passes it to the provider as
 * `abortSignal` — so a barge-in that unblocks the tool's `await` also cancels
 * the generation behind it, whether or not the author thought about it.
 *
 * An option here would be a SECOND signal beside that one, and the failure
 * would be silent in the worst direction: a tool that passes nothing is
 * cancelled and a tool that carefully passes a narrower deadline would replace
 * the turn's signal with it unless every layer remembered to combine them.
 * A narrower deadline is a real want — "give up on this summary after two
 * seconds" — and it is not expressible today; adding it means threading a
 * combined signal through {@link GenerateFn}'s host implementation, not a
 * field on this bag.
 */

import type { LlmProvider } from "./providers.ts";
import type { InferSchemaOutput, StandardSchemaV1 } from "./schema.ts";

/**
 * Options for one LLM generation call.
 *
 * No `signal`: the call is already bound to `ctx.signal` by the runtime — see
 * the module doc for why a field here would be a second, competing one.
 */
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

/**
 * Result of one LLM generation call without a Standard Schema — text only.
 *
 * `object` is declared as optional-and-`unknown` rather than omitted because
 * this is also what a PLAIN JSON Schema call returns: the host does produce an
 * object there, but nothing types it, so a caller must narrow before reading.
 */
export type GenerateResult = {
  /** The generated text. For schema calls, the JSON-stringified object. */
  text: string;
  /** The parsed object when a plain JSON Schema was passed; absent otherwise. */
  object?: unknown;
};

/**
 * Result of a generation call that passed a Standard Schema — `object` is
 * REQUIRED, matching what the host guarantees.
 *
 * Split from {@link GenerateResult} rather than expressed as
 * `GenerateResult<T>` with an optional `object`: the optionality survived the
 * typed overload, so the one spelling the overload exists to reward —
 * `const { object } = await ctx.generate({ prompt, schema })` — needed a `!`
 * or an `if` before any field could be read, even though `host/generate.ts`
 * returns `{ text, object }` unconditionally on that path.
 */
export type GenerateObjectResult<T> = {
  /** The generated text — the JSON-stringified object. */
  text: string;
  /** The schema-validated object. Always present on this overload. */
  object: T;
};

/**
 * One-shot LLM generation — the signature of `ctx.generate`. A call with a
 * Standard Schema `schema` returns a result whose `object` is typed by that
 * schema and non-optional; a plain-JSON-Schema or schemaless call returns
 * {@link GenerateResult}, whose `object` is `unknown` and must be narrowed.
 */
export type GenerateFn = {
  <S extends StandardSchemaV1>(
    options: GenerateOptions & { schema: S },
  ): Promise<GenerateObjectResult<InferSchemaOutput<S>>>;
  (options: GenerateOptions): Promise<GenerateResult>;
};
