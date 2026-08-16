// Copyright 2026 the AAI authors. MIT license.

import { InvalidToolInputError, type ModelMessage, NoSuchToolError, parsePartialJson } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test } from "vitest";
import { makeLogger, silentLogger } from "./_test-utils.ts";
import { createToolCallRepair, salvageJson } from "./tool-call-repair.ts";

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

describe("what jsonrepair adds beyond the two hand-rolled pre-passes", () => {
  // The pre-passes handled a raw control char and an anchored fence, and nothing
  // else. These are shapes models do emit that used to reach the paid tier.
  test("single-quoted strings", async () => {
    expect(await parsed("{'path':'a.ts','content':'x'}")).toEqual({ path: "a.ts", content: "x" });
  });

  test("unquoted keys", async () => {
    expect(await parsed('{path:"a.ts"}')).toEqual({ path: "a.ts" });
  });

  test("Python's None / True / False", async () => {
    expect(await parsed('{"done":False,"note":None,"ok":True}')).toEqual({
      done: false,
      note: null,
      ok: true,
    });
  });

  test("comments", async () => {
    expect(await parsed('{"path":"a.ts" /* the file */}')).toEqual({ path: "a.ts" });
  });

  test("recovers a field parsePartialJson would have SILENTLY DROPPED", async () => {
    // The hazard the empty-object check exists for: `parsePartialJson` calls this
    // a `repaired-parse` and hands back `{}`, so taking its answer would run the
    // tool with no arguments and report success. Pinned end to end because the
    // ordering, not either library, is what makes it right.
    await expect(parsePartialJson('{path:"a.ts"}')).resolves.toMatchObject({
      state: "repaired-parse",
      value: {},
    });
    expect(await parsed('{path:"a.ts"}')).toEqual({ path: "a.ts" });
  });

  test("a tool that really takes no arguments still salvages to {}", async () => {
    // The other side of that check — `{}` is a legitimate answer when it is the
    // whole object, so preferring the repair must not turn it into a null.
    expect(await parsed("{}")).toEqual({});
  });

  test("prose AFTER a closing fence is left to the model tier", async () => {
    // Not covered, deliberately. `jsonrepair` reads the trailing sentence as a
    // second document and answers with an ARRAY, and picking an element out of
    // it is the "latched onto a fragment" guess the object guard exists to
    // refuse. Tier 2 is the right answer for this one.
    expect(await salvageJson('```json\n{"path":"a.ts"}\n```\nLet me know!')).toBeNull();
  });
});

describe("what the SDK already covers", () => {
  // `parsePartialJson` runs first and alone on the happy path, so what it does
  // NOT handle is what justifies the `jsonrepair` pass behind it. If these
  // expectations ever flip, that pass has less to do.
  test("parsePartialJson repairs structure but not raw control chars or fences", async () => {
    await expect(parsePartialJson('{"a":"b')).resolves.toMatchObject({ state: "repaired-parse" });
    await expect(parsePartialJson('{"a":"b",}')).resolves.toMatchObject({
      state: "repaired-parse",
    });
    // The two the second pass was originally added for:
    await expect(parsePartialJson('{"a":"one\ntwo"}')).resolves.toMatchObject({
      state: "failed-parse",
    });
    await expect(parsePartialJson('```json\n{"a":1}\n```')).resolves.toMatchObject({
      state: "failed-parse",
    });
  });
});

/**
 * `createToolCallRepair` end to end, over a REAL `NoSuchToolError`, a real
 * `InvalidToolInputError` and a real `MockLanguageModelV3`.
 *
 * This absorbed `tool-call-repair.test.ts`, which drove the same four branches
 * through `vi.mock("ai")` — a module mock that replaced `NoSuchToolError` with
 * a `__noSuchTool` sentinel, so the "unknown tool" spec exercised the stub
 * rather than the SDK's own predicate, and every options object had to be
 * laundered through `as never`. Nothing was lost in the fold: the two
 * abort-signal specs below are the only ones that file uniquely covered.
 */
