// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render, screen } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import { createMockSignals } from "../_test_utils.ts";
import { SessionProvider } from "../signals.ts";
import { Controls } from "./controls.tsx";

function renderControls(overrides?: Parameters<typeof createMockSignals>[0]) {
  const signals = createMockSignals(overrides);
  return render(
    <SessionProvider value={signals}>
      <Controls />
    </SessionProvider>,
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
