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
});
