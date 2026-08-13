// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:hooks` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * What a client reads off the AGENT rather than off the session — and both
 * overloads of each hook, because an overload is a promise of its own:
 * `useAgentState()` nullable against `useAgentState(fallback)`, and the
 * named-tool form of the tool hooks against the catch-all form.
 */

import {
  type ToolCallInfo,
  useAgentState,
  useEvent,
  useToolCallStart,
  useToolResult,
} from "../../../index.ts";

type CartView = { count: number; total: number };

/** Hoisted, because the hook does not memoize it. */
const EMPTY: CartView = { count: 0, total: 0 };

type Confirmation = { orderId: string };

export function Cart() {
  // The nullable overload: nothing has been pushed before the first tool call.
  const maybeCart = useAgentState<CartView>();
  // The fallback overload, which is what every real client wanted.
  const cart = useAgentState<CartView>(EMPTY);

  // One named tool, typed result.
  useToolResult<Confirmation>("place_order", (result, toolCall: ToolCallInfo) => {
    window.localStorage.setItem(`order:${toolCall.callId}`, result.orderId);
  });
  // Every tool, so the name arrives first.
  useToolResult((name: string, result: unknown, toolCall: ToolCallInfo) => {
    console.debug(name, toolCall.status, toolCall.seq, result);
  });

  // The same split on the start side.
  useToolCallStart("place_order", (toolCall) => console.debug(toolCall.args));
  useToolCallStart((toolCall) => console.debug(toolCall.name, toolCall.afterMessageId));

  // A custom event `ctx.send` put on the wire.
  useEvent<{ url: string }>("open", (data) => window.open(data.url));

  return (
    <p>
      {cart.count} item(s), {cart.total} — {maybeCart === null ? "no state yet" : "synced"}
    </p>
  );
}
