// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import { ThinkingIndicator } from "./thinking-indicator.tsx";

describe("ThinkingIndicator", () => {
  test("renders three dots", () => {
    const { container } = render(<ThinkingIndicator />);
    const dots = container.querySelectorAll(".rounded-full");
    expect(dots.length).toBe(3);
  });
});
