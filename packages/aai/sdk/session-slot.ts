// Copyright 2026 the AAI authors. MIT license.
/**
 * Typed named slots inside `ctx.state` — the one seam a multi-file agent needs
 * to read and write its own session state without a cast.
 *
 * @module session-slot
 */

import type { ToolContext } from "./types.ts";

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
 * state exist before the first tool call), and composes: pass
 * `() => ({ [slot.key]: slot.create() })`, or just let the slot install itself.
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
 * // tools/add_item.ts — no cast, no lazy-init boilerplate.
 * // (`no-check`: the point of the example is the OTHER file, so it cannot be
 * // self-contained.)
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 * import { cartSlot } from "../shared.ts";
 *
 * export const addItem = tool({
 *   description: "Add an item to the cart",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }, ctx) => {
 *     const cart = cartSlot.get(ctx);
 *     cart.items.push(item);
 *     return { count: cart.items.length };
 *   },
 * });
 * ```
 *
 * @public
 */
export function sessionSlot<const K extends string, T>(key: K, create: () => T): SessionSlot<K, T> {
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
  return {
    key,
    create,
    get(ctx) {
      // A slot explicitly holding `undefined` is indistinguishable from an
      // untouched one to every reader here, so it counts as absent.
      const existing = ctx.state[key];
      if (existing !== undefined) return existing;
      const value = create();
      ctx.state[key] = value;
      return value;
    },
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
  };
}
