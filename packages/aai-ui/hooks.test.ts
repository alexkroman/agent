// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "./context.ts";
import { useToolCallStart, useToolResult } from "./hooks.ts";
import type { SessionCore } from "./session-core.ts";
import type { ToolCallInfo } from "./types.ts";

function createMockCore(toolCalls: ToolCallInfo[] = []): SessionCore & {
  setToolCalls: (tc: ToolCallInfo[]) => void;
} {
  let snapshot = {
    state: "ready" as const,
    messages: [],
    toolCalls,
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: true,
    running: true,
  };
  const subs = new Set<() => void>();
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
    connect: () => {
      /* noop */
    },
    cancel: () => {
      /* noop */
    },
    resetState: () => {
      /* noop */
    },
    reset: () => {
      /* noop */
    },
    disconnect: () => {
      /* noop */
    },
    start: () => {
      /* noop */
    },
    toggle: () => {
      /* noop */
    },
    [Symbol.dispose]: () => {
      /* noop */
    },
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

describe("useToolResult", () => {
  it("fires callback for completed tool call matching name", () => {
    const core = createMockCore([makeToolCall({ name: "add_pizza" })]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolResult("add_pizza", cb), { wrapper });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toEqual({ ok: true });
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
    act(() => core.setToolCalls([tc]));
    expect(cb).toHaveBeenCalledOnce();
  });

  it("fires for all tools when no name filter", () => {
    const core = createMockCore([
      makeToolCall({ callId: "tc-1", name: "tool_a" }),
      makeToolCall({ callId: "tc-2", name: "tool_b" }),
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
      makeToolCall({ callId: "tc-1", name: "a", status: "pending", result: undefined }),
      makeToolCall({ callId: "tc-2", name: "b", status: "pending", result: undefined }),
    ]);
    const cb = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionProvider, { value: core }, children);
    renderHook(() => useToolCallStart(cb), { wrapper });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
