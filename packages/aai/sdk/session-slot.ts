// Copyright 2026 the AAI authors. MIT license.
/**
 * Typed named slots inside `ctx.state` — the one seam a multi-file agent needs
 * to read and write its own session state without a cast.
 *
 * @module session-slot
 */

import { createKeyedLock, withLock } from "./keyed-lock.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * The `ctx.state` shape a slot keyed `K` holding `T` requires: one optional
 * property, so a session that has not touched the slot yet is still a legal
 * state object.
 *
 * @public
 */
export type SlotState<K extends string, T> = { [P in K]?: T };

/**
 * The `ctx.state` shape a slot requires, derived from the slot itself — the
 * one spelling of a slot-backed agent's state type.
 *
 * @example
 * ```ts
 * import { sessionSlot, type SlotStateOf } from "@alexkroman1/aai";
 *
 * export const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
 * export type StateSlot = SlotStateOf<typeof cartSlot>;
 * ```
 *
 * @public
 */
export type SlotStateOf<S> = S extends SessionSlot<infer K, infer T> ? SlotState<K, T> : never;

/**
 * The authoring shape of a slot-backed tool: {@link ToolDef} with the slot's
 * live value handed to `execute` directly.
 *
 * `value` comes SECOND because it is what a slot-backed tool body actually
 * uses; most take `(args, cart)` and never mention `ctx` at all, which is the
 * point. Putting it there rather than third cannot be got wrong silently — a
 * body converted from `tool()` that still names its second parameter `ctx` is a
 * type error the first time it reads `ctx.state`, since `T` is not a
 * {@link ToolContext}.
 *
 * @public
 */
export interface SlotToolDef<P extends ToolInputSchema, K extends string, T> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /** The tool body, handed this session's slot value alongside the usual args. */
  execute(
    args: InferSchemaOutput<P>,
    value: T,
    ctx: ToolContext<SlotState<K, T>>,
  ): Promise<unknown> | unknown;
}

/**
 * A named slot inside `ctx.state`, created by {@link sessionSlot}.
 *
 * @typeParam K - The property name the value is stored under.
 * @typeParam T - The value's shape.
 *
 * @public
 */
