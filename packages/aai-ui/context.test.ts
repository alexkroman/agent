// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider, ThemeProvider, useSession, useTheme } from "./context.ts";
import type { ClientTheme } from "./types.ts";

function sessionWrapper(core: ReturnType<typeof createMockSessionCore>) {
  return ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
}

function themeWrapper(theme: ClientTheme) {
  return ({ children }: { children: ReactNode }) =>
    createElement(ThemeProvider, { value: theme }, children);
}

describe("useSession", () => {
  it("returns session snapshot from context", () => {
    const core = createMockSessionCore({ state: "listening", started: true });
    const { result } = renderHook(() => useSession(), { wrapper: sessionWrapper(core) });
    expect(result.current.state).toBe("listening");
    expect(result.current.started).toBe(true);
  });

  it("throws when used outside SessionProvider", () => {
    expect(() => renderHook(() => useSession())).toThrow();
  });

  it("exposes session methods", () => {
    const core = createMockSessionCore();
    const { result } = renderHook(() => useSession(), { wrapper: sessionWrapper(core) });
    expect(result.current.start).toBeTypeOf("function");
    expect(result.current.cancel).toBeTypeOf("function");
    expect(result.current.reset).toBeTypeOf("function");
    expect(result.current.disconnect).toBeTypeOf("function");
    expect(result.current.toggle).toBeTypeOf("function");
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
    const { result } = renderHook(() => useTheme(), { wrapper: themeWrapper(theme) });
    expect(result.current.bg).toBe("#000");
    expect(result.current.primary).toBe("#f00");
  });

  it("fills missing theme fields with defaults", () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: themeWrapper({ primary: "#f00" }),
    });
    expect(result.current.primary).toBe("#f00");
    expect(result.current.bg).toBe("#101010");
  });
});
