// Copyright 2025 the AAI authors. MIT license.

import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { withDOM } from "../_test_utils.ts";
import { ThinkingIndicator } from "./thinking_indicator.tsx";

describe("ThinkingIndicator", () => {
  test(
    "renders three dots",
    withDOM((container) => {
      render(h(ThinkingIndicator, null), container);
      const dots = container.querySelectorAll(".rounded-full");
      expect(dots.length).toBe(3);
    }),
  );
});
