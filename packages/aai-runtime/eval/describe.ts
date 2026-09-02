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
import type { LlmProvider } from "@alexkroman1/aai/llm";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, test } from "vitest";
import { createGenerateFn } from "../generate.ts";
import {
  type EvalCredentials,
  type EvalSession,
  type EvalSessionOptions,
  evalCredentials,
  openEvalSession,
} from "./session.ts";
import { installStubLlm, type StubScript } from "./stub-llm.ts";
import {
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  evalWorkflowCredentials,
  openEvalWorkflows,
} from "./workflows.ts";

/** What a case gets to say about how it should be run. */
export type EvalCaseOptions = {
  /**
   * What a SCRIPTED model does when this suite runs without a key — one entry
   * per model call, the last line repeating. A string is a line the agent says;
   * `{ tool, args }` is a tool call, which is what makes a stub run worth having
   * for an agent that HAS tools:
   *
   * `no-check`: the fence is one FIELD of this type, and its only compilable
   * reading is a labelled statement inside a block — it would type-check
   * whatever the field were called, so checking it asserts nothing about
   * {@link EvalCaseOptions.stubReply}. Kept as a fragment deliberately, not
   * because it cannot compile: a `no-check` that would pass is unclaimed
   * headroom, and this one would pass for the wrong reason.
   *
   * ```ts no-check
   * { stubReply: [{ tool: "look_up", args: { orderId: "W1234" } }, "It shipped."] }
   * ```
   *
   * Choose it so the case's own assertions still hold: the point of a stub run
   * is that the case really executes, and a stub the case then fails against
   * measures nothing.
   */
  readonly stubReply?: StubScript;
  /**
   * What a SCRIPTED `ctx.generate` answers with — its OWN script, walked by its
   * own cursor.
   *
   * Separate from {@link EvalCaseOptions.stubReply} because `ctx.generate`
   * resolves a model INSTANCE of its own, in parallel with the turn's: one
   * script would need element 0 to be the turn's first move and the first
   * `generate` answer simultaneously. A tool that reasons with a model — a
   * grader, a planner, a rewriter — is the shape this exists for, and two
   * shipped templates' central tools are exactly that. For the schema overload,
   * write the object as the JSON string the model would have returned.
   */
  readonly stubGenerate?: StubScript;
  /**
   * This case only means something against a live model — it is SKIPPED in stub
   * mode. Use it for a claim no script can honestly satisfy: a tool the model
   * has to choose for itself, a refusal, a judgement.
   */
  readonly live?: boolean;
  /**
   * The mirror: this case only means something against a SCRIPT, and is skipped
   * against a live model.
   *
   * It is not a symmetry for its own sake — three cases needed it. A gate can
   * only be observed refusing if something CALLS the gated tool, and a competent
   * model declines to (measured: `solo-rpg`'s game-over route is a tool its own
   * prompt forbids unprompted; a dispatcher calls `resources_get_available`
   * first and never trips the busy-unit refusal; a `visit_webpage` at a private
   * address is the SSRF screen's own case and a live model sensibly refuses to
   * try). Without this marker each cost a red live run and got weakened.
   */
  readonly scripted?: boolean;
};

/** How the suite is running, and why. */
export type EvalMode = "live" | "stub";

/** What a case body is handed: its own session, and which model it is on. */
export type EvalTestContext = {
  /** Open for this case, closed after it. */
  readonly session: EvalSession;
  /** Which model this run got. A case may branch on it, and most should not. */
  readonly mode: EvalMode;
  /**
   * The workflow app behind this session's `ctx.workflows`, for an agent that
   * declares workflows — `undefined` for one that does not.
   *
   * Opened per case and closed after it, and it is what makes a tool calling
   * `ctx.workflows.start` runnable at all: the real client the runtime would
   * build cannot start an untransformed body. A case reads the run its tool
   * started with `workflows.settle(runId)`.
   *
   * The engine under it is NOT durable — see `eval/workflow-engine.ts` before
   * writing a claim about a run.
   */
  readonly workflows: EvalWorkflows | undefined;
};

