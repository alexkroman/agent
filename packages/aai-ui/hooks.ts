// Copyright 2025 the AAI authors. MIT license.

import type { DefaultToolResult } from "@alexkroman1/aai";
import { useEffect, useRef } from "react";
import { tryParseJSON } from "./_utils.ts";
import { useSessionSelector } from "./context.ts";
import type { ToolCallInfo } from "./types.ts";

type ToolCallCallback = (...args: unknown[]) => void;

/**
 * Per-hook-instance dedup state for tool-call processing.
 *
 * `seq` is a watermark: every tool call with `seq <= watermark` has been fully
 * processed and is never rescanned. `fired` holds the (small, transient) set
 * of call IDs that were processed *ahead* of the watermark — e.g. a later tool
 * call that completed while an earlier one is still pending — and is pruned as
 * the watermark advances past them. This keeps both scan cost and memory
 * bounded by the unprocessed tail instead of the whole capped array.
 */
type ToolCallCursor = { seq: number; fired: Set<string> };

/** Index of the first item whose sequence number is above the watermark (tail scan from the end). */
function tailStart<T>(items: readonly T[], seqOf: (item: T) => number, watermark: number): number {
  let start = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || seqOf(item) <= watermark) break;
    start = i;
  }
  return start;
}

/**
 * Process the unprocessed tail of `toolCalls`: fire `onNew` once per item that
 * has settled (per `isSettled`), then advance the watermark past the leading
 * run of settled items. Resets the cursor when the list is empty (session
 * reset), matching the previous seen-set behavior.
 */
function processToolCallTail(
  toolCalls: readonly ToolCallInfo[],
  cursor: ToolCallCursor,
  isSettled: (tc: ToolCallInfo) => boolean,
  onNew: (tc: ToolCallInfo) => void,
): void {
  if (toolCalls.length === 0) {
    cursor.seq = 0;
    cursor.fired.clear();
    return;
  }
  const start = tailStart(toolCalls, (tc) => tc.seq, cursor.seq);
  for (let i = start; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!(tc && isSettled(tc)) || cursor.fired.has(tc.callId)) continue;
    cursor.fired.add(tc.callId);
    onNew(tc);
  }
  for (let i = start; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!(tc && isSettled(tc))) break;
    cursor.fired.delete(tc.callId);
    cursor.seq = tc.seq;
  }
}

/**
 * Shared scaffold for the tool-call lifecycle hooks: parses the optional
 * `(toolName, callback)` / `(callback)` overload args, dedups by call ID,
 * and invokes `fire` once per tool call reaching `status`.
 */
function useToolCallEffect(
  status: ToolCallInfo["status"],
  args: unknown[],
  fire: (callback: ToolCallCallback, toolCall: ToolCallInfo, filtered: boolean) => void,
): void {
  // The overload is `(toolName, callback)` or `(callback)`, so the first
  // argument decides both — read once rather than type-tested twice.
  const first = args[0];
  const filterName = typeof first === "string" ? first : null;
  const callback = (filterName === null ? first : args[1]) as ToolCallCallback;

  const toolCalls = useSessionSelector((s) => s.toolCalls);
  const cursorRef = useRef<ToolCallCursor>({ seq: 0, fired: new Set<string>() });
  const mountedRef = useRef(false);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const fireRef = useRef(fire);
  fireRef.current = fire;

  useEffect(() => {
    const firstRun = !mountedRef.current;
    mountedRef.current = true;
    processToolCallTail(
      toolCalls,
      cursorRef.current,
      // Every tool call is born "pending", so for the start hook insertion
      // itself settles the item; the done hook must wait for completion.
      (tc) => status === "pending" || tc.status === status,
      (tc) => {
        // A new call first observed past `status` still *reached* it — e.g.
        // `tool_call` and `tool_call_done` frames coalescing into one commit
        // must not lose the start event. The exception is the mount pass,
        // where pre-existing settled calls are history, not new events.
        //
        // **It is `useToolCallStart`'s guard alone, and the asymmetry is
        // deliberate.** This line can only fire for a hook whose `isSettled`
        // admits an item whose status is not the one it watches, and only the
        // start hook's does (`status === "pending"` is true for every item, by
        // construction — a tool call is BORN pending, so insertion is what
        // settles it there). `useToolResult` reaches `onNew` only for calls
        // that already read `"done"`, so the condition is false for it every
        // time. A late-mounting component therefore learns nothing about tool
        // calls that STARTED before it, and does receive the results of ones
        // that already completed — which is the right split: a start event is
        // about the moment, a result is a value the UI is being driven from.
        if (tc.status !== status && firstRun) return;
        if (filterName && tc.name !== filterName) return;
        fireRef.current(callbackRef.current, tc, filterName !== null);
      },
    );
  }, [toolCalls, filterName, status]);
}

/**
 * Fire a callback when a tool call settles, with the tool's JSON result.
 *
 * For new code prefer explicit events — `ctx.send(event, data)` in the tool
 * paired with {@link useEvent} here — over listening to tool results.
 *
 * @typeParam R - The result shape. Defaults to {@link DefaultToolResult}
 *   (`any`) so the ordinary untyped spelling compiles; pass the shape —
 *   `useToolResult<Quote>(…)` — for real checking.
 *
 * @public
 */
