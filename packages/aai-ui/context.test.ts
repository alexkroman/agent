// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import {
  SessionProvider,
  ThemeProvider,
  useSession,
  useSessionSelector,
  useTheme,
} from "./context.ts";
import type { ClientTheme } from "./types.ts";

describe("useSession", () => {
  it("returns session snapshot from context", () => {
    const core = createMockSessionCore({ state: "listening", started: true });
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(SessionProvider, { value: core }, children);
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.state).toBe("listening");
    expect(result.current.started).toBe(true);
  });

  it("throws when used outside SessionProvider", () => {
    expect(() => {
      renderHook(() => useSession());
    }).toThrow();
  });

  it("exposes session methods", () => {
    const core = createMockSessionCore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(SessionProvider, { value: core }, children);
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(result.current.start).toBeTypeOf("function");
    expect(result.current.cancel).toBeTypeOf("function");
    expect(result.current.reset).toBeTypeOf("function");
    expect(result.current.disconnect).toBeTypeOf("function");
    expect(result.current.toggle).toBeTypeOf("function");
  });
});

describe("useSessionSelector", () => {
  function makeWrapper(core: ReturnType<typeof createMockSessionCore>) {
    return ({ children }: { children: ReactNode }) =>
      React.createElement(SessionProvider, { value: core }, children);
  }

  it("returns the selected slice of the snapshot", () => {
    const core = createMockSessionCore({ running: true });
    const { result } = renderHook(() => useSessionSelector((s) => s.running), {
      wrapper: makeWrapper(core),
    });
    expect(result.current).toBe(true);
  });

  it("re-renders only when the selected value changes", () => {
    const core = createMockSessionCore({ running: true });
    const renderSpy = vi.fn();
    const { result } = renderHook(
      () => {
        renderSpy();
        return useSessionSelector((s) => s.running);
      },
      { wrapper: makeWrapper(core) },
    );
    const rendersBefore = renderSpy.mock.calls.length;

    // Unrelated snapshot changes: no re-render.
    act(() => core.update({ userTranscript: "hi" }));
    act(() => core.update({ state: "thinking" }));
    expect(renderSpy.mock.calls.length).toBe(rendersBefore);

    // Selected value changes: re-render with the new value.
    act(() => core.update({ running: false }));
    expect(result.current).toBe(false);
    expect(renderSpy.mock.calls.length).toBeGreaterThan(rendersBefore);
  });

  it("supports a custom isEqual for derived selections", () => {
    const core = createMockSessionCore({
      messages: [{ id: 1, role: "user", content: "hi" }],
    });
    const renderSpy = vi.fn();
    renderHook(
      () => {
        renderSpy();
        return useSessionSelector(
          (s) => ({ count: s.messages.length }),
          (a, b) => a.count === b.count,
        );
      },
      { wrapper: makeWrapper(core) },
    );
    const rendersBefore = renderSpy.mock.calls.length;

    // New array reference, same length: custom isEqual suppresses the re-render.
    act(() => core.update({ messages: [{ id: 2, role: "user", content: "other" }] }));
    expect(renderSpy.mock.calls.length).toBe(rendersBefore);
  });

  it("throws when used outside SessionProvider", () => {
    expect(() => {
      renderHook(() => useSessionSelector((s) => s.running));
    }).toThrow();
  });
});

describe("useTheme", () => {
  it("returns default theme when no provider", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.bg).toBe("#101010");
    expect(result.current.primary).toBe("#fab283");
  });

  it("returns custom theme from provider", () => {
    const theme: Required<ClientTheme> = {
      bg: "#000",
      primary: "#f00",
      text: "#fff",
      surface: "#111",
      border: "#222",
    };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value: theme }, children);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.bg).toBe("#000");
    expect(result.current.primary).toBe("#f00");
  });

  it("fills missing theme fields with defaults", () => {
    const partial: ClientTheme = { primary: "#f00" };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value: partial }, children);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.primary).toBe("#f00");
    expect(result.current.bg).toBe("#101010");
  });
});