export interface SessionSlot<K extends string, T> {
  /** The `ctx.state` property this slot occupies. */
  readonly key: K;
  /** A fresh default value, as `get` would install one. */
  create(): T;
  /**
   * This slot's `AgentDef.state` factory — `agent({ state: cartSlot.state })`.
   *
   * Declaring `state` makes the session's state object exist BEFORE the first
   * tool call, which is what `pushStateSnapshot` needs to have something to
   * project on a resumed connection. The slot installs itself lazily either
   * way, so this is not required — it is just the half that is easy to forget,
   * and was: of the five shipped templates built on a slot, four omitted the
   * hand-written `() => ({ [slot.key]: slot.create() })` this replaces, despite
   * the guide telling them to write it. A property that is already correct
   * cannot be forgotten in the same way.
   *
   * A factory rather than the slot itself because `AgentDef.state` IS a
   * factory: handing it one keeps `S` inferred from the same position it has
   * always been inferred from, so tools stay checked against the state shape
   * with no widening anywhere.
   *
   * @example
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default agent({
   *   name: "Shop",
   *   state: cartSlot.state,
   *   syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
   * });
   * ```
   */
  readonly state: () => SlotState<K, T>;
  /**
   * Define a tool over this slot: `execute` is handed the live value, so the
   * body needs neither a `ToolContext<SlotStateOf<typeof slot>>` annotation nor
   * an opening `slot.get(ctx)`.
   *
   * Those two lines are what a slot-backed tool in its own module costs today —
   * every tool in every stateful template opens with them. The tool this
   * returns is an ordinary {@link ToolDef}, so it drops into `agent({ tools })`
   * unchanged.
   *
   * `get` semantics: fine for a synchronous read-modify-write, which cannot
   * interleave. **A body that awaits between reading and writing wants
   * {@link SessionSlot.updateTool} instead**, for the reason
   * {@link SessionSlot.update} gives.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export const addItem = cartSlot.tool({
   *   description: "Add an item to the cart",
   *   inputSchema: z.object({ item: z.string() }),
   *   execute: ({ item }, cart) => {
   *     cart.items.push(item);
   *     return { count: cart.items.length };
   *   },
   * });
   * ```
   */
  tool<P extends ToolInputSchema = ToolInputSchema>(
    def: SlotToolDef<P, K, T>,
  ): ToolDef<P, SlotState<K, T>>;
  /**
   * {@link SessionSlot.tool}, with the body run inside
   * {@link SessionSlot.update} — serialized per session, and followed by the
   * slot's `after` hook.
   *
   * The one to reach for whenever the body AWAITS: the LLM loop runs a step's
   * tool calls concurrently, so two async mutators of one slot interleave at
   * every await and each reads what the other half-applied.
   *
   * **Inherits `update`'s non-reentrancy**, which is the one thing to hold in
   * mind: a body that calls `update` (or another `updateTool`) on the SAME slot
   * waits on a key only its own caller can release — a deadlock, not an error.
   * Call the value you were handed, not back through the slot.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export const addItem = cartSlot.updateTool({
   *   description: "Add an item to the cart",
   *   inputSchema: z.object({ sku: z.string() }),
   *   execute: async ({ sku }, cart) => {
   *     const priced = await Promise.resolve(sku);
   *     cart.items.push(priced);
   *     return { count: cart.items.length };
   *   },
   * });
   * ```
   */
  updateTool<P extends ToolInputSchema = ToolInputSchema>(
    def: SlotToolDef<P, K, T>,
  ): ToolDef<P, SlotState<K, T>>;
  /**
   * This session's live value, installing the default on first access.
   *
   * Mutations to the returned object stick — it *is* the object stored in
   * `ctx.state`, not a copy.
   */
  get(ctx: ToolContext<SlotState<K, T>>): T;
  /** Replace this session's value wholesale (a load, an import, a restore). */
  set(ctx: ToolContext<SlotState<K, T>>, value: T): T;
  /** Discard this session's value and install a fresh default. */
  reset(ctx: ToolContext<SlotState<K, T>>): T;
  /**
   * Read a slot out of a whole state object, defaulting when absent — the
   * shape `AgentDef.syncState` is handed.
   */
  read(state: SlotState<K, T> | undefined): T;
  /**
   * A `syncState` projection over this slot: `read`, then `project`.
   *
   * The point is that `project` receives a REAL value, so a projection needs
   * no optional chaining for the pre-first-tool-call moment.
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
  projection<V>(project: (value: T) => V): (state: SlotState<K, T> | undefined) => V;
  /**
   * Mutate this session's value under a per-session lock, then run the slot's
   * `after` hook. Resolves with whatever `mutate` returned.
   *
   * **Use this instead of `get` for any mutation that awaits.** The LLM loop
   * runs a step's tool calls CONCURRENTLY, so two async mutators of one slot
   * interleave at every await and each reads what the other half-applied.
   * `get` is fine for a synchronous read-modify-write, which cannot interleave.
   *
   * **Not re-entrant.** A `mutate` body that calls `update` on the same slot
   * waits on a key only its own caller can release — a deadlock, not an error.
   * Keep the serialized region to the mutation itself: call other tools'
   * helpers on the value you were handed, not through `update` again. (The
   * lock is per slot AND per session, so a DIFFERENT slot's `update` nests
   * safely.)
   *
   * For serialized work that is NOT a slot mutation — an external resource, a
   * key that isn't the session id, or a mutation that must fail rather than
   * queue — reach for `createKeyedLock`/`withLock` directly. They are public
   * for exactly that, and `createKeyedLock({ timeoutMs })` is what turns a
   * contended acquire into a `KeyedLockTimeoutError` instead of a wait.
   *
   * @example
   * ```ts
   * import { sessionSlot, tool } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export const addItem = tool({
   *   description: "Add an item to the cart",
   *   inputSchema: z.object({ sku: z.string() }),
   *   execute: (args, ctx) =>
   *     cartSlot.update(ctx, async (cart) => {
   *       const priced = await Promise.resolve(args.sku);
   *       cart.items.push(priced);
   *       return { count: cart.items.length };
   *     }),
   * });
   * ```
   */
  update<R>(ctx: ToolContext<SlotState<K, T>>, mutate: (value: T) => R | Promise<R>): Promise<R>;
}

/**
 * Options for {@link sessionSlot}.
 *
 * @public
 */
export interface SessionSlotOptions<T> {
  /**
   * Invariant restoration, run inside the lock at the end of every successful
   * {@link SessionSlot.update} — pruning growth, recalculating a derived field.
   *
   * It exists so those rules live with the slot rather than being re-listed at
   * every mutating call site, which is how one gets forgotten. Because it runs
   * inside the lock, it sees a value no other mutator is touching.
   *
   * **It does NOT run when `mutate` throws.** A mutator that failed part-way
   * may have left the value in a shape the hook itself cannot handle, and an
   * error thrown from the hook would replace the one that actually explains
   * the failure. The mutator's error propagates and the lock releases either
   * way.
   */
  after?: (value: T) => void;
}

