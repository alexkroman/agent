// Copyright 2026 the AAI authors. MIT license.
// A tool call leaving a REQUIRED text argument blank is refused before it runs,
// on every path that runs a tool loop: the AI SDK loop (pipeline, text agent,
// subagent — `to-vercel-tools.ts`), a host relay behind it, and a
// provider-run S2S call (`session-tool-steps.ts`).

import type { Message, ToolMessages } from "@alexkroman1/aai";
import type { ExecuteTool } from "@alexkroman1/aai/host-internal";
import type { ToolSchema } from "@alexkroman1/aai/manifest";
import { isToolFailure, omitUndefined, safeJsonParse } from "@alexkroman1/aai/utils";
import type { Tool } from "ai";
import type { JSONSchema7 } from "json-schema";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { emptyRequiredFailure, emptyRequiredStrings } from "./_empty-required-args.ts";
import { makeCore } from "./_session-core-harness.ts";
import { flush, makeLogger } from "./_test-utils.ts";
import { createRelayExecuteTool } from "./host-relay.ts";
import { toVercelTools } from "./to-vercel-tools.ts";
import { createToolSpeechController, type ToolSpeechChannel } from "./tool-messages-runner.ts";

const LOOKUP: JSONSchema7 = {
  type: "object",
  properties: {
    name: { type: "string" },
    postal_code: { type: "string" },
    note: { type: "string" },
    count: { type: "number" },
  },
  required: ["name", "postal_code", "count"],
};

function schemaOf(parameters: JSONSchema7, messages?: ToolMessages): ToolSchema {
  return {
    type: "function",
    name: "find_user",
    description: "Find a user.",
    parameters,
    ...omitUndefined({ messages }),
  };
}

const ONE_BLANK = JSON.stringify({
  error: '"postal_code" is empty — ask the caller for it before calling find_user.',
});

function run(tool: Tool | undefined, args: Record<string, unknown>): Promise<unknown> {
  if (!tool?.execute) throw new Error("tool.execute missing");
  return tool.execute(args, { toolCallId: "tc-1", messages: [], context: undefined });
}

describe("emptyRequiredStrings", () => {
  test.each([
    ["an empty string", { name: "A", postal_code: "", count: 1 }, ["postal_code"]],
    ["whitespace only", { name: "A", postal_code: "  \t", count: 1 }, ["postal_code"]],
    ["a missing field", { name: "A", count: 1 }, ["postal_code"]],
    ["a non-string value", { name: "A", postal_code: 12_345, count: 1 }, ["postal_code"]],
    [
      "several, in `required` order",
      { postal_code: "", name: " ", count: 1 },
      ["name", "postal_code"],
    ],
    ["nothing blank", { name: "A", postal_code: "12345", count: 1 }, []],
  ])("%s", (_label, args, expected) => {
    expect(emptyRequiredStrings(args, LOOKUP)).toEqual(expected);
  });

  test("an OPTIONAL string and a required NUMBER are not checked", () => {
    expect(emptyRequiredStrings({ name: "A", postal_code: "1", note: "" }, LOOKUP)).toEqual([]);
  });

  test("a nullable string accepts null and refuses a blank; a union with a number is skipped", () => {
    const parameters: JSONSchema7 = {
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "string" }, { type: "null" }] },
        c: { type: ["string", "number"] },
        d: { type: "string", enum: ["", "x"] },
      },
      required: ["a", "b", "c", "d"],
    };
    expect(emptyRequiredStrings({ a: null, b: null, c: "", d: "" }, parameters)).toEqual([]);
    expect(emptyRequiredStrings({ a: "", b: " ", c: "", d: "" }, parameters)).toEqual(["a", "b"]);
  });

  test("the failure names every blank field", () => {
    expect(safeJsonParse(emptyRequiredFailure(["name", "postal_code"], "find_user"))).toEqual({
      error: '"name", "postal_code" are empty — ask the caller for them before calling find_user.',
    });
  });
});

