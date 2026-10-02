// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * `ToolCallRow` — the design system's one row per tool invocation, rendered by
 * the agent UI's tool-call block and by the studio's chat transcript.
 *
 * Purely presentational, so it is driven with props directly: the title never
 * pushes the chevron out (moved from `tool-call-block.test.tsx`), the row is
 * expandable exactly when it has a panel, and the chip, shimmer and variant
 * follow their props.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import { ToolCallRow } from "./tool-call-row.tsx";

describe("ToolCallRow title overflow", () => {
  test("the title truncates instead of pushing the chevron out of the row", () => {
    // `shrink-0` on the title let a long tool name push the args preview to
    // zero width and then shove the chevron past the container's
    // `overflow-hidden`: measured on the 760px column, the preview vanished
    // at a 74-character name and the chevron was clipped at 76. The row still
    // expanded on click, but nothing on screen said it could.
    render(
      <ThemeProvider>
        <ToolCallRow
          title="mcp__some_provider__an_extremely_long_tool_name_that_overflows_the_row"
          detail='{"query":"x"}'
        >
          ok
        </ToolCallRow>
      </ThemeProvider>,
    );
    const title = screen.getByText(
      "mcp__some_provider__an_extremely_long_tool_name_that_overflows_the_row",
    );
    expect(title).toHaveClass("truncate");
    expect(title).toHaveClass("min-w-0");
    expect(title).not.toHaveClass("shrink-0");
    // The expand affordance survives a title of any length.
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("ToolCallRow", () => {
  test("with a panel it toggles open and closed", () => {
    render(
      <ThemeProvider>
        <ToolCallRow title="web_search">
          <pre>the result</pre>
        </ToolCallRow>
      </ThemeProvider>,
    );
    const button = screen.getByRole("button");
    expect(screen.queryByText("the result")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the result")).toBeInTheDocument();

    fireEvent.click(button);
    expect(screen.queryByText("the result")).not.toBeInTheDocument();
  });

  test("without a panel the row is inert and claims no expansion", () => {
    render(
      <ThemeProvider>
        <ToolCallRow title="web_search" />
      </ThemeProvider>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-expanded");
    expect(button).not.toHaveTextContent("▶");
  });

  test("the TOOL chip stands in until a caller passes an icon", () => {
    const { rerender } = render(
      <ThemeProvider>
        <ToolCallRow title="web_search" />
      </ThemeProvider>,
    );
    expect(screen.getByText("Tool")).toBeInTheDocument();

    rerender(
      <ThemeProvider>
        <ToolCallRow title="web_search" icon="🔎" />
      </ThemeProvider>,
    );
    expect(screen.queryByText("Tool")).not.toBeInTheDocument();
    expect(screen.getByText("🔎")).toBeInTheDocument();
  });

  test("a pending call shimmers its title, and the compact variant is denser", () => {
    render(
      <ThemeProvider>
        <ToolCallRow title="web_search" pending variant="compact" />
      </ThemeProvider>,
    );
    const title = screen.getByText("web_search");
    expect(title).toHaveClass("tool-shimmer");
    expect(title).toHaveClass("text-[11px]");
  });
});
