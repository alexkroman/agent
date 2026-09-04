// Copyright 2026 the AAI authors. MIT license.
/**
 * The text-agent eval harness, driven against a SCRIPTED model.
 *
 * Same argument as `session.test.ts`: a live-key eval is what this module
 * exists to make possible and is the wrong instrument for testing the module
 * itself. What is pinned here is the harness's own contract — a `send()` that
 * returns when the reply to THAT message ends, one conversation across several
 * turns, the two refusals, and a turn nothing can be read off failing loudly
 * instead of passing vacuously.
 */

import { type AgentDef, agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { createFakeLanguageModel, type FakeLanguageModel } from "../_fake-llm.ts";
import { registerLlmKind } from "../providers/resolve.ts";
import { openEvalTextAgent } from "./text-agent.ts";

const SPEC_LLM_KIND = "eval-text-spec-llm";
const SPEC_LLM_ENV = "EVAL_TEXT_SPEC_LLM_KEY";

/**
 * An LLM descriptor whose model is a script, registered exactly like a real
 * provider — which is the path the keyless fallback takes, so the specs take it
 * too.
 *
 * `models` collects every instance the registry created, because two of the
 * claims here are about WHO resolved the descriptor: the turn model and
 * `ctx.generate`'s are separate instances of the same kind, and the growing
 * `prompt` a second turn is handed is only visible on the model's own record.
 */
function scriptedLlm(steps: Parameters<typeof createFakeLanguageModel>[0]) {
  const models: FakeLanguageModel[] = [];
  const release = registerLlmKind(SPEC_LLM_KIND, {
    envVar: SPEC_LLM_ENV,
    label: "Eval text spec",
    create: () => {
      const model = createFakeLanguageModel(steps);
      models.push(model);
      return model;
    },
  });
  return {
    llm: { kind: SPEC_LLM_KIND, options: {} },
    providerEnv: { [SPEC_LLM_ENV]: "spec-key" },
    models,
    release,
  };
}

const lookUp = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => `order ${id} shipped`,
});

/** A tool that reasons with a model — the shape that proves where `llm` landed. */
const grade = tool({
  description: "Grade the answer.",
  inputSchema: z.object({}),
  execute: async (_args, ctx) => `graded:${(await ctx.generate({ prompt: "grade it" })).text}`,
});

const desk = agent({ name: "Text Desk", text: true, systemPrompt: "Be brief." });

describe("openEvalTextAgent refusals", () => {
  test("refuses a voice agent, naming the harness that drives one", async () => {
    await expect(openEvalTextAgent({ agent: agent({ name: "Voice" }) })).rejects.toThrow(
      /does not declare `text: true`[\s\S]*openEvalSession/,
    );
  });

  test("refuses a text agent that also declares s2s", async () => {
    // Spread rather than `agent({ text: true, s2s })`, which `AgentParams`
    // already refuses at COMPILE time with a message of its own — this is the
    // other door: a raw `export default {…}`, or a definition loaded from a
    // config, reaches the harness having skipped that check.
    const def: AgentDef = { ...desk, s2s: { kind: "assemblyai", options: {} } };
    await expect(openEvalTextAgent({ agent: def })).rejects.toThrow(/s2s provider/);
  });

  test("names the credential it could not resolve rather than running on nothing", async () => {
    // `providerEnv: {}` defeats the host fallback, which is what a machine with
    // no key has anyway. A keyless run must fail LOUDLY at open time — a green
    // run of nothing is the outcome the whole tier is shaped against.
    await expect(openEvalTextAgent({ agent: desk, providerEnv: {} })).rejects.toThrow(
      /ASSEMBLYAI_API_KEY/,
    );
  });
});

