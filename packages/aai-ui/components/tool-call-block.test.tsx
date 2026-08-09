// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ThemeProvider } from "../context.ts";
import type { ToolCallInfo } from "../types.ts";
import { ToolCallBlock } from "./tool-call-block.tsx";

function renderBlock(toolCall: ToolCallInfo) {
  return render(
    <ThemeProvider>
      <ToolCallBlock toolCall={toolCall} />
    </ThemeProvider>,
  );
}

describe("ToolCallBlock", () => {
  const pendingToolCall: ToolCallInfo = {
    callId: "tc_1",
    name: "web_search",
    args: { query: "weather today" },
    status: "pending",
    seq: 1,
    afterMessageId: -1,
  };

  const completedToolCall: ToolCallInfo = {
    callId: "tc_2",
    name: "fetch_json",
    args: { url: "https://api.example.com/data" },
    status: "done",
    result: '{"temperature": 72}',
    seq: 2,
    afterMessageId: -1,
  };

  test("renders tool name", () => {
    renderBlock(pendingToolCall);
    expect(screen.getByText("web_search")).toBeDefined();
  });

  test("shows pending status indicator for pending tool calls", () => {
    const { container } = renderBlock(pendingToolCall);
    expect(container.innerHTML).toContain("tool-shimmer");
  });

  test("shows result for completed tool calls", () => {
    const { container } = renderBlock(completedToolCall);
    expect(container.innerHTML).not.toContain("tool-shimmer");
    expect(screen.getByText("fetch_json")).toBeDefined();
  });

  test("clicking a completed call expands the formatted JSON result", () => {
    renderBlock({ ...completedToolCall, result: '{"answer":42}' });
    // Collapsed: the result is not in the document yet.
    expect(screen.queryByText(/"answer"/)).toBeNull();

    fireEvent.click(screen.getByRole("button"));

    // Expanded: pretty-printed JSON with the key and value visible.
    expect(screen.getByText(/"answer": 42/)).toBeDefined();
  });

  test('a tool named "constructor" renders its raw name with an empty config', () => {
    // Regression: a plain-object config lookup would resolve "constructor"
    // through Object.prototype and treat a Function as display config. With
    // Object.hasOwn the raw name renders under the default "Tool" eyebrow.
    renderBlock({
      callId: "tc_3",
      name: "constructor",
      args: {},
      status: "done",
      result: "ok",
      seq: 3,
      afterMessageId: -1,
    });
    expect(screen.getByText("constructor")).toBeDefined();
    expect(screen.getByText("Tool")).toBeDefined();
  });
});

describe("ToolCallRow title overflow", () => {
  test("the title truncates instead of pushing the chevron out of the row", () => {
    // `shrink-0` on the title let a long tool name push the args preview to
    // zero width and then shove the chevron past the container's
    // `overflow-hidden`: measured on the 760px column, the preview vanished
    // at a 74-character name and the chevron was clipped at 76. The row still
    // expanded on click, but nothing on screen said it could.
    renderBlock({
      callId: "tc_long",
      name: "mcp__some_provider__an_extremely_long_tool_name_that_overflows_the_row",
      args: { query: "x" },
      status: "done",
      result: "ok",
      seq: 1,
      afterMessageId: 0,
    });
    const title = screen.getByText(
      "mcp__some_provider__an_extremely_long_tool_name_that_overflows_the_row",
    );
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("min-w-0");
    expect(title.className).not.toContain("shrink-0");
    // The expand affordance survives a title of any length.
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});
