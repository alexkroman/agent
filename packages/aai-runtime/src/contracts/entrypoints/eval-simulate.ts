// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval-simulate`.
 *
 * A SIMULATED CALLER (a second model with a persona and a goal, driving a
 * session until it hangs up) and a MODEL-GRADED JUDGE (one ruling per
 * criterion, the verdict computed from them), plus `evalSimulation`, which
 * builds the pair for one `describeEval` case, live or scripted.
 *
 * Its own capability rather than part of `eval`: the harness a case runs in is
 * one promise, and the two extra models a simulation adds are another that
 * moves for different reasons — a new metric, a judge prompt, a persona field.
 * It used to be intersected into `EvalTestContext` and the suite options, so
 * every such change was an epoch of the harness itself.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval/simulate`. This file is not
 * shipped and nothing imports it — it exists so `pnpm check:api-contracts` can
 * extract a report for this capability alone, hash it, and hold it to a
 * committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
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
} from "../../eval-simulate-barrel.ts";
