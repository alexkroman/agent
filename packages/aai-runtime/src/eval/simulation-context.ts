// Copyright 2026 the AAI authors. MIT license.
/**
 * The `simulate` and `judge` a `describeEval`/`describeTextEval` case is
 * handed, with the MODEL decision made the way the rest of the suite makes it.
 *
 * Live, the caller and the judge run on the suite's `callerLlm`/`judgeLlm`,
 * falling back to the model the agent itself is evaluated on — one key, one
 * bill, and nothing new to configure for a first simulation. In a keyless run
 * both are SCRIPTED, like the agent's own model: `stubCaller` is the caller's
 * lines, `stubJudge` the rulings, and a stub verdict says it is one
 * (`CallVerdict.scripted`). A keyless simulation checks that the loop, the
 * hang-up and the metrics are wired; it grades nothing.
 *
 * Shared by both doors so the two cannot come to disagree about which model a
 * simulated caller runs on.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import { ASSEMBLYAI_LLM_DEFAULT_MODEL, type LlmProvider, llm } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import type { EvalMode } from "./_announce.ts";
import { type CallVerdict, type JudgeInput, judgeCall, runJudge } from "./judge.ts";
import {
  END_CALL_TOOL,
  type SimulatedCall,
  type SimulatedCaller,
  type SimulationTarget,
  simulateCall,
} from "./simulate.ts";
import { installStubLlm, type StubScript } from "./stub-llm.ts";

/** What a case gets for running a simulated caller and grading the result. */
export type EvalSimulationContext = {
  /**
   * Run a simulated caller against this case's session (or text agent) until
   * it hangs up or `maxTurns` runs out. See `simulateCall`.
   */
  simulate(
    caller: SimulatedCaller,
    options?: { readonly maxTurns?: number },
  ): Promise<SimulatedCall>;
  /**
   * Have a model rule on `criteria` over a simulated call, a list of turns, or
   * a transcript. See `judgeCall`.
   */
  judge(
    input: JudgeInput,
    criteria: readonly string[],
    options?: { readonly context?: string },
  ): Promise<CallVerdict>;
};

/** The suite-level model choices for the caller and the judge. */
export type EvalSimulationSuiteOptions = {
  /** The model that PLAYS the caller when live. Defaults to the agent's model. */
  readonly callerLlm?: LlmProvider;
  /** The model that JUDGES when live. Defaults to the agent's model. */
  readonly judgeLlm?: LlmProvider;
};

/** The per-case scripts a keyless run uses in place of the two models. */
export type EvalSimulationCaseOptions = {
  /**
   * The simulated caller's lines in a keyless run, one per caller turn. End it
   * with `{ tool: "end_call", args: { reason } }`; absent, the stub caller says
   * one line and hangs up.
   */
  readonly stubCaller?: StubScript;
  /**
   * The rulings a keyless judge hands back, one per criterion in order —
   * missing entries pass. Absent, every criterion passes, marked scripted.
   */
  readonly stubJudge?: readonly boolean[];
};

const DEFAULT_STUB_CALLER: StubScript = [
  "Hi, I'm calling for some help, please.",
  { tool: END_CALL_TOOL, args: { reason: "the scripted caller finished" } },
];

type Inputs = {
  readonly agent: AgentDef;
  readonly mode: EvalMode;
  readonly target: SimulationTarget;
  readonly suite: EvalSimulationSuiteOptions & {
    readonly llm?: LlmProvider;
    readonly env?: Record<string, string>;
    readonly providerEnv?: ProviderEnv;
  };
  readonly caseOptions: EvalSimulationCaseOptions | undefined;
};

/**
 * Build the pair for one case. Every stub it installs is released before the
 * call that installed it returns, so a case owes nothing back.
 */
export function simulationContext(inputs: Inputs): EvalSimulationContext {
  const { agent, mode, target, suite, caseOptions } = inputs;
  const liveEnv = (): ProviderEnv =>
    suite.providerEnv ?? withHostCredentialFallback({ ...suite.env });
  const agentModel = (): LlmProvider =>
    suite.llm ?? agent.llm ?? llm({ provider: "assemblyai", model: ASSEMBLYAI_LLM_DEFAULT_MODEL });

  return {
    async simulate(caller, options) {
      if (mode === "live") {
        return await simulateCall(target, {
          caller,
          llm: suite.callerLlm ?? agentModel(),
          providerEnv: liveEnv(),
          ...omitUndefined({ maxTurns: options?.maxTurns }),
        });
      }
      const stub = installStubLlm(caseOptions?.stubCaller ?? DEFAULT_STUB_CALLER);
      try {
        return await simulateCall(target, {
          caller,
          llm: stub.llm,
          providerEnv: stub.env,
          ...omitUndefined({ maxTurns: options?.maxTurns }),
        });
      } finally {
        stub.release();
      }
    },
    async judge(input, criteria, options) {
      const context = omitUndefined({ context: options?.context });
      if (mode === "live") {
        return await judgeCall(input, {
          criteria,
          llm: suite.judgeLlm ?? agentModel(),
          providerEnv: liveEnv(),
          ...context,
        });
      }
      const rulings = criteria.map((_, i) => ({
        index: i + 1,
        pass: caseOptions?.stubJudge?.[i] ?? true,
        reason: "scripted ruling (stubJudge) — no model read this transcript",
      }));
      const stub = installStubLlm(
        JSON.stringify({
          criteria: rulings,
          summary: "Scripted verdict from the eval stub judge.",
        }),
      );
      try {
        return await runJudge(
          input,
          { criteria, llm: stub.llm, providerEnv: stub.env, ...context },
          true,
        );
      } finally {
        stub.release();
      }
    },
  };
}
