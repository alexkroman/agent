// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `useUserTranscript`.
 *
 * The whole subject is that `null` and `""` are different, so every case here is
 * one of those two or the transition between them.
 */

import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { SessionProvider } from "./context.ts";
import { TRANSCRIBING_PLACEHOLDER, useUserTranscript } from "./use-user-transcript.ts";

function render(userTranscript: string | null) {
  const core = createMockSessionCore({ userTranscript, started: true });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(SessionProvider, { value: core }, children);
  return { core, ...renderHook(() => useUserTranscript(), { wrapper }) };
}

describe("useUserTranscript", () => {
  test("nobody speaking: not speaking, no text", () => {
    expect(render(null).result.current).toEqual({ speaking: false, text: "", partial: null });
  });

  test("speech detected with no words yet is SPEAKING — the case a falsy check loses", () => {
    expect(render("").result.current).toEqual({
      speaking: true,
      text: TRANSCRIBING_PLACEHOLDER,
      partial: "",
    });
  });

  test("words so far are the text", () => {
    expect(render("cancel my").result.current).toEqual({
      speaking: true,
      text: "cancel my",
      partial: "cancel my",
    });
  });

  test("the placeholder gives way to the first real word", () => {
    const { core, result } = render("");
    expect(result.current.text).toBe(TRANSCRIBING_PLACEHOLDER);
    act(() => core.update({ userTranscript: "cancel" }));
    expect(result.current.text).toBe("cancel");
  });

  test("the turn ending returns it to not-speaking", () => {
    const { core, result } = render("cancel my order");
    act(() => core.update({ userTranscript: null }));
    expect(result.current).toEqual({ speaking: false, text: "", partial: null });
  });
});
