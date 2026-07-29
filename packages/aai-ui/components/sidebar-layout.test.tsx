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

  test("sidebar defaults to the left with a right border", () => {
    const { getByTestId, container } = renderLayout();
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    // Left placement: sidebar column comes before the main column.
    const root = container.firstElementChild as HTMLElement;
    expect(root.firstElementChild).toBe(sidebar);
    expect(sidebar.style.borderRight).toContain("1px solid");
    expect(sidebar.style.borderLeft).toBe("");
    expect(sidebar.style.width).toBe("18rem");
  });

  test("sidebarPosition: right places the sidebar last with a left border", () => {
    const { getByTestId, container } = renderLayout({ sidebarPosition: "right" });
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    const root = container.firstElementChild as HTMLElement;
    expect(root.lastElementChild).toBe(sidebar);
    expect(sidebar.style.borderLeft).toContain("1px solid");
    expect(sidebar.style.borderRight).toBe("");
  });

  test("honors a custom sidebarWidth and extra className", () => {
    const { getByTestId, container } = renderLayout({
      sidebarWidth: "24rem",
      className: "custom-shell",
    });
    const sidebar = getByTestId("sidebar-content").parentElement as HTMLElement;
    expect(sidebar.style.width).toBe("24rem");
    expect((container.firstElementChild as HTMLElement).className).toContain("custom-shell");
  });
});
