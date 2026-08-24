// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval` — a gated eval suite, with the session and the mode handled.
 *
 * Every eval file opens with the same three decisions, and each of them is easy
 * to get quietly wrong:
 *
 * 1. **Is there a key?** Without one a live case cannot run, and a suite that
 *    fails for want of a credential says nothing about the agent.
 * 2. **What does a run with no key still prove?** Rather than skipping, the
 *    suite runs against a SCRIPTED model (`stub-llm.ts`): the real runtime, the
 *    real pipeline, the real tools, a fake reply. That is a wiring check and it
 *    is worth having in a pipeline, which cannot have a key.
 * 3. **Which mode did I just get?** Announced, once, on every run. The one
 *    outcome this module refuses to produce is a green suite whose reader
 *    cannot tell which of the two it was.
 *
 * Plus the per-case bookkeeping: one session per case, opened before the body
 * and closed after it whatever happens, so the body is the assertions and
 * nothing else.
 *
 * This lives on `@alexkroman1/aai-runtime/eval/vitest` rather than beside
 * `openEvalSession`, on the repo's standing rule: anything that INSTALLS and
 * anything that RESTORES belongs on the subpath that pulls the test runner.
 * `vitest` is an optional peer, so importing that subpath is what asks for it.
 *
 * @module
 */

import type { AgentDef } from "@alexkroman1/aai";
import { describe, test } from "vitest";
import {
  type EvalSession,
  type EvalSessionOptions,
  evalCredentials,
  openEvalSession,
} from "./session.ts";
import { installStubLlm } from "./stub-llm.ts";

/** What a case gets to say about how it should be run. */
export type EvalCaseOptions = {
  /**
   * What a SCRIPTED model answers with when this suite runs without a key —
   * one string per model call, the last repeating. Choose it so the case's own
   * assertions still hold: the point of a stub run is that the case really
   * executes, and a stub the case then fails against measures nothing.
   */
  readonly stubReply?: string | readonly string[];
  /**
   * This case only means something against a live model — it is SKIPPED in stub
   * mode. Use it for a claim no script can honestly satisfy: a tool the model
   * has to choose for itself, a refusal, a judgement.
   */
  readonly live?: boolean;
};

/** How the suite is running, and why. */
export type EvalMode = "live" | "stub";

/** What a case body is handed: its own session, and which model it is on. */
export type EvalTestContext = {
  /** Open for this case, closed after it. */
  readonly session: EvalSession;
  /** Which model this run got. A case may branch on it, and most should not. */
  readonly mode: EvalMode;
};

/**
 * Declare one eval case. The session is opened for it and closed after it.
 *
 * Two things about this signature are decided by a LINTER rather than by
 * taste, both A/B'd against Biome 2.5 and both invisible until a user's own
 * project lights up red on a file the SDK told them to write:
 *
 * - **The parameter is named `test`.** `noMisplacedAssertion` matches on the
 *   CALLEE IDENTIFIER and nothing else, so an `expect` inside `evalTest(…)` is
 *   an error while the identical body inside `test(…)` is fine.
 * - **The body takes a DESTRUCTURED context, not the session positionally.**
 *   `noDoneCallback` reads the first parameter of an async test callback as
 *   jest's `done`, so `async (session) => …` is an error; `async ({ session })
 *   => …` is not — and it is vitest's own fixture shape, which is what a reader
 *   already expects.
 */
export type EvalTest = (
  name: string,
  body: (ctx: EvalTestContext) => Promise<void>,
  options?: EvalCaseOptions,
) => void;

/** What a stub-mode model says when a case scripts nothing. */
const DEFAULT_STUB_REPLY = "This is a scripted reply from the eval stub model.";

const truthy = (value: string | undefined): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/**
 * Live if this machine can be, stub if it cannot — unless a caller has said
 * which it wants.
 *
 * `AAI_REQUIRE_EVAL` is for a pipeline that means to MEASURE: with it set, a
 * missing credential is a failure instead of a quiet downgrade to a wiring
 * check. `AAI_EVAL_STUB` is the opposite instruction, and CI wants it —
 * a required check must not start spending tokens the day a key reaches its
 * environment, and must not become a flaky gate on a live model's behaviour.
 */
export function resolveEvalMode(
  agent: AgentDef,
  env: Record<string, string | undefined> = process.env,
): { mode: EvalMode; reason: string } {
  const creds = evalCredentials(agent, env);
  if (truthy(env.AAI_EVAL_STUB)) {
    return { mode: "stub", reason: "AAI_EVAL_STUB is set" };
  }
  if (creds.ready) return { mode: "live", reason: "a provider credential is set" };
  if (truthy(env.AAI_REQUIRE_EVAL)) {
    throw new Error(
      `AAI_REQUIRE_EVAL is set but this eval cannot run live: ${creds.reason}. ` +
        "Unset it to fall back to the scripted model, or supply the credential.",
    );
  }
  return { mode: "stub", reason: creds.reason ?? "no provider credential" };
}

/**
 * Declare an eval suite for `agent`.
 *
 * ```ts no-check
 * describeEval(agentDef, (test) => {
 *   test(
 *     "offers to take an order",
 *     async ({ session }) => {
 *       const turn = await session.say("hi, what can you do?");
 *       expect(turn.text).toMatch(/order/i);
 *     },
 *     { stubReply: "I can take an order for you." },
 *   );
 * });
 * ```
 */
export function describeEval(
  agent: AgentDef,
  define: (test: EvalTest) => void,
  options?: Omit<EvalSessionOptions, "agent">,
): void {
  const { mode, reason } = resolveEvalMode(agent);
  // One line, every run, before any case: a reader who cannot tell a wiring
  // check from a behaviour measurement has been handed the wrong confidence.
  console.warn(
    mode === "live"
      ? `eval: ${agent.name} — LIVE model (${reason}). This spends tokens.`
      : `eval: ${agent.name} — SCRIPTED model (${reason}). This checks the wiring, not the agent's behaviour.`,
  );

  describe(agent.name, () => {
    const evalTest: EvalTest = (name, body, caseOptions) => {
      const run = mode === "stub" && caseOptions?.live === true ? test.skip : test;
      run(name, async () => {
        const stub =
          mode === "stub"
            ? installStubLlm(caseOptions?.stubReply ?? DEFAULT_STUB_REPLY)
            : undefined;
        const session = await openEvalSession({
          ...options,
          agent,
          ...(stub === undefined
            ? {}
            : { llm: stub.llm, providerEnv: { ...options?.providerEnv, ...stub.env } }),
        });
        try {
          await body({ session, mode });
        } finally {
          await session.close();
          stub?.release();
        }
      });
    };
    define(evalTest);
  });
}
