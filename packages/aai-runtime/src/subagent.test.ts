// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit tests for the host `ctx.delegate` implementation — that a delegated run
 * is a real tool loop (its tools go through `executeToolCall`, with validation
 * and a real `ToolContext`), that what comes back is the ANSWER plus a cost
 * report rather than a transcript, and the two refusals the contract promises:
 * no LLM, and a subagent trying to delegate again.
 */

import { subagent, tool } from "@alexkroman1/aai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createScriptedOneShotModel,
  registerFakeProviders,
  type ScriptedTurn,
} from "./_pipeline-test-fakes.ts";
import { createSubagentRunner, NESTED_DELEGATE_MESSAGE } from "./subagent.ts";
import type { ToolCallDefaults } from "./tool-executor.ts";

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

function setup(script: readonly ScriptedTurn[]) {
  const model = createScriptedOneShotModel(script);
  const fakes = registerFakeProviders({ llm: model });
  unregister = fakes.unregister;
  if (!fakes.llm) throw new Error("fake llm descriptor missing");
  return { model, descriptor: fakes.llm, env: fakes.env };
}

/** Silent, so a forced-final-answer log line does not print through the run. */
const noop = (): void => undefined;
const silent = { debug: noop, info: noop, warn: noop, error: noop };

/** The bag a tool call carries, as a parent tool's context would hand it over. */
function parentCall(overrides: Partial<ToolCallDefaults> = {}): ToolCallDefaults {
  return {
    env: { TENANT_KEY: "tenant-value" },
    sessionId: "session-1",
    logger: silent,
    ...overrides,
  };
}

describe("createSubagentRunner", () => {
  it("returns the subagent's final text with an empty cost report", async () => {
    const { descriptor, env } = setup([{ text: "Three sources agree: yes." }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Research and summarize." }),
      { task: "Is it raining?" },
      parentCall(),
    );

    expect(result).toEqual({ text: "Three sources agree: yes.", steps: 1, toolCalls: [] });
  });

  it("runs the subagent's tools and reports the calls, not their results", async () => {
    const { descriptor, env } = setup([
      { call: { name: "lookup", input: { term: "tide" } } },
      { text: "The tide is out." },
    ]);
    const seen: { term: string; env: string | undefined; messages: number }[] = [];
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: ({ term }, ctx) => {
        seen.push({ term, env: ctx.env.TENANT_KEY, messages: ctx.messages.length });
        return { definition: "a secret only the subagent read" };
      },
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Look things up.", tools: { lookup } }),
      { task: "What is the tide doing?" },
      parentCall(),
    );

    expect(result.text).toBe("The tide is out.");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([{ name: "lookup", input: { term: "tide" } }]);
    // The RESULT stayed in the subagent's window — that is the delegation.
    expect(JSON.stringify(result)).not.toContain("a secret only the subagent read");
    // The tool ran with the parent's env, and with no conversation.
    expect(seen).toEqual([{ term: "tide", env: "tenant-value", messages: 0 }]);
  });

  it("validates a subagent tool's arguments like any other tool call", async () => {
    const { descriptor, env } = setup([
      { call: { name: "lookup", input: { wrong: 1 } } },
      { text: "I could not look that up." },
    ]);
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: () => "never reached",
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Look things up.", tools: { lookup } }),
      { task: "anything" },
      parentCall(),
    );

    // The bad call came back to the subagent as a tool RESULT, so the loop
    // carried on and answered rather than rejecting.
    expect(result.text).toBe("I could not look that up.");
  });

  it("refuses a second level of delegation, naming the rule", async () => {
    const { descriptor, env } = setup([
      { call: { name: "deeper", input: {} } },
      { text: "Could not go deeper." },
    ]);
    let refusal = "";
    const deeper = tool({
      description: "Try to delegate again",
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        await ctx
          .delegate(subagent({ name: "nested", systemPrompt: "hi" }), { task: "again" })
          .catch((err: unknown) => {
            refusal = err instanceof Error ? err.message : String(err);
          });
        return "tried";
      },
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    await run(
      subagent({ name: "researcher", systemPrompt: "Delegate.", tools: { deeper } }),
      { task: "anything" },
      parentCall(),
    );

    expect(refusal).toBe(NESTED_DELEGATE_MESSAGE);
  });

  it("spends its last step with tools withheld, so a capped run still answers", async () => {
    const { model, descriptor, env } = setup([
      { call: { name: "lookup", input: { term: "a" } } },
      { text: "Answering with what I have." },
    ]);
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: () => "ok",
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({
        name: "researcher",
        systemPrompt: "Look things up.",
        tools: { lookup },
        maxSteps: 1,
      }),
      { task: "anything" },
      parentCall(),
    );

    expect(result.text).toBe("Answering with what I have.");
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.toolChoice).toEqual({ type: "none" });
  });

  it("sends the subagent's own instructions, with the call's context appended", async () => {
    const { model, descriptor, env } = setup([{ text: "done" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    await run(
      subagent({ name: "researcher", systemPrompt: "Be brief." }),
      { task: "Summarize.", context: "The caller is Ada." },
      parentCall(),
    );

    const prompt = model.calls[0]?.prompt as { role: string; content: unknown }[];
    expect(prompt[0]).toMatchObject({ role: "system" });
    expect(JSON.stringify(prompt[0]?.content)).toContain("Be brief.");
    expect(JSON.stringify(prompt[0]?.content)).toContain("The caller is Ada.");
  });

  it("gives a subagent the builtins it names, whatever the parent enabled", async () => {
    const { model, descriptor, env } = setup([{ text: "done" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    await run(
      subagent({
        name: "researcher",
        systemPrompt: "Search.",
        builtinTools: ["web_search", "calculate"],
      }),
      { task: "anything" },
      parentCall(),
    );

    const tools = model.calls[0]?.tools as { name: string }[];
    expect(tools.map((one) => one.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "calculate",
      "web_search",
    ]);
  });

  it("rejects naming the subagent when no LLM is configured or named", async () => {
    const run = createSubagentRunner({ env: {}, logger: silent });
    await expect(
      run(subagent({ name: "researcher", systemPrompt: "hi" }), { task: "x" }, parentCall()),
    ).rejects.toThrow(/subagent "researcher": no LLM configured/);
  });

  it("carries the parent's cancellation into the provider call", async () => {
    const { model, descriptor, env } = setup([{ text: "done" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const controller = new AbortController();

    await run(
      subagent({ name: "researcher", systemPrompt: "hi" }),
      { task: "x" },
      parentCall({ signal: controller.signal }),
    );

    // Asserted by ABORTING it rather than by identity: the AI SDK combines the
    // caller's signal with its own timeout, so the signal the provider sees is
    // legitimately a different object — what has to hold is that the parent's
    // barge-in still reaches it.
    const seen = model.calls[0]?.abortSignal as AbortSignal | undefined;
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});
