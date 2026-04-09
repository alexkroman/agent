// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SessionProvider, ThemeProvider, useSession, useTheme } from "./context.ts";
import type { SessionCore } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

function mockSessionCore(overrides = {}): SessionCore {
  const snapshot = {
    state: "ready" as const,
    messages: [],
    toolCalls: [],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: true,
    running: true,
    ...overrides,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {
      /* noop */
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

describe("useSession", () => {
  it("returns session snapshot from context", () => {
    const core = mockSessionCore({ state: "listening" });
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
    const core = mockSessionCore();
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(SessionProvider, { value: core }, children);
    const { result } = renderHook(() => useSession(), { wrapper });
    expect(typeof result.current.start).toBe("function");
    expect(typeof result.current.cancel).toBe("function");
    expect(typeof result.current.reset).toBe("function");
    expect(typeof result.current.disconnect).toBe("function");
    expect(typeof result.current.toggle).toBe("function");
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
