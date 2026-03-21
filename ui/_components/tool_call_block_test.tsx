// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

import { render, screen } from "@testing-library/preact";
import { describe, expect, test } from "vitest";
import type { ToolCallInfo } from "../types.ts";
import { ToolCallBlock } from "./tool_call_block.tsx";

describe("ToolCallBlock", () => {
  const pendingToolCall: ToolCallInfo = {
    toolCallId: "tc_1",
    toolName: "web_search",
    args: { query: "weather today" },
    status: "pending",
    afterMessageIndex: 0,
  };

  const completedToolCall: ToolCallInfo = {
    toolCallId: "tc_2",
    toolName: "fetch_json",
    args: { url: "https://api.example.com/data" },
    status: "done",
    result: '{"temperature": 72}',
    afterMessageIndex: 0,
  };

  test("renders tool name", () => {
    render(<ToolCallBlock toolCall={pendingToolCall} />);
    expect(screen.getByText("Web Search")).toBeDefined();
  });

  test("shows pending status indicator for pending tool calls", () => {
    const { container } = render(<ToolCallBlock toolCall={pendingToolCall} />);
    expect(container.innerHTML).toContain("tool-shimmer");
  });

  test("shows result for completed tool calls", () => {
    const { container } = render(<ToolCallBlock toolCall={completedToolCall} />);
    expect(container.innerHTML).not.toContain("tool-shimmer");
    expect(screen.getByText("Fetch JSON")).toBeDefined();
  });
});
