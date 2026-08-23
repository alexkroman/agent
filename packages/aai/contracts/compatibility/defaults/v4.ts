// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:defaults` epoch 4.
 *
 * **Epoch 4 is one constant, and epoch 3 is DROPPED.** The other 21 moved to
 * `@alexkroman1/aai/internal`, so `./v3.ts` no longer compiles and was deleted
 * with it; `contracts.json` carries the reason. The short version is that this
 * capability answered "what happens if I leave this field off" a second time,
 * after the field's own JSDoc had already answered it with the value — and
 * epoch 3's own example named the readers who really wanted them, all three of
 * them framework code: "a client sizing a buffer, a harness matching the host's
 * endpointing, a test asserting the shipped value."
 *
 * `DEFAULT_SYSTEM_PROMPT` is not a leftover. It is the only one of the 22 an
 * `agent.ts` NAMES, because `agent({ systemPrompt })` REPLACES the whole
 * default prompt rather than extending it — so an author who wants the measured
 * voice rules AND their own domain rules has to compose the two by hand, and
 * this constant is the left-hand side. That makes its VALUE part of the
 * contract in a way the numeric budgets never were: an agent that omitted the
 * field and an agent that appended to it both change behaviour when the prompt
 * changes.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { DEFAULT_SYSTEM_PROMPT } from "../../../index.ts";

/**
 * The recipe: keep the shipped voice rules, add a domain rule after them. This
 * is what `agent({ systemPrompt })` takes, and the reason the constant is on
 * the root barrel at all.
 */
export function extendedPrompt(domainRules: string): string {
  return `${DEFAULT_SYSTEM_PROMPT}\n\n${domainRules}`;
}

/**
 * It is a plain `string`, so a caller may still measure it — the prompt is
 * ~10,000 characters and is the bulk of every request's system message, which
 * is a thing a caller budgeting context wants to know.
 */
export const promptLength: number = DEFAULT_SYSTEM_PROMPT.length;

/** And compare against it, which is how a config reports "this agent kept the default". */
export const isDefault = (prompt: string): boolean => prompt === DEFAULT_SYSTEM_PROMPT;
