// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { SidebarLayout } from "./sidebar-layout.tsx";

function renderLayout(props?: Partial<Parameters<typeof SidebarLayout>[0]>) {
  return render(
    <ThemeProvider>
      <SidebarLayout sidebar={<nav data-testid="sidebar-content">cart</nav>} {...props}>
        <main data-testid="main-content">chat</main>
      </SidebarLayout>
    </ThemeProvider>,
  );
}

describe("SidebarLayout", () => {
  test("renders sidebar and main content", () => {
    const { getByTestId } = renderLayout();
    expect(getByTestId("sidebar-content").textContent).toBe("cart");
    expect(getByTestId("main-content").textContent).toBe("chat");
  });

  test("sidebar defaults to the left, with the divider on its right edge", () => {
    const { getByTestId, container } = renderLayout();
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    // Left placement: sidebar column comes before the main column.
    const root = container.firstElementChild as HTMLElement;
    expect(root.firstElementChild).toBe(sidebar);
    expect(sidebar.className).toContain("md:border-r");
    expect(sidebar.className).not.toContain("md:border-l");
    expect(sidebar.style.borderColor).not.toBe("");
  });

  test("sidebarPosition: right places the sidebar last, divider on its left edge", () => {
    const { getByTestId, container } = renderLayout({ sidebarPosition: "right" });
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    const root = container.firstElementChild as HTMLElement;
    expect(root.lastElementChild).toBe(sidebar);
    expect(sidebar.className).toContain("md:border-l");
    expect(sidebar.className).not.toContain("md:border-r");
  });

  test("honors a custom sidebarWidth and extra className", () => {
    const { getByTestId, container } = renderLayout({
      sidebarWidth: "24rem",
      className: "custom-shell",
    });
    const root = container.firstElementChild as HTMLElement;
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    // The width reaches the sidebar as a custom property so a media query can
    // drop it when the panes stack — an inline `width` could not be overridden.
    expect(root.style.getPropertyValue("--aai-sidebar-w")).toBe("24rem");
    expect(sidebar.className).toContain("md:w-(--aai-sidebar-w)");
    expect(root.className).toContain("custom-shell");
  });

  // Regression guard for the layout this component shipped with: the sidebar
  // was an unshrinkable fixed width at every viewport, so at 390px it kept all
  // 288px and left the main pane ~30px of text column once ChatView's padding
  // came off — a conversation rendered one character per line.
  test("stacks the panes below the md breakpoint instead of squeezing them", () => {
    const { getByTestId, container } = renderLayout();
    const root = container.firstElementChild as HTMLElement;
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    expect(root.className).toContain("flex-col");
    expect(root.className).toContain("md:flex-row");
    // Full width when stacked; the fixed width only applies from md up.
    expect(sidebar.className).toContain("w-full");
    expect(sidebar.className).toContain("md:w-(--aai-sidebar-w)");
    // And capped in height when stacked, so the main pane is still reachable.
    expect(sidebar.className).toContain("max-h-[40vh]");
    expect(sidebar.className).toContain("md:max-h-none");
  });
});