describe("toVercelTools — a blank required string", () => {
  function setup(extra: { toolSpeech?: ReturnType<typeof createToolSpeechController> } = {}) {
    const executeTool = vi.fn<ExecuteTool>(async () => "found");
    const recorded: Message[] = [];
    const log = makeLogger();
    const tools = toVercelTools([schemaOf(LOOKUP)], {
      executeTool,
      sessionId: "s-1",
      messages: () => [],
      recordToolResult: (m) => recorded.push(m),
      log,
      ...extra,
    });
    return { executeTool, recorded, log, tool: tools.find_user };
  }

  test.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["missing", undefined],
  ])("%s: not executed; the failure is the model's copy AND the recorded result", async (_l, v) => {
    const { executeTool, recorded, log, tool } = setup();
    const args =
      v === undefined ? { name: "A", count: 1 } : { name: "A", postal_code: v, count: 1 };
    const result = await run(tool, args);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toBe(ONE_BLANK);
    expect(isToolFailure(safeJsonParse(String(result)))).toBe(true);
    // Paired: the call still has its result in the conversation view.
    expect(recorded).toEqual([
      { role: "tool", content: ONE_BLANK, toolName: "find_user", toolCallId: "tc-1" },
    ]);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("empty required argument; call not executed", {
      sid: "s-1",
      toolName: "find_user",
      fields: ["postal_code"],
    });
  });

  test("names every blank field", async () => {
    const { executeTool, tool } = setup();
    const result = await run(tool, { name: "", postal_code: " ", count: 1 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(safeJsonParse(String(result))).toEqual({
      error: '"name", "postal_code" are empty — ask the caller for them before calling find_user.',
    });
  });

  test("an optional string left empty runs normally", async () => {
    const { executeTool, recorded, log, tool } = setup();
    const result = await run(tool, { name: "A", postal_code: "1", count: 1, note: "" });
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result).toBe("found");
    expect(recorded[0]).toMatchObject({ content: "found" });
    expect(log.info).not.toHaveBeenCalled();
  });

  test("a required non-string field is not this check's to refuse", async () => {
    const { executeTool, tool } = setup();
    // `count` is required and absent — but it is a number, left to the tool.
    await run(tool, { name: "A", postal_code: "1" });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});

describe("toVercelTools — host relay", () => {
  test("a refused call is never relayed, so the client is never asked for a result", async () => {
    const send = vi.fn();
    const relay = createRelayExecuteTool({ send, timeoutMs: 1000 });
    const recorded: Message[] = [];
    const tools = toVercelTools([schemaOf(LOOKUP)], {
      executeTool: relay.executeTool,
      sessionId: "s-1",
      messages: () => [],
      recordToolResult: (m) => recorded.push(m),
    });
    const result = await run(tools.find_user, { name: "A", postal_code: "", count: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(result).toBe(ONE_BLANK);
    expect(recorded).toHaveLength(1);
    // Nothing left pending: disposing rejects nothing.
    relay.dispose();
  });
});

describe("toVercelTools — tool speech", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a refused call speaks nothing and leaves no ladder running", async () => {
    const sent: string[] = [];
    const recordedSpeech: string[] = [];
    const toolSpeech = createToolSpeechController({ log: makeLogger(), sid: "s", random: () => 0 });
    const channel: ToolSpeechChannel = {
      send: (text) => sent.push(text),
      boundary: () => undefined,
      record: (text) => recordedSpeech.push(text),
      callerSpeaking: () => false,
      awaitSpoken: async () => undefined,
    };
    toolSpeech.bind(channel);
    toolSpeech.beginTurn();
    const messages: ToolMessages = {
      start: [{ content: "Let me look." }],
      delayed: [{ afterMs: 3000, content: "Still looking." }],
      failed: [{ role: "assistant", content: "I could not find you." }],
    };
    const executeTool = vi.fn<ExecuteTool>(async () => "found");
    const tools = toVercelTools([schemaOf(LOOKUP, messages)], {
      executeTool,
      sessionId: "s",
      messages: () => [],
      toolSpeech,
    });
    const result = await run(tools.find_user, { name: "A", postal_code: "", count: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBe(ONE_BLANK);
    expect(sent).toEqual([]);
    expect(recordedSpeech).toEqual([]);
    // No verbatim latch — the model is still called, and can ask for the field.
    expect(toolSpeech.verbatim()).toBeUndefined();
    // The generic dead-air cover is not held off by a call that is not running.
    expect(toolSpeech.covering()).toBe(false);
  });
});

describe("S2S — session-tool-steps", () => {
  test("a refused call is not executed; provider, event and history carry the failure", async () => {
    const executeTool = vi.fn<ExecuteTool>(async () => "found");
    const logger = makeLogger();
    const { core, sink, transport } = makeCore({
      executeTool,
      logger,
      toolSchemas: [schemaOf(LOOKUP)],
    });
    await core.start();
    core.onReplyStarted("r1");
    const call = (toolCallId: string, postal_code: string) =>
      core.report({
        type: "tool.called",
        toolCallId,
        toolName: "find_user",
        args: { name: "A", postal_code, count: 1 },
      });
    call("c1", " ");
    expect(executeTool).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("empty required argument; call not executed", {
      sid: "s-test",
      toolName: "find_user",
      fields: ["postal_code"],
    });
    expect(sink.events).toContainEqual(
      expect.objectContaining({ type: "tool.completed", toolCallId: "c1", result: ONE_BLANK }),
    );
    // A complete call still runs — and reads the refusal as a paired result.
    call("c2", "12345");
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledTimes(1));
    expect(executeTool.mock.calls[0]?.[3]).toEqual([
      { role: "tool", content: ONE_BLANK, toolName: "find_user", toolCallId: "c1" },
    ]);
    await flush();
    core.report({ type: "reply.completed" });
    await vi.waitFor(() => expect(transport.sendToolResult).toHaveBeenCalledWith("c1", ONE_BLANK));
    expect(transport.sendToolResult).toHaveBeenCalledWith("c2", "found");
  });
});