describe("createToolCallRepair over a real model", () => {
  const model = {} as Parameters<typeof createToolCallRepair>[0];
  const inputSchema = async () => ({ type: "object" as const });
  /**
   * The rest of the SDK's repair bag, spelled out rather than cast away: the
   * hook is handed the whole request, and only these four fields are ones
   * this module has no opinion about.
   */
  const rest = {
    instructions: undefined,
    system: undefined,
    messages: [] as ModelMessage[],
    tools: {},
  };

  const invalidInput = (input: string) =>
    new InvalidToolInputError({
      toolName: "write_file",
      toolInput: input,
      cause: new Error("parse failed"),
    });

  /**
   * A tier-2 model that answers with fixed JSON, recording every call it is
   * handed — the request is what the abort-signal specs below assert on.
   */
  function fixerModel(json: string): {
    model: MockLanguageModelV3;
    calls: () => number;
    signals: () => (AbortSignal | undefined)[];
  } {
    const seen: (AbortSignal | undefined)[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seen.push(options.abortSignal);
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
    return { model, calls: () => seen.length, signals: () => seen };
  }

  test("leaves an unknown tool name alone", async () => {
    // Guessing which tool was meant risks turning a delete into a write.
    const repair = createToolCallRepair(model, silentLogger);
    const result = await repair({
      toolCall: { type: "tool-call", toolCallId: "t0", toolName: "nope", input: "{}" },
      error: new NoSuchToolError({ toolName: "nope", availableTools: ["write_file"] }),
      inputSchema,
      ...rest,
    });
    expect(result).toBeNull();
  });

  test("tier 1 salvages malformed input without spending any tokens", async () => {
    const { model: fixer, calls } = fixerModel('{"never":"used"}');
    const repair = createToolCallRepair(fixer, silentLogger);
    const broken = '{"path":"a.ts","content":"line one\nline two"}';

    const result = await repair({
      toolCall: { type: "tool-call", toolCallId: "t1", toolName: "write_file", input: broken },
      error: invalidInput(broken),
      inputSchema,
      ...rest,
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
    const repair = createToolCallRepair(fixer, silentLogger);
    const hopeless = "write a.ts with content x please";

    const result = await repair({
      toolCall: { type: "tool-call", toolCallId: "t2", toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
      ...rest,
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
    // Fresh per test: `restoreMocks` clears neither the history nor the
    // implementation of a plain `vi.fn()`, so a shared logger would let an
    // earlier test's warning satisfy this one.
    const log = makeLogger();
    const repair = createToolCallRepair(failing, log);
    const hopeless = "not json";

    const result = await repair({
      toolCall: { type: "tool-call", toolCallId: "t2", toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
      ...rest,
    });

    expect(result).toBeNull();
    // Silently returning null would leave a repair that never worked
    // indistinguishable from one that was never needed.
    expect(log.warn).toHaveBeenCalledWith(
      "tool-call repair failed",
      expect.objectContaining({ tool: "write_file", error: "model unavailable" }),
    );
  });

  // The turn's abort signal has to reach the tier-2 request, or a barged-in
  // turn keeps paying for a rewrite nobody will read. `getAbortSignal` is
  // OPTIONAL and the option is omitted rather than passed as `undefined`, so
  // both arms are pinned.
  test("threads the turn's abort signal into the tier-2 request", async () => {
    const { model: fixer, signals } = fixerModel('{"path":"a.ts","content":"x"}');
    const ctl = new AbortController();
    const repair = createToolCallRepair(fixer, silentLogger, () => ctl.signal);
    const hopeless = "write a.ts with content x please";

    await repair({
      toolCall: { type: "tool-call", toolCallId: "t3", toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
      ...rest,
    });

    expect(signals()).toEqual([ctl.signal]);
  });

  test("omits abortSignal when the getter returns undefined", async () => {
    const { model: fixer, signals } = fixerModel('{"path":"a.ts","content":"x"}');
    const repair = createToolCallRepair(fixer, silentLogger, () => undefined);
    const hopeless = "write a.ts with content x please";

    await repair({
      toolCall: { type: "tool-call", toolCallId: "t4", toolName: "write_file", input: hopeless },
      error: invalidInput(hopeless),
      inputSchema,
      ...rest,
    });

    expect(signals()).toEqual([undefined]);
  });
});
