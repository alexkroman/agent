// @vitest-environment jsdom

import { sessionSlot } from "@alexkroman1/aai";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { useAgentState, useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { ToolCallInfo } from "./types.ts";

function createMockCore(toolCalls: ToolCallInfo[] = []) {
  return createMockSessionCore({ state: "ready", toolCalls, started: true });
}

function makeToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    callId: "tc-1",
    name: "test_tool",
    args: {},
    status: "done",
    result: JSON.stringify({ ok: true }),
    seq: 1,
    afterMessageId: -1,
    ...overrides,
  };
}

describe("useToolResult", () => {
  it("fires callback for completed tool call matching name", () => {
    const core = createMockCore([makeToolCall({ name: "add_pizza" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("add_pizza", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.at(0)).toEqual({ ok: true });
  });

  it("does not fire for non-matching tool name", () => {
    const core = createMockCore([makeToolCall({ name: "other_tool" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("add_pizza", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires only once per callId (deduplication)", () => {
    const tc = makeToolCall({ callId: "tc-1" });
    const core = createMockCore([tc]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    act(() => core.update({ toolCalls: [tc] }));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "tool_a", seq: 1 }),
      makeToolCall({ callId: "tc-2", name: "tool_b", seq: 2 }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not fire for pending tool calls", () => {
    const core = createMockCore([makeToolCall({ status: "pending", result: undefined })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires when a pending tool call later completes", () => {
    const pending = makeToolCall({ status: "pending", result: undefined });
    const core = createMockCore([pending]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();

    act(() => core.update({ toolCalls: [{ ...pending, status: "done", result: '{"ok":true}' }] }));
    expect(cb).toHaveBeenCalledOnce();

    // No re-fire once the watermark has passed the completed call.
    act(() => core.update({ toolCalls: [{ ...pending, status: "done", result: '{"ok":true}' }] }));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("handles out-of-order completion without re-firing", () => {
    const first = makeToolCall({ callId: "tc-1", seq: 1, status: "pending", result: undefined });
    const second = makeToolCall({ callId: "tc-2", seq: 2, status: "done" });
    const core = createMockCore([first, second]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    // tc-2 completed while tc-1 (inserted earlier) is still pending.
    renderHook(() => useToolResult(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.at(2)).toMatchObject({ callId: "tc-2" });

    // tc-1 completes later — fires exactly once, tc-2 does not re-fire.
    act(() => core.update({ toolCalls: [{ ...first, status: "done", result: "{}" }, second] }));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]?.at(2)).toMatchObject({ callId: "tc-1" });

    act(() => core.update({ toolCalls: [{ ...first, status: "done", result: "{}" }, second] }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("resets dedup state when the tool call list empties (session reset)", () => {
    const tc = makeToolCall();
    const core = createMockCore([tc]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("test_tool", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();

    act(() => core.update({ toolCalls: [] }));
    act(() => core.update({ toolCalls: [tc] }));
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("useToolCallStart", () => {
  it("fires callback for pending tool call matching name", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "search", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart("search", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "a", status: "pending", result: undefined, seq: 1 }),
      makeToolCall({ callId: "tc-2", name: "b", status: "pending", result: undefined, seq: 2 }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not fire for a tool call first seen already done", () => {
    const core = createMockCore([makeToolCall({ status: "done" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires when a call first appears already done in a live update (coalesced frames)", () => {
    // tool_call + tool_call_done can land in one commit: the call is first
    // seen with status "done", but it still *started* during this session,
    // so the start hook must fire (exactly once).
    const core = createMockCore([]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();

    const done = makeToolCall({ status: "done" });
    act(() => core.update({ toolCalls: [done] }));
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.at(0)).toMatchObject({ callId: "tc-1" });

    // No re-fire on a later snapshot containing the same call.
    act(() => core.update({ toolCalls: [done] }));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires once per callId even as status changes", () => {
    const pending = makeToolCall({ status: "pending", result: undefined });
    const core = createMockCore([pending]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();

    act(() => core.update({ toolCalls: [{ ...pending, status: "done", result: "{}" }] }));
    expect(cb).toHaveBeenCalledOnce();
  });
});

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
  });

  it("exposes the latest pushed state", () => {
    const core = createMockCore();
    const { result } = renderHook(() => useAgentState<{ cart: string[] }>(), {
      wrapper: wrap(core),
    });
    act(() => core.update({ agentState: { cart: ["margherita"] } }));
    expect(result.current).toEqual({ cart: ["margherita"] });
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

  it("prefers the pushed state over the projection's default", () => {
    const core = createMockCore();
    const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
    const projection = cartSlot.projection((cart) => ({ count: cart.items.length }));
    const { result } = renderHook(() => useAgentState(projection), { wrapper: wrap(core) });
    act(() => core.update({ agentState: { count: 7 } }));
    expect(result.current).toEqual({ count: 7 });
  });

  it("keeps the projected default a stable reference across renders", () => {
    // The doc promises this, and it is the half the `fallback` overload can
    // only ask a caller to arrange by hoisting: a fresh object per render
    // re-fires every downstream effect and memo that depends on the frame.
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

  it("still treats a plain object as a fallback, not a projection", () => {
    // The projection overload is declared FIRST so it wins for a function, and
    // a type test caught `fallback: S` swallowing one. This is the other
    // direction: the older overload must keep working unchanged.
    const core = createMockCore();
    const { result } = renderHook(() => useAgentState<{ cart: string[] }>({ cart: [] }), {
      wrapper: wrap(core),
    });
    expect(result.current).toEqual({ cart: [] });
  });

  it("replaces rather than accumulating", () => {
    // The distinction from useEvent: this is a value, not a log, so a
    // component mounting late reads current state instead of replaying.
    const core = createMockCore();
    const { result } = renderHook(() => useAgentState<{ n: number }>(), { wrapper: wrap(core) });
    act(() => core.update({ agentState: { n: 1 } }));
    act(() => core.update({ agentState: { n: 2 } }));
    expect(result.current).toEqual({ n: 2 });
  });
});

describe("useEvent", () => {
  it("fires callback for matching custom_event", () => {
    const core = createMockCore();
    act(() =>
      core.update({ customEvents: [{ id: 1, event: "score_update", data: { score: 42 } }] }),
    );
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useEvent("score_update", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.at(0)).toEqual({ score: 42 });
  });

  it("ignores non-matching events", () => {
    const core = createMockCore();
    act(() =>
      core.update({ customEvents: [{ id: 1, event: "other_event", data: { foo: "bar" } }] }),
    );
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useEvent("score_update", cb), { wrapper });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not re-fire for already-seen events", () => {
    const core = createMockCore();
    act(() =>
      core.update({ customEvents: [{ id: 1, event: "score_update", data: { score: 1 } }] }),
    );
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useEvent("score_update", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    // Add a second event — only the new one should fire
    act(() =>
      core.update({
        customEvents: [
          { id: 1, event: "score_update", data: { score: 1 } },
          { id: 2, event: "score_update", data: { score: 2 } },
        ],
      }),
    );
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]?.at(0)).toEqual({ score: 2 });
  });

  it("resets the watermark when the event list empties (session reset)", () => {
    const core = createMockCore();
    act(() => core.update({ customEvents: [{ id: 1, event: "score_update", data: { n: 1 } }] }));
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useEvent("score_update", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();

    act(() => core.update({ customEvents: [] }));
    // A fresh session may reuse low ids — they must fire again after a reset.
    act(() => core.update({ customEvents: [{ id: 1, event: "score_update", data: { n: 2 } }] }));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]?.at(0)).toEqual({ n: 2 });
  });
});
