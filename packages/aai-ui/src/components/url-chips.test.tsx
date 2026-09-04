// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { UiUrlChip } from "./url-chips.tsx";

function installClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("UrlChip copy feedback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows Copied, then reverts after the feedback window", async () => {
    vi.useFakeTimers();
    installClipboard(() => Promise.resolve());
    render(<UiUrlChip />);

    fireEvent.click(screen.getByTestId("ui-url-chip"));
    // Flush the clipboard promise so the .then() runs.
    await act(async () => {
      /* flush the clipboard promise */
    });
    expect(screen.getByText("Copied")).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("UI")).toBeDefined();
  });

  test("clears the feedback timer on unmount", async () => {
    vi.useFakeTimers();
    installClipboard(() => Promise.resolve());
    const { unmount } = render(<UiUrlChip />);

    fireEvent.click(screen.getByTestId("ui-url-chip"));
    await act(async () => {
      /* flush the clipboard promise */
    });
    expect(vi.getTimerCount()).toBe(1);

    // A live timer here would fire setState on an unmounted component.
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("clipboard failure leaves the chip usable", async () => {
    installClipboard(() => Promise.reject(new Error("denied")));
    render(<UiUrlChip />);
    fireEvent.click(screen.getByTestId("ui-url-chip"));
    await act(async () => {
      /* flush the clipboard promise */
    });
    expect(screen.getByText("UI")).toBeDefined();
  });
});

describe("UrlChip focus", () => {
  test("declares a focus-visible ring", () => {
    // `outline-none` sat here with no replacement, so a chip reachable by Tab
    // showed nothing at all when it received focus (WCAG 2.4.7).
    render(
      <ThemeProvider>
        <UiUrlChip />
      </ThemeProvider>,
    );
    const chip = screen.getByTestId("ui-url-chip");
    expect(chip.className).toContain("focus-visible:[outline:2px_solid]");
    expect(chip.style.outlineColor).not.toBe("");
  });
});
