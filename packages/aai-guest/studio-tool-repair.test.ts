// Copyright 2026 the AAI authors. MIT license.

import { InvalidToolInputError, parsePartialJson } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test } from "vitest";
import { createToolCallRepair, salvageJson } from "./studio-tool-repair.ts";

/** Salvage a payload and parse it back to an object for shape assertions. */
async function parsed(input: string): Promise<Record<string, unknown>> {
  const text = await salvageJson(input);
  if (text === null) throw new Error("expected the payload to be salvaged");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("salvageJson", () => {
  test("passes valid JSON through unchanged in meaning", async () => {
    expect(await parsed('{"path":"agent.ts","content":"ok"}')).toEqual({
      path: "agent.ts",
      content: "ok",
    });
  });

  test("escapes a raw newline inside a string — the common write_file break", async () => {
    // A model emitting file content often writes real newlines into the JSON
    // string instead of \n, which is a hard parse error.
    const broken = '{"path":"a.ts","content":"line one\nline two"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(await parsed(broken)).toEqual({ path: "a.ts", content: "line one\nline two" });
  });

  test("handles raw tabs and carriage returns too", async () => {
    const broken = '{"content":"a\tb\r\nc"}';
    expect(await parsed(broken)).toEqual({ content: "a\tb\r\nc" });
  });

  test("strips a markdown fence the model wrapped the arguments in", async () => {
    const fenced = '```json\n{"path":"a.ts","content":"x"}\n```';
    expect(await parsed(fenced)).toEqual({ path: "a.ts", content: "x" });
  });

  test("drops a trailing comma", async () => {
    expect(await parsed('{"path":"a.ts","content":"x",}')).toEqual({
      path: "a.ts",
      content: "x",
    });
  });

  test("closes a truncated payload so the turn survives", async () => {
    // Output cut mid-string: the content is partial, but the model gets a
    // real tool result and can continue instead of losing the call.
    const truncated = '{"path":"a.ts","content":"half a fi';
    const value = await parsed(truncated);
    expect(value.path).toBe("a.ts");
    expect(value.content).toBe("half a fi");
  });

  test("closes nested structures left open", async () => {
    const truncated = '{"todos":[{"text":"one","done":false}';
    expect(await parsed(truncated)).toEqual({
      todos: [{ text: "one", done: false }],
    });
  });

  test("preserves already-escaped sequences", async () => {
    // Must not double-escape: \\n in the payload is a literal backslash-n.
    const value = await parsed('{"content":"a\\nb"}');
    expect(value.content).toBe("a\nb");
  });

  test("refuses a fragment that is not an object", async () => {
    // Tool inputs are always objects; salvaging a bare scalar would hand the
    // tool something it cannot use.
    expect(await salvageJson('"just a string"')).toBeNull();
    expect(await salvageJson("42")).toBeNull();
    expect(await salvageJson("[1,2]")).toBeNull();
  });

  test("gives up rather than guessing", async () => {
    expect(await salvageJson("this is not json at all")).toBeNull();
    expect(await salvageJson("")).toBeNull();
  });
});

describe("what the SDK already covers", () => {
  // This module only exists for what parsePartialJson does NOT handle. If
  // these expectations ever flip, delete the corresponding pre-pass.
  test("parsePartialJson repairs structure but not raw control chars or fences", async () => {
    await expect(parsePartialJson('{"a":"b')).resolves.toMatchObject({ state: "repaired-parse" });
    await expect(parsePartialJson('{"a":"b",}')).resolves.toMatchObject({
      state: "repaired-parse",
    });
    // The two we add:
    await expect(parsePartialJson('{"a":"one\ntwo"}')).resolves.toMatchObject({
      state: "failed-parse",
    });
    await expect(parsePartialJson('```json\n{"a":1}\n```')).resolves.toMatchObject({
      state: "failed-parse",
    });
  });
});

describe("createToolCallRepair", () => {
  const model = {} as Parameters<typeof createToolCallRepair>[0];
  const inputSchema = async () => ({ type: "object" as const });

  const invalidInput = (input: string) =>
    new InvalidToolInputError({
      toolName: "write_file",
      toolInput: input,
      cause: new Error("parse failed"),
    });

  /** A tier-2 model that answers with fixed JSON, counting its calls. */
  function fixerModel(json: string): { model: MockLanguageModelV3; calls: () => number } {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [{ type: "text" as const, text: json }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    return { model, calls: () => calls };
  }

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

  test("tier 1 salvages malformed input without spending any tokens", async () => {
    const { model: fixer, calls } = fixerModel('{"never":"used"}');
    const repair = createToolCallRepair(fixer);
    const broken = '{"path":"a.ts","content":"line one\nline two"}';

    const result = await repair({
      toolCall: { toolName: "write_file", input: broken },
      error: invalidInput(broken),
      inputSchema,
    });

    expect(result).not.toBeNull();
    expect(JSON.parse(result?.input as string)).toEqual({
      path: "a.ts",
      content: "line one\nline two",
    });
    expect(calls()).toBe(0);
  });

  test("tier 2 asks the model to rewrite input that cannot be salvaged", async () => {
    const { model: fixer, calls } = fixerModel('{"path":"a.ts","content":"x"}');
    const repair = createToolCallRepair(fixer);
    const hopeless = "write a.ts with content x please";

    const result = await repair({
      toolCall: { toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
    });

    expect(calls()).toBe(1);
    expect(result).not.toBeNull();
    expect(JSON.parse(result?.input as string)).toEqual({ path: "a.ts", content: "x" });
    // The rest of the call rides through unchanged.
    expect(result?.toolName).toBe("write_file");
  });

  test("a failed tier-2 rewrite falls through to null so the original error reports", async () => {
    const failing = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("model unavailable");
      },
    });
    const repair = createToolCallRepair(failing);
    const hopeless = "not json";

    const result = await repair({
      toolCall: { toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
    });

    expect(result).toBeNull();
  });
});
