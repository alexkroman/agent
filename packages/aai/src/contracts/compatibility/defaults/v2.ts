// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:defaults` epoch 2.
 *
 * Epoch 3 changed the same one thing epoch 2 did: the VALUE, and so the
 * literal type, of `DEFAULT_SYSTEM_PROMPT`. SPEAKING's identifier rule became
 * a SPELLING rule (hyphenate a code, drop the "#"), gained the digit-only
 * identifiers it had never covered and an email-address rule of its own, and
 * TOOLS' "copy values exactly" was scoped to what is SENT to a tool so it
 * stops cancelling the respelling. The export list is unchanged and no
 * signature moved, which is why epoch 2 is RETAINED rather than dropped — the
 * same call epoch 1 got, for the same reason.
 *
 * The promise is therefore the narrow one epoch 1's example already states,
 * and this file holds it at the next epoch: an author who READ the default
 * prompt, appended their own instructions to it, or measured its length still
 * compiles. Depending on the prompt's exact TEXT was never safe and is what
 * this file must not do — a binding annotated with the old literal or a
 * substring assertion would have reddened on every epoch so far, and rightly:
 * each of the three revised rules measured against a run.
 *
 * What differs from `v1.ts` is only WHICH shapes are pinned, so the two files
 * pin different ones rather than restating each other. v1 covers inspection
 * and prepend-composition; this one covers the two shapes an author who read
 * the epoch-2 docs most plausibly wrote next: passing the constant straight
 * into `agent({ systemPrompt })` (which `buildSystemPrompt` STRIPS rather than
 * duplicating — the behaviour is a repair, but it has to keep type-checking),
 * and narrowing the literal to `string` to store or ship it.
 *
 * If a later epoch removes the constant, splits it into per-section exports,
 * or turns it into a function of the agent config, this file reddens — the
 * signal to DROP epoch 2 rather than to edit around it.
 */

import { agent } from "../../../sdk/define.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../../../sdk/system-prompt.ts";

/**
 * Widening: the literal flows into a plain `string` slot, which is how an
 * author stores, logs, or ships it.
 */
const promptForShipping: string = DEFAULT_SYSTEM_PROMPT;

/**
 * The shape epoch 2's own docs warn about but must keep COMPILING: handing the
 * default back to `agent({ systemPrompt })`. `buildSystemPrompt` strips the
 * leading copy and warns, so this is a no-op at runtime rather than a doubled
 * prompt — but it type-checks, and an author who followed the older advice has
 * it in their tree.
 */
const composedAgent = agent({
  name: "defaults-epoch-2",
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nNever quote a delivery date.`,
});

export { composedAgent, promptForShipping };
