// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { render, screen } from "@testing-library/react";
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
    afterMessageIndex: 0,
  };

  const completedToolCall: ToolCallInfo = {
    callId: "tc_2",
    name: "fetch_json",
    args: { url: "https://api.example.com/data" },
    status: "done",
    result: '{"temperature": 72}',
    afterMessageIndex: 0,
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
});
