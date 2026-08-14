// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 6.
 *
 * Epoch 6 adds {@link stepGenerateJson} and {@link stripJsonFence} — one model
 * call from a `"use step"` body that has to come back as a SHAPE. A pure
 * addition, so epoch 5 is retained; this file demonstrates the shape the
 * addition is meant to be written in.
 *
 * The schema is what makes the type, which is the property worth freezing: the
 * hand-rolled predecessor was `askJson<T>()`, a value the compiler believed and
 * nothing checked.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";
import {
  type StepGenerateJsonOptions,
  stepGenerateJson,
  stripJsonFence,
} from "../../../sdk/utils.ts";

/** The shape the model is asked for, as something that CHECKS. */
const Digest = z.object({
  headline: z.string(),
  points: z.array(z.string()),
});

/**
 * A stage whose reply is JSON: the fence, the parse, the non-object case and the
 * shape are all the helper's, and the return type is the schema's output.
 */
export async function summarize(article: string): Promise<{ headline: string; points: string[] }> {
  "use step";

  return await stepGenerateJson(article, {
    schema: Digest,
    system: 'Reply with JSON only: {"headline": string, "points": string[]}.',
    // The `stepGenerate` options ride along unchanged.
    temperature: 0.2,
    maxTokens: 400,
  });
}

/**
 * A LENIENT schema, which is a supported answer rather than a workaround: a
 * model that put one number in an array of strings should cost that element,
 * not the whole pass.
 */
const Angles = z.object({
  angles: z
    .array(z.unknown())
    .transform((values) => values.filter((v): v is string => typeof v === "string")),
});

/** The options type, nameable for a caller writing its own wrapper. */
export type PlanOptions = StepGenerateJsonOptions<typeof Angles>;

/** Planning, through a caller-built options object. */
export async function planAngles(brief: string, opts: PlanOptions): Promise<string[]> {
  "use step";

  return (await stepGenerateJson(brief, opts)).angles;
}

/** The fence stripper on its own, for a caller parsing a reply itself. */
export function unwrap(reply: string): string {
  return stripJsonFence(reply);
}
