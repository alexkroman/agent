// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading what the agent projects — `agent({ syncState })` — in the browser.
 *
 * The frame is KEYED by slot name (`{ [slot]: view }`), so every reader here
 * selects ONE slot by the name the agent keyed it under. That is what lets a
 * component re-render only when ITS slot changed: the session core keeps an
 * unchanged slot's value referentially stable across pushes, and
 * {@link selectAgentState} is a stable selector per key, so
 * `useSessionSelector`'s `Object.is` comparison does the rest.
 *
 * Split out of `hooks.ts` at the source-length cap; re-exported from there.
 */

import type { DefaultToolResult, StateProjection } from "@alexkroman1/aai";
import { useMemo } from "react";
import { useSessionSelector } from "./context.ts";
import type { AgentStateFrame, SessionSnapshot } from "./session-core-types.ts";

/** One stable selector per slot name — see {@link selectAgentState}. */
const selectors = new Map<string, (snapshot: SessionSnapshot) => unknown>();

/** The whole frame — module scope, so its identity is stable. */
const selectFrame = (snapshot: SessionSnapshot): AgentStateFrame | null => snapshot.agentState;

/**
 * A `useSessionSelector` selector for ONE slot of the agent's projected state:
 * its value, or `undefined` before the agent has pushed it.
 *
 * The same function for the same name on every call, which is load-bearing:
 * `useSessionSelector` caches its selection on the selector's identity, and an
 * inline arrow would re-run it on every snapshot.
 *
 * ```tsx
 * import { selectAgentState, useSessionSelector } from "@alexkroman1/aai-ui";
 *
 * function CartBadge() {
 *   // Re-renders when the `cart` slot changes, and on nothing else.
 *   const cart = useSessionSelector(selectAgentState<{ count: number }>("cart"));
 *   return <span>{cart?.count ?? 0}</span>;
 * }
 * ```
 *
 * @public
 */
export function selectAgentState<V = DefaultToolResult>(
  slot: string,
): (snapshot: SessionSnapshot) => V | undefined {
  let selector = selectors.get(slot);
  if (selector === undefined) {
    selector = (snapshot) => snapshot.agentState?.[slot];
    selectors.set(slot, selector);
  }
  return selector as (snapshot: SessionSnapshot) => V | undefined;
}

/**
 * The agent's whole projected frame — `{ [slot]: view }` for every slot its
 * `syncState` names — or `null` before the first push. Prefer naming the slot
 * (the overloads below): a component reading the whole frame re-renders when
 * any slot changes.
 *
 * @public
 */
export function useAgentState(): AgentStateFrame | null;
/**
 * One slot's projected state, typed and defaulted by the SAME projection the
 * agent pushes — pass `slot.projected` and there is no type argument to
 * restate, no slot name to repeat and no empty frame to derive.
 *
 * ```tsx no-check
 * // `no-check`: the slot lives with the agent, in another file.
 * // agent.ts: syncState: { cart: cartSlot.projected }
 * const cart = useAgentState(cartSlot.projected); // reads state.cart
 * ```
 *
 * The projection carries its slot key, so this selects `state[projection.key]`
 * — the key `agent()` requires the agent's `syncState` to use. Before the first
 * push it answers `projection()`, the slot's DEFAULT through the same view,
 * memoized on the projection's identity; `slot.projected` is built once with
 * the slot, so that identity is stable for the life of the component.
 *
 * **The one case that cannot use this overload is a slot whose declaring
 * module is expensive to IMPORT** (a seeded factory pulls its seed into the
 * browser bundle): name the slot instead, with a fallback.
 *
 * @public
 */
export function useAgentState<V>(projection: StateProjection<V>): V;
/**
 * One slot's projected state by NAME, or `null` before the agent pushed it.
 * Typed by the caller, as `useToolResult` is: the shape is the author's own
 * projection, which this file cannot see.
 *
 * @public
 */
export function useAgentState<V = DefaultToolResult>(slot: string): V | null;
/**
 * One slot's projected state by NAME, falling back to `fallback` before the
 * first push — for a slot whose module the browser should not import. Build the
 * fallback by running the SAME view over an empty state, and hoist it to module
 * scope so it is a stable reference.
 *
 * ```tsx no-check
 * // `no-check`: the view lives with the agent, in another file.
 * const EMPTY: StoreView = storeView(createEmptyStore());
 * const view = useAgentState("retail", EMPTY);
 * ```
 *
 * @public
 */
export function useAgentState<V>(slot: string, fallback: V): V;
export function useAgentState(
  source?: string | StateProjection<unknown>,
  fallback?: unknown,
): unknown {
  const projection = typeof source === "function" ? source : undefined;
  const slot = projection?.key ?? (typeof source === "string" ? source : undefined);
  const selected = useSessionSelector(slot === undefined ? selectFrame : selectAgentState(slot));
  // Unconditional, because a hook may not be called conditionally; the
  // name arms never call anything.
  const empty = useMemo(() => projection?.(), [projection]);
  if (slot === undefined) return selected ?? null;
  if (selected !== undefined) return selected;
  if (projection !== undefined) return empty;
  return fallback === undefined ? null : fallback;
}
