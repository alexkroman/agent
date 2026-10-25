// Copyright 2026 the AAI authors. MIT license.
/**
 * What `sessionSlot()` hands BACK: the handle every tool module, event handler
 * and `agent.ts` holds.
 *
 * Split from `sdk/session-slot.ts` when that file reached the 500-line cap,
 * along the seam the package already draws for `dialog()` — `sdk/dialog-types.ts`
 * for what an author DECLARES and `sdk/dialog-handle.ts` for the object those
 * declarations produce. Here that is `sdk/session-slot-types.ts` (the options, a
 * slot-backed tool's shape, the caps) against this file. The line is worth
 * keeping even though both are types: the declaration half is read while writing
 * the slot, and this half while writing the code that drives one.
 *
 * Re-exported by `sdk/session-slot.ts` and so by `@alexkroman1/aai`: no import
 * moved, and none should have to.
 *
 * @module session-slot-handle
 */

import type { DeepReadonly } from "./deep-readonly.ts";
import type { DialogSendFromChecked, DialogSendOptions, DialogToolResult } from "./dialog-types.ts";
import type { ToolInputSchema } from "./schema.ts";
import type {
  RejectThenable,
  RejectThenableResult,
  SlotDialogGate,
  SlotPreparedToolDef,
  SlotToolDef,
  SlotTransaction,
  SlotUpdateToolDef,
} from "./session-slot-types.ts";
import type { SlotHolder, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

/**
 * The frozen value a slot hands a reader — `DeepReadonly<T>` for the slot's
 * own `T`, read off the handle so a helper's signature names the slot rather
 * than restating its type: `(cart: SlotValueOf<typeof cartSlot>) => …`.
 *
 * **For a helper declared AFTER the slot.** The slot's type depends on its
 * `view`, so a `view` written inline cannot name `SlotValueOf<typeof thisSlot>`
 * for its own parameter — that is `typeof thisSlot` referring to itself
 * (`TS7022`). Inside the declaration the parameter is already typed:
 * `view: (cart) => …` sees `DeepReadonly<T>` with no annotation at all.
 *
 * @public
 */
export type SlotValueOf<S extends SessionSlot<string, unknown, unknown>> =
  S extends SessionSlot<string, infer T, unknown> ? DeepReadonly<T> : never;

/**
 * The mutable draft a slot hands a mutator — the slot's own `T`, read off the
 * handle: `(cart: SlotDraftOf<typeof cartSlot>) => …` for a helper called
 * inside `update`/`updateTool`.
 *
 * @public
 */
export type SlotDraftOf<S extends SessionSlot<string, unknown, unknown>> =
  S extends SessionSlot<string, infer T, unknown> ? T : never;

/**
 * What a slot tool declaring a dialog gate resolves: the dialog envelope over the
 * body's success value, or the refusal/failure. Named because every gated
 * overload of {@link SessionSlot.tool} and {@link SessionSlot.updateTool} answers it.
 *
 * @sealed
 * @public
 */
export type GatedOutput<R> = Promise<
  DialogToolResult<Exclude<Awaited<R>, ToolFailure>> | ToolFailure
>;

/**
 * A named slot of per-session state, created by {@link sessionSlot}.
 *
 * @typeParam K - The key this slot occupies in the session's state.
 * @typeParam T - The value's shape.
 * @typeParam V - What {@link SessionSlot.projected} projects to — the return of
 *   {@link SessionSlotOptions.view}, or the whole value when no view was
 *   declared.
 *
 * @sealed
 * @public
 */
export interface SessionSlot<K extends string, T, V = DeepReadonly<T>> {
  /** The store key this slot occupies. Two slots must not share one. */
  readonly key: K;
  /**
   * A fresh default value, as `get` would install one — the factory the slot
   * was declared with, or a `structuredClone` of the plain value it was.
   */
  create(): T;
  /**
   * Whether this slot's value is stored durably. `true` unless the slot
   * declared otherwise — see {@link SessionSlotOptions.durable}.
   */
  readonly durable: boolean;
  /**
   * The caps the slot DECLARED ({@link SessionSlotOptions.caps}), when it
   * declared any — read back by `expectSlotContract`, so a spec need not
   * restate them. Typed as the record it is on the wire rather than
   * `SlotCaps<T>`, which is `never` for the erased `T` the `SlotValueOf`
   * constraint reads through.
   */
  readonly caps?: Readonly<Partial<Record<string, number>>>;
  /** The seeded slot's blank ({@link SessionSlotOptions.empty}), when declared. */
  readonly empty?: () => T;
  /**
   * This session's value, installing the default on first access.
   *
   * **Readonly all the way down, and frozen to match.** Mutating what this
   * returns is a compile error at every depth — `cart.items.push(x)` as much as
   * `cart.total = 0` — and a `TypeError` for a caller with no types, because a
   * mutation applied here is applied to a value nothing is going to store.
   * Every write goes through {@link SessionSlot.update}. See
   * {@link DeepReadonly} for why the type is deep rather than shallow.
   */
  get(ctx: SlotHolder): DeepReadonly<T>;
  /**
   * A MUTABLE deep copy of this session's value — `structuredClone` of what
   * {@link SessionSlot.get} returns, typed as the slot's own `T` rather than
   * its readonly view, installing the default on first access like `get`.
   *
   * For the caller that wants to hold a value BESIDE the slot: a spec recording
   * the state before a tool runs so it can restore it with
   * {@link SessionSlot.set}, or a tool building a modified candidate it may
   * never store. Mutating the copy changes nothing stored — every write still
   * goes through `update` or `set`. It replaces
   * `structuredClone(slot.get(ctx)) as Parameters<typeof slot.set>[1]`, whose
   * cast was the only way back from `DeepReadonly<T>` to `T`.
   */
  snapshot(ctx: SlotHolder): T;
  /**
   * Mutate this session's value, and store the result.
   *
   * `mutate` is handed a mutable DRAFT — a private copy of the current value —
   * and whatever it leaves behind becomes the stored value when it returns.
   * Resolves to whatever `mutate` returned, so a tool body can compute its
   * result and its mutation in one pass.
   *
   * **It is SYNCHRONOUS, and that is the invariant, not an implementation
   * detail.** There is no await between the read and the write, so a
   * read-modify-write cannot interleave with another JS turn — which matters
   * because the LLM loop runs a step's tool calls CONCURRENTLY. Await in FRONT
   * of the mutation instead:
   *
   * ```ts
   * import { sessionSlot, tool } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[], quote: 0 }));
   *
   * export default tool({
   *   description: "Price the cart",
   *   inputSchema: z.object({}),
   *   execute: async (_args, ctx) => {
   *     const quote = await ctx.generate({ prompt: "price it" });   // await first
   *     return cartSlot.update(ctx, (cart) => {                     // then mutate
   *       cart.quote = Number(quote.text);
   *       return { quote: cart.quote };
   *     });
   *   },
   * });
   * ```
   *
   * A mutator that throws stores NOTHING: the draft is discarded and the
   * mutator's error propagates. The `after` hook does not run either — see
   * {@link SessionSlotOptions.after}.
   *
   * For serialized work that is not a slot mutation — an external resource, a
   * key that isn't the session id, or a mutation that must fail rather than
   * queue — reach for `createKeyedLock`/`withLock`. They are public for exactly
   * that, and this method no longer takes a lock at all: a synchronous window
   * has nothing to serialize.
   */
  update<R>(ctx: SlotHolder, mutate: (draft: T) => R): RejectThenableResult<R>;
  /**
   * Replace this session's value wholesale (a load, an import, a restore), and
   * return it as `get` would.
   *
   * **The caller's object is COPIED, not adopted.** A durable slot freezes what
   * it stores, and this method's own examples — a load, an import, a restore —
   * are exactly the cases where the caller still holds a reference to what it
   * passed: freezing in place turned an unrelated later line
   * (`imported.items.push(...)`) into a `TypeError` from a stack that names
   * nothing about this slot. {@link SessionSlot.update} was already safe because
   * its draft is a copy; this is the same rule applied to the other writer.
   */
  set(ctx: SlotHolder, value: T): DeepReadonly<T>;
  /** Discard this session's value and install a fresh default, and return it. */
  reset(ctx: SlotHolder): DeepReadonly<T>;
  /**
   * Define a READ-ONLY tool over this slot: `execute` is handed the frozen
   * value, so the body needs neither a context annotation nor an opening
   * `slot.get(ctx)`.
   *
   * A body that mutates wants {@link SessionSlot.updateTool}. This one's value
   * is {@link DeepReadonly}`<T>`, so choosing wrong is a compile error — at any
   * depth — rather than a write that goes nowhere or throws.
   *
   * **`R` is threaded out**, as {@link tool}'s is: `R` used to be bound here and
   * thrown away at the interface, so `InferToolOutput` answered `unknown` for
   * exactly the tools an agent most often writes. Narrowing a return type is
   * covariant, so the tool stays assignable to `ToolDef<ToolInputSchema>`.
   *
   * **Declaring `dialog` gates it** (see {@link SlotDialogGate}): the refusal
   * runs before the read, `send`/`sendFrom` after a success, and the tool
   * answers the {@link DialogToolResult} envelope exactly as {@link Dialog.tool}
   * does — which is why that overload's output is wrapped and async. A
   * `require` precondition runs before the body on either overload.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default cartSlot.tool({
   *   description: "How many items are in the cart",
   *   inputSchema: z.object({}),
   *   execute: (_args, cart) => ({ count: cart.items.length }),
   * });
   * ```
   */
  tool<
    P extends ToolInputSchema | undefined = ToolInputSchema,
    R = unknown,
    E extends { type: string } = { type: string },
    K extends string = string,
  >(
    def: SlotToolDef<P, DeepReadonly<T>, R> & SlotDialogGate<R, E, K>,
    options?: DialogSendOptions<Awaited<R>, E, K>,
  ): DialogSendFromChecked<K, Awaited<R>, E, ToolDef<P, GatedOutput<R>>>;
  tool<P extends ToolInputSchema | undefined = ToolInputSchema, R = unknown>(
    def: SlotToolDef<P, DeepReadonly<T>, R>,
  ): ToolDef<P, R>;
  /**
   * Define a MUTATING tool over this slot: the body runs inside
   * {@link SessionSlot.update}, so it is handed a draft and whatever it leaves
   * behind is stored.
   *
   * The body must therefore be SYNCHRONOUS. A tool that has to await does the
   * awaiting in an ordinary `tool()` and calls `update` afterwards; see
   * `update`'s example.
   *
   * That is enforced at RUN TIME rather than in the type, and the reason is
   * worth knowing before "fixing" it: a conditional return type
   * (`R extends Promise<unknown> ? never : R`) cannot be satisfied by a generic
   * WRAPPER around this method, and a per-agent wrapper is the main way it gets
   * used (`retail-orders-agent`'s `retailTool`). The runtime check has the better message
   * anyway, and it is the half a user's project actually runs — neither bundler
   * type-checks user code.
   *
   * **It fires at DECLARATION for the common case.** An `async` body is an
   * `AsyncFunction`, visible the moment the module loads — under `aai dev`, in
   * the build, in the agent's own spec. A sync function that RETURNS a promise
   * is the other half, and only the call can catch it.
   *
   * **The four overloads are one pipeline with optional stages**, in order:
   * the dialog refusal (`dialog`), `require` on the frozen value, the async
   * `prepare` and a second `require`, the synchronous window (`execute`, then
   * the slot's `after` and `caps`), `report` on the stored value, and the
   * dialog's `send`/`sendFrom` with the envelope. A tool declaring `prepare`
   * or `dialog` is therefore async and may answer a {@link ToolFailure}; one
   * declaring neither keeps the synchronous `R` it always had. See
   * {@link SlotPreparedToolDef}, {@link SlotUpdateToolDef.report} and
   * {@link SlotDialogGate}. A `require` refusal is a `ToolFailure` the
   * declared result type does not spell on the plain overload, like a thrown
   * error's — the model-facing channel, not the client's.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default cartSlot.updateTool({
   *   description: "Add an item to the cart",
   *   inputSchema: z.object({ item: z.string() }),
   *   execute: ({ item }, cart) => {
   *     cart.items.push(item);
   *     return { count: cart.items.length };
   *   },
   * });
   * ```
   */
  updateTool<
    P extends ToolInputSchema | undefined = ToolInputSchema,
    Prep = unknown,
    R = unknown,
    R2 = R,
    E extends { type: string } = { type: string },
    K extends string = string,
  >(
    def: SlotPreparedToolDef<P, T, Prep, R, R2> & SlotDialogGate<R2, E, K> & RejectThenable<R>,
    options?: DialogSendOptions<R2, E, K>,
  ): DialogSendFromChecked<K, R2, E, ToolDef<P, GatedOutput<R2>>>;
  updateTool<
    P extends ToolInputSchema | undefined = ToolInputSchema,
    Prep = unknown,
    R = unknown,
    R2 = R,
  >(
    def: SlotPreparedToolDef<P, T, Prep, R, R2> & RejectThenable<R>,
  ): ToolDef<P, Promise<R2 | ToolFailure>>;
  updateTool<
    P extends ToolInputSchema | undefined = ToolInputSchema,
    R = unknown,
    R2 = R,
    E extends { type: string } = { type: string },
    K extends string = string,
  >(
    def: SlotUpdateToolDef<P, T, R, R2> & SlotDialogGate<R2, E, K> & RejectThenable<R>,
    options?: DialogSendOptions<R2, E, K>,
  ): DialogSendFromChecked<K, R2, E, ToolDef<P, GatedOutput<R2>>>;
  updateTool<P extends ToolInputSchema | undefined = ToolInputSchema, R = unknown, R2 = R>(
    def: SlotUpdateToolDef<P, T, R, R2> & RejectThenable<R>,
  ): ToolDef<P, R2 | Extract<R, ToolFailure>>;
  /**
   * An await ahead of a synchronous window, from inside a plain `tool()`: the
   * non-tool form of {@link SlotPreparedToolDef}.
   *
   * `prepare` runs on the frozen value (and `require`, if declared, before it
   * and again right before the window); a {@link ToolFailure} from either ends
   * the transaction as its result, and nothing is stored. `commit` is the
   * window — handed the draft and what `prepare` produced — and its return is
   * the transaction's.
   *
   * @example
   * ```ts
   * import { sessionSlot, tool, toolFailure } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[], quote: 0 }));
   *
   * export default tool({
   *   description: "Price the cart",
   *   inputSchema: z.object({}),
   *   execute: (_args, ctx) =>
   *     cartSlot.transact(ctx, {
   *       require: (cart) => (cart.items.length === 0 ? toolFailure("The cart is empty.") : undefined),
   *       prepare: async (cart) => Number((await ctx.generate({ prompt: `price ${cart.items}` })).text),
   *       commit: (cart, quote) => {
   *         cart.quote = quote;
   *         return { quote };
   *       },
   *     }),
   * });
   * ```
   */
  transact<Prep, R>(ctx: SlotHolder, tx: SlotTransaction<T, Prep, R>): Promise<R | ToolFailure>;
  /**
   * This slot's view as a `syncState` projection — THE way to project a slot.
   * Built once, at declaration, so both ends pass the same object.
   *
   * `agent({ syncState: cartSlot.projected })` on the server and
   * `useAgentState(cartSlot.projected)` in the browser are then the SAME
   * projection by construction, so the frame rendered before the first push
   * cannot describe a different view than the frames pushed after it. Being
   * built at declaration also makes it identity-stable, which `useAgentState`
   * memoizes its empty frame on.
   *
   * Callable with nothing — `cartSlot.projected()` is the pre-first-tool-call
   * frame: the default (or {@link SessionSlotOptions.empty}), with `after` and
   * `caps` applied. With no {@link SessionSlotOptions.view}, it projects the
   * whole value; declare one to narrow it to what the page renders.
   *
   * @example
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }), {
   *   view: (cart) => ({ count: cart.items.length }),
   * });
   *
   * export default agent({ name: "Shop", syncState: cartSlot.projected });
   * ```
   */
  readonly projected: StateProjection<V>;
}
