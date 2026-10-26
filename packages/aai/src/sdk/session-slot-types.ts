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
import type { Dialog } from "./dialog-handle.ts";
import type { DialogGate, DialogSendFrom, EventNameOf } from "./dialog-types.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

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
 * **Built FROM `ToolDef`, not copied from it.** Every field but `execute` is
 * `ToolDef`'s own — `description`, `inputSchema`, `onError`, `messages`, and
 * whatever `ToolDef` grows next — so a slot-backed tool can declare anything a
 * plain one can. The field-by-field copy this replaced restated three of them,
 * and the one it missed was `messages`: a slot tool could not declare tool-call
 * speech at all, although the builder spreads the def and the runtime would
 * have spoken it.
 *
 * `onError` behaves exactly as it does on any tool, and the slot is not
 * involved: an `updateTool` mutator that threw stored nothing, by that method's
 * own contract, so a handler is classifying a call that changed no state.
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
 * @input
 * @public
 */
export interface SlotToolDef<P extends ToolInputSchema | undefined, V, R>
  extends Omit<ToolDef<P, R>, "execute"> {
  /** The tool body, handed this session's slot value alongside the usual args. */
  execute(args: InferSchemaOutput<P>, value: V, ctx: ToolContext): R;
  /**
   * A precondition on the FROZEN value, checked before the body — and before
   * an update window opens. A returned {@link ToolFailure} is the tool's whole
   * result: no window, no `prepare`, nothing sent.
   *
   * For the "is there an order yet", "is the caller verified" check every
   * mutating body used to open with, written once beside the body rather than
   * as its first line, where the value in hand is already a draft. Handed the
   * readonly value whichever method the tool was declared through.
   *
   * With {@link SlotPreparedToolDef.prepare} it runs TWICE: once before the
   * await, once more on the fresh value right before the window, so a state
   * change during the await is caught.
   */
  require?: (value: DeepReadonly<V>, args: InferSchemaOutput<P>) => ToolFailure | undefined;
}

/**
 * The authoring shape of {@link SessionSlot.updateTool}: a {@link SlotToolDef}
 * over the mutable draft, plus `report`.
 *
 * @typeParam R - What `execute` returns — the PARTIAL result, if `report` is
 *   declared.
 * @typeParam R2 - What the tool answers after `report`; `R` without one.
 *
 * @input
 * @public
 */
export interface SlotUpdateToolDef<P extends ToolInputSchema | undefined, T, R, R2 = R>
  extends SlotToolDef<P, T, R> {
  /**
   * The mutation body: handed the DRAFT, stored when it returns.
   *
   * **A {@link ToolFailure} it RETURNS stores nothing**, exactly as a throw
   * does: the draft's mutations are discarded, nothing is pushed to the
   * client, and the failure is the tool's whole result. The gate's rule is
   * that a failed tool did not do the thing, and the slot keeps the same
   * rule — a body that pushed an item and then answered `toolFailure(…)` has
   * declined, not half-succeeded.
   */
  execute(args: InferSchemaOutput<P>, draft: T, ctx: ToolContext): R;
  /**
   * Complete the body's result from the value ACTUALLY STORED — after the
   * slot's `after` hook and `caps` have applied, which the draft inside the
   * window has not seen yet.
   *
   * `({ added }, stored) => ({ added, count: stored.items.length })`: the count
   * a body reads off its draft is the count BEFORE a cap trimmed it, and a
   * derived field `after` recalculates is not on the draft when the body
   * returns. Reporting from the stored value is the only reading that cannot
   * disagree with the next `get`. A `sendFrom` on a gated tool sees the
   * reported value.
   *
   * **It runs INSIDE the window**, on the value about to be stored, so a
   * {@link ToolFailure} it returns — or a throw — stores nothing, like the
   * body's own; it may not write the slot. A `report` that answers a promise
   * is settled after the window closed, and a failure it then resolves to
   * cannot discard. It reads the value BEFORE the dialog's `send`, so what an
   * `onEnter` hook writes to this slot during the move is not in `stored`.
   *
   * **Skipped when the body returned a {@link ToolFailure}**, which is answered
   * unchanged: a failure has no partial result to complete.
   */
  report?: (stored: DeepReadonly<T>, partial: NoInfer<Exclude<R, ToolFailure>>) => R2;
}

