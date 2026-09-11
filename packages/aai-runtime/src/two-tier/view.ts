// Copyright 2026 the AAI authors. MIT license.
/**
 * The INFORMATION BOUNDARY: everything the slow tier may see, and a type that
 * makes a richer context unconstructible.
 *
 * The claim a fast/slow architecture makes is that its gain comes from
 * additional REASONING over agent-visible inputs — Pickle states it as one
 * sentence in `docs/mentor-prompt-constitution.md`: "the mentor is
 * information-equivalent to the voice agent, and score uplift comes only from
 * additional reasoning over agent-visible inputs." A slow tier that can see the
 * task definition, the expected actions, the grading criteria or a simulated
 * caller's hidden profile is an ORACLE. An oracle scores well and ships
 * nothing, and the failure is silent: the run looks like the architecture
 * working.
 *
 * The risk is concrete rather than theoretical, because under a benchmark the
 * task objects are in the same process as the runtime. Any context assembled
 * from anything but live session state is the leak.
 *
 * ## How it is enforced
 *
 * Not by a prompt instruction and not by a review rule, but by the type:
 *
 * 1. {@link SlowTierView} carries a `unique symbol` brand declared with no
 *    value, so there is nothing a caller could write — an object literal is a
 *    compile error naming the missing key.
 * 2. {@link slowTierViewOf} is the only producer, and its parameter is
 *    {@link SessionFacts}, whose three members are exactly the three things the
 *    FAST tier's own request carried: the instructions it was sent, its own
 *    conversation (`ctx.messages`), and the tool catalogue the agent declares.
 * 3. The digest is not a parameter either — it is read off the session's own
 *    store, so a caller cannot substitute a richer one.
 *
 * Widening what the slow tier sees therefore means editing
 * {@link SessionFacts}, which is one reviewable place with this header above
 * it, rather than adding a field at a call site nobody is watching.
 *
 * ## And it is TRIMMED, which is the same rule from the other side
 *
 * `contextMessages` bounds the conversation window. SABER's third component is
 * block-based context cleaning, and its motivation is not cost: errors grow
 * with context length as an agent drifts from its role and acts on stale
 * constraints. Fewer channels in is also fewer channels for a leak.
 */

import type { Message } from "@alexkroman1/aai";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import type { StateDigest } from "./digest.ts";

declare const VIEW_BRAND: unique symbol;

/**
 * One tool as the slow tier learns of it.
 *
 * Name, description and the two classifications — and NOT the JSON Schema,
 * which is how a model is told to SHAPE arguments rather than anything the
 * catalogue summary needs. It is the tool's DESCRIPTION that carries the policy
 * a decision is made against, which is Pickle's R2: every domain fact enters at
 * runtime through the policy text, the tool names and descriptions, the
 * observed transcript, or official tool results.
 */
export type ToolCatalogEntry = {
  readonly name: string;
  readonly description: string;
  readonly mutates: boolean;
  readonly completes: boolean;
};

/**
 * Exactly what the fast tier's own request carried — see this module's header.
 *
 * Adding a member here is how the information boundary widens, and there is no
 * other way. Every member owes a sentence naming the FAST-tier input it is a
 * projection of.
 */
export type SessionFacts = {
  /** The system prompt the fast tier is sent, resolved for this session. */
  readonly instructions: string;
  /** The session's conversation — the same list `ctx.messages` hands a tool. */
  readonly messages: readonly Message[];
  /** The tool schemas the agent declares. */
  readonly toolSchemas: readonly ToolSchema[];
};

/**
 * The slow tier's whole world.
 *
 * Unconstructible outside {@link slowTierViewOf}: the brand is a
 * `declare const … unique symbol`, so there is no value to write.
 */
export type SlowTierView = {
  readonly [VIEW_BRAND]: true;
  readonly instructions: string;
  readonly conversation: readonly Message[];
  readonly catalog: readonly ToolCatalogEntry[];
  readonly digest: StateDigest;
};

/**
 * Read the two classifications off a wire schema.
 *
 * Absent means "not declared", which is reported rather than assumed — see
 * `ToolDef.mutates`.
 */
export function classifyToolSchema(schema: ToolSchema): ToolCatalogEntry {
  return {
    name: schema.name,
    description: schema.description,
    // `completes` IMPLIES `mutates`, resolved here rather than at the
    // declaration site so an author who wrote only `completes: true` still
    // gets the step treated as one that cannot be taken back.
    mutates: schema.mutates === true || schema.completes === true,
    completes: schema.completes === true,
  };
}

/**
 * Build the slow tier's view from the session's own facts and its digest.
 *
 * @param facts what the fast tier has — see {@link SessionFacts}
 * @param digest this session's digest, read from its store
 * @param contextMessages how many trailing messages the window keeps
 */
export function slowTierViewOf(
  facts: SessionFacts,
  digest: StateDigest,
  contextMessages: number,
): SlowTierView {
  return {
    // The brand is an assertion rather than a value: there is nothing to
    // construct, and this is the one place allowed to claim it.
    ...({} as { readonly [VIEW_BRAND]: true }),
    instructions: facts.instructions,
    // The TAIL, because a decision is about what was just asked for; the
    // standing instructions carry what does not change.
    conversation: contextMessages > 0 ? facts.messages.slice(-contextMessages) : [],
    catalog: facts.toolSchemas.map(classifyToolSchema),
    digest,
  };
}
