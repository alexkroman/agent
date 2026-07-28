// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
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
