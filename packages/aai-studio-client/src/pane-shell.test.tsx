// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The page frame the full-width panes share. Two of its classes are behaviour,
// not styling: `min-w-0` (a wide child cannot stretch the shell) and the pane
// owning its own `overflow-y-auto` scroll.

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PaneShell } from "./pane-shell.tsx";

describe("PaneShell", () => {
  test("renders the title as the page heading, the subtitle under it, then the body", () => {
    render(
      <PaneShell title="Secrets" subtitle="demo-project">
        <p>body</p>
      </PaneShell>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Secrets" });
    const header = heading.closest("header");
    expect(header?.textContent).toContain("demo-project");
    expect(screen.getByText("body").closest("header")).toBeNull();
  });

  test("the outermost element scrolls itself and cannot be stretched sideways", () => {
    const { container } = render(
      <PaneShell title="t" subtitle="s">
        <span />
      </PaneShell>,
    );
    const root = container.firstElementChild;
    const cls = (root?.className ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["min-w-0", "min-h-0", "overflow-y-auto"]));
  });
});
