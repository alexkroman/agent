// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:hooks` epoch 2.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 1 plus the third `useAgentState` overload, which is the one this epoch
 * exists for: it takes the SAME `slot.projection(view)` the agent declares as
 * `syncState`, so the client restates neither the state's type nor the frame it
 * renders before the first push. Both older overloads are exercised too — this
 * epoch RETAINED epoch 1, and an example that dropped them would stop proving
 * that.
 *
 * `sessionSlot` comes from `@alexkroman1/aai` by SPECIFIER rather than by
 * relative path — the reason the others are relative is that a package cannot
 * resolve itself by name, and this one is a different package.
 */

import { sessionSlot } from "@alexkroman1/aai";
import {
  type ToolCallInfo,
  useAgentState,
  useEvent,
  useToolCallStart,
  useToolResult,
} from "../../../index.ts";

type CartView = { count: number; total: number };

/** Still hoisted: the `fallback` overload does not memoize what it is handed. */
const EMPTY: CartView = { count: 0, total: 0 };

/**
 * The slot and its projection, as a real project declares them — in the module
 * that owns the slot, so `agent.ts` and `client.tsx` import one expression
 * rather than composing it twice.
 */
const cartSlot = sessionSlot("cart", () => ({ items: [] as { price: number }[] }));
const cartProjection = cartSlot.projection((cart) => ({
  count: cart.items.length,
  total: cart.items.reduce((sum, item) => sum + item.price, 0),
}));

type Confirmation = { orderId: string };

export function Cart() {
  // The nullable overload: nothing has been pushed before the first tool call.
  const maybeCart = useAgentState<CartView>();
  // The fallback overload — still right when a slot's `create()` is expensive
  // to import into the browser, since the projection overload calls it.
  const fallbackCart = useAgentState<CartView>(EMPTY);
  // The projection overload: no type argument, no empty frame to derive, and
  // the frame is memoized on the projection's identity.
  const cart = useAgentState(cartProjection);

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
      {cart.count} item(s), {cart.total} — {maybeCart === null ? "no state yet" : "synced"} (
      {fallbackCart.count} hand-built)
    </p>
  );
}
