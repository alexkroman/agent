// Copyright 2025 the AAI authors. MIT license.

import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { createMockSignals, withDOM } from "../_test_utils.ts";
import { SessionProvider } from "../signals.ts";
import { Controls } from "./controls.tsx";

describe("Controls", () => {
  test(
    "shows Stop when running",
    withDOM((container) => {
      const signals = createMockSignals({ running: true });
      render(h(SessionProvider, { value: signals }, h(Controls, null)), container);
      expect(container.innerHTML).toContain("Stop");
    }),
  );

  test(
    "shows Resume when not running",
    withDOM((container) => {
      const signals = createMockSignals({ running: false });
      render(h(SessionProvider, { value: signals }, h(Controls, null)), container);
      expect(container.innerHTML).toContain("Resume");
    }),
  );

  test(
    "shows New Conversation button",
    withDOM((container) => {
      const signals = createMockSignals();
      render(h(SessionProvider, { value: signals }, h(Controls, null)), container);
      expect(container.innerHTML).toContain("New Conversation");
    }),
  );
});
