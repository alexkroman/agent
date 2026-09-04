// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the text session mode.
 *
 * The model is a scripted fake, which is the right instrument here: a text
 * agent's whole job is assembling ONE `streamText` request out of an agent
 * definition, so what these assert is mostly what the model was sent — the
 * system prompt, the tool declarations, the tool choice — plus what came back
 * out of the tools it ran.
 */

import { type AgentDef, agent, sessionSlot, tool } from "@alexkroman1/aai";
import { type ToolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "./_fake-llm.ts";
import { silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import { createTextAgent } from "./text-agent.ts";

/** Drain a turn's text, which is also what forces the tool loop to run. */
async function drain(result: { textStream: AsyncIterable<string> }): Promise<string> {
  let out = "";
  for await (const delta of result.textStream) out += delta;
  return out;
}

/**
 * A text agent WITH its tools — the def a build produces, in one call.
 *
 * `agent()` takes no `tools`: a tool is a FILE, and the enumeration happens
 * where the bundle is assembled. A spec has no bundler in its path, so it
 * resolves the registry itself — `virtual:aai/agent` (or `deployedAgent` over an
 * `import.meta.glob`) in a real project, and a literal here, since these tools
 * exist to be driven rather than to live anywhere.
 */
function textAgent(def: Parameters<typeof agent>[0], tools: ToolRegistry = {}): AgentDef {
  return withTools(agent(def), tools);
}

describe("createTextAgent", () => {
  test("streams a reply, sending the agent's system prompt", async () => {
    const model = createFakeLanguageModel({ script: [{ type: "text", text: "hello there" }] });
    const chat = createTextAgent({
      agent: textAgent({ name: "Helper", text: true, systemPrompt: "Be brief." }),
      model,
      logger: silentLogger,
    });

    expect(await drain(chat.stream({ messages: [{ role: "user", content: "hi" }] }))).toBe(
      "hello there",
    );
    const [call] = model.calls;
    const prompt = call?.prompt as { role: string; content: unknown }[];
    expect(prompt[0]).toMatchObject({ role: "system", content: "Be brief." });
  });

  test("refuses an agent that did not opt into text mode", () => {
    expect(() =>
      createTextAgent({
        agent: agent({ name: "Voice" }),
        model: createFakeLanguageModel({ script: [] }),
      }),
    ).toThrow(/not a text agent/);
  });

  test("createRuntime refuses a text agent, naming what to use instead", () => {
    expect(() =>
      createRuntime({ agent: textAgent({ name: "Chat", text: true }), env: {} }),
    ).toThrow(/createTextAgent/);
  });

  test("runs a tool through the SDK executor, with ctx.env and slot state", async () => {
    const seen: { env: unknown; state: unknown; sessionId: string }[] = [];
    const wordSlot = sessionSlot("words", () => ({ words: [] as string[] }));
    const remember = tool({
      description: "Remember a word",
      inputSchema: z.object({ word: z.string() }),
      execute: ({ word }, ctx) =>
        wordSlot.update(ctx, (state) => {
          state.words.push(word);
          seen.push({ env: ctx.env.TOKEN, state: state.words.slice(), sessionId: ctx.sessionId });
          return { count: state.words.length };
        }),
    });
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "remember", input: '{"word":"one"}' }],
        [{ type: "tool-call", toolCallId: "c2", toolName: "remember", input: '{"word":"two"}' }],
        [{ type: "text", text: "done" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Notes",
          text: true,
        },
        { remember },
      ),
      env: { TOKEN: "t0" },
      model,
      sessionId: "sid-1",
      logger: silentLogger,
    });

    await drain(chat.stream({ messages: [{ role: "user", content: "remember two words" }] }));

    // One state object across the conversation, not one per call — the
    // property `getState`'s memo exists for.
    expect(seen).toEqual([
      { env: "t0", state: ["one"], sessionId: "sid-1" },
      { env: "t0", state: ["one", "two"], sessionId: "sid-1" },
    ]);
  });

  test("declares builtinTools to the model alongside the agent's own", async () => {
    const model = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Researcher",
          text: true,
          builtinTools: ["calculate"],
        },
        {
          ping: tool({ description: "Ping", execute: () => "pong" }),
        },
      ),
      model,
      logger: silentLogger,
    });

    await drain(chat.stream({ messages: [{ role: "user", content: "hi" }] }));

    const tools = model.calls[0]?.tools as { name: string }[];
    expect(tools.map((t) => t.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "calculate",
      "ping",
    ]);
    // Same surface the caller can render a tool console from.
    expect(Object.keys(chat.tools).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "calculate",
      "ping",
    ]);
  });

  test("an invalid tool call comes back as a tool RESULT, not a thrown turn", async () => {
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "add", input: '{"n":"not-a-number"}' }],
        [{ type: "text", text: "recovered" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Math",
          text: true,
        },
        {
          add: tool({
            description: "Add one",
            inputSchema: z.object({ n: z.number() }),
            execute: ({ n }) => n + 1,
          }),
        },
      ),
      model,
      logger: silentLogger,
    });

    // "not-a-number" is unparsable as a number, so coercion leaves it and the
    // schema rejects it — the point is the turn CONTINUES and the model is
    // told, which is what makes a recoverable tool failure recoverable.
    expect(await drain(chat.stream({ messages: [{ role: "user", content: "add" }] }))).toBe(
      "recovered",
    );
    const second = model.calls[1]?.prompt as { role: string; content: unknown }[];
    expect(JSON.stringify(second)).toContain("Invalid arguments");
  });

  test("coerces a stringified scalar toward the tool's schema", async () => {
    const got: number[] = [];
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "add", input: '{"n":"41"}' }],
        [{ type: "text", text: "42" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Math",
          text: true,
        },
        {
          add: tool({
            description: "Add one",
            inputSchema: z.object({ n: z.number() }),
            execute: ({ n }) => {
              got.push(n);
              return n + 1;
            },
          }),
        },
      ),
      model,
      logger: silentLogger,
    });

    await drain(chat.stream({ messages: [{ role: "user", content: "add" }] }));
    expect(got).toEqual([41]);
  });

  test("the step past maxSteps runs with tools off, so a capped turn answers", async () => {
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "noop", input: "{}" }],
        [{ type: "text", text: "here is what I found" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Capped",
          text: true,
          maxSteps: 1,
        },
        { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      ),
      model,
      logger: silentLogger,
    });

    expect(await drain(chat.stream({ messages: [{ role: "user", content: "go" }] }))).toBe(
      "here is what I found",
    );
    expect(model.calls[0]?.toolChoice).toMatchObject({ type: "auto" });
    expect(model.calls[1]?.toolChoice).toMatchObject({ type: "none" });
  });

  test("a caller's prepareStep keeps its messages and never regains tools at the cap", async () => {
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "noop", input: "{}" }],
        [{ type: "text", text: "wrapped up" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Capped",
          text: true,
          maxSteps: 1,
        },
        { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      ),
      model,
      logger: silentLogger,
    });

    await drain(
      chat.stream({
        messages: [{ role: "user", content: "go" }],
        prepareStep: ({ messages, stepNumber }) =>
          stepNumber === 1
            ? {
                messages: [...messages, { role: "user" as const, content: "WRAP UP NOW" }],
                toolChoice: "required" as const,
              }
            : {},
      }),
    );

    const second = JSON.stringify(model.calls[1]?.prompt);
    expect(second).toContain("WRAP UP NOW");
    // The caller asked for `required`; the reserved answering step overrides.
    expect(model.calls[1]?.toolChoice).toMatchObject({ type: "none" });
  });

  test("a caller stop condition can end the turn before the step cap", async () => {
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "noop", input: "{}" }],
        [{ type: "tool-call", toolCallId: "c2", toolName: "noop", input: "{}" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Budgeted",
          text: true,
          maxSteps: 10,
        },
        { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      ),
      model,
      logger: silentLogger,
    });

    await drain(
      chat.stream({
        messages: [{ role: "user", content: "go" }],
        stopWhen: [() => true],
      }),
    );
    expect(model.calls).toHaveLength(1);
  });

  test("tools see the turn's conversation as ctx.messages", async () => {
    let seen: unknown;
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "peek", input: "{}" }],
        [{ type: "text", text: "ok" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent(
        {
          name: "Peeker",
          text: true,
        },
        {
          peek: tool({
            description: "Read history",
            execute: (_args, ctx) => {
              seen = ctx.messages;
              return "ok";
            },
          }),
        },
      ),
      model,
      logger: silentLogger,
    });

    await drain(
      chat.stream({
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "second" }] },
        ],
      }),
    );

    expect(seen).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  test("two overlapping turns each see their OWN conversation", async () => {
    // `turnMessages` used to be one instance-scoped `let` that `stream()`
    // overwrote, with a comment claiming the opposite — so turn 1's in-flight
    // tool call read turn 2's conversation. The tool here blocks until both
    // turns have started, which is exactly the interleaving a chat surface
    // serving two tabs produces.
    const seen: string[] = [];
    const peek = tool({
      description: "Read history",
      execute: (_args, ctx) => {
        seen.push(ctx.messages.map((m) => m.content).join("|"));
        return "ok";
      },
    });
    const chat = createTextAgent({
      agent: textAgent({ name: "Peeker", text: true }, { peek }),
      model: createFakeLanguageModel({
        // One step per `doStream` call, and the two turns interleave: turn 1's
        // request, turn 2's request, then each turn's answering step.
        steps: [
          [{ type: "tool-call", toolCallId: "c1", toolName: "peek", input: "{}" }],
          [{ type: "tool-call", toolCallId: "c2", toolName: "peek", input: "{}" }],
          [{ type: "text", text: "ok" }],
          [{ type: "text", text: "ok" }],
        ],
      }),
      logger: silentLogger,
    });

    // Both turns are STARTED before either model stream yields its tool call —
    // which is the ordinary case, since that wait is LLM latency measured in
    // seconds. `stream()` assigned the shared `let` synchronously, so by the
    // time turn 1's tool was dispatched the variable already held turn 2's
    // conversation and both reads answered "beta".
    await Promise.all([
      drain(chat.stream({ messages: [{ role: "user", content: "alpha" }] })),
      drain(chat.stream({ messages: [{ role: "user", content: "beta" }] })),
    ]);

    expect(seen.toSorted((a, b) => a.localeCompare(b))).toEqual(["alpha", "beta"]);
  });

  test("the exposed `tools` belong to no turn", async () => {
    // `TextAgent.tools` is the declaration list a caller renders. It must carry
    // the right NAMES; it is not the set a turn runs on, so a call through it
    // reads an empty `ctx.messages` rather than some other turn's.
    const chat = createTextAgent({
      agent: textAgent(
        { name: "Peeker", text: true },
        { peek: tool({ description: "Read history", execute: () => "ok" }) },
      ),
      model: createFakeLanguageModel({ script: [] }),
      logger: silentLogger,
    });
    expect(Object.keys(chat.tools)).toEqual(["peek"]);
  });

  test("an abort signal ends the turn", async () => {
    const abort = new AbortController();
    const model = createFakeLanguageModel({
      script: [
        { type: "text", text: "start" },
        { type: "text", text: "never" },
      ],
      delayMs: 20,
    });
    const chat = createTextAgent({
      agent: textAgent({ name: "Stoppable", text: true }),
      model,
      logger: silentLogger,
    });
    const result = chat.stream({
      messages: [{ role: "user", content: "go" }],
      signal: abort.signal,
    });

    let out = "";
    for await (const delta of result.textStream) {
      out += delta;
      abort.abort();
    }
    expect(out).toBe("start");
  });

  test("a per-turn system prompt overrides the agent's", async () => {
    const model = createFakeLanguageModel({ script: [{ type: "text", text: "ok" }] });
    const chat = createTextAgent({
      agent: textAgent({ name: "Helper", text: true, systemPrompt: "Base." }),
      model,
      logger: silentLogger,
    });
    await drain(
      chat.stream({ messages: [{ role: "user", content: "hi" }], systemPrompt: "Per turn." }),
    );
    const prompt = model.calls[0]?.prompt as { role: string; content: unknown }[];
    expect(prompt[0]).toMatchObject({ role: "system", content: "Per turn." });
  });
});