describe("openEvalTextAgent", () => {
  test("send() answers the turn it provoked, and there is no greeting turn", async () => {
    const { llm, providerEnv, release } = scriptedLlm({
      steps: [[{ type: "text", text: "Sure — what is the order number?" }]],
    });
    const chat = await openEvalTextAgent({ agent: desk, llm, providerEnv });
    try {
      const turn = await chat.send("I want to check an order");
      expect(turn.text).toBe("Sure — what is the order number?");
      expect(turn.completed).toBe(true);
      expect(turn.toolCalls).toEqual([]);
      // The message that provoked the reply is the turn's first event, and the
      // terminator is its last — which is what a reader partitions on.
      expect(turn.events.at(0)?.type).toBe("user-transcript.committed");
      expect(turn.events.at(-1)?.type).toBe("reply.completed");
      // ONE reply, where the voice harness would already have two: a text agent
      // has no greeting turn, so a case ported across is off by one until it
      // stops accounting for one.
      expect(chat.said()).toEqual(["Sure — what is the order number?"]);
      expect(chat.id).toMatch(/^eval-text-/);
    } finally {
      await chat.close();
      release();
    }
  });

  test("records a tool call with its arguments and its result", async () => {
    const { llm, providerEnv, release } = scriptedLlm({
      steps: [
        [{ type: "tool-call", toolCallId: "c1", toolName: "look_up", input: '{"id":"W1234"}' }],
        [{ type: "text", text: "It shipped yesterday." }],
      ],
    });
    const chat = await openEvalTextAgent({
      agent: withTools(desk, { look_up: lookUp }),
      llm,
      providerEnv,
    });
    try {
      const turn = await chat.send("where is order W1234");
      expect(turn.toolCalls).toEqual([
        {
          toolCallId: "c1",
          name: "look_up",
          args: { id: "W1234" },
          result: expect.stringContaining("W1234 shipped"),
        },
      ]);
      expect(turn.text).toContain("shipped yesterday");
      expect(chat.toolCalls()).toHaveLength(1);
    } finally {
      await chat.close();
      release();
    }
  });

  test("sendAll drives one CONVERSATION, each turn built on the last", async () => {
    const { llm, providerEnv, models, release } = scriptedLlm({
      steps: [[{ type: "text", text: "Which order?" }], [{ type: "text", text: "W1234, got it." }]],
    });
    const chat = await openEvalTextAgent({ agent: desk, llm, providerEnv });
    try {
      const turns = await chat.sendAll(["I want to check an order", "W1234"]);
      expect(turns.map((t) => t.text)).toEqual(["Which order?", "W1234, got it."]);
      // No turn holds the other's events: the second line is sent only after
      // the first reply ended, which is what makes a recorded order the
      // agent's rather than the harness's.
      expect(turns[0]?.events).not.toEqual(turns[1]?.events);
      expect(chat.said()).toEqual(["Which order?", "W1234, got it."]);
      // The harness carries the conversation, which is the whole difference
      // from `runTextAgent`: the second model call is handed the first turn's
      // exchange as well as the new line.
      const secondPrompt = JSON.stringify(models[0]?.calls.at(1)?.prompt);
      expect(secondPrompt).toContain("I want to check an order");
      expect(secondPrompt).toContain("Which order?");
      expect(secondPrompt).toContain("W1234");
    } finally {
      await chat.close();
      release();
    }
  });

  test("sendAll over no lines drives nothing and answers no turns", async () => {
    const { llm, providerEnv, release } = scriptedLlm({ steps: [] });
    const chat = await openEvalTextAgent({ agent: desk, llm, providerEnv });
    try {
      expect(await chat.sendAll([])).toEqual([]);
      expect(chat.events()).toEqual([]);
    } finally {
      await chat.close();
      release();
    }
  });

  test("the llm override reaches ctx.generate, not just the turn's model", async () => {
    // The claim the keyless fallback rests on: the descriptor rides on the
    // DEFINITION, so a tool that reasons with a model resolves the same
    // scripted kind. Were it passed as `createTextAgent({ model })`, this tool
    // would resolve the agent's own default and fail on the absent
    // ASSEMBLYAI_API_KEY — the hole `stubGenerate` exists to close.
    const { llm, providerEnv, models, release } = scriptedLlm({
      steps: [
        [{ type: "tool-call", toolCallId: "g1", toolName: "grade", input: "{}" }],
        [{ type: "text", text: "Graded." }],
      ],
    });
    const chat = await openEvalTextAgent({
      agent: withTools(desk, { grade }),
      llm,
      // No AssemblyAI key anywhere: the only resolvable credential is the
      // override's own.
      providerEnv,
    });
    try {
      const turn = await chat.send("grade my answer");
      expect(turn.toolCalls[0]?.result).not.toContain("ASSEMBLYAI_API_KEY");
      expect(turn.toolCalls[0]?.result).toContain("graded:");
      // A second instance of the same kind: `ctx.generate` resolved the
      // descriptor itself, which is what "it reached generate" means.
      expect(models.length).toBeGreaterThan(1);
    } finally {
      await chat.close();
      release();
    }
  });
});

describe("a turn nothing can be read off", () => {
  test("a model-stream error FAILS the turn instead of reading as silence", async () => {
    const { llm, providerEnv, release } = scriptedLlm({
      steps: [[{ type: "error", error: new Error("401 Unauthorized") }]],
    });
    const chat = await openEvalTextAgent({ agent: desk, llm, providerEnv });
    try {
      // One rejection, read twice: the same promise, so nothing is driven a
      // second time.
      const failed = chat.send("what painkiller should I take?");
      await expect(failed).rejects.toThrow(/did not come from the agent[\s\S]*401 Unauthorized/);
      // The text-mode consequence, which differs from the voice one: no
      // transcript is committed at all, so `not.toMatch` would have held.
      await expect(failed).rejects.toThrow(/commits NO transcript/);
      // Still readable: a case that MEANS to observe a broken turn catches the
      // throw and reads the stream itself.
      expect(chat.events().some((e) => e.type === "error.reported")).toBe(true);
      expect(chat.said()).toEqual([]);
    } finally {
      await chat.close();
      release();
    }
  });

  test("a turn that outruns its deadline is cancelled and reported", async () => {
    const { llm, providerEnv, release } = scriptedLlm({
      // Real elapsed time in the model, against a deadline two orders of
      // magnitude smaller — the only way to observe the deadline is to make
      // the provider slower than it.
      steps: [[{ type: "text", text: "eventually" }]],
      delayMs: 500,
    });
    const chat = await openEvalTextAgent({
      agent: desk,
      llm,
      providerEnv,
      turnTimeoutMs: 5,
    });
    try {
      await expect(chat.send("hello?")).rejects.toThrow(/timed out after 5ms/);
    } finally {
      await chat.close();
      release();
    }
  });
});
