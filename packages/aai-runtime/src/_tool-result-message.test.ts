// Copyright 2026 the AAI authors. MIT license.
// ONE statement of what a settled tool call contributes to `ctx.messages`.
// Four producers reach this shape from four directions — the pipeline's tool
// runner, the text agent, the S2S session's tool steps, and a resume reading
// the event log — and a tool must see the SAME history under `aai dev`, in the
// sandbox and after a reconnect. So the two claims are the ones that make those
// four agree: the cap is applied HERE, and an absent name is an absent KEY.

import { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_MARKER } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { toolResultMessage } from "./_tool-result-message.ts";

describe("toolResultMessage", () => {
  test('is always role "tool", whatever else it carries', () => {
    // The arm is read by ROLE, never by the presence of a field: a completion
    // whose `tool.called` fell off the front of the event log has no name to
    // give, and must still be recognisable as a tool result.
    expect(toolResultMessage({ result: "ok" }).role).toBe("tool");
    expect(toolResultMessage({ result: "ok", toolName: "lookup" }).role).toBe("tool");
  });

  test("carries the name and the call id when they are known", () => {
    expect(toolResultMessage({ result: "42", toolName: "add", toolCallId: "call_1" })).toEqual({
      role: "tool",
      content: "42",
      toolName: "add",
      toolCallId: "call_1",
    });
  });

  test("an unknown name is an ABSENT KEY, not a key set to undefined", () => {
    // `exactOptionalPropertyTypes` makes those different types, and the
    // difference is observable where it matters most: a `{ toolName: undefined }`
    // survives `structuredClone` and vanishes through a JSON round trip, so a
    // live history and a resumed one would stop being byte-identical.
    const message = toolResultMessage({ result: "ok", toolName: undefined });
    expect(Object.hasOwn(message, "toolName")).toBe(false);
    expect(Object.hasOwn(message, "toolCallId")).toBe(false);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    expect(structuredClone(message)).toEqual(message);
  });

  test("one known field does not drag the other along", () => {
    const named = toolResultMessage({ result: "ok", toolName: "add" });
    expect(Object.hasOwn(named, "toolName")).toBe(true);
    expect(Object.hasOwn(named, "toolCallId")).toBe(false);
  });

  test("the result is CAPPED here, which is what makes the four producers agree", () => {
    // The event log only ever holds a capped result (the wire schema refuses
    // more), so a live path recording the full string would hand a tool one
    // thing during the call and a shorter thing after a resume, with nothing
    // reporting the difference.
    const long = "x".repeat(MAX_TOOL_RESULT_CHARS + 500);
    const { content } = toolResultMessage({ result: long });
    expect(content).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true);
  });

  test("a result at or under the cap is passed through byte for byte", () => {
    const exact = "y".repeat(MAX_TOOL_RESULT_CHARS);
    expect(toolResultMessage({ result: exact }).content).toBe(exact);
    expect(toolResultMessage({ result: "" }).content).toBe("");
    expect(toolResultMessage({ result: '{"count":42}' }).content).toBe('{"count":42}');
  });

  test("two calls with the same input produce equal, independent messages", () => {
    // Every producer calls this per settled call; nothing here may be shared
    // mutable state that a later message could edit out from under an earlier.
    const first = toolResultMessage({ result: "ok", toolName: "add" });
    const second = toolResultMessage({ result: "ok", toolName: "add" });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