/**
 * What {@link describeEval} takes beyond the agent.
 *
 * The session options, plus `workflowOptions` for the engine it opens per case
 * when the agent declares `workflows`. That second one is not symmetry for its
 * own sake: a workflow-starting tool's STEPS make provider calls, and the only
 * honest way to evaluate which tool the desk reached for — without paying for
 * five gateway calls and a real web search per case, and without a 429 failing
 * the run outright because a step's `maxRetries` is inert here — is to script
 * the step's HTTP while leaving the SESSION's model live. Both templates that
 * hand off to a run had to install that inside the case body, which worked only
 * because the engine publishes nothing when nobody passed one.
 */
export type DescribeEvalOptions = Omit<EvalSessionOptions, "agent"> & {
  readonly workflowOptions?: Omit<EvalWorkflowsOptions, "agent">;
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
  /**
   * What the CASE overrides, which decides the credential question with it.
   *
   * Without this the mode was read off the AGENT alone, so
   * `describeEval(def, define, { llm: assemblyAILlm() })` on an agent declaring
   * `anthropic()` announced "SCRIPTED — ANTHROPIC_API_KEY is not set" while
   * holding the key the run would actually have used. Measured on
   * `pipeline-simple`: the override was honoured by the session and ignored by
   * the gate, so a case could not be run live at all.
   */
  overrides?: { readonly llm?: LlmProvider },
): { mode: EvalMode; reason: string } {
  // The override replaces the LLM and nothing else, so the credential question
  // is asked about an agent carrying it. `omitUndefined` keeps the field ABSENT
  // rather than present-and-undefined, which `exactOptionalPropertyTypes` makes
  // a different type.
  const effective: AgentDef = { ...agent, ...omitUndefined({ llm: overrides?.llm }) };
  return modeFrom(evalCredentials(effective, env), env);
}

/**
 * {@link resolveEvalMode} for a WORKFLOW app, whose credentials are a different
 * question.
 *
 * Split rather than folded in because the two gates read different fields and the
 * wrong one is silent: a `page: "static"` agent needs no provider credential, so
 * `evalCredentials` reports every workflow app ready and a keyless run goes LIVE
 * — then every case fails on a 401 three layers down. `evalWorkflowCredentials`
 * reads `requiredEnv`, which is the only thing a workflow app declares its
 * credentials in.
 */
export function resolveWorkflowEvalMode(
  agent: AgentDef,
  env: Record<string, string | undefined> = process.env,
): { mode: EvalMode; reason: string } {
  return modeFrom(evalWorkflowCredentials(agent, env), env);
}

