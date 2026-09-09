// Copyright 2026 the AAI authors. MIT license.
// One question, asked of a `ModelMessage` list: what does a TOOL see of this
// conversation? The answer has to be the same three-role `Message` union the
// pipeline and the session produce, and the arm that is easiest to get wrong is
// `tool` — a text-only projection dropped every tool result, so a caller
// resuming a conversation handed its tools a history with every result missing
// while the model reading the same list saw them all.

import { MAX_TOOL_RESULT_CHARS } from "@alexkroman1/aai/internal";
import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, test } from "vitest";
import { toContextMessages, toolOutputText } from "./text-agent-messages.ts";

/** One `tool` message carrying the given result parts. */
function toolMessage(...parts: ToolResultPart[]): ModelMessage {
  return { role: "tool", content: parts };
}

/** A `tool-result` part with the fields a case varies. */
function resultPart(
  output: ToolResultPart["output"],
  overrides: { toolName?: string; toolCallId?: string } = {},
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId: overrides.toolCallId ?? "call_1",
    toolName: overrides.toolName ?? "lookup",
    output,
  };
}

describe("toolOutputText", () => {
  test("a text output IS the string", () => {
    expect(toolOutputText({ type: "text", value: "sunny" })).toBe("sunny");
  });

  test("a json output is serialized — which is the form this SDK's executor produces", () => {
    expect(toolOutputText({ type: "json", value: { count: 42 } })).toBe('{"count":42}');
  });

  test("the ERROR arms are not dropped — a failed tool is what a later tool wants to know", () => {
    // This SDK's own failures already arrive as an ordinary result
    // (`serializeToolFailure`), so dropping the tagged error arms would hide
    // only the failures another producer reported honestly.
    expect(toolOutputText({ type: "error-text", value: "upstream 503" })).toBe("upstream 503");
    expect(toolOutputText({ type: "error-json", value: { error: "boom" } })).toBe(
      '{"error":"boom"}',
    );
  });

  test("a multimodal content output keeps its text parts and joins them", () => {
    expect(
      toolOutputText({
        type: "content",
        value: [
          { type: "text", text: "one " },
          { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one two");
  });

  test("a content output with no text at all is the empty string, not a crash", () => {
    expect(
      toolOutputText({
        type: "content",
        value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } }],
      }),
    ).toBe("");
  });

  test("execution-denied has no result, so the REASON is the result", () => {
    expect(toolOutputText({ type: "execution-denied", reason: "policy: no shell" })).toBe(
      "policy: no shell",
    );
    expect(toolOutputText({ type: "execution-denied" })).toBe("Tool execution denied.");
  });
});

describe("toContextMessages", () => {
  test("keeps user and assistant words, joined across parts", () => {
    expect(
      toContextMessages([
        { role: "user", content: "book me a table" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "For " },
            { type: "text", text: "two?" },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", content: "book me a table" },
      { role: "assistant", content: "For two?" },
    ]);
  });

  test("drops the SYSTEM message — a tool does not need the agent's own prompt back", () => {
    expect(toContextMessages([{ role: "system", content: "Be brief." }])).toEqual([]);
  });

  test("drops a non-text part rather than inventing a string for it", () => {
    expect(
      toContextMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image", image: "AAAA" },
          ],
        },
      ]),
    ).toEqual([{ role: "user", content: "what is this" }]);
  });

  test("a message whose text is empty contributes nothing", () => {
    // An assistant message that is only `tool-call` parts is the real case: the
    // CALL is not information a later tool can act on, and the result that
    // answers it arrives one message later carrying the tool's name anyway.
    expect(
      toContextMessages([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: {} }],
        },
        { role: "user", content: "" },
      ]),
    ).toEqual([]);
  });

  test("a tool message becomes ONE message PER PART, with the name and the call id", () => {
    // The pairing a tool needs is result-to-CALL, and one `tool` message can
    // answer several calls at once — so collapsing them into one row would lose
    // which result belongs to which call.
    expect(
      toContextMessages([
        toolMessage(
          resultPart({ type: "text", value: "sunny" }, { toolName: "weather", toolCallId: "c1" }),
          resultPart({ type: "json", value: { n: 2 } }, { toolName: "count", toolCallId: "c2" }),
        ),
      ]),
    ).toEqual([
      { role: "tool", content: "sunny", toolName: "weather", toolCallId: "c1" },
      { role: "tool", content: '{"n":2}', toolName: "count", toolCallId: "c2" },
    ]);
  });

  test("a non-result part inside a tool message is skipped", () => {
    // `ToolContent` also admits a `tool-approval-response`, which carries no
    // result at all — a projection that assumed every part was a result would
    // hand a tool a row with `undefined` content.
    expect(
      toContextMessages([
        {
          role: "tool",
          content: [
            { type: "tool-approval-response", approvalId: "a1", approved: false },
            resultPart({ type: "text", value: "sunny" }),
          ],
        },
      ]),
    ).toEqual([{ role: "tool", content: "sunny", toolName: "lookup", toolCallId: "call_1" }]);
  });

  test("the tool arm goes through toolResultMessage, so it is CAPPED like every other producer", () => {
    // The reason `_tool-result-message.ts` exists: four producers, one shape,
    // one cap — or a tool sees a different history live than after a resume.
    const [message] = toContextMessages([
      toolMessage(resultPart({ type: "text", value: "z".repeat(MAX_TOOL_RESULT_CHARS + 100) })),
    ]);
    expect(message?.content).toHaveLength(MAX_TOOL_RESULT_CHARS);
  });

  test("order is preserved across the roles, which is what makes it a conversation", () => {
    expect(
      toContextMessages([
        { role: "system", content: "Be brief." },
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "weather", input: {} }],
        },
        toolMessage(resultPart({ type: "text", value: "sunny" }, { toolCallId: "c1" })),
        { role: "assistant", content: "It's sunny." },
      ]).map((message) => message.role),
    ).toEqual(["user", "tool", "assistant"]);
  });

  test("an empty conversation projects to an empty list", () => {
    expect(toContextMessages([])).toEqual([]);
  });
});