/**
 * Declare a named slot inside `ctx.state`.
 *
 * `ctx.state` is one mutable bag per session, and an agent whose tools live in
 * separate modules has no way to type it there: `tool()` learns the state shape
 * only from an annotated context, so every module either restates the
 * annotation or — the spelling this replaces — casts (`ctx.state as StateSlot`)
 * and hand-rolls `slot.x ??= createDefault()`. A slot moves that narrowing into
 * ONE typed seam every module imports, and the lazy install with it.
 *
 * Declaring `state` on the agent is still worth doing (it makes the session's
 * state exist before the first tool call): pass {@link SessionSlot.state}, or
 * just let the slot install itself on first access.
 *
 * {@link SessionSlot.tool} and {@link SessionSlot.updateTool} are the other
 * half — a tool declared through them is handed the live value, so a tool
 * module needs neither an annotated context nor a `slot.get(ctx)` line.
 *
 * @param key - The `ctx.state` property to occupy. Two slots must not share
 *   one key.
 * @param create - Factory for a fresh value. Called once per session on first
 *   access (and again on `reset`), so a shared module-level default must be
 *   cloned here — `() => structuredClone(DEFAULT)` — or every session mutates
 *   the same object.
 *
 * @example
 * ```ts
 * // shared.ts — the one place the slot is declared.
 * import { sessionSlot, type SlotStateOf } from "@alexkroman1/aai";
 *
 * export type Cart = { items: string[] };
 * export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }));
 * export type StateSlot = SlotStateOf<typeof cartSlot>;
 * ```
 *
 * @example
 * ```ts no-check
 * // tools/add_item.ts — no cast, no annotation, no lazy-init boilerplate.
 * // (`no-check`: the point of the example is the OTHER file, so it cannot be
 * // self-contained.)
 * import { cartSlot } from "../shared.ts";
 * import { z } from "zod";
 *
 * export const addItem = cartSlot.tool({
 *   description: "Add an item to the cart",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }, cart) => {
 *     cart.items.push(item);
 *     return { count: cart.items.length };
 *   },
 * });
 * ```
 *
 * @public
 */
export function sessionSlot<const K extends string, T>(
  key: K,
  create: () => T,
  options: SessionSlotOptions<T> = {},
): SessionSlot<K, T> {
  /**
   * `=== undefined` and NOT `??`: only an absent value defaults. `??` would
   * also swallow a slot legitimately holding `null`, and would put `read` and
   * `get` on different rules about the same slot — the kind of disagreement
   * that surfaces as a projection and a tool seeing different state.
   */
  const read = (state: SlotState<K, T> | undefined): T => {
    const existing = state?.[key];
    return existing === undefined ? create() : existing;
  };
  const get = (ctx: ToolContext<SlotState<K, T>>): T => {
    // A slot explicitly holding `undefined` is indistinguishable from an
    // untouched one to every reader here, so it counts as absent.
    const existing = ctx.state[key];
    if (existing !== undefined) return existing;
    const value = create();
    ctx.state[key] = value;
    return value;
  };
  // Per SLOT as well as per session, so one slot's serialized region cannot
  // block another's — and `createKeyedLock` drops a key once its chain drains,
  // so a long-running agent does not accumulate one entry per session id.
  const lock = createKeyedLock();
  const update = <R>(
    ctx: ToolContext<SlotState<K, T>>,
    mutate: (value: T) => R | Promise<R>,
  ): Promise<R> =>
    withLock(lock, ctx.sessionId, async () => {
      const result = await mutate(get(ctx));
      // Re-read rather than reusing what `mutate` was handed: a mutator that
      // called `set` (a load, a restore) replaced the stored object, and the
      // hook has to normalize what the slot NOW holds, not what it held when
      // the mutation began.
      options.after?.(get(ctx));
      return result;
    });
  return {
    key,
    create,
    // `{ [key]: create() }` needs the computed key widened back to K — a
    // computed property on an object literal types as `{ [x: string]: T }`.
    state: () => ({ [key]: create() }) as SlotState<K, T>,
    get,
    // Spreading the rest rather than restating `description`/`inputSchema`
    // keeps `inputSchema`'s optionality EXACTLY as declared — rebuilding it
    // field by field needs a spread ternary or an `omitUndefined` whose mapped
    // type cannot resolve against a still-generic `P`.
    tool: ({ execute, ...rest }) => ({
      ...rest,
      execute: (args, ctx) => execute(args, get(ctx), ctx),
    }),
    updateTool: ({ execute, ...rest }) => ({
      ...rest,
      execute: (args, ctx) => update(ctx, (value) => execute(args, value, ctx)),
    }),
    set(ctx, value) {
      ctx.state[key] = value;
      return value;
    },
    reset(ctx) {
      const value = create();
      ctx.state[key] = value;
      return value;
    },
    read,
    projection(project) {
      return (state) => project(read(state));
    },
    update,
  };
}
