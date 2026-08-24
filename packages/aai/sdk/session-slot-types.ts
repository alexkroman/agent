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
 * The compile error a mutation body gets for being `async`.
 *
 * A message TYPE rather than a comment, on the same pattern as `AgentParams`'
 * misuse arms: intersecting it into a parameter position makes the offending
 * argument unassignable and puts the rule itself in what `tsc` prints.
 */
export type SyncMutationMisuse =
  "a slot mutation window is SYNCHRONOUS — `await` BEFORE the mutation, not inside it: the draft is stored when the body returns, so an await inside one writes to a value that has already been stored";

/**
 * `unknown` — i.e. no additional constraint — unless `R` is thenable, in which
 * case {@link SyncMutationMisuse}, which nothing an author can pass satisfies.
 *
 * @remarks
 * This is the invariant that cost `aai:state` epochs 3 through 6, all four
 * dropped for a change `pnpm typecheck` could not see: the examples still
 * COMPILED and threw on their first call. The SDK's runtime refusal is still
 * there and still names the rule; this makes the same rule a compile error, so
 * the gate can prove what the drop reasons had to assert by hand.
 */
export type RejectThenable<R> =
  IsAny<R> extends true
    ? unknown
    : [R] extends [never]
      ? unknown
      : [R] extends [PromiseLike<unknown>]
        ? SyncMutationMisuse
        : unknown;

/**
 * The same check in RETURN position: `R`, unless `R` is thenable, in which case
 * {@link SyncMutationMisuse}.
 *
 * {@link SessionSlot.update} uses this rather than {@link RejectThenable}, and
 * the difference is generic WRAPPERS. A parameter typed
 * `((draft: T) => R) & RejectThenable<R>` cannot be satisfied when `R` is still
 * a type parameter — the conditional is deferred and nothing is assignable to
 * it — so a helper that forwards its own `R` into a mutation stops compiling.
 * This repo has one (`retailTool` in the retail template, which wraps every one
 * of its fifteen tools), and making it and every future wrapper carry a cast
 * would be a worse trade than the weaker check.
 *
 * Weaker in exactly one way: an async body whose RESULT is discarded is not an
 * error, where the parameter form would catch it. Everything that uses the
 * result — an annotation, a return, a `tool()` body — still gets one, and
 * `updateTool`, which is what all four dropped `aai:state` epochs actually got
 * wrong, keeps the strong form because its argument is an object rather than a
 * forwarded callback. The runtime refusal covers the rest.
 */
export type RejectThenableResult<R> =
  IsAny<R> extends true
    ? R
    : [R] extends [never]
      ? R
      : [R] extends [PromiseLike<unknown>]
        ? SyncMutationMisuse
        : R;

/**
 * Whether `T` is `any`.
 *
 * `any` is assignable to everything, `PromiseLike<unknown>` included, so
 * without this arm a mutator whose return type inference lands on `any` — six
 * of this repo's own specs, where the callback body is an expression — is
 * reported as an async mutation. `0 extends 1 & T` is only true for `any`,
 * because the intersection collapses to `any` and nothing else absorbs `1`.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

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
export interface SessionSlotOptions<T, After = void> {
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
   *
   * **It runs INSIDE the mutation window, so it is synchronous too** — an
   * `async` hook is a compile error naming the rule — see `RejectThenable`,
   * which is off the docs for the reason the `AgentParams` misuse types are:
   * you meet it in what tsc prints, never by name.
   * The `After` parameter exists only to carry that check: it is inferred from
   * the hook and defaults to `void`, so a caller never writes it.
   */
  after?: ((draft: T) => After) & RejectThenable<After>;
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