/**
 * {@link SlotUpdateToolDef} with an ASYNC `prepare` ahead of the synchronous
 * window — the shape of a mutating tool that has to await first.
 *
 * The window stays synchronous and the await moves in front of it, which is
 * the pattern {@link SessionSlot.update}'s doc prescribes by hand; declaring it
 * here is what lets a mutating tool stay ONE declaration. `execute` is handed
 * what `prepare` produced as its THIRD argument, ahead of `ctx` — so the
 * three-argument body of a tool without `prepare` is unchanged.
 *
 * @typeParam Prep - What `prepare` hands the body.
 *
 * @input
 * @public
 */
export interface SlotPreparedToolDef<P extends ToolInputSchema | undefined, T, Prep, R, R2 = R>
  extends Omit<SlotUpdateToolDef<P, T, R, R2>, "execute"> {
  /**
   * The async half: handed the args and the FROZEN value (no draft exists yet),
   * it awaits what the body needs — a model call, an HTTP lookup — and answers
   * it, or a {@link ToolFailure} that becomes the tool's result with no window
   * opened. `require`, if declared, is re-run on the fresh value afterwards.
   *
   * The failure is read STRUCTURALLY (`isToolFailure`): any record with a
   * string `error` field is one, so a fetched payload that happens to carry
   * `error: ""` ends the tool here. Rename or strip that field before
   * answering it.
   */
  prepare(
    args: InferSchemaOutput<P>,
    value: DeepReadonly<T>,
    ctx: ToolContext,
  ): Prep | ToolFailure | Promise<Prep | ToolFailure>;
  /** The synchronous body: the draft, then what `prepare` produced, then `ctx`. */
  execute(args: InferSchemaOutput<P>, draft: T, prepared: Prep, ctx: ToolContext): R;
}

/**
 * The {@link DialogGate} a slot-backed tool carries, with the dialog it is on.
 *
 * A {@link SessionSlot.tool} or {@link SessionSlot.updateTool} declaring
 * `dialog` runs exactly what {@link Dialog.tool} runs around the body — the
 * refusal before, the transition and the `{ ...position, result }` envelope
 * after, nothing sent on a {@link ToolFailure} — around its own read or update
 * window. `E` is read from the dialog handle alone (`NoInfer` on the gate's
 * own fields): with `send: E` an inference site too, a misspelled event was
 * simply inferred INTO `E`, and `Dialog<E>` — whose every `E` sits in a
 * bivariant method parameter — still accepted the handle.
 *
 * **A misuse is still reported on the `dialog:` line**, not at `send`: an
 * overload that fails every candidate is reported against the LAST one, the
 * ungated overload, where `dialog` is the first thing wrong. What that line
 * says is {@link UngatedDef}'s message, which names the gate fields to check.
 *
 * @typeParam R - The tool's result as the gate reads it (reported, for an
 *   `updateTool`).
 * @typeParam E - The dialog's event union.
 *
 * @input
 * @public
 */
export interface SlotDialogGate<R, E extends { type: string }, K extends string = string>
  extends DialogGate<Awaited<R>, NoInfer<E>, K> {
  /** The dialog this tool is gated on. */
  dialog: Dialog<E>;
  /**
   * {@link DialogGate.sendFrom}, with the function form's return spelled so a
   * plain `{ type: "QUOTED" }` literal keeps its literal.
   *
   * On {@link Dialog.tool} `E` is fixed by the handle, so the arrow's
   * contextual return type is the concrete union and the literal narrows.
   * Here `E` is a type parameter of the SAME call, and `NoInfer<E>`'s
   * apparent type is its constraint, `{ type: string }` — so a bare
   * `() => ({ type: "QUOTED" })` inferred `{ type: string }` (a zero-parameter
   * arrow is checked before `dialog` has supplied `E`, and its return type is
   * cached), failed the gated overload, and the author was told `dialog` does
   * not exist on `SlotToolDef`. Intersecting `{ type: EventNameOf<NoInfer<E>> }`
   * puts an INSTANTIABLE type (an indexed access over the type parameter,
   * constrained to `string`) in the `type` property's contextual position,
   * which is a literal context; once `E` is known the intersection is `E`
   * itself, so a payload an event declares is still required and
   * `{ type: "TYPO" }` is still refused.
   */
  sendFrom?: DialogSendFrom<Awaited<R>, NoInfer<E> & { type: EventNameOf<NoInfer<E>> }, K>;
}

