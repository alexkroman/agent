// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { serializeToolFailure } from "./_tool-failure-wire.ts";
import { isToolFailure, toolRefusal } from "./utils.ts";

describe("serializeToolFailure", () => {
  test("is the JSON form of `{ error }`, with no `reason` key when none is given", () => {
    expect(serializeToolFailure("boom")).toBe('{"error":"boom"}');
  });

  test("carries a refusal's reason beside the message", () => {
    expect(JSON.parse(serializeToolFailure("no such tool", "unknown_tool"))).toEqual({
      error: "no such tool",
      reason: "unknown_tool",
    });
  });

  test("parses back to what toolRefusal builds, so both halves name one shape", () => {
    const parsed: unknown = JSON.parse(serializeToolFailure("not now", "dialog"));
    expect(parsed).toEqual(toolRefusal("dialog", "not now"));
    expect(isToolFailure(parsed)).toBe(true);
  });

  test("escapes a message that would otherwise break the JSON", () => {
    const message = 'quote " and newline \n';
    expect(JSON.parse(serializeToolFailure(message))).toEqual({ error: message });
  });
});
