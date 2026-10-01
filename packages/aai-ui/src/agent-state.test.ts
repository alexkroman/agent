// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
/**
 * `useAgentState` and `selectAgentState` (`agent-state.ts`): every reader
 * selects ONE slot of the slot-keyed `agent_state` frame.
 */

import { sessionSlot } from "@alexkroman1/aai";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { selectAgentState, useAgentState } from "./agent-state.ts";
import { SessionProvider } from "./context.ts";

function createMockCore() {
  return createMockSessionCore({ state: "ready", toolCalls: [], started: true });
}

describe("useAgentState", () => {
  const wrap =
    (core: ReturnType<typeof createMockCore>) =>
    ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);

  it("is null before the agent has pushed anything", () => {
    // A UI has to render the moment before the first tool call.
    const core = createMockCore();
    const { result } = renderHook(() => useAgentState(), { wrapper: wrap(core) });
    expect(result.current).toBeNull();
    const named = renderHook(() => useAgentState("cart"), { wrapper: wrap(core) });
    expect(named.result.current).toBeNull();
  });

  it("exposes the latest frame, and one slot of it by name", () => {
    const core = createMockCore();
    const whole = renderHook(() => useAgentState(), { wrapper: wrap(core) });
    const cart = renderHook(() => useAgentState<string[]>("cart"), { wrapper: wrap(core) });
    act(() => core.update({ agentState: { cart: ["margherita"], prefs: { units: "metric" } } }));
    expect(whole.result.current).toEqual({ cart: ["margherita"], prefs: { units: "metric" } });
    expect(cart.result.current).toEqual(["margherita"]);
  });

  it("projects the slot's default before the agent has pushed anything", () => {
    // The round-trip the overload closes: the pre-first-push frame is the SAME
    // projection run over the slot's own default, so a field added to the
    // projection reaches the first render too.
    const core = createMockCore();
    const cartSlot = sessionSlot("cart", () => ({ items: ["seeded"] }));
    const projection = cartSlot.projection((cart) => ({ count: cart.items.length }));
    const { result } = renderHook(() => useAgentState(projection), { wrapper: wrap(core) });
    expect(result.current).toEqual({ count: 1 });
  });

  it("selects the projection's OWN slot from the frame", () => {
    const core = createMockCore();
    const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
    const projection = cartSlot.projection((cart) => ({ count: cart.items.length }));
    const { result } = renderHook(() => useAgentState(projection), { wrapper: wrap(core) });
    act(() => core.update({ agentState: { cart: { count: 7 }, other: { count: 99 } } }));
    expect(result.current).toEqual({ count: 7 });
  });

  it("keeps the projected default a stable reference across renders", () => {
    // A fresh object per render re-fires every downstream effect and memo that
    // depends on the frame.
    const core = createMockCore();
    const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
    const projection = cartSlot.projection((cart) => ({ count: cart.items.length }));
    const { result, rerender } = renderHook(() => useAgentState(projection), {
      wrapper: wrap(core),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("takes the slot's DECLARED view, and the two ends are one object", () => {
    // The browser half of the round trip: the agent declares
    // `syncState: cartSlot.projected` and this passes the same field,
    // so the frame rendered before the first push and the frames pushed after
    // it are the same view by construction.
    const core = createMockCore();
    const cartSlot = sessionSlot("cart", () => ({ items: ["seeded"] }), {
      view: (cart) => ({ count: cart.items.length }),
    });
    const { result, rerender } = renderHook(() => useAgentState(cartSlot.projected), {
      wrapper: wrap(core),
    });
    const before = result.current;
    expect(before).toEqual({ count: 1 });
    rerender();
    expect(result.current).toBe(before);

    act(() => core.update({ agentState: { cart: cartSlot.projected({ items: ["a", "b"] }) } }));
    expect(Object.keys(result.current).sort()).toEqual(Object.keys(before).sort());
    expect(result.current).toEqual({ count: 2 });
  });

  it("a named slot with a fallback answers the fallback until pushed", () => {
    const core = createMockCore();
    const EMPTY = { items: [] as string[] };
    const { result } = renderHook(() => useAgentState("retail", EMPTY), { wrapper: wrap(core) });
    expect(result.current).toBe(EMPTY);
    act(() => core.update({ agentState: { retail: { items: ["a"] } } }));
    expect(result.current).toEqual({ items: ["a"] });
  });

  it("replaces rather than accumulating", () => {
    // The distinction from useEvent: this is a value, not a log, so a
    // component mounting late reads current state instead of replaying.
    const core = createMockCore();
    const { result } = renderHook(() => useAgentState<number>("n"), { wrapper: wrap(core) });
    act(() => core.update({ agentState: { n: 1 } }));
    act(() => core.update({ agentState: { n: 2 } }));
    expect(result.current).toBe(2);
  });
});

describe("selectAgentState", () => {
  it("is one stable selector per slot name", () => {
    expect(selectAgentState("cart")).toBe(selectAgentState("cart"));
    expect(selectAgentState("cart")).not.toBe(selectAgentState("prefs"));
  });

  it("reads its slot off a snapshot, undefined before a push", () => {
    const core = createMockCore();
    expect(selectAgentState("cart")(core.getSnapshot())).toBeUndefined();
    core.update({ agentState: { cart: { count: 2 } } });
    expect(selectAgentState("cart")(core.getSnapshot())).toEqual({ count: 2 });
  });
});
