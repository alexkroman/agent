// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createToolCallRepair, salvageJson } from "./studio-tool-repair.ts";

/** Parse a salvaged payload back to an object for shape assertions. */
function parsed(text: string | null): Record<string, unknown> {
  if (text === null) throw new Error("expected the payload to be salvaged");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("salvageJson", () => {
  test("passes valid JSON through unchanged in meaning", () => {
    expect(parsed(salvageJson('{"path":"agent.ts","content":"ok"}'))).toEqual({
      path: "agent.ts",
      content: "ok",
    });
  });

  test("escapes a raw newline inside a string — the common write_file break", () => {
    // A model emitting file content often writes real newlines into the JSON
    // string instead of \n, which is a hard parse error.
    const broken = '{"path":"a.ts","content":"line one\nline two"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(parsed(salvageJson(broken))).toEqual({ path: "a.ts", content: "line one\nline two" });
  });

  test("handles raw tabs and carriage returns too", () => {
    const broken = '{"content":"a\tb\r\nc"}';
    expect(parsed(salvageJson(broken))).toEqual({ content: "a\tb\r\nc" });
  });

  test("strips a markdown fence the model wrapped the arguments in", () => {
    const fenced = '```json\n{"path":"a.ts","content":"x"}\n```';
    expect(parsed(salvageJson(fenced))).toEqual({ path: "a.ts", content: "x" });
  });

  test("drops a trailing comma", () => {
    expect(parsed(salvageJson('{"path":"a.ts","content":"x",}'))).toEqual({
      path: "a.ts",
      content: "x",
    });
  });

  test("closes a truncated payload so the turn survives", () => {
    // Output cut mid-string: the content is partial, but the model gets a
    // real tool result and can continue instead of losing the call.
    const truncated = '{"path":"a.ts","content":"half a fi';
    const value = parsed(salvageJson(truncated));
    expect(value.path).toBe("a.ts");
    expect(value.content).toBe("half a fi");
  });

  test("closes nested structures left open", () => {
    const truncated = '{"todos":[{"text":"one","done":false}';
    expect(parsed(salvageJson(truncated))).toEqual({
      todos: [{ text: "one", done: false }],
    });
  });

  test("preserves already-escaped sequences", () => {
    // Must not double-escape: \\n in the payload is a literal backslash-n.
    const value = parsed(salvageJson('{"content":"a\\nb"}'));
    expect(value.content).toBe("a\nb");
  });

  test("refuses a fragment that is not an object", () => {
    // Tool inputs are always objects; salvaging a bare scalar would hand the
    // tool something it cannot use.
    expect(salvageJson('"just a string"')).toBeNull();
    expect(salvageJson("42")).toBeNull();
    expect(salvageJson("[1,2]")).toBeNull();
  });

  test("gives up rather than guessing", () => {
    expect(salvageJson("this is not json at all")).toBeNull();
    expect(salvageJson("")).toBeNull();
  });
});

describe("createToolCallRepair", () => {
  const model = {} as Parameters<typeof createToolCallRepair>[0];
  const inputSchema = async () => ({ type: "object" as const });

  test("leaves an unknown tool name alone", async () => {
    // Guessing which tool was meant risks turning a delete into a write.
    const repair = createToolCallRepair(model);
    const result = await repair({
      toolCall: { toolName: "nope", input: "{}" },
      error: new Error("No such tool"),
      inputSchema,
    });
    expect(result).toBeNull();
  });
});
