// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/eval/simulate` — a simulated caller, and a
 * model-graded judge.
 *
 * {@link simulateCall} has a SECOND model play the caller — a persona and a
 * goal — driving the same `say()`/`send()` a scripted case does until it calls
 * `end_call` or `maxTurns` runs out. The result is ordinary `EvalTurn`s plus
 * the call's metrics, so every reader on `@alexkroman1/aai-runtime/eval` takes
 * it unchanged. {@link judgeCall} rules on each criterion over a call, a list
 * of turns or a transcript, and computes the verdict from those rulings rather
 * than asking for one. Deterministic readers stay the first instrument; a judge
 * is for the claims only visible as meaning, and it is a noisy one — run it
 * under `AAI_EVAL_REPEAT` and read the spread.
 *
 * In a `describeEval` / `describeTextEval` case, {@link evalSimulation} builds
 * the pair from the case's own `session` and `mode`, live or scripted the way
 * the rest of the suite is:
 *
 * ```ts
 * import type { AgentDef } from "@alexkroman1/aai";
 * import { evalSimulation } from "@alexkroman1/aai-runtime/eval/simulate";
 * import type { EvalTestContext } from "@alexkroman1/aai-runtime/eval/vitest";
 *
 * declare const agentDef: AgentDef;
 *
 * // The body of a `describeEval` case: `session` and `mode` come from its context.
 * export async function forecastCase({ session, mode }: EvalTestContext): Promise<boolean> {
 *   const { simulate, judge } = evalSimulation({ agent: agentDef, mode, target: session });
 *   const call = await simulate({ persona: "a commuter", goal: "the forecast" });
 *   return (await judge(call, ["It answered the question."])).pass;
 * }
 * ```
 *
 * Its own subpath and capability rather than names on `/eval` and fields on the
 * case context: the harness a case runs in and the second and third models a
 * simulation adds move for unrelated reasons, and one epoch for both would
 * version neither honestly. Runner-free, like `/eval`.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate.
 *
 * @module eval/simulate
 */

export {
  type CallVerdict,
  type CriterionVerdict,
  type JudgeCallOptions,
  type JudgeInput,
  judgeCall,
} from "./eval/judge.ts";
export {
  DEFAULT_MAX_TURNS,
  END_CALL_TOOL,
  type SimulateCallOptions,
  type SimulatedCall,
  type SimulatedCaller,
  type SimulatedTurn,
  type SimulationMetrics,
  type SimulationTarget,
  simulateCall,
} from "./eval/simulate.ts";
export {
  type EvalSimulationContext,
  type EvalSimulationOptions,
  evalSimulation,
} from "./eval/simulation-context.ts";
