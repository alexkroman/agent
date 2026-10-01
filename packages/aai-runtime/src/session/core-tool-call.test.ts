// Copyright 2026 the AAI authors. MIT license.
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { flush } from "../_test-utils.ts";
import { makeCore } from "./_core-harness.ts";

describe("createSessionCore — the shared tool-call core", () => {
  test("coerces a reported call's stringified scalars toward the declared schema", async () => {
    // The step the pipeline's tools always took, which the S2S path skipped
    // before both ran through `runToolCall`.
    const executeTool = vi.fn<ExecuteTool>(async () => "ok");
    const { core } = makeCore({
      executeTool,
      toolSchemas: [
        {
          type: "function",
          name: "book",
          description: "book a table",
          parameters: {
            type: "object",
            properties: { guests: { type: "integer" }, note: { type: "string" } },
          },
        },
      ],
    });
    await core.start();
    core.onReplyStarted("r1");
    core.report({
      type: "tool.called",
      toolCallId: "c1",
      toolName: "book",
      args: { guests: "4", note: "12" },
    });
    await flush();
    expect(executeTool.mock.calls[0]?.[1]).toEqual({ guests: 4, note: "12" });
  });
});