/** The mode decision itself, shared by both gates above. */
function modeFrom(
  creds: EvalCredentials,
  env: Record<string, string | undefined>,
): { mode: EvalMode; reason: string } {
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
 * Say which mode this run got — one line, every run, before any case.
 *
 * A DIRECT stderr write, not `console.warn`, and that is the whole point of the
 * function. Vitest INTERCEPTS `console` and hands what it captures to the
 * reporter, so whether the line is ever seen is the REPORTER's decision — and
 * vitest 4 picks that reporter for you: with `reporters` unset it resolves
 * `std-env`'s `isAgent ? "agent" : "default"`, and the agent reporter prints a
 * passing file's captured output nowhere. A scaffolded agent project sets no
 * `reporters`. So `aai eval` run BY AN AGENT — this repo's own studio coding
 * agent included — showed the line only when the run FAILED, which is the one
 * case where it does not matter.
 *
 * Measured on a scaffolded project, vitest 4.1.10, one passing case: with the
 * agent markers in the environment `console.warn` printed nothing while a
 * `process.stderr.write` beside it printed; with those markers stripped — a
 * human at a terminal — `console.warn` printed too. Pinning
 * `reporters: ["default"]` restores it as well, which is exactly why THIS repo
 * never saw it: `vitest.shared.ts` pins that value and every config here
 * spreads it.
 *
 * A stderr write is right rather than merely sufficient: it is the reporter's
 * job to decide what a TEST said, and not the reporter's job to decide whether
 * the harness may state what it just did. The trailing newline is ours for the
 * same reason — nothing is formatting this.
 */
export function announceEvalMode(line: string): void {
  process.stderr.write(`${line}\n`);
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
  options?: DescribeEvalOptions,
): void {
  const { mode, reason } = resolveEvalMode(
    agent,
    process.env,
    omitUndefined({ llm: options?.llm }),
  );
  announceEvalMode(
    mode === "live"
      ? `eval: ${agent.name} — LIVE model (${reason}). This spends tokens.`
      : `eval: ${agent.name} — SCRIPTED model (${reason}). This checks the wiring, not the agent's behaviour.`,
  );

  describe(agent.name, () => {
    const evalTest: EvalTest = (name, body, caseOptions) => {
      const skipped =
        (mode === "stub" && caseOptions?.live === true) ||
        (mode === "live" && caseOptions?.scripted === true);
      const run = skipped ? test.skip : test;
      run(name, () => runCase({ agent, mode, options, caseOptions, body }));
    };
    define(evalTest);
  });
}

/** What one case needs to stand itself up. */
type CaseRun = {
  readonly agent: AgentDef;
  readonly mode: EvalMode;
  readonly options: DescribeEvalOptions | undefined;
  readonly caseOptions: EvalCaseOptions | undefined;
  readonly body: (ctx: EvalTestContext) => Promise<void>;
};

/**
 * Open everything one case needs, run its body, and close in reverse.
 *
 * Its own function rather than an arrow inside `describeEval`, because the four
 * things a case may need — a scripted turn model, a scripted `ctx.generate`, a
 * workflow engine, the session over all three — put that arrow past Biome's
 * complexity ceiling. The teardown is the reason it is worth reading as one
 * unit: every one of those four owns a PROCESS-GLOBAL registration or a live
 * runtime, and the `finally` is the only thing that gives them back.
 */
async function runCase(run: CaseRun): Promise<void> {
  const { agent, mode, options, caseOptions, body } = run;
  const stub =
    mode === "stub" ? installStubLlm(caseOptions?.stubReply ?? DEFAULT_STUB_REPLY) : undefined;
  // Its own kind, so its own cursor: see `EvalCaseOptions.stubGenerate`.
  const generateStub =
    mode === "stub" && caseOptions?.stubGenerate !== undefined
      ? installStubLlm(caseOptions.stubGenerate)
      : undefined;
  // Opened BEFORE the session, because the session is handed its client. Only
  // for an agent that declares workflows, and only when the suite did not supply
  // a client of its own — a caller who passed one owns it.
  const workflows =
    options?.workflows === undefined && hasWorkflows(agent)
      ? openEvalWorkflows({
          agent,
          ...omitUndefined({ env: options?.env }),
          ...(options?.workflowOptions ?? {}),
        })
      : undefined;
  const session = await openEvalSession({
    ...options,
    agent,
    ...omitUndefined({
      workflows: workflows?.client,
      // The scripted `ctx.generate`, which the runtime would otherwise build
      // from the agent's own descriptor — a second instance of the TURN's
      // model, walking that script from the start.
      generate:
        generateStub === undefined
          ? undefined
          : createGenerateFn({ llm: generateStub.llm, env: generateStub.env }),
    }),
    ...(stub === undefined
      ? {}
      : { llm: stub.llm, providerEnv: { ...options?.providerEnv, ...stub.env } }),
  });
  try {
    await body({ session, mode, workflows });
  } finally {
    await session.close();
    await workflows?.close();
    stub?.release();
    generateStub?.release();
  }
}

/** Does this agent declare a workflow for a tool to start? */
function hasWorkflows(agent: AgentDef): boolean {
  return Object.keys(agent.workflows ?? {}).length > 0;
}
