// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `defaults`.
 *
 * The documented defaults, and what is left of them. It was 22 constants — the
 * published answer to "what happens if I leave this field off" for every
 * `agent()` field — and 21 of those went to `@alexkroman1/aai/internal`,
 * because that question is answered where an author asks it: in the field's own
 * JSDoc, which carries the value. The constant beside it added a second place to
 * read the same number, and no template, no scaffold and no line of the shipped
 * authoring guide ever named one. Epoch 1 had already dropped three constants
 * for exactly that reason; this is the rest of the same subtraction.
 *
 * `DEFAULT_SYSTEM_PROMPT` is the one that stays, and it stays by PASSING the
 * root barrel's membership test rather than as a leftover.
 * `agent({ systemPrompt })` replaces ~10,000 characters of measured voice rules
 * wholesale, so naming this constant is the only way to keep them and add
 * domain rules on top — the recipe the constant documents and
 * `check:doc-examples` compiles. Its VALUE changing is a behaviour change for
 * every agent that omitted the field and for every agent that composed against
 * it, which is what a capability is for.
 *
 * The capability is therefore kept rather than retired: it has a real member,
 * and retiring it would delete the epoch record of three decisions
 * (`contracts/epochs/defaults/`) that is the whole point of the mechanism.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export { DEFAULT_SYSTEM_PROMPT } from "../../index.ts";
