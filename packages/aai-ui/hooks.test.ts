// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "./context.ts";
import { useEvent, useToolCallStart, useToolResult } from "./hooks.ts";
import type { CustomEvent, SessionCore } from "./session-core.ts";
import type { ToolCallInfo } from "./types.ts";

type MockCore = SessionCore & {
  setToolCalls: (tc: ToolCallInfo[]) => void;
  setCustomEvents: (ce: CustomEvent[]) => void;
};

function createMockCore(toolCalls: ToolCallInfo[] = []): MockCore {
  let snapshot = {
    state: "ready" as const,
    messages: [],
    toolCalls,
    customEvents: [] as CustomEvent[],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: true,
    running: true,
  };
  const subs = new Set<() => void>();
  const noop = () => {
    /* noop */
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    setToolCalls: (tc) => {
      snapshot = { ...snapshot, toolCalls: tc };
      for (const cb of subs) cb();
    },
    setCustomEvents: (ce) => {
      snapshot = { ...snapshot, customEvents: ce };
      for (const cb of subs) cb();
    },
    connect: noop,
    cancel: noop,
    resetState: noop,
    reset: noop,
    disconnect: noop,
    start: noop,
    toggle: noop,
    [Symbol.dispose]: noop,
  };
}

function makeToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    callId: "tc-1",
    name: "test_tool",
    args: {},
    status: "done",
    result: JSON.stringify({ ok: true }),
    afterMessageIndex: 0,
    ...overrides,
  };
}

function makeWrapper(core: SessionCore) {
  return ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
}

describe("useToolResult", () => {
  it("fires callback for completed tool call matching name", () => {
    const core = createMockCore([makeToolCall({ name: "add_pizza" })]);
    const cb = vi.fn();
    renderHook(() => useToolResult("add_pizza", cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.at(0)).toEqual({ ok: true });
  });

  it("does not fire for non-matching tool name", () => {
    const core = createMockCore([makeToolCall({ name: "other_tool" })]);
    const cb = vi.fn();
    renderHook(() => useToolResult("add_pizza", cb), { wrapper: makeWrapper(core) });
    expect(cb).not.toHaveBeenCalled();
  });

  it("fires only once per callId (deduplication)", () => {
    const tc = makeToolCall({ callId: "tc-1" });
    const core = createMockCore([tc]);
    const cb = vi.fn();
    renderHook(() => useToolResult("test_tool", cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledOnce();
    act(() => core.setToolCalls([tc]));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "tool_a" }),
      makeToolCall({ callId: "tc-2", name: "tool_b" }),
    ]);
    const cb = vi.fn();
    renderHook(() => useToolResult(cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("does not fire for pending tool calls", () => {
    const core = createMockCore([makeToolCall({ status: "pending", result: undefined })]);
    const cb = vi.fn();
    renderHook(() => useToolResult("test_tool", cb), { wrapper: makeWrapper(core) });
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("useToolCallStart", () => {
  it("fires callback for pending tool call matching name", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "search", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    renderHook(() => useToolCallStart("search", cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "a", status: "pending", result: undefined }),
      makeToolCall({ callId: "tc-2", name: "b", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    renderHook(() => useToolCallStart(cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe("useEvent", () => {
  it("fires callback for matching custom_event", () => {
    const core = createMockCore();
    act(() => core.setCustomEvents([{ id: 1, event: "score_update", data: { score: 42 } }]));
    const cb = vi.fn();
    renderHook(() => useEvent("score_update", cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0]?.at(0)).toEqual({ score: 42 });
  });

  it("ignores non-matching events", () => {
    const core = createMockCore();
    act(() => core.setCustomEvents([{ id: 1, event: "other_event", data: { foo: "bar" } }]));
    const cb = vi.fn();
    renderHook(() => useEvent("score_update", cb), { wrapper: makeWrapper(core) });
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not re-fire for already-seen events", () => {
    const core = createMockCore();
    act(() => core.setCustomEvents([{ id: 1, event: "score_update", data: { score: 1 } }]));
    const cb = vi.fn();
    renderHook(() => useEvent("score_update", cb), { wrapper: makeWrapper(core) });
    expect(cb).toHaveBeenCalledOnce();
    act(() =>
      core.setCustomEvents([
        { id: 1, event: "score_update", data: { score: 1 } },
        { id: 2, event: "score_update", data: { score: 2 } },
      ]),
    );
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb.mock.calls[1]?.at(0)).toEqual({ score: 2 });
  });
});
