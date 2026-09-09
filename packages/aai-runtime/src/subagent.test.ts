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
import { createUsageMeter, type UsageSnapshot } from "./usage-meter.ts";

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

    expect(result).toEqual({
      text: "Three sources agree: yes.",
      steps: 1,
      toolCalls: [],
      // No guardrail: accepted first time, by definition, with nothing sent back.
      revisions: 0,
      accepted: true,
    });
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

  describe("expectedOutput", () => {
    it("appends it to the instructions as its own section", async () => {
      const { model, descriptor, env } = setup([{ text: "done" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      await run(
        subagent({
          name: "researcher",
          systemPrompt: "Research the task.",
          expectedOutput: "One paragraph, naming your sources.",
        }),
        { task: "x" },
        parentCall(),
      );

      expect(instructionsOf(model.calls[0])).toBe(
        "Research the task.\n\n## EXPECTED OUTPUT\nOne paragraph, naming your sources.",
      );
    });

    it("puts the per-call context AFTER it, so a call can refine the shape", async () => {
      const { model, descriptor, env } = setup([{ text: "done" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      await run(
        subagent({
          name: "researcher",
          systemPrompt: "Research the task.",
          expectedOutput: "One paragraph.",
        }),
        { task: "x", context: "One sentence is enough this time." },
        parentCall(),
      );

      expect(instructionsOf(model.calls[0])).toBe(
        "Research the task.\n\n## EXPECTED OUTPUT\nOne paragraph.\n\nOne sentence is enough this time.",
      );
    });

    it("leaves the instructions alone when the subagent declares none", async () => {
      const { model, descriptor, env } = setup([{ text: "done" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      await run(
        subagent({ name: "researcher", systemPrompt: "Research the task." }),
        { task: "x" },
        parentCall(),
      );

      expect(instructionsOf(model.calls[0])).toBe("Research the task.");
    });
  });

  describe("schema", () => {
    const Verdict = z.object({
      verdict: z.enum(["confirmed", "contradicted", "unclear"]),
      detail: z.string(),
    });

    it("parses the answer and hands the caller the typed object", async () => {
      const { descriptor, env } = setup([
        { text: '{"verdict":"confirmed","detail":"Two sources agree."}' },
      ]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({ name: "checker", systemPrompt: "Check it.", schema: Verdict }),
        { task: "x" },
        parentCall(),
      );

      // `text` is still the raw answer beside it, so a caller can quote what
      // came back as well as branch on it.
      expect(result).toMatchObject({
        object: { verdict: "confirmed", detail: "Two sources agree." },
        revisions: 0,
        accepted: true,
      });
    });

    it("unwraps a fence, which models add however firmly they are told not to", async () => {
      const { descriptor, env } = setup([
        { text: '```json\n{"verdict":"unclear","detail":"Nothing found."}\n```' },
      ]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({ name: "checker", systemPrompt: "Check it.", schema: Verdict }),
        { task: "x" },
        parentCall(),
      );

      expect(result).toMatchObject({ object: { verdict: "unclear" }, revisions: 0 });
    });

    it("sends a mis-shaped answer BACK, and keeps what the attempt already paid for", async () => {
      const { model, descriptor, env } = setup([
        { text: '{"verdict":"probably","detail":"Hmm."}' },
        { text: '{"verdict":"unclear","detail":"Hmm."}' },
      ]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({ name: "checker", systemPrompt: "Check it.", schema: Verdict }),
        { task: "Is it raining?" },
        parentCall(),
      );

      expect(result).toMatchObject({
        object: { verdict: "unclear" },
        revisions: 1,
        accepted: true,
      });
      // The retry CONTINUES the run, exactly as a guardrail rejection does: the
      // second request carries the task, the rejected answer, and the issues.
      const second = promptOf(model.calls[1]);
      expect(second.filter((message) => message.role === "user")).toHaveLength(2);
      expect(JSON.stringify(second)).toContain("did not match the required shape");
      expect(JSON.stringify(second)).toContain("Is it raining?");
    });

    it("gives up after the retry budget and says the shape is why", async () => {
      const { descriptor, env } = setup([{ text: "not json at all" }, { text: "still not json" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          schema: Verdict,
          maxRetries: 1,
        }),
        { task: "x" },
        parentCall(),
      );

      // Unaccepted rather than thrown — the caller is a tool on a live call and
      // needs something to say, which is the same trade `accepted: false` makes
      // for a guardrail.
      expect(result.accepted).toBe(false);
      expect(result.complaint).toContain("JSON");
      expect(result).not.toHaveProperty("object");
    });

    it("is checked BEFORE the guardrail, which judges a well-formed answer", async () => {
      const seen: string[] = [];
      const { descriptor, env } = setup([
        { text: "not json" },
        { text: '{"verdict":"confirmed","detail":"ok"}' },
      ]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          schema: Verdict,
          guardrail: ({ text }) => {
            seen.push(text);
            return true;
          },
        }),
        { task: "x" },
        parentCall(),
      );

      // The malformed attempt never reached the guardrail: judging a reply that
      // is not the right shape is asking the wrong question.
      expect(seen).toEqual(['{"verdict":"confirmed","detail":"ok"}']);
    });
  });

  describe("guardrail", () => {
    it("accepts the first answer when the guardrail passes it", async () => {
      const { model, descriptor, env } = setup([{ text: "Confirmed: yes." }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({ name: "checker", systemPrompt: "Check it.", guardrail: () => true }),
        { task: "x" },
        parentCall(),
      );

      expect(result).toMatchObject({ text: "Confirmed: yes.", revisions: 0, accepted: true });
      expect(result.complaint).toBeUndefined();
      expect(model.calls).toHaveLength(1);
    });

    it("sends a rejected answer back with the complaint, and accepts the revision", async () => {
      const { model, descriptor, env } = setup([{ text: "Yes." }, { text: "Confirmed: yes." }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          guardrail: ({ text }) =>
            text.startsWith("Confirmed:") || "Start with 'Confirmed:' or 'Unclear:'.",
        }),
        { task: "Is it raining?" },
        parentCall(),
      );

      expect(result).toMatchObject({ text: "Confirmed: yes.", revisions: 1, accepted: true });
      expect(model.calls).toHaveLength(2);
      // The retry CONTINUES the run: the second request carries the original
      // task, the rejected answer, and the complaint — which is the whole reason
      // this is in the runtime rather than a loop an author writes.
      const second = promptOf(model.calls[1]);
      expect(second.filter((message) => message.role === "user")).toHaveLength(2);
      expect(JSON.stringify(second)).toContain("Start with 'Confirmed:' or 'Unclear:'.");
      expect(JSON.stringify(second)).toContain("Is it raining?");
    });

    it("returns the last rejected answer UNACCEPTED once the budget is spent", async () => {
      const { model, descriptor, env } = setup([{ text: "no" }, { text: "still no" }]);
      const info: string[] = [];
      const run = createSubagentRunner({
        llm: descriptor,
        env,
        logger: { ...silent, info: (message: string) => info.push(message) },
      });

      const result = await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          guardrail: () => "Not good enough",
        }),
        { task: "x" },
        parentCall(),
      );

      // One retry is the default budget, so two attempts and then the answer
      // comes back rather than throwing — a live call still needs something to say.
      expect(model.calls).toHaveLength(2);
      expect(result).toMatchObject({
        text: "still no",
        revisions: 1,
        accepted: false,
        complaint: "Not good enough",
      });
      expect(info.join("\n")).toContain('subagent "checker": guardrail still rejecting');
    });

    it("honours maxRetries, and 0 means the guardrail reports without retrying", async () => {
      const { model, descriptor, env } = setup([{ text: "a" }, { text: "b" }, { text: "c" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
      const check = subagent({
        name: "checker",
        systemPrompt: "Check it.",
        guardrail: () => "nope",
      });

      const none = await run({ ...check, maxRetries: 0 }, { task: "x" }, parentCall());
      expect(model.calls).toHaveLength(1);
      expect(none).toMatchObject({ revisions: 0, accepted: false, complaint: "nope" });

      const twice = await run({ ...check, maxRetries: 2 }, { task: "x" }, parentCall());
      expect(model.calls).toHaveLength(4);
      expect(twice).toMatchObject({ revisions: 2, accepted: false });
    });

    it("awaits an async guardrail", async () => {
      const { descriptor, env } = setup([{ text: "first" }, { text: "second" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

      const result = await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          guardrail: async ({ text }) => (text === "second" ? true : "try again"),
        }),
        { task: "x" },
        parentCall(),
      );

      expect(result).toMatchObject({ text: "second", revisions: 1, accepted: true });
    });

    it("judges the ATTEMPT, so a guardrail sees that run's own cost report", async () => {
      const { descriptor, env } = setup([{ text: "answered without looking" }]);
      const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
      const seen: unknown[] = [];

      await run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          maxRetries: 0,
          guardrail: (answer) => {
            seen.push(answer);
            return "no lookups";
          },
        }),
        { task: "x" },
        parentCall(),
      );

      // `revisions`/`accepted` are absent: a guardrail judging its own past
      // verdicts is a loop, not a check.
      expect(seen).toEqual([{ text: "answered without looking", steps: 1, toolCalls: [] }]);
    });
  });
});

/**
 * What a delegated run costs the SESSION that delegated.
 *
 * The gap these close is the one that stopped two templates adopting
 * `usageLimits` at all: a subagent run is a full nested tool loop — the most
 * expensive thing a delegating agent does — and none of it reached the meter,
 * so `usage.updated` under-reported and a budget bounded only the conversation.
 * They drive the real runner over a fake that really reports tokens, because a
 * spec that recorded into the meter itself would pass against either wiring.
 */
describe("createSubagentRunner — the delegating session's budget", () => {
  /** The scripted fake spends two tokens per `doGenerate`, i.e. per STEP. */
  function metered(limits?: { totalTokens: number }) {
    const updates: UsageSnapshot[] = [];
    const usage = createUsageMeter({ limits, onUpdate: (snapshot) => updates.push(snapshot) });
    return { usage, updates };
  }

  it("reports EVERY step of the run, not one lump per delegation", async () => {
    // Two steps: a tool call, then the answer. A per-attempt report would say
    // one, and a fan-out's cost would then be understated by its own depth.
    const { descriptor, env } = setup([
      { call: { name: "lookup", input: { term: "tide" } } },
      { text: "The tide is out." },
    ]);
    const lookup = tool({
      description: "Look a term up",
      inputSchema: z.object({ term: z.string() }),
      execute: () => "out",
    });
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { usage, updates } = metered();

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Research.", tools: { lookup } }),
      { task: "Is the tide in?" },
      parentCall({ usage }),
    );

    expect(result.steps).toBe(2);
    expect(usage.snapshot()).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4, steps: 2 });
    // Announced per step, which is what makes `usage.updated` usable as a
    // progress signal on a delegation that takes a while.
    expect(updates).toHaveLength(2);
  });

  it("refuses a delegation once the budget is spent, without dialling the model", async () => {
    const { model, descriptor, env } = setup([{ text: "never asked" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { usage } = metered({ totalTokens: 100 });
    usage.record({ inputTokens: 90, outputTokens: 30 });

    await expect(
      run(
        subagent({ name: "researcher", systemPrompt: "Research." }),
        { task: "Is the tide in?" },
        parentCall({ usage }),
      ),
    ).rejects.toThrow(/usageLimits\.totalTokens/);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses a REVISION too — a guardrail retry is another full run", async () => {
    // The cap is reached by the first attempt. A check placed above the retry
    // loop would let the guardrail spend the whole revision budget past it.
    const { model, descriptor, env } = setup([{ text: "first" }, { text: "second" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });
    const { usage } = metered({ totalTokens: 2 });

    await expect(
      run(
        subagent({
          name: "checker",
          systemPrompt: "Check it.",
          maxRetries: 3,
          guardrail: () => "try again",
        }),
        { task: "x" },
        parentCall({ usage }),
      ),
    ).rejects.toThrow(/usageLimits\.totalTokens/);
    expect(model.calls).toHaveLength(1);
  });

  it("a sessionless parent (a workflow step) is uncounted, never refused", async () => {
    // `stepDelegate` hands over a bag with no meter — a durable run does not
    // belong to a session's budget, and absent must not read as exhausted.
    const { descriptor, env } = setup([{ text: "done" }]);
    const run = createSubagentRunner({ llm: descriptor, env, logger: silent });

    const result = await run(
      subagent({ name: "researcher", systemPrompt: "Research." }),
      { task: "x" },
      { env: {}, logger: silent },
    );

    expect(result.text).toBe("done");
  });
});

/** The messages a scripted `doGenerate` was handed. */
function promptOf(call: Record<string, unknown> | undefined): { role: string; content: unknown }[] {
  return (call?.prompt ?? []) as { role: string; content: unknown }[];
}

/**
 * The system prompt a scripted `doGenerate` was handed.
 *
 * `ToolLoopAgent`'s `instructions` reach the provider as the prompt's leading
 * `system` message, which is the only place a spec can read them back — there
 * is no seam between the agent and the model that carries them separately.
 */
function instructionsOf(call: Record<string, unknown> | undefined): string | undefined {
  const system = promptOf(call).find((message) => message.role === "system");
  return system?.content as string | undefined;
}