/**
 * What {@link SessionSlot.transact} takes: the async half, then the
 * synchronous window — {@link SlotPreparedToolDef}'s two halves for a caller
 * inside a plain `tool()` body.
 *
 * @typeParam Prep - What `prepare` hands `commit`.
 * @typeParam R - What `commit` returns.
 *
 * @input
 * @public
 */
export interface SlotTransaction<T, Prep, R> {
  /** A precondition on the frozen value — see {@link SlotToolDef.require}. Run before `prepare` and again before `commit`. */
  require?: (value: DeepReadonly<T>) => ToolFailure | undefined;
  /** The await, handed the frozen value; a {@link ToolFailure} ends the transaction with no window. */
  prepare(value: DeepReadonly<T>): Prep | ToolFailure | Promise<Prep | ToolFailure>;
  /**
   * The synchronous window, handed the draft and what `prepare` produced. A
   * {@link ToolFailure} it returns stores nothing, like a throw — see
   * {@link SlotUpdateToolDef.execute}.
   */
  commit(draft: T, prepared: Prep): R;
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
 * @input
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
   * cannot disagree, and the projection is identity-stable for the life of
   * the module.
   *
   * **Absent, the WHOLE value is projected.** Declare a view to narrow it — to
   * what the page renders, rather than to whatever the slot happens to hold.
   *
   * A slot has ONE projection; a page that needs a second shape of the same
   * slot derives it from this one.
   *
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * type Cart = { items: string[]; nextId: number };
   * export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], nextId: 1 }), {
   *   view: (cart) => ({ count: cart.items.length }),
   *   sync: true,
   * });
   *
   * export default agent({ name: "Shop" });
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
   * Invariant restoration, run on the value at the end of every successful
   * {@link SessionSlot.update} — pruning growth, recalculating a derived field.
   *
   * It exists so those rules live with the slot rather than being re-listed at
   * every mutating call site, which is how one gets forgotten. Because it runs
   * inside the mutation window, it sees the complete value about to be stored
   * and may mutate it in place.
   *
   * **It runs on EVERY store, not only `update`**: on the default the first
   * `get` installs, on `set`, on `reset`, and on the frame `projected()`
   * renders with no argument. A derived field the hook computes was absent
   * from the default and present after the first update, so a page rendered
   * two shapes of one slot and a tool reading the default saw the field
   * missing. Caps still apply after it, on every path.
   *
   * **It does NOT run when `mutate` throws.** A mutator that failed part-way
   * may have left the draft in a shape the hook itself cannot handle, and an
   * error thrown from the hook would replace the one that actually explains the
   * failure. Nothing is stored in that case either.
   *
   * **A throw from it on a value the SLOT produced is framed**: on the default
   * and on the `empty` frame the error names the slot and the phase ("failed
   * on the default", "on the empty frame"), with the hook's own error as its
   * `cause`, since a hook written for a populated value is most often tripped
   * by the blank the slot made for it. On a caller's own value (`set`, a draft)
   * it is the caller's error, unchanged.
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
   * Register {@link SessionSlot.projected} with `agent()`, which collects
   * every slot declared with `sync: true` into `AgentDef.syncState` — the
   * only way a slot reaches the browser, since `syncState` is not a parameter.
   *
   * The slot is then declared ONCE, view and all, and the agent names nothing:
   * `sessionSlot("cart", create, { view, sync: true })` is the whole wiring.
   *
   * **It works because `agent.ts` and `shared.ts` share one bundle**: the
   * registry is module state in the SDK copy the bundle carries, and
   * `agent()` reads it when `agent.ts` runs, so the slot has to be declared in
   * a module `agent.ts` imports (`shared.ts`), not only in a `tools/` file the
   * build loads afterwards.
   */
  sync?: boolean;
  /**
   * What {@link SessionSlot.projected} projects for a session that has not
   * touched the slot, INSTEAD of `create()`.
   *
   * For a SEEDED slot: `create` builds the catalogue or the demo accounts the
   * first `get` installs, and `projected()` with no argument — the frame a page
   * renders before its first push — would otherwise ship that seed to the
   * browser. `empty()` is the shape with nothing in it. Runs through `after`
   * and `caps` like any stored value.
   */
  empty?: () => T;
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
