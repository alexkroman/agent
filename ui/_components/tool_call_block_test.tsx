// Copyright 2025 the AAI authors. MIT license.

import { h, render } from "preact";
import { describe, expect, test } from "vitest";
import { withDOM } from "../_test_utils.ts";
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

  test(
    "renders tool name",
    withDOM((container) => {
      render(h(ToolCallBlock, { toolCall: pendingToolCall }), container);
      expect(container.innerHTML).toContain("Web Search");
    }),
  );

  test(
    "shows pending status indicator for pending tool calls",
    withDOM((container) => {
      render(h(ToolCallBlock, { toolCall: pendingToolCall }), container);
      expect(container.innerHTML).toContain("tool-shimmer");
    }),
  );

  test(
    "shows result for completed tool calls",
    withDOM((container) => {
      render(h(ToolCallBlock, { toolCall: completedToolCall }), container);
      // Completed tool calls should not have the shimmer class
      expect(container.innerHTML).not.toContain("tool-shimmer");
      // The tool name should be rendered
      expect(container.innerHTML).toContain("Fetch JSON");
    }),
  );
});
