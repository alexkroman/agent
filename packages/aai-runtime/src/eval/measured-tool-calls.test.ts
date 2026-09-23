// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent } from "@alexkroman1/aai";
import { tool } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { measuredToolCalls } from "./_turn-faults.ts";
import { toolNames } from "./events.ts";

const meta = { id: "e1", at: 0 };

const called = (id: string, name: string): SessionEvent => ({
  type: "tool.called",
  meta,
  toolCallId: id,
  toolName: name,
  args: {},
});

const TURN: readonly SessionEvent[] = [
  called("c1", "think"),
  called("c2", "add_pizza"),
  called("c3", "think"),
];

describe("measuredToolCalls", () => {
  test("drops the think builtin, so a turn reads as the actions it took", () => {
    expect(toolNames(measuredToolCalls(TURN, { tools: {} }))).toEqual(["add_pizza"]);
  });

  test("keeps an AUTHORED think, which is an action like any other tool", () => {
    const think = tool({
      description: "The author's own think.",
      inputSchema: z.object({}),
      execute: () => "ok",
    });
    expect(toolNames(measuredToolCalls(TURN, { tools: { think } }))).toEqual([
      "think",
      "add_pizza",
      "think",
    ]);
  });
});
