// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:defaults` epoch 1.
 *
 * Epoch 2 changed exactly one thing an author can observe: the VALUE, and so
 * the literal type, of `DEFAULT_SYSTEM_PROMPT`. Two rules moved inside it —
 * `PROMPT_ROLE`'s carve-out now names the TOOLS recovery ladder alongside
 * LISTENING and SPEAKING, and the TOOLS "retry once" budget is scoped to
 * non-lookup errors. The export list is unchanged and no signature moved,
 * which is why epoch 1 is RETAINED rather than dropped.
 *
 * So the promise this file holds is narrow and worth stating precisely: an
 * epoch-1 author who READ the default prompt, appended their own instructions
 * to it, or measured its length still compiles. What such an author could NOT
 * have done safely — and what this file therefore must not do — is depend on
 * the prompt's exact TEXT. A binding annotated with the old literal, a
 * substring assertion, or a byte-length check would have reddened on epoch 2,
 * and rightly: the constant's own doc calls the sections "measured rather than
 * chosen" and every rule in it is revised as measurements arrive.
 *
 * Note what an author does NOT need this constant for: `agent({ systemPrompt })`
 * is APPENDED to the defaults rather than replacing them (`buildSystemPrompt`
 * emits every section and then adds the author's prompt under a precedence
 * header), so reading it is for inspection and composition, never a
 * prerequisite for customising behaviour.
 *
 * If a later epoch removes the constant, splits it into per-section exports,
 * or turns it into a function of the agent config, this file reddens — the
 * signal to DROP epoch 1 rather than to edit around it.
 */

import { DEFAULT_SYSTEM_PROMPT } from "../../../sdk/system-prompt.ts";

/** Inspection: the default is a plain string an author can read and measure. */
const defaultPromptLength: number = DEFAULT_SYSTEM_PROMPT.length;

/**
 * Composition: prepending the defaults to a house prompt. Deliberately builds
 * the string rather than asserting anything about its contents — an epoch-1
 * author could compose with it, never depend on what it says.
 */
const housePrompt: string = [
  DEFAULT_SYSTEM_PROMPT,
  "You are the support line for a bicycle shop. Never quote a delivery date.",
].join("\n\n");

export { defaultPromptLength, housePrompt };