export function useToolResult<R = DefaultToolResult>(
  toolName: string,
  callback: (result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult<R = DefaultToolResult>(
  callback: (name: string, result: R, toolCall: ToolCallInfo) => void,
): void;
export function useToolResult(...args: unknown[]): void {
  useToolCallEffect("done", args, (callback, tc, filtered) => {
    const parsed = tryParseJSON(tc.result);
    if (filtered) {
      (callback as (r: unknown, tc: ToolCallInfo) => void)(parsed, tc);
    } else {
      (callback as (n: string, r: unknown, tc: ToolCallInfo) => void)(tc.name, parsed, tc);
    }
  });
}

/**
 * The agent's projected session state, or `null` before the first push.
 *
 * The counterpart to `syncState` on the agent: whatever that projection
 * returns is what arrives here — no per-tool result mirroring needed.
 *
 * ```tsx
 * import { useAgentState } from "@alexkroman1/aai-ui";
 *
 * type Item = { sku: string; qty: number };
 *
 * function Cart() {
 *   const state = useAgentState<{ cart: Item[] }>();
 *   return <ul>{state?.cart.map((item) => <li key={item.sku}>{item.qty}</li>)}</ul>;
 * }
 * ```
 *
 * Typed by the caller for the same reason `useToolResult` is: the shape is
 * the author's own projection, which the framework cannot see. It is
 * nullable on purpose — nothing has been pushed before the first tool call,
 * and a UI has to render that moment.
 *
 * @public
 */
export function useAgentState<S = DefaultToolResult>(): S | null;
/**
 * The agent's projected session state, falling back to `fallback` before the
 * first push — so the return is never `null` and a sidebar needs no branch for
 * the pre-first-tool-call moment.
 *
 * Build the fallback by running the SAME projection over an empty state, not
 * by hand-writing an empty-looking literal: a field added to the projection
 * then reaches the first render too, instead of being `undefined` only in
 * that one frame.
 *
 * ```tsx no-check
 * // `no-check`: the projection lives with the agent, in another file.
 * import { useAgentState } from "@alexkroman1/aai-ui";
 * import { cartSlot, cartView, type CartView } from "./shared.ts";
 *
 * const EMPTY: CartView = cartSlot.projection(cartView)(undefined);
 *
 * function Cart() {
 *   const cart = useAgentState<CartView>(EMPTY);
 *   return <ul>{cart.items.map((item) => <li key={item.sku}>{item.qty}</li>)}</ul>;
 * }
 * ```
 *
 * @param fallback - Returned while the agent has pushed nothing. Not memoized
 *   here — hoist it to module scope (or memoize it) so it is a stable
 *   reference across renders.
 *
 * @public
 */
export function useAgentState<S = DefaultToolResult>(fallback: S): S;
export function useAgentState<S = DefaultToolResult>(fallback?: S): S | null {
  const state = useSessionSelector((snapshot) => snapshot.agentState) as S | null;
  if (state !== null) return state;
  // An absent `fallback` must read back as `null`, not `undefined` — that is
  // the no-arg overload's documented pre-first-push value, and a client
  // spelling `state === null` predates this parameter.
  return fallback === undefined ? null : fallback;
}

/**
 * Subscribe to custom events emitted by agent tools via
 * `ctx.send(event, data)`; the callback receives each event's `data`.
 *
 * This is the preferred way to drive UI from tools — an explicit event beats
 * inferring state from tool results with {@link useToolResult}.
 *
 * @example
 * ```tsx
 * import { useEvent } from "@alexkroman1/aai-ui";
 * import { useState } from "react";
 *
 * type Item = { sku: string; qty: number };
 *
 * function Cart() {
 *   const [cart, setCart] = useState<Item[]>([]);
 *   // Tool: ctx.send("item_added", { sku, qty })
 *   useEvent<Item>("item_added", (data) => {
 *     setCart((cart) => [...cart, data]);
 *   });
 *   return <div>{cart.length} items</div>;
 * }
 * ```
 *
 * @public
 */
export function useEvent<T = unknown>(event: string, callback: (data: T) => void): void {
  const customEvents = useSessionSelector((s) => s.customEvents);
  // Watermark over the monotonic event `id`: only the tail with id above it
  // is scanned, and no per-event memory accumulates in long sessions.
  const watermarkRef = useRef(0);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (customEvents.length === 0) {
      watermarkRef.current = 0;
      return;
    }
    const start = tailStart(customEvents, (ce) => ce.id, watermarkRef.current);
    for (let i = start; i < customEvents.length; i++) {
      const ce = customEvents[i];
      if (!ce) continue;
      watermarkRef.current = ce.id;
      if (ce.event === event) callbackRef.current(ce.data as T);
    }
  }, [customEvents, event]);
}

/**
 * Fire a callback when a tool call starts (before its result arrives).
 * Optionally filter by tool name.
 *
 * @public
 */
export function useToolCallStart(
  toolName: string,
  callback: (toolCall: ToolCallInfo) => void,
): void;
export function useToolCallStart(callback: (toolCall: ToolCallInfo) => void): void;
export function useToolCallStart(...args: unknown[]): void {
  useToolCallEffect("pending", args, (callback, tc) => {
    (callback as (tc: ToolCallInfo) => void)(tc);
  });
}
