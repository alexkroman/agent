// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeTextEval` — `describeEval` for an agent that has no voice.
 *
 * Its own function rather than a flag, for the reason there are two harnesses
 * underneath: `openEvalSession` stands up `createRuntime`, which REFUSES
 * `text: true` by name, so a text agent's eval runs on `openEvalTextAgent` and
 * nothing about the two can be merged below the suite. What IS shared is
 * everything a reader cares about — the two modes, the announce line, the
 * per-case script, the `live`/`scripted` markers, and the `EvalTurn` a case
 * asserts on — so a case moved between the two files changes one word.
 *
 * Two things differ, and both are properties of the MODE rather than of this
 * function:
 *
 * - **The context is `{ agent }`, not `{ session }`.** There is no session: a
 *   text agent is a message list and a model. Naming it `session` would be the
 *   kind of sameness that costs a reader an hour when they go looking for the
 *   transport.
 * - **The credential gate is `evalTextCredentials`.** `evalCredentials`
 *   answers about a VOICE agent and adds the default AssemblyAI STT key to any
 *   agent without a complete pipeline — which every text agent is — so a suite
 *   for an agent declaring `anthropicLlm()` skipped over a key it would never
 *   read.
 *
 * There is no workflow engine opened here, where `describeEval` opens one for
 * an agent that declares `workflows`. A text agent may still be handed one
 * through {@link DescribeTextEvalOptions.workflows}; what is missing is the
 * per-case AUTOMATIC open, and it is missing because nothing has needed it yet
 * rather than for a reason. Add it the day a text agent starts a run, and take
 * `describeEval`'s version whole.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, test } from "vitest";
import {
  announceEvalCoverage,
  announceEvalMode,
  type EvalMode,
  registerEmptySuiteFailure,
} from "./_announce.ts";
import { type EvalCaseOptions, modeFrom } from "./describe.ts";
import { installStubLlm } from "./stub-llm.ts";
import {
  type EvalTextAgent,
  type EvalTextAgentOptions,
  evalTextCredentials,
  openEvalTextAgent,
} from "./text-agent.ts";

/** What a text case body is handed: its own conversation, and the mode. */
export type EvalTextTestContext = {
  /** Opened for this case, released after it. */
  readonly agent: EvalTextAgent;
  /** Which model this run got. A case may branch on it, and most should not. */
  readonly mode: EvalMode;
};

/** Declare one text eval case. The conversation is opened and closed for it. */
export type EvalTextTest = (
  name: string,
  body: (ctx: EvalTextTestContext) => Promise<void>,
  options?: EvalCaseOptions,
) => void;

/** What {@link describeTextEval} takes beyond the agent. */
export type DescribeTextEvalOptions = Omit<EvalTextAgentOptions, "agent">;

/** What a stub-mode model says when a case scripts nothing. */
const DEFAULT_STUB_REPLY = "This is a scripted reply from the eval stub model.";

/**
 * Declare an eval suite for a TEXT agent.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { toolNames } from "@alexkroman1/aai-runtime/eval";
 * import { describeTextEval } from "@alexkroman1/aai-runtime/eval/vitest";
 * import { expect } from "vitest";
 *
 * const agentDef = agent({ name: "Coder", text: true });
 *
 * describeTextEval(agentDef, (test) => {
 *   test(
 *     "reads a file before it edits one",
 *     async ({ agent: coder }) => {
 *       const turn = await coder.send("rename `total` to `sum` in cart.ts");
 *       expect(toolNames(turn.toolCalls)).toContain("read_file");
 *     },
 *     { stubReply: [{ tool: "read_file", args: { path: "cart.ts" } }, "Renamed it."] },
 *   );
 * });
 * ```
 */
export function describeTextEval(
  agent: AgentDef,
  define: (test: EvalTextTest) => void,
  options?: DescribeTextEvalOptions,
): void {
  const { mode, reason } = modeFrom(
    evalTextCredentials({ ...agent, ...omitUndefined({ llm: options?.llm }) }),
    process.env,
  );
  announceEvalMode(
    mode === "live"
      ? `eval: ${agent.name} — LIVE model (${reason}). This spends tokens.`
      : `eval: ${agent.name} — SCRIPTED model (${reason}). This checks the wiring, not the agent's behaviour.`,
  );

  describe(agent.name, () => {
    let declared = 0;
    let skippedCases = 0;
    const evalTest: EvalTextTest = (name, body, caseOptions) => {
      declared += 1;
      const skipped =
        (mode === "stub" && caseOptions?.live === true) ||
        (mode === "live" && caseOptions?.scripted === true);
      if (skipped) skippedCases += 1;
      const run = skipped ? test.skip : test;
      run(name, async () => {
        // The stub is a process-global provider registration, so the release
        // is the only thing that gives it back — hence one `finally` covering
        // both it and the conversation.
        const stub =
          mode === "stub"
            ? installStubLlm(caseOptions?.stubReply ?? DEFAULT_STUB_REPLY)
            : undefined;
        const textAgent = await openEvalTextAgent({
          ...options,
          agent,
          ...(stub === undefined
            ? {}
            : { llm: stub.llm, providerEnv: { ...options?.providerEnv, ...stub.env } }),
        });
        try {
          await body({ agent: textAgent, mode });
        } finally {
          await textAgent.close();
          stub?.release();
        }
      });
    };
    define(evalTest);
    announceEvalCoverage(agent.name, mode, declared, skippedCases);
    registerEmptySuiteFailure(agent.name, mode, declared, skippedCases);
  });
}
