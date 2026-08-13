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

import { agent, tool } from "@alexkroman1/aai";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel } from "./_fake-llm.ts";
import { createRuntime } from "./runtime.ts";
import { createTextAgent } from "./text-agent.ts";

/** Drain a turn's text, which is also what forces the tool loop to run. */
async function drain(result: { textStream: AsyncIterable<string> }): Promise<string> {
  let out = "";
  for await (const delta of result.textStream) out += delta;
  return out;
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function textAgent(def: Parameters<typeof agent>[0]) {
  return agent(def);
}

describe("createTextAgent", () => {
  test("streams a reply, sending the agent's system prompt", async () => {
    const model = createFakeLanguageModel({ script: [{ type: "text", text: "hello there" }] });
    const chat = createTextAgent({
      agent: textAgent({ name: "Helper", text: true, system: "Be brief.", tools: {} }),
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
        agent: agent({ name: "Voice", tools: {} }),
        model: createFakeLanguageModel({ script: [] }),
      }),
    ).toThrow(/not a text agent/);
  });

  test("createRuntime refuses a text agent, naming what to use instead", () => {
    expect(() =>
      createRuntime({ agent: textAgent({ name: "Chat", text: true, tools: {} }), env: {} }),
    ).toThrow(/createTextAgent/);
  });

  test("runs a tool through the SDK executor, with ctx.env and ctx.state", async () => {
    const seen: { env: unknown; state: unknown; sessionId: string }[] = [];
    const remember = tool({
      description: "Remember a word",
      inputSchema: z.object({ word: z.string() }),
      execute: ({ word }, ctx) => {
        const state = ctx.state as { words: string[] };
        state.words.push(word);
        seen.push({ env: ctx.env.TOKEN, state: state.words.slice(), sessionId: ctx.sessionId });
        return { count: state.words.length };
      },
    });
    const model = createFakeLanguageModel({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "remember", input: '{"word":"one"}' }],
        [{ type: "tool-call", toolCallId: "c2", toolName: "remember", input: '{"word":"two"}' }],
        [{ type: "text", text: "done" }],
      ],
    });
    const chat = createTextAgent({
      agent: textAgent({
        name: "Notes",
        text: true,
        tools: { remember },
        state: () => ({ words: [] as string[] }),
      }),
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
      agent: textAgent({
        name: "Researcher",
        text: true,
        builtinTools: ["calculate"],
        tools: {
          ping: tool({ description: "Ping", execute: () => "pong" }),
        },
      }),
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
      agent: textAgent({
        name: "Math",
        text: true,
        tools: {
          add: tool({
            description: "Add one",
            inputSchema: z.object({ n: z.number() }),
            execute: ({ n }) => n + 1,
          }),
        },
      }),
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
      agent: textAgent({
        name: "Math",
        text: true,
        tools: {
          add: tool({
            description: "Add one",
            inputSchema: z.object({ n: z.number() }),
            execute: ({ n }) => {
              got.push(n);
              return n + 1;
            },
          }),
        },
      }),
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
      agent: textAgent({
        name: "Capped",
        text: true,
        maxSteps: 1,
        tools: { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      }),
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
      agent: textAgent({
        name: "Capped",
        text: true,
        maxSteps: 1,
        tools: { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      }),
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
      agent: textAgent({
        name: "Budgeted",
        text: true,
        maxSteps: 10,
        tools: { noop: tool({ description: "Nothing", execute: () => "ok" }) },
      }),
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
      agent: textAgent({
        name: "Peeker",
        text: true,
        tools: {
          peek: tool({
            description: "Read history",
            execute: (_args, ctx) => {
              seen = ctx.messages;
              return "ok";
            },
          }),
        },
      }),
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
      agent: textAgent({ name: "Stoppable", text: true, tools: {} }),
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
      agent: textAgent({ name: "Helper", text: true, system: "Base." }),
      model,
      logger: silentLogger,
    });
    await drain(chat.stream({ messages: [{ role: "user", content: "hi" }], system: "Per turn." }));
    const prompt = model.calls[0]?.prompt as { role: string; content: unknown }[];
    expect(prompt[0]).toMatchObject({ role: "system", content: "Per turn." });
  });
});
