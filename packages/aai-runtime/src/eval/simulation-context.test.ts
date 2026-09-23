// Copyright 2026 the AAI authors. MIT license.
/**
 * Which model `simulate()` and `judge()` run on, per mode.
 *
 * The target is a fake with a scripted `say()`, because the question here is
 * only the MODEL decision — `simulate.test.ts` drives a real session.
 */

import { agent } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import type { EvalTurn } from "./session.ts";
import { evalSimulation } from "./simulation-context.ts";
import { installStubLlm } from "./stub-llm.ts";

function fakeTarget(reply: string) {
  const heard: string[] = [];
  return {
    heard,
    target: {
      said: () => ["Hello, desk here."],
      say: async (text: string): Promise<EvalTurn> => {
        heard.push(text);
        return { text: reply, events: [], toolCalls: [], completed: true, errors: [] };
      },
    },
  };
}

const caller = { persona: "a regular", goal: "say hi" };
const def = agent({ name: "Desk" });

describe("evalSimulation", () => {
  test("stub mode: the default scripted caller says one line and hangs up", async () => {
    const { heard, target } = fakeTarget("Hi there.");
    const ctx = evalSimulation({ agent: def, mode: "stub", target });
    const call = await ctx.simulate(caller);
    expect(heard).toHaveLength(1);
    expect(call.endedBy).toBe("caller");
    expect(call.endReason).toBe("the scripted caller finished");
  });

  test("stub mode: stubJudge decides the rulings, and the verdict says it was scripted", async () => {
    const { target } = fakeTarget("Hi.");
    const ctx = evalSimulation({ agent: def, mode: "stub", target, stubJudge: [false] });
    const verdict = await ctx.judge("Agent: hi", ["It greeted.", "It was brief."]);
    expect(verdict.scripted).toBe(true);
    // The first ruling was scripted false; the missing second one passes.
    expect(verdict.criteria.map((c) => c.pass)).toEqual([false, true]);
  });

  test("live mode: callerLlm and judgeLlm are the models used, not the agent's", async () => {
    const callerStub = installStubLlm(["Hello!", { tool: "end_call", args: { reason: "bye" } }]);
    const judgeStub = installStubLlm(
      JSON.stringify({ criteria: [{ index: 1, pass: true, reason: "ok" }], summary: "fine" }),
    );
    const { heard, target } = fakeTarget("Hi.");
    try {
      const ctx = evalSimulation({
        agent: def,
        mode: "live",
        target,
        callerLlm: callerStub.llm,
        judgeLlm: judgeStub.llm,
        providerEnv: { ...callerStub.env, ...judgeStub.env },
      });
      const call = await ctx.simulate(caller, { maxTurns: 5 });
      expect(heard).toEqual(["Hello!"]);
      expect(call.endReason).toBe("bye");
      const verdict = await ctx.judge(call, ["It answered."]);
      expect(verdict.pass).toBe(true);
      // A live verdict is never labelled scripted, whatever model produced it.
      expect(verdict.scripted).toBe(false);
    } finally {
      callerStub.release();
      judgeStub.release();
    }
  });
});
