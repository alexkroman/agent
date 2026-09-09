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
import type { ToolInputSchema } from "./schema.ts";
import type { RejectThenable, RejectThenableResult, SlotToolDef } from "./session-slot-types.ts";
import type { SlotHolder, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";

/**
 * A named slot of per-session state, created by {@link sessionSlot}.
 *
 * @typeParam K - The key this slot occupies in the session's state.
 * @typeParam T - The value's shape.
 * @typeParam V - What {@link SessionSlot.projected} projects to — the return of
 *   {@link SessionSlotOptions.view}, or the whole value when no view was
 *   declared.
 *
 * @public
 */
export interface SessionSlot<K extends string, T, V = DeepReadonly<T>> {
  /** The store key this slot occupies. Two slots must not share one. */
  readonly key: K;
  /** A fresh default value, as `get` would install one. */
  create(): T;
  /**
   * Whether this slot's value is stored durably. `true` unless the slot
   * declared otherwise — see {@link SessionSlotOptions.durable}.
   */
  readonly durable: boolean;
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
  tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
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
  updateTool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: SlotToolDef<P, T, R> & RejectThenable<R>,
  ): ToolDef<P, R>;
  /**
   * This slot's declared view as a `syncState` projection — built ONCE, here,
   * so both ends can pass the same object.
   *
   * `agent({ syncState: cartSlot.projected })` on the server and
   * `useAgentState(cartSlot.projected)` in the browser are then the SAME
   * projection by construction, and the frame rendered before the first push
   * cannot describe a different view than the frames pushed after it. Composing
   * `slot.projection(view)` at each end is what could: the two expressions have
   * to name the same view and nothing checks that they do.
   *
   * Being built at declaration also makes it identity-stable, which
   * `useAgentState` memoizes its empty frame on — so this spelling cannot
   * produce the fresh-object-per-render an inline `slot.projection(view)` does.
   *
   * With no {@link SessionSlotOptions.view}, this projects the whole value.
   * Declare one to narrow it.
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
  /**
   * A `syncState` projection over this slot: read the value (defaulting when
   * the session has not touched it), then project.
   *
   * **Reach for {@link SessionSlot.projected} first** — one view, declared with
   * the slot, passed by both ends. This is the multi-view case: `syncState`
   * takes an array, so an agent that shows one slot to two audiences composes a
   * second projection here.
   *
   * The result is CALLABLE as well as declarable, which is what lets a client
   * derive its own empty state from the same function the server pushes —
   * `slot.projection(view)()` is the pre-first-tool-call frame. Declaring it is
   * `agent({ syncState: slot.projection(view) })`, and an agent with more than
   * one slot passes an array; the frame carries the merge.
   *
   * `project` receives a REAL value, so a projection needs no optional chaining
   * for the moment before the first tool call.
   *
   * @example
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default agent({
   *   name: "Shop",
   *   syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
   * });
   * ```
   */
  projection<P>(project: (value: DeepReadonly<T>) => P): StateProjection<P>;
}
