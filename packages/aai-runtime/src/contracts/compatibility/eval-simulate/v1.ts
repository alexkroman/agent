// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring template: `aai-runtime:eval-simulate` epoch 1.
 *
 * A simulated caller and a model-graded judge over an eval session, written the
 * way a case authored them at epoch 1. It must keep compiling for as long as
 * that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * `SimulatedCall.endedBy` gained a third member, `"agent"`: the agent can hang
 * up now (`endSession(ctx)` takes effect in an eval session), and the loop
 * stops on that turn rather than asking the caller model to talk to a dead
 * line. A RETURNED union growing is what the probe calls incompatible, and for
 * one shape of reader it is: an exhaustive `switch` that assigns the leftover
 * to `never`. Every reader epoch 1's own documentation showed —
 * `call.endedBy !== "caller"`, `expect(call.endedBy).toBe("caller")` — still
 * compiles and still means what it meant, which is what this file holds the
 * surface to.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 1 has to be dropped with a reason.
 *
 * @module
 */

import { agent } from "@alexkroman1/aai";
import { llm } from "@alexkroman1/aai/llm";
import {
  type CallVerdict,
  type CriterionVerdict,
  DEFAULT_MAX_TURNS,
  END_CALL_TOOL,
  type EvalSimulationContext,
  type EvalSimulationOptions,
  evalSimulation,
  type JudgeCallOptions,
  type JudgeInput,
  judgeCall,
  type SimulateCallOptions,
  type SimulatedCall,
  type SimulatedCaller,
  type SimulatedTurn,
  type SimulationMetrics,
  type SimulationTarget,
  simulateCall,
} from "../../../eval-simulate-barrel.ts";

/** EDIT THIS: the agent under evaluation. */
const desk = agent({ name: "Order Desk", systemPrompt: "Look orders up before answering." });

/** EDIT THIS: who is calling, and what they came for. */
const caller: SimulatedCaller = {
  persona: "a polite but hurried customer",
  goal: "find out whether order W1234 has shipped",
  opening: "Hi, I'm checking on an order.",
};

/** The pair a case builds from its own session and mode. */
export function pairFor(target: SimulationTarget, mode: "live" | "stub"): EvalSimulationContext {
  const settings: EvalSimulationOptions = {
    agent: desk,
    mode,
    target,
    stubCaller: ["It's W1234.", { tool: END_CALL_TOOL, args: { reason: "got my answer" } }],
    stubJudge: [true],
  };
  return evalSimulation(settings);
}

/** Simulate the call, then grade it — the case body epoch 1's docs showed. */
export async function gradeCall(target: SimulationTarget, mode: "live" | "stub"): Promise<string> {
  const { simulate, judge } = pairFor(target, mode);
  const call: SimulatedCall = await simulate(caller, { maxTurns: DEFAULT_MAX_TURNS });
  if (call.endedBy !== "caller") return `the caller never finished: ${call.transcript()}`;
  const input: JudgeInput = call;
  const verdict: CallVerdict = await judge(input, ["It looked the order up before answering."]);
  const failed: readonly CriterionVerdict[] = verdict.criteria.filter((c) => !c.pass);
  return failed.map((c) => `${c.criterion}: ${c.reason}`).join("\n");
}

/** The lower-level doors, driven directly with an explicit model. */
export async function simulateByHand(target: SimulationTarget): Promise<SimulationMetrics> {
  const model = llm({ provider: "anthropic", model: "claude-haiku-4-5" });
  const options: SimulateCallOptions = { caller, llm: model, maxTurns: 6 };
  const call = await simulateCall(target, options);
  const first: SimulatedTurn | undefined = call.turns[0];
  const judgeOptions: JudgeCallOptions = {
    criteria: ["It answered the caller's question."],
    llm: model,
    context: first === undefined ? "No turn was taken." : `It opened with: ${first.turn.text}`,
  };
  const verdict = await judgeCall(call, judgeOptions);
  if (!verdict.pass) throw new Error(verdict.summary);
  return call.metrics;
}
