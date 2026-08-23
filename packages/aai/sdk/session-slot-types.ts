// Copyright 2026 the AAI authors. MIT license.
/**
 * The authoring TYPES of `sessionSlot()` — what a caller passes IN.
 *
 * Split out of `sdk/session-slot.ts` when that file crossed the 500-line cap,
 * along the seam a reader already uses: these two are written by whoever
 * DECLARES a slot or a slot-backed tool, where `SessionSlot` itself is the
 * handle the factory answers with. Import them from `@alexkroman1/aai` —
 * `sdk/session-slot.ts` re-exports both, so nothing about where a slot type
 * comes from changed.
 *
 * @module session-slot-types
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * The authoring shape of a slot-backed tool: {@link ToolDef} with the slot's
 * value handed to `execute` directly.
 *
 * `value` comes SECOND because it is what a slot-backed tool body actually
 * uses; most take `(args, cart)` and never mention `ctx` at all, which is the
 * point. Putting it there rather than third cannot be got wrong silently — a
 * body converted from `tool()` that still names its second parameter `ctx` is a
 * type error the first time it reads `ctx.env`, since `V` is not a
 * {@link ToolContext}.
 *
 * @typeParam V - What `execute` is handed: a deep-frozen
 *   {@link DeepReadonly}`<T>` from {@link SessionSlot.tool}, a mutable draft
 *   from {@link SessionSlot.updateTool}.
 *
 * @public
 */
export interface SlotToolDef<P extends ToolInputSchema, V, R> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /** The tool body, handed this session's slot value alongside the usual args. */
  execute(args: InferSchemaOutput<P>, value: V, ctx: ToolContext): R;
}

/**
 * Options for {@link sessionSlot}.
 *
 * @public
 */
export interface SessionSlotOptions<T> {
  /**
   * Invariant restoration, run on the draft at the end of every successful
   * {@link SessionSlot.update} — pruning growth, recalculating a derived field.
   *
   * It exists so those rules live with the slot rather than being re-listed at
   * every mutating call site, which is how one gets forgotten. Because it runs
   * inside the mutation window, it sees the complete value about to be stored
   * and may mutate it in place.
   *
   * **It does NOT run when `mutate` throws.** A mutator that failed part-way
   * may have left the draft in a shape the hook itself cannot handle, and an
   * error thrown from the hook would replace the one that actually explains the
   * failure. Nothing is stored in that case either.
   */
  after?: (draft: T) => void;
  /**
   * Whether this slot's value is STORED. Defaults to `true`.
   *
   * `false` declares a VIRTUAL slot: a per-session box whose contents are
   * neither checked, frozen, nor committed, and which does not survive the
   * process. That is the right shape for a value whose lifetime is one call and
   * which could not be stored anyway — a provider handle, an open socket, a
   * cached client.
   *
   * It is a property of the slot's DECLARATION rather than a per-value opt-out,
   * which is what makes it a decision the author makes once instead of a check
   * somebody has to remember to skip. Note `get` on a virtual slot returns the
   * live value: there is nothing to protect it from, since nothing is going to
   * store a copy of it.
   */
  durable?: boolean;
}
