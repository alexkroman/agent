// Copyright 2026 the AAI authors. MIT license.
/**
 * One model call that has to come back as a SHAPE, from inside a step.
 *
 * {@link stepGenerate} is `ctx.generate`'s counterpart for a step, and it stops
 * one step short of where `ctx.generate` gets to: that one takes a
 * `GenerateOptions.schema` and returns a typed object, while this one returned a
 * string and left every caller to re-derive the same four things — unwrap the
 * fence a model puts around JSON however firmly it is told not to, parse it,
 * decide the reply was not an object, and check the shape.
 *
 * Both workflow templates had written that, and they had already DIVERGED on
 * the first of the four (one trimmed the unwrapped text, the other did not) —
 * the same signal that justified extracting `stepGenerate` itself.
 *
 * ## Why a schema rather than a type parameter
 *
 * The hand-rolled version's last step is the one that rots: `askJson<Action>()`
 * returns a value the compiler believes and nothing checked, so a model that
 * answered with a plausible neighbouring shape flows into the step's own logic
 * as if it had obeyed. Taking a schema makes the check the thing that produces
 * the type — and makes a reply that ignored the format a PLAIN throw, which is
 * exactly what a step's retry is for: a model may well obey on the next
 * attempt, where a 401 will not.
 *
 * ## And it stays zod-free
 *
 * This module is re-exported from `@alexkroman1/aai/step`, whose zero-zod budget
 * covers every export: a `workflows/*.ts` module is bundled with the agent, so
 * zod's module graph would ride in with it. It does not need to: VALIDATION is the Standard Schema contract itself (a `~standard.validate`
 * call), and only JSON Schema CONVERSION needs a vendor-specific path. So the
 * types come from `sdk/standard-schema.ts` — see that module's doc — and any
 * Standard Schema works here, zod being merely the documented default.
 */

import { isRecord } from "./is-record.ts";
import { previewBody } from "./response-body.ts";
import { safeJsonParse } from "./safe-json-parse.ts";
import {
  formatSchemaIssues,
  type InferSchemaOutput,
  type StandardSchemaV1,
} from "./standard-schema.ts";
import { type StepGenerateOptions, stepGenerate } from "./step-generate.ts";

/** Options for {@link stepGenerateJson}: {@link StepGenerateOptions} plus the shape. */
export type StepGenerateJsonOptions<S extends StandardSchemaV1> = StepGenerateOptions & {
  /**
   * The shape the reply must satisfy — any
   * [Standard Schema](https://standardschema.dev), zod being the documented
   * default. Its OUTPUT type is what this call returns, so a schema that
   * coerces (dropping the elements a model got wrong, say) is a supported and
   * often better answer than one that rejects the whole reply.
   */
  schema: S;
};

/**
 * Ask the model for JSON and return it validated.
 *
 * The reply is unfenced, parsed, and checked against `schema`; the validated
 * value is what comes back, typed as the schema's output.
 *
 * **From a step, prefer `stepGenerateJsonOrFail` (`@alexkroman1/aai/step-errors`).**
 * It is this call plus `throwStepError`, and the engine decides its retry policy
 * from WHICH error a step throws: raw, a terminal failure burns every remaining
 * attempt and a rate limit backs off for one second while the delay the far side
 * named sits unread. Reach for the raw call where the failure is not simply a
 * failure — a `404` that means "already deleted".
 *
 * @param prompt - The user message. The SHAPE belongs in `system` — this says
 *   nothing about JSON on the caller's behalf, because the wording that gets a
 *   model to comply is part of the prompt a template is demonstrating.
 * @returns The validated reply.
 * @throws {Error} A plain error — retryable by the engine's default, which is
 *   the point — when the reply is not JSON, is not an object, or does not
 *   satisfy `schema`. All three are things a model may get right next time.
 * @throws {import("./step-generate.ts").StepGenerateError} On any gateway
 *   failure, exactly as {@link stepGenerate} does. Classify it with
 *   `toStepError` from `@alexkroman1/aai/step-errors`.
 *
 * @example
 * ```ts
 * import { stepGenerateJson } from "@alexkroman1/aai/step";
 * import { z } from "zod";
 *
 * const Digest = z.object({ headline: z.string(), points: z.array(z.string()) });
 *
 * export async function summarize(article: string): Promise<{ headline: string }> {
 *   return await stepGenerateJson(article, {
 *     schema: Digest,
 *     system: 'Reply with JSON only: {"headline": string, "points": string[]}.',
 *   });
 * }
 * ```
 *
 * @public
 */
export async function stepGenerateJson<S extends StandardSchemaV1>(
  prompt: string,
  options: StepGenerateJsonOptions<S>,
): Promise<InferSchemaOutput<S>> {
  const { schema, ...generate } = options;
  const reply = await stepGenerate(prompt, generate);
  const parsed = safeJsonParse(stripJsonFence(reply));
  // A record OR an array, spelled out — this is the one guard in the package
  // that must accept arrays, because a caller's schema is free to describe a
  // LIST and a top-level `[...]` reply is then correct. `isRecord` alone would
  // reject it; the two comparisons written inline would say the same thing
  // while reading as the guard this package has a name for
  // (`guard-invariants` rule 17).
  if (!(isRecord(parsed) || Array.isArray(parsed))) {
    throw new Error(`Expected JSON from the model, got: ${previewBody(reply)}`);
  }
  const result = await schema["~standard"].validate(parsed);
  if (result.issues) {
    throw new Error(
      `The model's JSON did not match the shape: ${formatSchemaIssues(result.issues)}`,
    );
  }
  return result.value as InferSchemaOutput<S>;
}

/**
 * Unwrap a ```` ```json ```` fence, which models add however firmly they are
 * told not to.
 *
 * Refusing one would cost a whole retry for a reply that was otherwise correct.
 * Text that carries no fence is returned trimmed and otherwise untouched.
 *
 * @public
 */
export function stripJsonFence(reply: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(reply);
  return (fenced?.[1] ?? reply).trim();
}
