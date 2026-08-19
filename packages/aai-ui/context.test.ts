// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    // The message names the fix — a bare "cannot read properties of null" from
    // deep inside a hook is the failure this guard exists to replace.
    expect(() => {
      renderHook(() => useSession());
    }).toThrow("Session hooks must be used within <SessionProvider>");
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

  it("returns a referentially stable object across renders without snapshot changes", () => {
    // Parent re-renders must not mint a fresh 15-property Session object —
    // consumers may put it in hook deps.
    const core = createMockSessionCore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(SessionProvider, { value: core }, children);
    const { result, rerender } = renderHook(() => useSession(), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    // A snapshot change still produces a new object with the new state.
    act(() => core.update({ state: "listening" }));
    expect(result.current).not.toBe(first);
    expect(result.current.state).toBe("listening");
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
    }).toThrow("Session hooks must be used within <SessionProvider>");
  });
});

describe("useTheme", () => {
  afterEach(() => {
    // The jsdom document is shared by every test in this file and `document` is
    // outside `restoreMocks`, so these have to be undone by hand. `ThemeProvider`
    // restores on unmount what it FOUND — which is correct behaviour and exactly
    // why the leak happens: the spec below deliberately pre-sets a host
    // background, so the value the provider faithfully puts back outlives the
    // test and becomes the starting state of every spec after it.
    document.body.style.background = "";
    document.documentElement.style.background = "";
  });

  it("returns default theme when no provider", () => {
    const { result } = renderHook(() => useTheme());
    // Every field, not a sample: an unset one reaches components as
    // `undefined` and renders as a missing color rather than an error.
    expect(result.current).toEqual({
      bg: "#FBF8F2",
      primary: "#3F2BC1",
      text: "#1B1A18",
      surface: "#FFFFFF",
      border: "#DCD7CC",
    });
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

  it("paints the page background so the theme reaches beyond the app column", () => {
    // Components paint theme.bg on their own containers, but html/body kept the
    // static color from index.html — so any viewport wider than the app column
    // showed a black letterbox around a cream UI.
    renderHook(() => useTheme(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(ThemeProvider, { value: undefined }, children),
    });
    expect(document.body.style.background).toBe("rgb(251, 248, 242)");
    expect(document.documentElement.style.background).toBe("rgb(251, 248, 242)");
  });

  it("a custom theme repaints the page too", () => {
    renderHook(() => useTheme(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(ThemeProvider, { value: { bg: "#123456" } }, children),
    });
    expect(document.body.style.background).toBe("rgb(18, 52, 86)");
  });

  it("keeps merged theme identity stable across re-renders", () => {
    // `MessageList`'s memoized rows take the theme as a dependency — a fresh
    // merged object per ThemeProvider render would rebuild every message row.
    const value: ClientTheme = { primary: "#f00" };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value }, children);
    const { result, rerender } = renderHook(() => useTheme(), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("re-merges when the theme value changes", () => {
    // The other half of the identity guard: memoizing on nothing would pin
    // the first theme forever, so a live theme change would never land.
    let value: ClientTheme = { primary: "#f00" };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value }, children);
    const { result, rerender } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.primary).toBe("#f00");

    value = { primary: "#00f" };
    rerender();
    expect(result.current.primary).toBe("#00f");
  });

  it("repaints the page when the theme background changes", () => {
    let value: ClientTheme = { bg: "#123456" };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value }, children);
    const { rerender } = renderHook(() => useTheme(), { wrapper });
    expect(document.body.style.background).toBe("rgb(18, 52, 86)");

    value = { bg: "#654321" };
    rerender();
    expect(document.body.style.background).toBe("rgb(101, 67, 33)");
  });

  it("restores the page background it found on unmount", () => {
    // The provider is not necessarily the page's only owner — a host app that
    // mounts the studio in a pane keeps its own background, and leaving the
    // theme's color behind would repaint the host.
    document.body.style.background = "rgb(1, 2, 3)";
    document.documentElement.style.background = "rgb(4, 5, 6)";

    const { unmount } = renderHook(() => useTheme(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(ThemeProvider, { value: { bg: "#123456" } }, children),
    });
    expect(document.body.style.background).toBe("rgb(18, 52, 86)");

    unmount();
    expect(document.body.style.background).toBe("rgb(1, 2, 3)");
    expect(document.documentElement.style.background).toBe("rgb(4, 5, 6)");
  });

  it("fills missing theme fields with defaults", () => {
    const partial: ClientTheme = { primary: "#f00" };
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(ThemeProvider, { value: partial }, children);
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.primary).toBe("#f00");
    expect(result.current.bg).toBe("#FBF8F2");
  });
});
