// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import { Controls } from "./controls.tsx";

function renderControls(overrides?: Parameters<typeof createMockSessionCore>[0]) {
  const session = createMockSessionCore(overrides);
  return render(
    <ThemeProvider>
      <SessionProvider value={session}>
        <Controls />
      </SessionProvider>
    </ThemeProvider>,
  );
}

describe("Controls", () => {
  test("shows Stop when running", () => {
    renderControls({ running: true });
    expect(screen.getByText("Stop")).toBeDefined();
  });

  test("shows Resume when not running", () => {
    renderControls({ running: false });
    expect(screen.getByText("Resume")).toBeDefined();
  });

  test("shows New Conversation button", () => {
    renderControls();
    expect(screen.getByText("New Conversation")).toBeDefined();
  });

  // Regression guard: the row was `shrink-0` with two nowrap buttons and the
  // chips, which measured 360px against a 320px viewport — the whole page
  // picked up a horizontal scrollbar on a small phone.
  test("wraps rather than overflowing a narrow container", () => {
    const { container } = renderControls();
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain("flex-wrap");
  });

  test("gives the URL chips their own line below the sm breakpoint", () => {
    renderControls();
    // Sharing the buttons' row, the chips truncated to their bare labels and
    // dropped the URL they exist to show.
    const chips = screen.getByTestId("ui-url-chip").parentElement as HTMLElement;
    expect(chips.className).toContain("basis-full");
    expect(chips.className).toContain("sm:basis-auto");
    expect(chips.className).toContain("sm:ml-auto");
  });
});
