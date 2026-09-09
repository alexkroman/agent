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

import type { DeepReadonly } from "./deep-readonly.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef, ToolErrorHandler } from "./types.ts";

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
 * This repo has one (`retailTool` in the retail-orders-agent template, which wraps every one
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
  /**
   * See {@link ToolDef.onError} — what a THROW out of this body means, and the
   * only way to say that a failure is fatal rather than something the model
   * should try again.
   *
   * It is forwarded to the {@link ToolDef} this builds and behaves identically:
   * the slot is not involved, because there is nothing left to hand a handler —
   * an `updateTool` mutator that threw stored nothing, by that method's own
   * contract, so `onError` is classifying a call that changed no state.
   */
  onError?: ToolErrorHandler;
}

/**
 * Growth caps for the ARRAYS at the top level of a slot's value — the type of
 * {@link SessionSlotOptions.caps}.
 *
 * A key is accepted only when the value under it is an array (or an array
 * behind `null`/`undefined`), so declaring a cap on a counter or a nested
 * object is a compile error naming the key rather than a bound that silently
 * applies to nothing. Each cap is the most entries that array keeps.
 *
 * @public
 */
export type SlotCaps<T> = T extends object
  ? {
      readonly [K in keyof T as NonNullable<T[K]> extends readonly unknown[] ? K : never]?: number;
    }
  : // A homomorphic mapped type over a PRIMITIVE is the primitive (`Partial<number>`
    // is `number`), which would let a counter slot declare `caps: 3`. A slot
    // holding a primitive has nothing to cap.
    never;

/**
 * Options for {@link sessionSlot}.
 *
 * @typeParam V - What {@link SessionSlotOptions.view} projects to, inferred from
 *   the view itself. Defaults to the whole value, which is what
 *   {@link SessionSlot.projected} projects when no view is declared.
 *
 * @public
 */
export interface SessionSlotOptions<T, After = void, V = DeepReadonly<T>> {
  /**
   * What this slot shows the BROWSER — declared here so it is written once and
   * read from both ends as {@link SessionSlot.projected}.
   *
   * `agent({ syncState: cartSlot.projected })` and
   * `useAgentState(cartSlot.projected)` are then the same object, so the frame
   * the server pushes and the frame the page renders before the first push
   * cannot disagree. That drift is what this field exists to remove:
   * {@link SessionSlot.projection} is a METHOD, so the projection is a value
   * somebody has to name, export and import at both ends — and every shipped
   * example that got it right did so by exporting
   * `export const cartProjection = cartSlot.projection(cartView)` from a
   * `shared.ts`, eight of them also hand-writing the `StateProjection<V>`
   * annotation that follows from the view.
   *
   * It also makes the memoization caveat on `useAgentState` evaporate for this
   * path: `projected` is built ONCE, at declaration, so it is identity-stable
   * for the life of the module and a projection spelled inline in a render body
   * is not something this spelling can express.
   *
   * **Absent, the WHOLE value is projected.** Declare a view to narrow it — to
   * what the page renders, rather than to whatever the slot happens to hold.
   *
   * A slot with more than one audience keeps
   * {@link SessionSlot.projection}: `syncState` takes an array, so a second view
   * is a second projection over the same slot.
   *
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * type Cart = { items: string[]; nextId: number };
   * export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], nextId: 1 }), {
   *   view: (cart) => ({ count: cart.items.length }),
   * });
   *
   * export default agent({ name: "Shop", syncState: cartSlot.projected });
   * ```
   */
  view?: (value: DeepReadonly<T>) => V;
  /**
   * Growth caps on the slot's top-level arrays, enforced by the SLOT on every
   * store — `update`, `set`, `reset`, and the first `get` that installs the
   * default — dropping the OLDEST entries past each cap.
   *
   * For the append-only lists an agent keeps: a call log, an activity feed, a
   * finding board. Every one feeds a prompt or a `syncState` frame, so
   * uncapped it grows what the model reads and what crosses the wire for the
   * length of the call. Declared here rather than at each `push`, because a
   * wrapper caps only the paths that call it: a slot with three capped arrays
   * and a fourth pushed to directly is the shape this replaces.
   *
   * **It runs AFTER {@link SessionSlotOptions.after}**, and that ordering is a
   * decision rather than an accident. A hook may itself append (restoring a
   * sentinel, recording what it recalculated), so a cap applied before it
   * could be exceeded by the hook's own write; applied after, the cap is the
   * last word and the stored value never exceeds it. The price is that the
   * hook sees the UNTRIMMED draft: a derived field that reads the array's
   * TAIL (`lastLine: log.at(-1)`) is unaffected, one that reads its `length`
   * counts the entries about to fall off. A mutator's own result is in the
   * same position, as it already is with `after`.
   *
   * **Top-level arrays only** — a key is accepted only when the value under it
   * is an array (see {@link SlotCaps}). A nested list (one timeline per
   * incident) has no single key to declare and stays on `pushCapped`, which is
   * the same bound applied by hand.
   *
   * A cap that is not a non-negative integer is refused at DECLARATION, naming
   * the slot and the key. Zero keeps nothing, as `pushCapped(…, 0)` does.
   *
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   *
   * type Desk = { log: string[]; findings: string[]; open: string | null };
   * export const deskSlot = sessionSlot(
   *   "desk",
   *   (): Desk => ({ log: [], findings: [], open: null }),
   *   { caps: { log: 40, findings: 12 } },
   * );
   * ```
   */
  caps?: SlotCaps<T>;
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
