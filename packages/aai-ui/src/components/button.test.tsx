// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { Button, type ButtonVariant } from "./button.tsx";

const VARIANTS: ButtonVariant[] = ["default", "secondary", "ghost"];

function renderButton(variant: ButtonVariant, props?: { style?: React.CSSProperties }) {
  render(
    <ThemeProvider>
      <Button variant={variant} {...props}>
        Press
      </Button>
    </ThemeProvider>,
  );
  return screen.getByRole("button", { name: "Press" });
}

describe("Button", () => {
  // These are class/inline-style assertions rather than behavioural ones on
  // purpose: jsdom has no cascade and no layout, so the *rendered* focus ring
  // is unobservable here. That is exactly how the package shipped three
  // variants whose focus state and hover state were both dead — a full unit
  // suite could not see either. Pinning the declarations is the cheapest
  // guard that would actually have failed.
  describe.each(VARIANTS)("variant %s", (variant) => {
    test("declares a focus-visible ring, since outline-none alone hid focus entirely", () => {
      const button = renderButton(variant);
      expect(button.className).toContain("focus-visible:[outline:2px_solid]");
      expect(button.className).toContain("focus-visible:[outline-offset:2px]");
      // The ring has to be visible against the page, so it takes the theme
      // accent rather than the button's own foreground.
      expect(button.style.outlineColor).not.toBe("");
    });

    test("declares hover colors distinct from rest", () => {
      const button = renderButton(variant);
      const rest = button.style.getPropertyValue("--aai-btn-bg");
      const hover = button.style.getPropertyValue("--aai-btn-bg-hover");
      expect(rest).not.toBe("");
      expect(hover).not.toBe("");
      // `transition-colors` was on this button from the start with nothing to
      // transition: rest and hover computed byte-identically in every variant.
      expect(hover).not.toBe(rest);
      expect(button.className).toContain("enabled:hover:bg-(--aai-btn-bg-hover)");
    });

    test("hover is suppressed while disabled", () => {
      const button = renderButton(variant);
      // `enabled:` rather than a bare `hover:` — a disabled control that
      // lights up under the cursor reads as clickable.
      expect(button.className).not.toMatch(/(?<!enabled:)hover:bg-/);
    });
  });

  test("a caller's own style prop still wins over the variant colors", () => {
    const button = renderButton("default", { style: { background: "rebeccapurple" } });
    // The colors moved to custom properties so a :hover rule could reach them
    // at all; an explicit inline background must still beat that class.
    expect(button.style.background).toBe("rebeccapurple");
  });
});
